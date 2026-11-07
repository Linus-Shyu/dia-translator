/* ============================================================================
 * file-store.js —— 专门负责「把用户选的文件句柄存起来 / 取出来」
 * ----------------------------------------------------------------------------
 * 背景：options.js 里用 showSaveFilePicker 拿到的 FileSystemFileHandle
 *      不能存进 chrome.storage（那里只能放 JSON 能表示的数据，句柄不行），
 *      所以这里改用浏览器自带的 IndexedDB，它可以直接存对象。
 *
 * 这个文件被两个页面同时引入：
 *   - options.html：用户选文件时 saveFileHandle()
 *   - offscreen.html：真正写文件时 loadFileHandle()
 *
 * 下面这些都是 IndexedDB 的老式 API（事件回调风格），所以要用 Promise 包一层，
 * 这样调用方才能写 await loadFileHandle()。
 * ========================================================================== */

const DB_NAME = "transdia";   // 数据库名
const STORE_NAME = "handles"; // 库里的「表」名（IndexedDB 叫 object store）
const HANDLE_KEY = "wordsFile"; // 表里只放一条记录，用这个固定的 key

/* ---------------------------------------------------------------------------
 * openDB：打开（必要时创建）数据库
 * ---------------------------------------------------------------------------
 * indexedDB.open(名字, 版本号)。版本号第一次是 1；
 * 以后如果要改表结构，必须把版本号 +1，才会触发 onupgradeneeded。
 * ------------------------------------------------------------------------- */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    // 只在「第一次创建」或「升级版本」时触发，这里用来建表
    req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/* ---------------------------------------------------------------------------
 * saveFileHandle：写入 / 覆盖文件句柄
 * ---------------------------------------------------------------------------
 * put 是「有就覆盖、没有就新增」，正好适合这种「只记一个文件」的场景。
 * 注意 IndexedDB 的事务是异步的，要等 tx.oncomplete 才算真正写完。
 * ------------------------------------------------------------------------- */
async function saveFileHandle(handle) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(handle, HANDLE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ---------------------------------------------------------------------------
 * loadFileHandle：读回文件句柄，没有就返回 null
 * ---------------------------------------------------------------------------
 * req.result 在没记录时是 undefined，转成 null 让调用方用 if (!handle) 判断。
 * ------------------------------------------------------------------------- */
async function loadFileHandle() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(HANDLE_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
