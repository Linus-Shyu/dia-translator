/* ============================================================================
 * background.js —— 扩展的「后台服务员」（MV3 的 service worker）
 * ----------------------------------------------------------------------------
 * 它没有界面、没有 DOM，主要干两件事：
 *   A. 翻译：收到 content.js 发来的 { type: "translate" } → 调 DeepSeek → 回结果
 *   B. 落盘：收到 { type: "syncWordsToFile" } → 叫醒 offscreen 页面去写本地文件
 *
 * 为什么写文件要绕一圈？因为 service worker 里不能直接弹文件选择框、
 * 也拿不到用户的文件句柄，Chrome 要求这类操作放进 offscreen 文档里做。
 *
 * 注意：service worker 空闲约 30 秒会被浏览器杀掉，所以所有状态都放在
 * chrome.storage / IndexedDB 里，不要指望这个文件里的变量长期存活。
 * ========================================================================== */

const API_URL = "https://api.deepseek.com/chat/completions";

/* ---------------------------------------------------------------------------
 * 1) 读取 .env 里的 API Key
 * ---------------------------------------------------------------------------
 * 扩展不能读宿主机环境变量，这里是把项目里的 .env 当成普通文件 fetch 进来，
 * 然后手工按 "KEY=VALUE" 逐行解析（顺便支持 # 注释和首尾引号）。
 * ------------------------------------------------------------------------- */
async function loadEnv() {
  try {
    // chrome.runtime.getURL 把扩展内相对路径转成 chrome-extension://... 的绝对地址
    const res = await fetch(chrome.runtime.getURL(".env"));
    if (!res.ok) return {};
    const text = await res.text();
    const env = {};
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue; // 跳过空行和注释
      const i = t.indexOf("=");
      if (i === -1) continue; // 没有等号，不是合法配置
      env[t.slice(0, i).trim()] = t
        .slice(i + 1)
        .trim()
        .replace(/^["']|["']$/g, ""); // 去掉包裹的引号
    }
    return env;
  } catch {
    return {}; // 文件不存在等情况一律当空配置，避免整个后台崩掉
  }
}

// 缓存 Promise：只读一次 .env，之后都复用同一个结果
let envPromise = null;
function getEnv() {
  if (!envPromise) envPromise = loadEnv();
  return envPromise;
}

/* ---------------------------------------------------------------------------
 * 2) 消息总入口
 * ---------------------------------------------------------------------------
 * 所有来自 content.js / popup.js / options.js 的消息都会进到这里，
 * 靠 message.type 分发。
 *
 * ⚠️ 关键点：处理是异步的（要等网络），必须 return true，
 *    否则 Chrome 会认为通道已关闭，sendResponse 就发不出去了。
 * ------------------------------------------------------------------------- */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "translate") {
    translate(message.text)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (message.type === "syncWordsToFile") {
    syncWordsToFile()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
});

/* ---------------------------------------------------------------------------
 * 3) 翻译主流程
 * ---------------------------------------------------------------------------
 * 长文本先切块，再逐块请求（串行，避免一下子打太多请求），最后用换行拼回去。
 * ------------------------------------------------------------------------- */
async function translate(text) {
  const chunks = splitText(text, 1200);
  const results = [];
  for (const chunk of chunks) {
    results.push(await translateChunk(chunk));
  }
  return results.join("\n");
}

/* 真正发 HTTP 请求的地方：一次翻译一块文本 */
async function translateChunk(chunk) {
  const env = await getEnv();
  if (!env.DEEPSEEK_API_KEY) throw new Error("未配置 DEEPSEEK_API_KEY");

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Bearer 后面就是 .env 里的 key
      Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [
        {
          role: "system",
          // 系统提示词决定了「翻译风格」，想让译文更口语/更学术，改这句就行
          content:
            "把用户给出的文本翻译成中文；若原文是中文则译成英文。只输出译文，不要解释。",
        },
        { role: "user", content: chunk },
      ],
      temperature: 1.3, // 翻译任务官方推荐偏高一点的温度
      stream: false,    // 一次性返回，不做流式
    }),
  });

  if (!res.ok) {
    // 把状态码和错误正文前 120 字带出来，方便在气泡里看到到底为什么失败
    const detail = await res.text().catch(() => "");
    throw new Error(`DeepSeek ${res.status} ${detail.slice(0, 120)}`);
  }

  const data = await res.json();
  // 标准 OpenAI 兼容格式：choices[0].message.content
  const out = data?.choices?.[0]?.message?.content;
  if (!out) throw new Error("DeepSeek 返回为空");
  return out.trim();
}

/* ---------------------------------------------------------------------------
 * 4) splitText —— 把超长文本切成 <= maxLen 的若干块
 * ---------------------------------------------------------------------------
 * 优先在句末标点处断开，读起来更连贯；如果半句话都没有标点，就硬切。
 *
 * ⚠️ 这段循环必须保证「每轮 rest 一定变短」，否则会死循环把后台卡死。
 *    这里的 end 最小是 maxLen（或 cut+1，且 cut >= maxLen/2），所以安全。
 * ------------------------------------------------------------------------- */
function splitText(text, maxLen) {
  const chunks = [];
  let rest = (text || "").trim();

  while (rest.length > maxLen) {
    const w = rest.slice(0, maxLen); // 只看前 maxLen 个字
    const cut = Math.max(
      w.lastIndexOf("。"),
      w.lastIndexOf("！"),
      w.lastIndexOf("？"),
      w.lastIndexOf("\n")
    );
    // 断点太靠前（不到一半）就干脆整段切，避免切出一堆碎句
    const end = cut >= maxLen * 0.5 ? cut + 1 : maxLen;
    chunks.push(rest.slice(0, end));
    rest = rest.slice(end);
  }

  if (rest) chunks.push(rest);
  return chunks;
}

/* ---------------------------------------------------------------------------
 * 5) 写文件：后台只负责「叫醒 offscreen」，真正写盘在 offscreen.js
 * ------------------------------------------------------------------------- */
let offscreenReady = false;

async function ensureOffscreen() {
  if (offscreenReady) return;
  try {
    // 创建/复用一个隐藏页面。reasons 必须写明理由，否则 Chrome 会拒绝。
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["BLOBS"],
      justification: "Write collected words to the user's chosen local file",
    });
  } catch (e) {
    // 文档已存在时会抛错，忽略
  }
  offscreenReady = true;
}

/* 把 storage 里的词表拼成 TSV，再让 offscreen 写进用户选的文件 */
async function syncWordsToFile() {
  const { words = [] } = await chrome.storage.local.get("words");

  // 一行一个词：单词 <TAB> 释义；先把可能破坏 TSV 结构的制表符/换行替换掉
  const lines = words.map((w) => {
    const term = String(w.word).replace(/[\t\n\r]+/g, " ").trim();
    const def = String(w.translation).replace(/[\t\n\r]+/g, " ").trim();
    return term + "\t" + def;
  });

  await ensureOffscreen();

  // target: "offscreen" 用来让 offscreen.js 里的 listener 认出这是给它的
  const res = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "write",
    text: lines.join("\n"),
  });

  if (!res || !res.ok) throw new Error(res ? res.error : "offscreen 无响应");
}
