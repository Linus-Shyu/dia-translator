/* ============================================================================
 * content.js —— 注入到「每一个网页」里运行的那部分代码
 * ----------------------------------------------------------------------------
 * 它只负责三件事：
 *   1. 监听鼠标松开 → 拿到用户选中的文字、以及这段文字在屏幕上的位置
 *   2. 在页面上画一个翻译气泡（用 Shadow DOM，样式不会被网页自己的 CSS 影响）
 *   3. 点 ☆ 时，把「单词 + 译文」存进 chrome.storage.local
 *
 * 它无法直接调用后台的 translate()，只能通过消息沟通：
 *     chrome.runtime.sendMessage({ type: "translate", text })
 *         ↓
 *     background.js 里的 listener 接住，翻译完再把结果 sendResponse 回来
 *
 * ⚠️ 改完本文件后：chrome://extensions 点刷新 → 再刷新网页，才会生效。
 * ========================================================================== */

/* ---------------------------------------------------------------------------
 * 1) 气泡的样式
 * ---------------------------------------------------------------------------
 * 这里的字符串最后会被塞进 <style> 标签，所以写法和普通 CSS 一样。
 * 之所以把样式集中成一个常量，而不是散落在 JS 里到处 style.xxx = ...，
 * 是因为后面要把它整体放进 Shadow DOM（见 ensureBubble）。
 *
 * 几个关键属性：
 *   position: 在宿主 div 上（fixed），保证气泡相对「浏览器视口」定位
 *   backdrop-filter: 毛玻璃，背后的网页内容会模糊透出来
 *   max-height: 40vh + overflow-y: auto → 译文太长时气泡自己滚动，不会撑爆屏幕
 * ------------------------------------------------------------------------- */
const BUBBLE_CSS = `
  .bubble {
    display: flex; align-items: flex-start; gap: 10px;
    max-width: 340px; padding: 10px 12px;
    border-radius: 12px;
    background: rgba(255,255,255,.92);
    backdrop-filter: blur(12px) saturate(180%);
    border: 1px solid rgba(0,0,0,.06);
    box-shadow: 0 8px 28px -6px rgba(16,24,40,.22), 0 2px 6px rgba(16,24,40,.06);
    font: 14px/1.6 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
    color: #111827;
    animation: td-in .16s cubic-bezier(.2,.9,.3,1.2);
  }
  @keyframes td-in {
    from { opacity: 0; transform: translateY(4px) scale(.97); }
    to   { opacity: 1; transform: none; }
  }
  .text {
    flex: 1; white-space: pre-wrap; word-break: break-word;
    max-height: 40vh; overflow-y: auto;
  }
  /* 翻译还没回来时，文字是灰色 + 显示「翻译中…」 */
  .text.loading { color: #9ca3af; }
  .star {
    border: 0; background: none; padding: 0; cursor: pointer;
    font-size: 16px; line-height: 1.3; color: #9ca3af;
    transition: transform .12s, color .12s;
  }
  .star:hover { transform: scale(1.15); }
  /* 收藏成功后由 JS 加上 .on，星星变金色 */
  .star.on { color: #f59e0b; }
  /* 系统是深色模式时自动换配色，不需要 JS 判断 */
  @media (prefers-color-scheme: dark) {
    .bubble {
      background: rgba(32,32,36,.92);
      border-color: rgba(255,255,255,.08);
      color: #f3f4f6;
      box-shadow: 0 8px 28px -6px rgba(0,0,0,.6);
    }
  }
`;

/* ---------------------------------------------------------------------------
 * 2) 模块级变量（整个 content script 只有这一份，页面刷新才会重置）
 * ------------------------------------------------------------------------- */
let bubble = null;      // 宿主 div（真正挂在网页上的那个元素）
let bubbleRoot = null;  // 上面的 div 内部的 shadow root，气泡本体在它里面
let textEl = null;      // 显示译文的那一块
let starBtn = null;     // 收藏按钮
let currentWord = "";        // 当前选中的原文
let currentTranslation = ""; // 当前译文（点星星时要一起存起来）
let currentRect = null;      // 选区的位置，译文回来后要重新定位气泡
let requestId = 0;           // 请求序号：防止「先发后到」的旧结果覆盖新结果

