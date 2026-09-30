// Shows a readable message instead of a blank page if the dashboard fails to start.
(function () {
  function show(msg) {
    var box = document.getElementById('content');
    if (!box || box.dataset.ok) return;
    box.innerHTML = '<div class="card"><h3>Job-AI could not start</h3><p class="muted">Please send this message to support:</p><pre class="ext-log"></pre></div>';
    box.querySelector('pre').textContent = String(msg);
  }
  window.addEventListener('error', function (e) { show((e.message || 'Error') + (e.filename ? '\n' + e.filename + ':' + e.lineno + ':' + e.colno : '') + (e.error && e.error.stack ? '\n' + e.error.stack : '')); });
  window.addEventListener('unhandledrejection', function (e) { var r = e.reason; show(r && r.stack ? r.stack : String(r)); });
  // If nothing has rendered after a few seconds, say so.
  setTimeout(function () { var b = document.getElementById('content'); if (b && !b.innerHTML.trim()) show('The dashboard did not load (no error was reported).'); }, 6000);
})();
