/* ==========================================================================
   Direction board — theme switching + canvas map previews.
   ========================================================================== */
(function () {
  'use strict';

  var params = new URLSearchParams(window.location.search);
  var theme = params.get('theme') === 'light' ? 'light' : 'dark';

  function syncURL() {
    var q = new URLSearchParams();
    q.set('theme', theme);
    try {
      window.history.replaceState(null, '', location.pathname + '?' + q.toString());
    } catch (e) { /* file:// */ }
  }

  function setTheme(next) {
    theme = next === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', theme);

    var label = document.getElementById('boardThemeLabel');
    if (label) label.textContent = theme === 'dark' ? '深色' : '亮色';

    var btn = document.querySelector('[data-theme-toggle]');
    if (btn) {
      btn.setAttribute('aria-pressed', theme === 'light' ? 'true' : 'false');
      btn.setAttribute('aria-label', theme === 'dark' ? '切换主题（当前深色）' : '切换主题（当前亮色）');
    }

    syncURL();
    requestAnimationFrame(function () {
      if (window.TJVMap) window.TJVMap.drawAll();
    });
  }

  function init() {
    document.documentElement.setAttribute('data-theme', theme);

    var btn = document.querySelector('[data-theme-toggle]');
    if (btn) {
      btn.addEventListener('click', function () {
        setTheme(theme === 'dark' ? 'light' : 'dark');
      });
    }

    setTheme(theme);

    var timer = 0;
    window.addEventListener('resize', function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        if (window.TJVMap) window.TJVMap.drawAll();
      }, 120);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