/* ---------------------------------------------------------------------------
 * 3) 入口：监听整页的鼠标松开
 * ---------------------------------------------------------------------------
 * 用 mouseup 而不是 selectionchange，是因为用户可能还在拖选，
 * 松开鼠标才代表「这次选择结束了」。
 * ------------------------------------------------------------------------- */
document.addEventListener("mouseup", (e) => {
  // 点在气泡自己身上（比如点星星）不算新的划词，直接返回
  if (bubble && bubble.contains(e.target)) return;

  const selection = window.getSelection();
  const text = selection ? selection.toString().trim() : "";
  if (!text) return hideBubble(); // 点空白处（没有选中文字）→ 收起气泡

  // getBoundingClientRect 拿到选区在视口中的坐标和大小，用来决定气泡放哪儿
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  showBubble(rect, text);
});

/* ---------------------------------------------------------------------------
 * 4) ensureBubble —— 懒加载：第一次用到才创建 DOM，之后复用
 * ---------------------------------------------------------------------------
 * Shadow DOM 的作用：气泡内部的结构和 CSS 与宿主网页完全隔离，
 * 网页里写的 div{...} 不会把气泡搞变形，气泡的样式也不会污染网页。
 * ------------------------------------------------------------------------- */
function ensureBubble() {
  if (bubble) return; // 已经建过了

  bubble = document.createElement("div");
  // all:initial 抹掉网页可能加到 div 上的所有样式；
  // position:fixed 让气泡相对视口定位，滚动时跟着走。
  bubble.style.cssText =
    "all:initial;position:fixed;z-index:2147483647;left:0;top:0;";

  // attachShadow 建立一个隔离区，mode:"open" 表示外部还能用 .shadowRoot 访问到
  bubbleRoot = bubble.attachShadow({ mode: "open" });
  // 注意：这里的 ${BUBBLE_CSS} 是模板字符串插值，会把上面那段 CSS 原样塞进 <style>
  bubbleRoot.innerHTML = `<style>${BUBBLE_CSS}</style>
    <div class="bubble">
      <button class="star" title="收藏这个单词">☆</button>
      <div class="text"></div>
    </div>`;

  textEl = bubbleRoot.querySelector(".text");
  starBtn = bubbleRoot.querySelector(".star");

  // 点星星：收藏当前这一对「原文 + 译文」
  starBtn.addEventListener("click", async (e) => {
    e.stopPropagation(); // 别让点击冒泡出去，避免触发页面自己的事件
    if (!currentWord || !currentTranslation) return; // 还没翻译完就不给收藏
    await saveWord(currentWord, currentTranslation);
    if (!starBtn) return; // 等待期间气泡可能已经被关掉了
    starBtn.textContent = "★";
    starBtn.classList.add("on");
  });

  document.body.appendChild(bubble);
}

/* ---------------------------------------------------------------------------
 * 5) showBubble —— 每次划词都会走这里
 * ---------------------------------------------------------------------------
 * 步骤：建好气泡 → 显示「翻译中…」→ 摆位置 → 发消息请求翻译
 *       → 结果回来就替换文字并重新摆位置
 * ------------------------------------------------------------------------- */
function showBubble(rect, text) {
  ensureBubble();

  currentWord = text;
  currentTranslation = "";
  currentRect = rect;

  textEl.classList.add("loading");
  textEl.textContent = "翻译中…";
  resetStar(); // 上一次可能点过星星，重置成空心
  placeBubble(rect);

  // 每次请求拿一个自增 id，回来时对不上就说明已经有更新的请求了，丢弃旧结果
  const myId = ++requestId;

  translate(text)
    .then((result) => {
      if (myId !== requestId || !textEl) return;
      currentTranslation = result;
      textEl.classList.remove("loading");
      textEl.textContent = result;
      placeBubble(currentRect); // 内容变高/变宽后重新定位
    })
    .catch((err) => {
      if (myId !== requestId || !textEl) return;
      textEl.classList.remove("loading");
      const msg = String(err && err.message ? err.message : err);
      // 「扩展已更新」是一种独立提示，不要套上「翻译失败:」前缀
      textEl.textContent = msg === MSG_DEAD ? msg : "翻译失败: " + msg;
      placeBubble(currentRect);
    });
}

