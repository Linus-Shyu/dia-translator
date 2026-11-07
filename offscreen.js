/* ============================================================================
 * offscreen.js —— 真正执行「写本地文件」的地方
 * ----------------------------------------------------------------------------
 * 调用链：
 *   content.js 点星星
 *     → background.js 的 syncWordsToFile()
 *       → chrome.runtime.sendMessage({ target:"offscreen", type:"write", text })
 *         → 本文件的 listener
 *           → writeWords() 用 File System Access API 写盘
 *
 * 为什么不直接在 background.js 里写？因为 service worker 拿不到文件句柄、
 * 也不能申请权限，必须借助一个有 DOM 的隐藏页面（offscreen 文档）。
 * ========================================================================== */

/* ---------------------------------------------------------------------------
 * writeWords：把一段文本整体覆盖写入用户选好的文件
 * ------------------------------------------------------------------------- */
async function writeWords(text) {
  // 句柄是用户在设置页选文件时存进 IndexedDB 的
  const handle = await loadFileHandle();
  if (!handle) throw new Error("尚未在设置里选择保存文件");

  // 浏览器重启后，之前的写权限会被重置成 "prompt"，这里按需重新申请
  let perm = await handle.queryPermission({ mode: "readwrite" });
  if (perm !== "granted") {
    perm = await handle.requestPermission({ mode: "readwrite" });
  }
  if (perm !== "granted") {
    throw new Error("文件权限未授予，请到扩展设置里重新选择文件");
  }

  // createWritable 会清空原文件，然后逐段 write，最后 close 才真正落盘
  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();
}

/* ---------------------------------------------------------------------------
 * 消息监听
 * ---------------------------------------------------------------------------
 * 后台的 syncWordsToFile 会广播一条 { target: "offscreen", type: "write" }，
 * 但同一条消息也会被 background.js 自己收到，所以这里必须先用
 * message.target 过滤，否则会自己回自己、无限循环。
 *
 * 注意这里通篇没有 message.type === "translate" 的分支——
 * 那是 background.js 的活儿，两个文件各管一摊。
 * ------------------------------------------------------------------------- */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== "offscreen") return;
  if (message.type === "write") {
    writeWords(message.text)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // 异步回复，必须 return true
  }
});
