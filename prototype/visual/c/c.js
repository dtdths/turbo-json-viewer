/* ==========================================================================
   Direction C — 工作台：活动栏 / 左侧面板 / 右侧工作区的接线
   A 的 app.js 负责屏幕、树、搜索结果、主题、地图；这里只补 C 的结构状态。
   ========================================================================== */
(function () {
  'use strict';

  var body = document.body;
  var params = new URLSearchParams(window.location.search);
  var $ = function (sel) { return document.querySelector(sel); };

  var TITLES = { search: '搜索', outline: '大纲', settings: '设置' };
  var PANELS = ['search', 'outline', 'settings'];

  // A's app.js binds every [data-nav]; the hidden buttons are our screen seam.
  function nav(screen) {
    var btn = document.querySelector('[data-nav="' + screen + '"]');
    if (btn) btn.click();
  }

  function setPanel(name) {
    body.setAttribute('data-panel', name);
    var title = $('#panelTitle');
    if (title) title.textContent = TITLES[name] || '文档树';
    var btns = document.querySelectorAll('[data-panel-btn]');
    for (var i = 0; i < btns.length; i++) {
      var n = btns[i].getAttribute('data-panel-btn');
      var active = n === name || (n === 'doc' && name === 'none');
      btns[i].classList.toggle('is-active', active);
    }
  }

  var bound = document.querySelectorAll('[data-panel-btn]');
  for (var b = 0; b < bound.length; b++) {
    bound[b].addEventListener('click', function () {
      var name = this.getAttribute('data-panel-btn');

      if (name === 'doc') { nav('main'); setPanel('none'); return; }

      if (name === 'expr') {
        var open = body.getAttribute('data-screen') === 'expr';
        nav(open ? 'main' : 'expr');
        setPanel(open ? 'none' : 'expr');
        return;
      }

      if (name === 'search') { nav('search'); setPanel('search'); return; }

      // outline / settings keep the tree as the main view
      if (body.getAttribute('data-screen') !== 'main') nav('main');
      setPanel(name);
    });
  }

  var close = document.querySelector('[data-panel-close]');
  if (close) close.addEventListener('click', function () { nav('main'); setPanel('none'); });

  /* ---------- rail collapse (two toggles must stay in sync) ---------- */

  var railToggles = [document.getElementById('railToggle'), document.getElementById('railToggleTop')];

  function syncRail(afterCollapse) {
    var collapsed = body.classList.contains('rail-collapsed');
    for (var i = 0; i < railToggles.length; i++) {
      var t = railToggles[i];
      if (!t) continue;
      t.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      t.setAttribute('aria-pressed', collapsed ? 'false' : 'true');
      t.setAttribute('aria-label', collapsed ? '展开右侧工作区' : '折叠右侧工作区');
    }
    if (afterCollapse !== false) {
      requestAnimationFrame(function () { if (window.TJVMap) window.TJVMap.drawAll(); });
    }
  }

  for (var r = 0; r < railToggles.length; r++) {
    if (!railToggles[r]) continue;
    railToggles[r].addEventListener('click', function () {
      body.classList.toggle('rail-collapsed');
      syncRail();
    });
  }

  /* the activity-bar theme button IS the [data-theme-toggle] A's app.js binds */

  // initial state: ?panel= wins, otherwise derive from ?screen=
  var initial = params.get('panel');
  if (!initial) {
    var screen = params.get('screen') || 'main';
    if (screen === 'search') initial = 'search';
    else if (screen === 'expr') initial = 'expr';
  }
  if (!initial || (initial !== 'expr' && PANELS.indexOf(initial) === -1)) {
    setPanel('none');
  } else {
    setPanel(initial);
  }

  if (params.get('rail') === '0') body.classList.add('rail-collapsed');
  syncRail(false);
})();