/* ---------------------------------------------------------------------------
 * 6) placeBubble —— 计算气泡该出现在哪
 * ---------------------------------------------------------------------------
 * 规则：水平居中于选区；竖直优先放在选区上方，上方放不下就翻到下方；
 *       最后再夹一下，保证不超出视口（否则贴着屏幕边缘会被裁掉）。
 * ------------------------------------------------------------------------- */
function placeBubble(rect) {
  if (!bubble || !rect) return;
  const gap = 8; // 气泡与选区之间的空隙
  // 先量出气泡当前的真实尺寸（内容多少会改变高度）
  const { width, height } = bubble.getBoundingClientRect();

  let left = rect.left + rect.width / 2 - width / 2;
  left = Math.min(Math.max(gap, left), innerWidth - width - gap);

  let top = rect.top - height - gap;
  if (top < gap) top = rect.bottom + gap; // 上方空间不够 → 放到选区下面
  top = Math.min(top, innerHeight - height - gap);

  bubble.style.left = `${left}px`;
  bubble.style.top = `${top}px`;
}

/* ---------------------------------------------------------------------------
 * 7) hideBubble —— 从页面上移除气泡，并把引用全部清空
 * ------------------------------------------------------------------------- */
function hideBubble() {
  if (!bubble) return;
  bubble.remove();
  bubble = null;
  bubbleRoot = null;
  textEl = null;
  starBtn = null;
  currentRect = null;
}

/* ---------------------------------------------------------------------------
 * 8) 与后台通信
 * ---------------------------------------------------------------------------
 * 扩展被重载 / 更新 / 禁用后，已经打开的标签页里，旧 content script 会失去
 * chrome.runtime（变成 undefined）。这时直接 sendMessage 会抛
 * "Cannot read properties of undefined (reading 'sendMessage')"。
 * 所以先检查一次，失效就给出「请刷新页面」的友好提示。
 * ------------------------------------------------------------------------- */
function extensionAlive() {
  try {
    return Boolean(chrome && chrome.runtime && chrome.runtime.id);
  } catch {
    return false;
  }
}

const MSG_DEAD = "扩展已更新，请刷新本页后重试";

function translate(text) {
  if (!extensionAlive()) return Promise.reject(new Error(MSG_DEAD));
  try {
    // sendMessage 返回 Promise，background.js 里 sendResponse 的内容就是它的值
    return chrome.runtime.sendMessage({ type: "translate", text }).then((res) => {
      if (res && res.ok) return res.result;
      throw new Error(res ? res.error : "扩展无响应");
    });
  } catch (e) {
    return Promise.reject(e);
  }
}

/* 把星星恢复成未收藏的样子 */
function resetStar() {
  if (!starBtn) return;
  starBtn.textContent = "☆";
  starBtn.classList.remove("on");
}

/* ---------------------------------------------------------------------------
 * 9) saveWord —— 收藏单词
 * ---------------------------------------------------------------------------
 * 存在 chrome.storage.local（扩展自己的存储，不会随网页关闭而消失），
 * 结构是 { words: [ { word, translation, time }, ... ] }。
 * 同名单词只存一次。
 * 存完再通知后台「把词表同步到用户选的那个文件」，失败无所谓（比如还没设置文件）。
 * ------------------------------------------------------------------------- */
async function saveWord(word, translation) {
  if (!extensionAlive()) return;
  const { words = [] } = await chrome.storage.local.get("words");
  if (words.some((w) => w.word === word)) return;
  words.push({ word, translation, time: Date.now() });
  await chrome.storage.local.set({ words });
  try {
    chrome.runtime.sendMessage({ type: "syncWordsToFile" }).catch(() => {});
  } catch {}
}
