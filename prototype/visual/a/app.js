/* ==========================================================================
   Turbo JSON Viewer — Direction A prototype
   Visual-only script: renders the demo tree, search results rail, theme
   switching and the JSON map. No product logic, no network.
   ========================================================================== */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var SCREENS = ['main', 'empty', 'edit', 'expr', 'search'];
  var params = new URLSearchParams(window.location.search);
  var screen = SCREENS.indexOf(params.get('screen')) >= 0 ? params.get('screen') : 'main';
  var theme = params.get('theme') === 'light' ? 'light' : 'dark';
  var typecol = params.get('typecol') === '1';

  var TYPE_LABEL = {
    object: 'object',
    array: 'array',
    string: 'string',
    number: 'number',
    boolean: 'bool',
    null: 'null'
  };

  /* ------------------------------------------------------------------ */
  /* demo document rows                                                  */
  /* ------------------------------------------------------------------ */

  var TREE = [
    { d: 0, k: 'root', kind: 'object', open: true, items: 6 },

    { d: 1, k: 'meta', kind: 'object', open: false, items: 3,
      preview: '"source": "hotel_catalog.json", "exported_at": "2026-10-19T09:12:00+08:00", "version": 3' },
    { d: 1, k: 'data', kind: 'object', open: true, items: 4 },

    { d: 2, k: 'hotel_list', kind: 'array', open: true, items: 5000 },
    { d: 3, k: '[0]', idx: true, kind: 'object', open: false, items: 6,
      preview: '"id": "H-0000", "city": "三亚", "star": 5, "price": 1280' },
    { d: 3, k: '[1]', idx: true, kind: 'object', open: false, items: 6,
      preview: '"id": "H-0001", "city": "上海", "star": 4, "price": 960' },
    { d: 3, ellipsis: '省略 1,231 项（[2] … [1232]）' },
    { d: 3, k: '[1232]', idx: true, kind: 'object', open: false, items: 6,
      preview: '"id": "H-1232", "city": "成都", "star": 4, "price": 1180' },
    { d: 3, k: '[1233]', idx: true, kind: 'object', open: false, items: 7,
      preview: '"id": "H-1233", "city": "苏州", "star": 5, "price": 1520' },
    { d: 3, k: '[1234]', idx: true, kind: 'object', open: true, items: 10 },

    { d: 4, k: 'id', kind: 'string', value: '"H-1234"' },
    { d: 4, k: 'name', kind: 'string', value: '"杭州西湖国宾馆"' },
    { d: 4, k: 'city', kind: 'string', value: '"杭州"' },
    { d: 4, k: 'star', kind: 'number', value: '5' },
    { d: 4, k: 'tags', kind: 'array', open: false, items: 3,
      preview: '"湖景", "园林", "亲子"' },
    { d: 4, k: 'address', kind: 'object', open: false, items: 4,
      preview: '"district": "西湖区", "street": "杨公堤 18 号", "geo": {…}' },
    { d: 4, k: 'rating', kind: 'number', value: '4.8' },
    { d: 4, k: 'rooms', kind: 'array', open: true, items: 12 },
    { d: 5, k: '[0]', idx: true, kind: 'object', open: false, items: 6,
      preview: '"type": "高级大床房", "area": 42, "price": 1080' },
    { d: 5, k: '[1]', idx: true, kind: 'object', open: false, items: 6,
      preview: '"type": "豪华双床房", "area": 46, "price": 1280' },
    { d: 5, k: '[2]', idx: true, kind: 'object', open: false, items: 6,
      preview: '"type": "豪华湖景房", "area": 52, "price": 1680' },
    { d: 5, k: '[3]', idx: true, kind: 'object', open: false, items: 6,
      preview: '"type": "行政大床房", "area": 58, "price": 1980' },
    { d: 5, k: '[4]', idx: true, kind: 'object', open: false, items: 6,
      preview: '"type": "行政套房", "area": 62, "price": 2280' },
    { d: 5, k: '[5]', idx: true, kind: 'object', open: true, items: 8 },

    { d: 6, k: 'type', kind: 'string', value: '"湖景套房"' },
    { d: 6, k: 'price', kind: 'number', value: '2380', sel: true },
    { d: 6, k: 'base_price', kind: 'number', value: '2100' },
    { d: 6, k: 'area', kind: 'number', value: '68' },
    { d: 6, k: 'breakfast', kind: 'boolean', value: 'true' },
    { d: 6, k: 'left', kind: 'number', value: '3' },
    { d: 6, k: 'note', kind: 'null', value: 'null' },
    { d: 6, k: 'max_guests', kind: 'number', value: '2' },

    { d: 5, k: '[6]', idx: true, kind: 'object', open: false, items: 6,
      preview: '"type": "湖景家庭房", "area": 74, "price": 2680' },
    { d: 5, k: '[7]', idx: true, kind: 'object', open: false, items: 6,
      preview: '"type": "亲子主题房", "area": 70, "price": 2480' },
    { d: 5, k: '[8]', idx: true, kind: 'object', open: false, items: 6,
      preview: '"type": "湖景大床房", "area": 55, "price": 1880' },
    { d: 5, ellipsis: '省略 3 项（[9] … [11]）' },

    { d: 4, k: 'reviews', kind: 'object', open: false, items: 1284,
      preview: '"count": 1284, "avg": 4.8, "recent": [… ]' },
    { d: 4, k: 'updated_at', kind: 'string', value: '"2026-10-19T09:12:00+08:00"' },

    { d: 2, k: 'filters', kind: 'object', open: false, items: 6,
      preview: '"cities": […500], "stars": [3, 4, 5], "price_range": {…}' },
    { d: 2, k: 'stats', kind: 'object', open: false, items: 5,
      preview: '"total": 5000, "avg_price": 1246.5, "max_price": 12800' },
    { d: 2, k: 'pagination', kind: 'object', open: false, items: 3,
      preview: '"page": 1, "page_size": 5000, "next": null' },

    { d: 1, k: 'schema_version', kind: 'string', value: '"3.2"' },
    { d: 1, k: 'exported_at', kind: 'string', value: '"2026-10-19T09:12:00+08:00"' },
    { d: 1, ellipsis: '顶层还有 2 项（checksum、generator）' }
  ];

  var SEARCH_TERM = 'price';
  var isSearch = screen === 'search';

  /* ------------------------------------------------------------------ */
  /* helpers                                                             */
  /* ------------------------------------------------------------------ */

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function hl(text) {
    var safe = esc(text);
    if (!isSearch || !SEARCH_TERM) return safe;
    var re = new RegExp('(' + SEARCH_TERM.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
    return safe.replace(re, '<mark class="hl">$1</mark>');
  }

  function hasHit(row) {
    if (!isSearch || !SEARCH_TERM) return false;
    var hay = [row.k, row.value, row.preview, row.ellipsis].join(' ').toLowerCase();
    return hay.indexOf(SEARCH_TERM.toLowerCase()) >= 0;
  }

  var CHEV = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6.3 4.2 4 3.8-4 3.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var COPY = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.6" y="5.6" width="6.8" height="6.8" rx="1.3" fill="none" stroke="currentColor" stroke-width="1.25"/><path d="M10.4 5.6V4.3c0-.7-.6-1.3-1.3-1.3H4.3c-.7 0-1.3.6-1.3 1.3v4.8c0 .7.6 1.3 1.3 1.3h1.3" fill="none" stroke="currentColor" stroke-width="1.25"/></svg>';
  var PEN = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.7 3 13 5.3 6.6 11.7l-2.8.6.6-2.8L10.7 3Z" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/></svg>';
  var ACTIONS = '<span class="row__actions">' +
    '<button type="button" tabindex="-1" aria-label="复制子树 JSON">' + COPY + '</button>' +
    '<button type="button" tabindex="-1" aria-label="编辑此节点 JSON">' + PEN + '</button>' +
    '</span>';

  function valueHTML(row) {
    switch (row.kind) {
      case 'string':
        var v = String(row.value).replace(/^"|"$/g, '');
        return '<span class="tok-str"><span class="q">"</span>' + hl(v) + '<span class="q">"</span></span>';
      case 'number': return '<span class="tok-num">' + hl(row.value) + '</span>';
      case 'boolean': return '<span class="tok-bool">' + hl(row.value) + '</span>';
      case 'null': return '<span class="tok-null">null</span>';
      case 'array': return '<span class="tok-punct">[…]</span>';
      default: return '<span class="tok-punct">{…}</span>';
    }
  }

  function depthAttrs(row, selected) {
    return 'role="treeitem" aria-level="' + (row.d + 1) + '"' +
      ' aria-selected="' + (selected ? 'true' : 'false') + '"' +
      (selected ? ' tabindex="0"' : ' tabindex="-1"');
  }

  function guides(d) {
    var out = '';
    for (var i = 0; i < d; i++) out += '<i></i>';
    return '<span class="row__guides" aria-hidden="true">' + out + '</span>';
  }

  function rowHTML(row) {
    if (row.ellipsis) {
      return '<div class="row row--ellipsis" ' + depthAttrs(row, false) + '>' +
        guides(row.d) +
        '<span class="row__caret is-leaf" aria-hidden="true"></span>' +
        '<span class="row__ellipsis-text">…&nbsp;&nbsp;' + esc(row.ellipsis) + '</span>' +
        '</div>';
    }

    var isContainer = row.kind === 'object' || row.kind === 'array';
    var hit = hasHit(row);
    var cls = 'row' + (row.sel ? ' is-selected' : '') + (hit ? ' is-hit' : '');

    var caret = isContainer
      ? '<span class="row__caret' + (row.open ? ' is-open' : '') + '" aria-hidden="true">' + CHEV + '</span>'
      : '<span class="row__caret is-leaf" aria-hidden="true"></span>';

    var key = row.idx
      ? '<span class="row__key row__key--idx">' + hl(row.k) + '</span>'
      : '<span class="row__key">' + hl(row.k) + '</span>';

    var count = '';
    if (isContainer) {
      count = row.kind === 'array'
        ? '<span class="row__count row__count--arr">[' + row.items + ']</span>'
        : '<span class="row__count">' + row.items + ' 项</span>';
    }

    var preview = row.preview
      ? '<span class="row__preview">' + hl(row.preview) + '</span>'
      : '';

    var expanded = isContainer ? ' aria-expanded="' + (!!row.open) + '"' : '';

    var typeCol = typecol
      ? '<span class="row__type">' + (TYPE_LABEL[row.kind] || '') + '</span>'
      : '';

    return '<div class="' + cls + '" ' + depthAttrs(row, !!row.sel) + expanded + '>' +
      guides(row.d) +
      caret +
      key +
      '<span class="row__colon" aria-hidden="true">:</span>' +
      '<span class="row__value">' + valueHTML(row) + '</span>' +
      count + preview +
      typeCol +
      ACTIONS +
      '</div>';
  }

  function renderTree() {
    var body = $('treeBody');
    if (!body) return;
    body.innerHTML = TREE.map(rowHTML).join('');

    var tree = $('tree');
    var sel = body.querySelector('.row.is-selected');
    if (!tree || !sel) return;
    requestAnimationFrame(function () {
      var tr = tree.getBoundingClientRect();
      var sr = sel.getBoundingClientRect();
      if (sr.bottom > tr.bottom - 12) {
        tree.scrollTop += sr.bottom - tr.bottom + 44;
        var pad = 5;
        tree.scrollTop = Math.max(0, Math.round((tree.scrollTop - pad) / 24) * 24 + pad);
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* search results (virtual list)                                       */
  /* ------------------------------------------------------------------ */

  var TOTAL = 37189;
  var ROW_H = 44;
  var WINDOW = 16;
  var selectedResult = 0;
  var curStart = 0;

  var RESULT_VARIANTS = [
    function (h, r) { return { path: 'data.hotel_list[' + h + '].rooms[' + r + '].price', value: '2380', kind: 'number', seg: 'price' }; },
    function (h, r) { return { path: 'data.hotel_list[' + h + '].rooms[' + r + '].price_note', value: '"含税价 · 含双早"', kind: 'string', seg: 'price_note' }; },
    function (h, r) { return { path: 'data.hotel_list[' + h + '].rooms[' + r + '].base_price', value: '2100', kind: 'number', seg: 'base_price' }; },
    function (h) { return { path: 'data.hotel_list[' + h + '].price', value: '1280', kind: 'number', seg: 'price' }; },
    function (h, r) { return { path: 'data.hotel_list[' + h + '].rooms[' + r + '].price_history[1]', value: '1890', kind: 'number', seg: 'price_history' }; },
    function (h) { return { path: 'data.hotel_list[' + h + '].tags[2]', value: '"price/quality"', kind: 'string', seg: 'price' }; },
    function (h, r) { return { path: 'data.hotel_list[' + h + '].rooms[' + r + '].price', value: '2680', kind: 'number', seg: 'price' }; },
    function (h) { return { path: 'meta.price_currency', value: '"CNY"', kind: 'string', seg: 'price_currency' }; }
  ];

  function resultAt(i) {
    if (i === 0) {
      return { path: 'data.hotel_list[1234].rooms[5].price', value: '2380', kind: 'number', seg: 'price' };
    }
    var hotel = (482 + i * 137) % 5000;
    var room = (i * 3 + 5) % 12;
    var v = RESULT_VARIANTS[i % RESULT_VARIANTS.length];
    return v(hotel, room);
  }

  function pathHTML(obj) {
    var before = obj.path.slice(0, obj.path.lastIndexOf('.') + 1);
    var tail = obj.path.slice(obj.path.lastIndexOf('.') + 1);
    return esc(before) + '<mark class="hl">' + esc(tail) + '</mark>';
  }

  function resultNode(i) {
    var r = resultAt(i);
    var kindCls = r.kind === 'string' ? ' is-str' : '';
    return '<div class="result' + (i === selectedResult ? ' is-selected' : '') + '"' +
      ' data-index="' + i + '" role="option" aria-selected="' + (i === selectedResult) + '"' +
      ' style="top:' + ((i - curStart) * ROW_H) + 'px">' +
      '<div class="result__path">' + pathHTML(r) + '</div>' +
      '<div class="result__meta">' +
      '<span class="result__value' + kindCls + '">' + esc(r.value) + '</span>' +
      '<span class="result__kind">' + r.kind + '</span>' +
      '<span>键名匹配 · ' + (r.value.indexOf('"') === 0 ? '值命中' : '数值命中') + '</span>' +
      '</div></div>';
  }

  function renderResultsWindow(force) {
    var scroll = $('resultsScroll');
    if (!scroll) return;
    var start = Math.max(0, Math.min(TOTAL - WINDOW, Math.floor(scroll.scrollTop / ROW_H)));
    if (!force && start === curStart) return;
    curStart = start;
    var frag = '';
    var end = Math.min(TOTAL, start + WINDOW);
    for (var i = start; i < end; i++) frag += resultNode(i);
    var win = $('resultsWindow');
    var spacer = $('resultsSpacer');
    win.style.top = (start * ROW_H) + 'px';
    if (spacer) spacer.style.height = (TOTAL * ROW_H) + 'px';
    win.innerHTML = frag;
    var rendered = $('resultsRendered');
    if (rendered) rendered.textContent = String(end - start);
  }

  function scrollResultIntoView(select) {
    var scroll = $('resultsScroll');
    if (!scroll) return;
    scroll.scrollTop = Math.max(0, select * ROW_H - scroll.clientHeight / 2 + ROW_H / 2);
    curStart = -1;
    renderResultsWindow(true);
  }

  function selectResult(i) {
    selectedResult = ((i % TOTAL) + TOTAL) % TOTAL;
    var r = resultAt(selectedResult);
    var status = $('statusPath');
    if (status) {
      status.textContent = r.path;
      status.setAttribute('title', r.path);
    }
    scrollResultIntoView(selectedResult);
  }

  function initResults() {
    var scroll = $('resultsScroll');
    if (!scroll) return;
    var spacer = $('resultsSpacer');
    if (spacer) spacer.style.height = (TOTAL * ROW_H) + 'px';
    scroll.addEventListener('scroll', function () { renderResultsWindow(false); });
    scroll.addEventListener('click', function (e) {
      var el = e.target.closest('.result');
      if (!el) return;
      selectResult(parseInt(el.getAttribute('data-index'), 10) || 0);
    });
    var prev = $('searchPrev');
    var next = $('searchNext');
    if (prev) prev.addEventListener('click', function () { selectResult(selectedResult - 1); });
    if (next) next.addEventListener('click', function () { selectResult(selectedResult + 1); });
    renderResultsWindow(true);
  }

  /* ------------------------------------------------------------------ */
  /* theme + screen                                                      */
  /* ------------------------------------------------------------------ */

  function syncURL() {
    var q = new URLSearchParams();
    q.set('screen', screen);
    q.set('theme', theme);
    if (typecol) q.set('typecol', '1');
    try {
      window.history.replaceState(null, '', location.pathname + '?' + q.toString());
    } catch (e) { /* file:// */ }
  }

  function setTheme(next, updateURL) {
    theme = next === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', theme);
    var label = $('themeLabel');
    if (label) label.textContent = theme === 'dark' ? '深色' : '亮色';
    var btn = document.querySelector('[data-theme-toggle]');
    if (btn) {
      btn.setAttribute('aria-pressed', theme === 'light' ? 'true' : 'false');
      btn.setAttribute('aria-label', theme === 'dark' ? '切换主题（当前深色）' : '切换主题（当前亮色）');
    }
    if (updateURL !== false) syncURL();
    requestAnimationFrame(function () {
      if (window.TJVMap) window.TJVMap.drawAll();
    });
  }

  function setScreen(next) {
    screen = SCREENS.indexOf(next) >= 0 ? next : 'main';
    isSearch = screen === 'search';
    document.body.setAttribute('data-screen', screen);
    syncURL();
    renderTree();
    if (isSearch) {
      initResults();
      requestAnimationFrame(function () {
        scrollResultIntoView(selectedResult);
        if (window.TJVMap) window.TJVMap.drawAll();
      });
    } else {
      requestAnimationFrame(function () {
        if (window.TJVMap) window.TJVMap.drawAll();
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /* init                                                                */
  /* ------------------------------------------------------------------ */

  function init() {
    document.documentElement.setAttribute('data-theme', theme);
    document.body.setAttribute('data-screen', screen);
    if (typecol) document.body.classList.add('has-typecol');

    var toggle = document.querySelector('[data-theme-toggle]');
    if (toggle) toggle.addEventListener('click', function () { setTheme(theme === 'dark' ? 'light' : 'dark'); });

    var mapToggle = $('mapToggle');
    var mapPanel = $('mapPanel');
    if (mapToggle && mapPanel) {
      mapToggle.addEventListener('click', function () {
        var collapsed = mapPanel.classList.toggle('is-collapsed');
        mapToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        mapToggle.setAttribute('aria-label', collapsed ? '展开 JSON 地图' : '折叠 JSON 地图');
        requestAnimationFrame(function () {
          if (!collapsed && window.TJVMap) window.TJVMap.draw($('mapCanvas'), window.TJVMap.trail);
        });
      });
    }

    var dismiss = document.querySelector('[data-dismiss-banner]');
    if (dismiss) {
      dismiss.addEventListener('click', function () {
        var banner = document.querySelector('.banner');
        if (banner) banner.remove();
      });
    }

    document.querySelectorAll('[data-nav]').forEach(function (el) {
      el.addEventListener('click', function () { setScreen(el.getAttribute('data-nav')); });
    });

    if (screen !== 'empty') renderTree();
    if (isSearch) initResults();

    setTheme(theme, false);
    requestAnimationFrame(function () {
      if (screen !== 'empty' && window.TJVMap) window.TJVMap.drawAll();
    });

    var resizeTimer = 0;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        if (screen !== 'empty' && window.TJVMap) window.TJVMap.drawAll();
      }, 120);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
