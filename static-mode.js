// 静态演示站专用：在 app.js 之前加载。
// 作用：标记只读模式、拦截需要后端（spawn 进程 / 写文件）的操作。
window.OPC_STATIC = true;

(function () {
  const BLOCKED = new Set([
    'start-script', 'render-now', 'rewrite', 'precheck', 'publish-real',
    'fetch-data', 'regen-topics',
    'fetch-hot', 'fetch-knowledge', 'save-cookie', 'clear-cookie',
    'save-schedule', 'run-schedule',
  ]);

  function note(msg) {
    const box = document.getElementById('toast');
    if (!box) return;
    const el = document.createElement('div');
    el.className = 'toast bad';
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || !BLOCKED.has(el.dataset.act)) return;
    e.preventDefault();
    e.stopPropagation();
    note(`静态演示站只读：请在本地运行 ./webui/start.sh 后再点「${el.textContent.trim()}」`);
  }, true);
})();
