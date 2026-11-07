/* ============================================================================
 * options.js —— 设置页的逻辑
 * ----------------------------------------------------------------------------
 * 只干两件事：
 *   1. 「选择保存文件」：弹系统对话框，让用户选一个 .tsv，然后把「文件句柄」存起来
 *      （存句柄的函数在 file-store.js 里，因为 offscreen 页面也要用）
 *   2. 「立即同步一次」：发消息给后台，让它把当前词表写进那个文件
 *
 * 小知识：FileSystemFileHandle 可以长期复用，但浏览器出于安全会把「写入权限」
 * 重置成 prompt，需要重新授权（见 offscreen.js 里的 requestPermission）。
 * ========================================================================== */

const statusEl = document.getElementById("status");

/* ---------------------------------------------------------------------------
 * refresh：页面打开时，把「当前选的是哪个文件、有没有写入权限」显示出来
 * ------------------------------------------------------------------------- */
async function refresh() {
  const handle = await loadFileHandle();
  if (!handle) {
    statusEl.textContent = "尚未选择文件";
    return;
  }

  let perm = "unknown";
  try {
    // queryPermission 只查询、不弹窗；写入时如果没权限才需要 requestPermission
    perm = await handle.queryPermission({ mode: "readwrite" });
  } catch (e) {}
  statusEl.textContent = `当前文件：${handle.name}（权限：${perm}）`;
}

/* ---------------------------------------------------------------------------
 * 按钮 1：选择保存文件
 * ---------------------------------------------------------------------------
 * window.showSaveFilePicker 属于 File System Access API，
 * 必须在「用户点击」这类手势里调用，否则会被浏览器拒绝。
 * ------------------------------------------------------------------------- */
document.getElementById("pick").addEventListener("click", async () => {
  try {
    const handle = await window.showSaveFilePicker({
      suggestedName: "words.tsv",
      types: [
        { description: "TSV 文本", accept: { "text/plain": [".tsv", ".txt"] } },
      ],
    });
    // 句柄存进 IndexedDB，后续（包括 offscreen 页面）都能再取出来
    await saveFileHandle(handle);
    statusEl.textContent = `已选择：${handle.name}`;
  } catch (e) {
    // 用户点「取消」也会走到这里，属于正常情况
    statusEl.textContent = "已取消：" + e.message;
  }
});

/* ---------------------------------------------------------------------------
 * 按钮 2：立即同步一次
 * ---------------------------------------------------------------------------
 * 转发给 background.js，由它调度 offscreen 去写文件。
 * 设置页自己不能直接写：句柄的写权限绑定在当初授权的上下文里。
 * ------------------------------------------------------------------------- */
document.getElementById("sync").addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: "syncWordsToFile" });
  statusEl.textContent =
    res && res.ok ? "已同步到文件 ✓" : "同步失败：" + (res ? res.error : "无响应");
});

// 打开页面就刷新一次状态
refresh();
