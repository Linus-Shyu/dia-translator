/* ============================================================================
 * popup.js —— 扩展弹窗的逻辑（点工具栏图标后看到的那一页）
 * ----------------------------------------------------------------------------
 * 三件事：
 *   1. 打开时读 chrome.storage.local，显示「已收藏 N 个单词」
 *   2. 复制 / 下载：把词表变成 TSV 文本（每行「单词<TAB>释义」）
 *   3. 设置按钮：打开扩展的选项页 options.html
 *
 * 为什么复制成 TSV 而不是 JSON？因为 Quizlet、Anki 这类背单词工具都支持
 * 直接粘贴「制表符分隔」的文本，一行一个词条。
 * ========================================================================== */

// 先把要操作的两个元素抓出来（对应 popup.html 里的 id="count" / id="status"）
const countEl = document.getElementById("count");
const statusEl = document.getElementById("status");

/* ---------------------------------------------------------------------------
 * getLines：从存储里取出词表，转成一行行 "单词\t释义" 的字符串数组
 * ---------------------------------------------------------------------------
 * { words = [] } 是解构 + 默认值：存储里还没有 words 这个键时取到空数组，
 * 避免 undefined.map 报错。
 * ------------------------------------------------------------------------- */
async function getLines() {
  const { words = [] } = await chrome.storage.local.get("words");
  return words.map((w) => {
    // 把可能存在的制表符/换行替换成空格，否则会把 TSV 一行撑成两列甚至两行
    const term = String(w.word).replace(/[\t\n\r]+/g, " ").trim();
    const def = String(w.translation).replace(/[\t\n\r]+/g, " ").trim();
    return term + "\t" + def;
  });
}

/* 刷新顶部的词数显示 */
async function refresh() {
  const { words = [] } = await chrome.storage.local.get("words");
  countEl.textContent = `已收藏 ${words.length} 个单词`;
}

// 脚本一加载就立刻刷新一次（弹窗每次打开都是重新加载，所以这行就够了）
refresh();

/* ---------------------------------------------------------------------------
 * 按钮 1：复制全部到剪贴板
 * ------------------------------------------------------------------------- */
document.getElementById("copy").addEventListener("click", async () => {
  const lines = await getLines();
  if (lines.length === 0) {
    statusEl.textContent = "还没有收藏的单词";
    return;
  }
  // 需要 manifest 里的 "clipboardWrite" 权限（已经声明了）
  await navigator.clipboard.writeText(lines.join("\n"));
  statusEl.textContent = "已复制 ✓";
});

/* ---------------------------------------------------------------------------
 * 按钮 2：下载成 words.tsv
 * ---------------------------------------------------------------------------
 * 浏览器里没有「直接存文件」的 API，通用套路是：
 *   文本 → Blob → 临时 URL → 造一个 <a download> 模拟点击 → 再回收 URL
 * ------------------------------------------------------------------------- */
document.getElementById("download").addEventListener("click", async () => {
  const lines = await getLines();
  if (lines.length === 0) {
    statusEl.textContent = "还没有收藏的单词";
    return;
  }
  const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = "words.tsv"; // 这个属性让浏览器走「下载」而不是「跳转」
  document.body.appendChild(a); // 有些浏览器要求 a 在文档里才能 click
  a.click();
  a.remove();

  // 1 秒后释放内存，太早释放可能导致下载失败
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  statusEl.textContent = "已下载 ✓";
});

/* ---------------------------------------------------------------------------
 * 按钮 3：打开设置页（options.html）
 * ------------------------------------------------------------------------- */
document.getElementById("options").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});
