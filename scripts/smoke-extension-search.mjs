/**
 * scripts/smoke-extension-search.mjs — 真实 unpacked 扩展验收：搜索（slice 4）+ 导入层交互回归。
 *
 *   node scripts/smoke-extension-search.mjs [sample]
 *   （dist 由 Lead 构建并冻结；本脚本不 build）
 *
 * 搜索流程（全部走真实 UI，不经 dev hook）：
 *   1. 以真实 unpacked 扩展（`--load-extension dist`）打开 page.html；
 *   2. 断言扩展上下文没有 `window.__tjv`（dev hook 只在 HTTP 下挂）；
 *   3. 初始空态粘贴 10MB（synthetic ClipboardEvent + DataTransfer）→ 导入层隐藏；
 *   4. 点活动栏打开搜索面板；搜索输入框内粘贴不触发全局导入；
 *   5. 真实 input `hotel` → 等 `#searchCount`（capped 50,000+）→ 校验结果列表/字段/highlight；
 *   6. Enter 跳转 → 树 `.row.is-current`；清空输入 → 空态；截图；0 console 错误。
 *
 * 导入层交互回归（grill-with-docs 收口：Q8=A′ / Q9=A / Q10=A / Q11=B / Q12=A / Q13=A）：
 *   - 文档已打开 + 层关闭：body/树粘贴合法 JSON **不导入**（defaultPrevented=false、文档不变）；
 *   - replace 层入口：`#importBtn` / `#fileChip` / `⌘O`；层结构：`data-mode="replace"`、
 *     `#emptyTitle`「打开新文档」、`#emptyWarn` 含当前文档名、`role=dialog`+`aria-modal`、
 *     不盖住工具栏、背景半透明；
 *   - 取消：`#emptyClose` / `Escape` → 层隐藏、文档完全不变；
 *   - 层内粘贴合法 JSON → 立即替换（`#fileName`≈剪贴板.json）+ 层隐藏；
 *   - 层内 drop 文件 → 直接导入（无二次确认）；
 *   - 层内粘贴非法文本 `min_price_` → 层保持打开、`#emptyError` 含 PARSE、原文档不变；
 *   - 外部 drop → `#emptyPending` 二次确认（文档不变）→ Esc 取消不导入 → 再次 drop +
 *     `#pendingReplace` 才替换；
 *   - 截图 `.spike/smoke/extension-import-layer.png`、`extension-import-layer-error.png`。
 *
 * 命中数口径：历史基准（docs/design/qa-editing-and-search.md §2.3 已注记）37,189 =
 * uncapped 键名命中数；当前 10MB 样本按 core/search.ts 语义 raw 74,378（37,189 key + 37,189 value）
 * → 上限 50,000 截断（UI `50,000+`）。脚本用 Node 侧 reference（与 core/search.ts 同语义、
 * capped + uncapped raw）算期望值，历史基准仅作 warning 记录。
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { extensionUrl, launchChrome, REPO_ROOT } from '../prototype/p1/lib/chrome.mjs';
import { startStaticServer } from '../prototype/p1/lib/http.mjs';

/* ------------------------------------------------------------------ config */

const SAMPLE = process.argv[2] || '.spike/samples/10mb.json';
const TERM = 'hotel';
const ROW_HEIGHT = 44;
const SEARCH_LIMIT = 50_000;
/** 历史基准（旧口径）：docs/design/qa-editing-and-search.md §2.3 已注记（= uncapped 键名命中数）。 */
const LEGACY_BASELINE_HITS = 37_189;
/** 当前口径（供文档复算）：capped 50,000 / uncapped raw 74,378。 */
const DOCUMENTED_HITS = { bigHotelCapped: 50_000, bigHotelRaw: 74_378 };
const DIST = path.join(REPO_ROOT, 'dist');
const SHOTS = path.join(REPO_ROOT, '.spike', 'smoke');
const OK = '✅';
const BAD = '❌';

await mkdir(SHOTS, { recursive: true });

/* ------------------------------------------------- reference hit counting */

/**
 * 与 `src/core/search.ts` 相同的 walk 语义（键名优先、大小写不敏感、上限截断）。
 * `limit = Infinity` 时统计 uncapped raw。
 */
function analyzeHits(value, query, limit = SEARCH_LIMIT) {
  const out = { total: 0, key: 0, value: 0, truncated: false };
  if (!query) return out;
  const uncapped = limit === Infinity;
  if (!uncapped && (!Number.isFinite(limit) || limit <= 0)) return out;
  const needle = query.toLowerCase();
  const matches = (text) => text.toLowerCase().includes(needle);
  const stack = [[value, 'root', false, true]];
  while (stack.length > 0) {
    const [node, key, isIdx, isRoot] = stack.pop();
    let field = null;
    if (!isIdx && !isRoot && matches(key)) field = 'key';
    else if (typeof node === 'string' && matches(node)) field = 'value';
    if (field !== null) {
      out.total += 1;
      out[field] += 1;
      if (out.total >= limit) {
        out.truncated = true;
        break;
      }
    }
    if (node === null || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) stack.push([node[i], '[' + i + ']', true, false]);
    } else {
      const keys = Object.keys(node);
      for (let i = keys.length - 1; i >= 0; i--) {
        const k = keys[i];
        stack.push([node[k], k, false, false]);
      }
    }
  }
  return out;
}

function formatCount(value) {
  return Math.max(0, Math.trunc(value)).toLocaleString('en-US');
}

/* ------------------------------------------------------- report primitives */

const checks = [];
const warnings = [];
const metrics = {};
const fatal = [];

function check(name, pass, detail) {
  checks.push({ name, pass: Boolean(pass), detail });
  return Boolean(pass);
}
function warn(name, detail) {
  warnings.push({ name, detail });
}
function digits(text) {
  const m = /([\d,]+)/.exec(String(text == null ? '' : text));
  return m ? Number(m[1].replace(/,/g, '')) : null;
}
function maxLongTask(tasks) {
  return (tasks || []).reduce((max, t) => Math.max(max, t.d || 0), 0);
}

/* ======================= page-side (stringified) helpers ================== */

/** 安装 window.__extSmoke（长任务 observer + 等待 + DOM 快照）。 */
async function extSetup() {
  const toNum = (text) => {
    const m = /([\d,]+)/.exec(String(text == null ? '' : text));
    return m ? Number(m[1].replace(/,/g, '')) : null;
  };
  const smoke = {
    longTasks: [],
    observer: false,
    reset() {
      smoke.longTasks.length = 0;
    },
    take() {
      const list = smoke.longTasks.slice();
      smoke.longTasks.length = 0;
      return list;
    },
    settle(ms = 120) {
      return new Promise((r) => setTimeout(r, ms));
    },
    async waitUntil(fn, timeoutMs = 10000, stepMs = 20) {
      const deadline = performance.now() + timeoutMs;
      while (performance.now() < deadline) {
        try {
          if (fn()) return true;
        } catch {
          /* keep polling */
        }
        await new Promise((r) => setTimeout(r, stepMs));
      }
      return false;
    },
    visibleResults() {
      return [...document.querySelectorAll('.result')].filter(
        (el) => !el.hidden && el.getClientRects().length > 0,
      );
    },
    dom() {
      const q = (sel) => document.querySelector(sel);
      const visible = smoke.visibleResults();
      const scroll = document.getElementById('resultsScroll') || q('.results__scroll');
      const spacer = q('.results__spacer');
      const emptyEl = q('.results__empty');
      const footEl = document.getElementById('resultsFoot') || q('.results__foot');
      const countEl = document.getElementById('searchCount');
      const posEl = document.getElementById('searchPos');
      const prev = document.getElementById('searchPrev');
      const next = document.getElementById('searchNext');
      const filters = [...document.querySelectorAll('.filter')].map((b) => ({
        filter: b.dataset.filter || null,
        on: b.classList.contains('is-on'),
        pressed: b.getAttribute('aria-pressed'),
        count: (b.querySelector('.filter__count') || {}).textContent || '',
      }));
      const selected = document.querySelector('.result.is-selected');
      // 树行池 hidden 行可能残留旧文本（display:none，不可见）；
      // review 修复的判据按「可见行」：可见 mark 只允许出现在 .row.is-hit 行。
      const visibleTreeRows = [...document.querySelectorAll('.row')].filter(
        (row) => !row.hidden && row.getClientRects().length > 0,
      );
      const treeVisibleMarks = visibleTreeRows.reduce(
        (n, row) => n + row.querySelectorAll('mark').length,
        0,
      );
      const treeVisibleHitMarks = visibleTreeRows.reduce(
        (n, row) => n + (row.classList.contains('is-hit') ? row.querySelectorAll('mark').length : 0),
        0,
      );
      return {
        countText: countEl ? countEl.textContent.trim() : null,
        posText: posEl ? posEl.textContent.trim() : null,
        footText: footEl ? footEl.textContent.trim() : null,
        footHidden: footEl ? footEl.hidden : null,
        footRendered: toNum((document.getElementById('resultsRendered') || {}).textContent),
        footTotal: toNum((document.getElementById('resultsTotal') || {}).textContent),
        emptyText: emptyEl ? emptyEl.textContent.trim() : null,
        emptyVisible: emptyEl ? !emptyEl.hidden && emptyEl.getClientRects().length > 0 : false,
        visibleRows: visible.length,
        totalRows: document.querySelectorAll('.result').length,
        resultFirstIndex: visible.length ? Number(visible[0].dataset.index) : null,
        resultLastIndex: visible.length ? Number(visible[visible.length - 1].dataset.index) : null,
        resultPaths: visible.slice(0, 8).map((el) => el.dataset.path || null),
        /** review 新增：结果行字段标签（键名 / 值） */
        fieldTexts: visible.slice(0, 24).map((el) => {
          const node = el.querySelector('.result__field');
          return node ? node.textContent.trim() : null;
        }),
        firstFieldText: (() => {
          const el = visible[0];
          if (!el) return null;
          const node = el.querySelector('.result__field');
          return node ? node.textContent.trim() : null;
        })(),
        fieldCount: visible.filter((el) => Boolean(el.querySelector('.result__field'))).length,
        anyMark: Boolean(document.querySelector('.result mark.result__hit')),
        pathMarks: visible.filter((el) => el.querySelector('.result__path mark.result__hit')).length,
        valueMarks: visible.filter((el) => el.querySelector('.result__value mark.result__hit')).length,
        selectedRow: Boolean(selected),
        selectedIndex: selected ? Number(selected.dataset.index) : null,
        treeCurrent: Boolean(document.querySelector('.row.is-current')),
        treeHitRows: document.querySelectorAll('.row.is-hit').length,
        treeHitMarks: document.querySelectorAll('.row.is-hit mark').length,
        /** review 修复：可见 mark 只允许出现在 .row.is-hit 行 */
        treeMarks: document.querySelectorAll('.row mark').length,
        treeVisibleMarks,
        treeVisibleHitMarks,
        treeMarksOutsideHitRows: treeVisibleMarks - treeVisibleHitMarks,
        treeMarksHidden: document.querySelectorAll('.row mark').length - treeVisibleMarks,
        spacerHeight: spacer ? Math.round(spacer.getBoundingClientRect().height * 100) / 100 : null,
        scrollTop: scroll ? Math.round(scroll.scrollTop) : null,
        scrollHeight: scroll ? Math.round(scroll.scrollHeight) : null,
        clientHeight: scroll ? Math.round(scroll.clientHeight) : null,
        prevDisabled: prev ? prev.disabled : null,
        nextDisabled: next ? next.disabled : null,
        filters,
        activeFilter: (filters.find((f) => f.on) || {}).filter || null,
      };
    },
    statusPath() {
      const node = document.getElementById('statusPath');
      return node ? node.textContent.trim() : '';
    },
    /** 导入层 DOM/几何/半透明度快照（contract: #empty[data-mode] / #emptyWarn / #emptyError / #emptyPending）。 */
    layer() {
      const q = (sel) => document.querySelector(sel);
      const empty = document.getElementById('empty');
      const toolbar = q('.toolbar');
      const warn = document.getElementById('emptyWarn');
      const title = document.getElementById('emptyTitle');
      const closeBtn = document.getElementById('emptyClose');
      const errorEl = document.getElementById('emptyError');
      const pending = document.getElementById('emptyPending');
      // 契约名为 #pendingReplace；实现用 #emptyPendingReplace（与 emptyPending 同前缀）。
      // 两者都接受，Node 侧在命中别名时告警，避免把命名偏差当成功能失败。
      const pendingReplace =
        document.getElementById('pendingReplace') || document.getElementById('emptyPendingReplace');
      const shown = (el) => Boolean(el) && !el.hidden && el.getClientRects().length > 0;
      const alphaOf = (color) => {
        const m = /rgba?\(([^)]+)\)/.exec(String(color || ''));
        if (!m) return null;
        const parts = m[1].split(',').map((s) => s.trim());
        return parts.length >= 4 ? Number(parts[3]) : 1;
      };
      const style = empty ? getComputedStyle(empty) : null;
      const rect = empty ? empty.getBoundingClientRect() : null;
      const toolbarRect = toolbar ? toolbar.getBoundingClientRect() : null;
      return {
        exists: Boolean(empty),
        visible: shown(empty),
        classIsHidden: empty ? empty.classList.contains('is-hidden') : null,
        mode: empty ? empty.dataset.mode || null : null,
        titleText: title ? title.textContent.trim() : null,
        warnVisible: shown(warn),
        warnText: warn ? warn.textContent.trim() : null,
        closeVisible: shown(closeBtn),
        role: empty ? empty.getAttribute('role') : null,
        ariaModal: empty ? empty.getAttribute('aria-modal') : null,
        errorVisible: shown(errorEl),
        errorText: errorEl ? errorEl.textContent.trim() : null,
        pendingVisible: shown(pending),
        pendingText: pending ? pending.textContent.trim() : null,
        pendingReplaceVisible: shown(pendingReplace),
        layerTop: rect ? Math.round(rect.top) : null,
        layerHeight: rect ? Math.round(rect.height) : null,
        toolbarBottom: toolbarRect ? Math.round(toolbarRect.bottom) : null,
        background: style ? style.backgroundColor : null,
        backgroundAlpha: style ? alphaOf(style.backgroundColor) : null,
        backdropFilter: style ? style.backdropFilter || style.webkitBackdropFilter || null : null,
      };
    },
    /** 文档态快照：导入是否发生以此为准。 */
    docState() {
      const name = document.getElementById('fileName');
      const status = document.getElementById('statusRows');
      const path = document.getElementById('statusPath');
      const toast = document.getElementById('toast');
      const rows = [...document.querySelectorAll('.row[data-path]:not([hidden])')];
      const chip = document.getElementById('fileChip');
      return {
        fileName: name ? name.textContent.trim() : null,
        statusRows: status ? status.textContent.trim() : null,
        statusPath: path ? path.textContent.trim() : null,
        visibleRows: rows.length,
        fileChipHidden: chip ? chip.hidden : null,
        toastHidden: toast ? toast.hidden : null,
        toastText: toast ? toast.textContent.trim() : null,
        activeId: document.activeElement ? document.activeElement.id || document.activeElement.tagName : null,
      };
    },
    /** 合成粘贴（target: 'document' | 'body'），返回 defaultPrevented。 */
    pasteText(text, target) {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      const node = target === 'body' ? document.body : document;
      node.dispatchEvent(ev);
      return { defaultPrevented: ev.defaultPrevented };
    },
    /** 合成文件拖放（where: 'window' = 外部拖放 / 'layer' = 层内拖放）。 */
    dropFile(fileName, text, where) {
      const dt = new DataTransfer();
      dt.items.add(new File([text], fileName, { type: 'application/json' }));
      const ev = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
      if (where === 'layer') {
        const zone = document.getElementById('dropzone') || document.getElementById('empty');
        if (!zone) return { dispatched: false, defaultPrevented: false, error: 'layer drop target missing' };
        zone.dispatchEvent(ev);
      } else {
        window.dispatchEvent(ev);
      }
      return { dispatched: true, defaultPrevented: ev.defaultPrevented };
    },
    pressKey(key, extra) {
      const init = Object.assign({ key, code: key === 'Escape' ? 'Escape' : 'KeyO', bubbles: true, cancelable: true }, extra || {});
      const ev = new KeyboardEvent('keydown', init);
      document.dispatchEvent(ev);
      return { defaultPrevented: ev.defaultPrevented };
    },
  };

  try {
    const po = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        smoke.longTasks.push({ d: Math.round(entry.duration), at: Math.round(entry.startTime) });
      }
    });
    po.observe({ entryTypes: ['longtask'] });
    smoke.observer = true;
  } catch {
    smoke.observer = false;
  }
  window.__extSmoke = smoke;

  return {
    hasChromeRuntime: Boolean(globalThis.chrome && chrome.runtime && chrome.runtime.id),
    hasDevHook: Boolean(window.__tjv),
    observer: smoke.observer,
    bodyPanel: document.body.dataset.panel || null,
    layer: smoke.layer(),
    dom: smoke.dom(),
  };
}

/** 真实粘贴入口：10MB 文本 → ClipboardEvent，然后点活动栏打开搜索面板。 */
async function extImportPhase(cfg) {
  const out = {};
  const text = await (await fetch(cfg.url)).text();
  out.sampleBytes = text.length;
  out.hasDevHookBefore = Boolean(window.__tjv);
  const dt = new DataTransfer();
  dt.setData('text/plain', text);
  const t0 = performance.now();
  document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt }));
  out.rowsAppeared = await window.__extSmoke.waitUntil(
    () => document.querySelectorAll('.row[data-path]:not([hidden])').length > 0,
    30000,
  );
  out.firstRowMs = Math.round(performance.now() - t0);
  await window.__extSmoke.settle(450);
  out.rows = document.querySelectorAll('.row[data-path]:not([hidden])').length;
  out.statusRows = (document.getElementById('statusRows') || {}).textContent || '';
  out.bodyPanelAfterPaste = document.body.dataset.panel || null;

  const btn = document.querySelector('[data-panel-btn="search"]');
  out.hasSearchButton = Boolean(btn);
  if (btn) btn.click();
  out.panelOpen = await window.__extSmoke.waitUntil(() => {
    const host = document.getElementById('searchPanel');
    const input = document.getElementById('searchInput');
    return Boolean(host) && host.offsetHeight > 0 && Boolean(input);
  }, 5000);
  await window.__extSmoke.settle(120);
  out.dom = window.__extSmoke.dom();
  out.layerAfterPaste = window.__extSmoke.layer();
  out.docAfterPaste = window.__extSmoke.docState();
  out.hasDevHook = Boolean(window.__tjv);
  out.longTasks = window.__extSmoke.take();
  return out;
}

/** 回归（2026-10-30）：在搜索输入框里粘贴普通文本（key 片段）不应触发全局 JSON 导入。 */
async function extPasteInputPhase(cfg) {
  const out = {};
  const input = document.getElementById('searchInput');
  if (!input) return { error: '#searchInput missing' };
  out.rowsBefore = document.querySelectorAll('.row[data-path]:not([hidden])').length;
  out.statusBefore = (document.getElementById('statusRows') || {}).textContent || '';
  input.focus();
  out.focusedBefore = document.activeElement === input;
  const dt = new DataTransfer();
  dt.setData('text/plain', cfg.text || 'min_price_');
  const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
  window.__extSmoke.reset();
  input.dispatchEvent(ev);
  await window.__extSmoke.settle(800);
  const toast = document.getElementById('toast');
  out.defaultPrevented = ev.defaultPrevented;
  out.toastHidden = toast ? toast.hidden : true;
  out.toastText = toast ? toast.textContent : '';
  out.rowsAfter = document.querySelectorAll('.row[data-path]:not([hidden])').length;
  out.statusAfter = (document.getElementById('statusRows') || {}).textContent || '';
  out.activeIsInput = document.activeElement === input;
  out.hasDevHook = Boolean(window.__tjv);
  out.longTasks = window.__extSmoke.take();
  // 说明：合成 ClipboardEvent 不会执行浏览器默认插入（只有可信事件才会），
  // 所以这里断言「全局 handler 没有 preventDefault / 没有触发导入」，而不是输入框内容。
  return out;
}

/** 真实输入（input 事件）→ 等命中数 → 校验列表 → Enter 跳转。 */
async function extSearchPhase(cfg) {
  const out = {};
  const input = document.getElementById('searchInput');
  if (!input) return { error: '#searchInput missing' };
  out.inputType = input.type;
  input.focus();
  window.__extSmoke.reset();
  input.value = cfg.term;
  const t0 = performance.now();
  input.dispatchEvent(new Event('input', { bubbles: true }));
  out.expectedReached = await window.__extSmoke.waitUntil(() => {
    const el = document.getElementById('searchCount');
    const txt = el ? el.textContent.trim() : '';
    return cfg.expectedCounts.indexOf(txt) >= 0 && window.__extSmoke.visibleResults().length > 0;
  }, cfg.countTimeoutMs || 10000, 50);
  out.countMs = Math.round(performance.now() - t0);
  await window.__extSmoke.settle(220);
  out.countReachedWithRows = out.expectedReached && window.__extSmoke.visibleResults().length > 0;
  out.inputValue = input.value;
  out.dom = window.__extSmoke.dom();
  out.longTasksAfterSearch = window.__extSmoke.take();

  // Enter → onSubmit → searchNext() → gotoHit（expandTo + 选中 + 树滚动）
  window.__extSmoke.reset();
  const t1 = performance.now();
  input.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }),
  );
  out.jumpAppeared = await window.__extSmoke.waitUntil(
    () => Boolean(document.querySelector('.row.is-current')),
    cfg.jumpTimeoutMs || 10000,
  );
  out.jumpMs = Math.round(performance.now() - t1);
  await window.__extSmoke.settle(250);
  out.afterJump = window.__extSmoke.dom();
  out.statusPath = window.__extSmoke.statusPath();
  out.inputValueAfterJump = input.value;
  out.longTasksAfterJump = window.__extSmoke.take();
  return out;
}

/** 清空输入 → 空态 / 结果行与树高亮清空。 */
async function extClearPhase() {
  const out = {};
  const input = document.getElementById('searchInput');
  if (!input) return { error: '#searchInput missing' };
  window.__extSmoke.reset();
  const t0 = performance.now();
  input.value = '';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  out.cleared = await window.__extSmoke.waitUntil(() => {
    const empty = document.querySelector('.results__empty');
    return (
      Boolean(empty) &&
      !empty.hidden &&
      empty.getClientRects().length > 0 &&
      window.__extSmoke.visibleResults().length === 0 &&
      document.querySelectorAll('.row.is-hit').length === 0
    );
  }, 10000, 50);
  out.clearMs = Math.round(performance.now() - t0);
  await window.__extSmoke.settle(220);
  out.dom = window.__extSmoke.dom();
  out.inputValue = input.value;
  out.hasDevHook = Boolean(window.__tjv);
  out.longTasks = window.__extSmoke.take();
  return out;
}

/* ================================================================= */
/* 导入层交互回归（grill-with-docs 收口：Q8=A′ / Q9=A / Q10=A / Q11=B / Q12=A / Q13=A） */
/* ================================================================= */

/** 文档已打开、导入层关闭：body/树上的粘贴不应导入（defaultPrevented=false、文档不变）。 */
async function extImportLayerGuardPhase() {
  const out = {};
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  const tree = document.getElementById('tree');
  if (tree && tree.focus) tree.focus();
  await window.__extSmoke.settle(150);
  out.before = window.__extSmoke.docState();
  out.layerBefore = window.__extSmoke.layer();
  out.paste = window.__extSmoke.pasteText('{"should":"not-import"}', 'document');
  await window.__extSmoke.settle(800);
  out.after = window.__extSmoke.docState();
  out.layerAfter = window.__extSmoke.layer();
  out.hasDevHook = Boolean(window.__tjv);
  out.longTasks = window.__extSmoke.take();
  return out;
}

/** 入口 1：点 #importBtn → replace 层（title/警示条/dialog/几何/半透明）。层保持打开供截图。 */
async function extImportLayerOpenPhase() {
  const out = {};
  out.before = window.__extSmoke.docState();
  out.layerBefore = window.__extSmoke.layer();
  const btn = document.getElementById('importBtn');
  out.hasImportBtn = Boolean(btn);
  const t0 = performance.now();
  if (btn) btn.click();
  out.opened = await window.__extSmoke.waitUntil(() => {
    const layer = window.__extSmoke.layer();
    return layer.visible && layer.mode === 'replace';
  }, 5000, 40);
  out.openMs = Math.round(performance.now() - t0);
  await window.__extSmoke.settle(180);
  out.layer = window.__extSmoke.layer();
  out.doc = window.__extSmoke.docState();
  out.hasDevHook = Boolean(window.__tjv);
  out.longTasks = window.__extSmoke.take();
  return out;
}

/** 入口 2/3 + 取消：#emptyClose / #fileChip / Escape / ⌘O。起始状态：replace 层已打开。 */
async function extImportLayerCancelPhase() {
  const out = {};
  out.startLayer = window.__extSmoke.layer();
  out.before = window.__extSmoke.docState();

  // 1) #emptyClose 取消
  const closeBtn = document.getElementById('emptyClose');
  out.hasCloseBtn = Boolean(closeBtn);
  if (closeBtn) closeBtn.click();
  out.closedByButton = await window.__extSmoke.waitUntil(() => {
    const layer = window.__extSmoke.layer();
    return !layer.visible && layer.classIsHidden === true;
  }, 5000, 40);
  await window.__extSmoke.settle(180);
  out.layerAfterClose = window.__extSmoke.layer();
  out.afterClose = window.__extSmoke.docState();

  // 2) #fileChip 打开
  const chip = document.getElementById('fileChip');
  out.hasFileChip = Boolean(chip) && chip.hidden === false;
  const t1 = performance.now();
  if (chip) chip.click();
  out.openedByFileChip = await window.__extSmoke.waitUntil(() => {
    const layer = window.__extSmoke.layer();
    return layer.visible && layer.mode === 'replace';
  }, 5000, 40);
  out.fileChipMs = Math.round(performance.now() - t1);
  await window.__extSmoke.settle(120);
  out.layerViaFileChip = window.__extSmoke.layer();
  out.docViaFileChip = window.__extSmoke.docState();

  // 3) Escape 取消
  out.escape1 = window.__extSmoke.pressKey('Escape');
  out.closedByEscape = await window.__extSmoke.waitUntil(() => !window.__extSmoke.layer().visible, 5000, 40);
  await window.__extSmoke.settle(180);
  out.layerAfterEscape = window.__extSmoke.layer();
  out.afterEscape = window.__extSmoke.docState();

  // 4) ⌘O 打开
  const t2 = performance.now();
  out.cmdO = window.__extSmoke.pressKey('o', { metaKey: true });
  out.openedByShortcut = await window.__extSmoke.waitUntil(() => {
    const layer = window.__extSmoke.layer();
    return layer.visible && layer.mode === 'replace';
  }, 5000, 40);
  out.shortcutMs = Math.round(performance.now() - t2);
  await window.__extSmoke.settle(120);
  out.layerViaShortcut = window.__extSmoke.layer();
  out.docViaShortcut = window.__extSmoke.docState();

  // 5) Escape 再取消
  out.escape2 = window.__extSmoke.pressKey('Escape');
  out.closedByEscape2 = await window.__extSmoke.waitUntil(() => !window.__extSmoke.layer().visible, 5000, 40);
  await window.__extSmoke.settle(180);
  out.finalLayer = window.__extSmoke.layer();
  out.finalDoc = window.__extSmoke.docState();
  out.hasDevHook = Boolean(window.__tjv);
  out.longTasks = window.__extSmoke.take();
  return out;
}

/** replace 层：粘贴合法 JSON 替换；层内 drop 直接导入；层内粘贴非法文本 → #emptyError 且原文档不变。 */
async function extImportLayerReplacePhase() {
  const out = {};
  out.before = window.__extSmoke.docState();

  // 1) 打开 replace 层 → 粘贴合法 JSON → 替换 + 层隐藏
  const btn = document.getElementById('importBtn');
  if (btn) btn.click();
  out.layerOpened = await window.__extSmoke.waitUntil(() => window.__extSmoke.layer().visible, 5000, 40);
  await window.__extSmoke.settle(150);
  window.__extSmoke.reset();
  const t0 = performance.now();
  out.paste = window.__extSmoke.pasteText('{"replaced":true,"n":42}', 'document');
  out.replaced = await window.__extSmoke.waitUntil(() => {
    const layer = window.__extSmoke.layer();
    const doc = window.__extSmoke.docState();
    return !layer.visible && doc.visibleRows > 0;
  }, 10000, 40);
  out.replaceMs = Math.round(performance.now() - t0);
  await window.__extSmoke.settle(280);
  out.afterPaste = window.__extSmoke.docState();
  out.layerAfterPaste = window.__extSmoke.layer();

  // 2) 打开 replace 层 → 层内 drop 文件 → 直接导入（不需要 pendingReplace）
  const btn2 = document.getElementById('importBtn');
  if (btn2) btn2.click();
  out.layerOpened2 = await window.__extSmoke.waitUntil(() => window.__extSmoke.layer().visible, 5000, 40);
  await window.__extSmoke.settle(150);
  window.__extSmoke.reset();
  const t1 = performance.now();
  out.layerDrop = window.__extSmoke.dropFile('layer-drop.json', '{"layerDrop":true}', 'layer');
  out.layerDropImported = await window.__extSmoke.waitUntil(() => {
    const layer = window.__extSmoke.layer();
    const doc = window.__extSmoke.docState();
    return !layer.visible && doc.visibleRows > 0 && String(doc.fileName || '').indexOf('layer-drop.json') >= 0;
  }, 10000, 40);
  out.layerDropMs = Math.round(performance.now() - t1);
  await window.__extSmoke.settle(280);
  out.afterLayerDrop = window.__extSmoke.docState();
  out.layerAfterDrop = window.__extSmoke.layer();
  out.longTasksAfterDrop = window.__extSmoke.take();

  // 3) 打开 replace 层 → 粘贴非法文本 → 层保持打开 + #emptyError + 原文档不变
  const btn3 = document.getElementById('importBtn');
  if (btn3) btn3.click();
  out.layerOpened3 = await window.__extSmoke.waitUntil(() => window.__extSmoke.layer().visible, 5000, 40);
  await window.__extSmoke.settle(150);
  window.__extSmoke.reset();
  const t2 = performance.now();
  out.badPaste = window.__extSmoke.pasteText('min_price_', 'document');
  out.errorShown = await window.__extSmoke.waitUntil(() => {
    const layer = window.__extSmoke.layer();
    return layer.visible && layer.errorVisible && String(layer.errorText || '').length > 0;
  }, 5000, 40);
  out.errorMs = Math.round(performance.now() - t2);
  await window.__extSmoke.settle(280);
  out.errorLayer = window.__extSmoke.layer();
  out.afterError = window.__extSmoke.docState();
  out.longTasksAfterError = window.__extSmoke.take();
  return out; // 层保持打开 + 错误可见：由 Node 侧截图
}

/** 外部拖放（层关闭、有文档）→ #emptyPending 二次确认；取消不导入；#pendingReplace 才替换。 */
async function extImportLayerPendingPhase() {
  const out = {};
  // 清理上一 phase 遗留的打开层（带错误）
  const leftover = window.__extSmoke.layer();
  out.leftoverLayer = leftover;
  if (leftover.visible) {
    const close = document.getElementById('emptyClose');
    if (close) close.click();
    out.closedLeftover = await window.__extSmoke.waitUntil(() => !window.__extSmoke.layer().visible, 5000, 40);
    await window.__extSmoke.settle(180);
  }
  out.before = window.__extSmoke.docState();

  // 1) 外部 drop 到 window → 只打开确认层，不立即替换
  window.__extSmoke.reset();
  const t0 = performance.now();
  out.externalDrop = window.__extSmoke.dropFile('external-drop.json', '{"externalDrop":true}', 'window');
  out.pendingShown = await window.__extSmoke.waitUntil(() => {
    const layer = window.__extSmoke.layer();
    return layer.visible && layer.pendingVisible;
  }, 10000, 40);
  out.pendingMs = Math.round(performance.now() - t0);
  await window.__extSmoke.settle(220);
  out.pendingLayer = window.__extSmoke.layer();
  out.afterExternalDrop = window.__extSmoke.docState();

  // 2) Escape 取消 pending → 层隐藏、原文档不变
  out.escape = window.__extSmoke.pressKey('Escape');
  out.pendingCancelled = await window.__extSmoke.waitUntil(() => !window.__extSmoke.layer().visible, 5000, 40);
  await window.__extSmoke.settle(180);
  out.layerAfterCancel = window.__extSmoke.layer();
  out.afterPendingCancel = window.__extSmoke.docState();

  // 3) 再外部 drop → pending → 点 #pendingReplace → 替换成功
  out.externalDrop2 = window.__extSmoke.dropFile('external-drop.json', '{"externalDrop":true}', 'window');
  out.pendingShown2 = await window.__extSmoke.waitUntil(() => {
    const layer = window.__extSmoke.layer();
    return layer.visible && layer.pendingVisible;
  }, 10000, 40);
  await window.__extSmoke.settle(180);
  out.pendingLayer2 = window.__extSmoke.layer();
  const replaceBtn =
    document.getElementById('pendingReplace') || document.getElementById('emptyPendingReplace');
  out.hasPendingReplace = Boolean(replaceBtn);
  out.pendingReplaceId = replaceBtn ? replaceBtn.id : null;
  const t1 = performance.now();
  if (replaceBtn) replaceBtn.click();
  out.replaced = await window.__extSmoke.waitUntil(() => {
    const layer = window.__extSmoke.layer();
    const doc = window.__extSmoke.docState();
    return !layer.visible && doc.visibleRows > 0 && String(doc.fileName || '').indexOf('external-drop.json') >= 0;
  }, 10000, 40);
  out.replaceMs = Math.round(performance.now() - t1);
  await window.__extSmoke.settle(280);
  out.afterReplace = window.__extSmoke.docState();
  out.layerAfterReplace = window.__extSmoke.layer();
  out.hasDevHook = Boolean(window.__tjv);
  out.longTasks = window.__extSmoke.take();
  return out;
}

/* ------------------------------------------------------------- main script */

const report = {
  script: 'scripts/smoke-extension-search.mjs',
  generatedAt: new Date().toISOString(),
  sample: SAMPLE,
  term: TERM,
  legacyBaselineHits: LEGACY_BASELINE_HITS,
  documentedHits: DOCUMENTED_HITS,
};

let server = null;
let chrome = null;
let page = null;
let errorsBefore = 0;
let logsBefore = 0;

async function runPhase(name, fn, cfg) {
  try {
    return await page.eval(`(${fn.toString()})(${JSON.stringify(cfg || {})})`);
  } catch (error) {
    fatal.push({ phase: name, error: String((error && error.message) || error) });
    check(name + ':phase', false, { error: String((error && error.message) || error) });
    return null;
  }
}

try {
  /* ---- Node 侧 reference 命中数（capped + uncapped raw） ---- */
  const sampleAbs = path.resolve(REPO_ROOT, SAMPLE);
  if (!existsSync(sampleAbs)) throw new Error('sample missing: ' + sampleAbs);
  if (!existsSync(path.join(DIST, 'page.html'))) {
    throw new Error('dist/page.html missing — run `node build.mjs` first');
  }
  const sampleValue = JSON.parse(await readFile(sampleAbs, 'utf8'));
  const ref = analyzeHits(sampleValue, TERM);
  const raw = analyzeHits(sampleValue, TERM, Infinity);
  const refCountText = ref.truncated ? formatCount(SEARCH_LIMIT) + '+' : formatCount(ref.total);
  const expectedCounts = [refCountText];
  report.reference = {
    sample: SAMPLE,
    term: TERM,
    capped: ref,
    raw,
    refCountText,
    expectedCounts,
  };
  metrics.reference = {
    hits: ref.total,
    truncated: ref.truncated,
    rawHits: raw.total,
    rawKey: raw.key,
    rawValue: raw.value,
    refCountText,
    expectedCounts,
  };

  if (ref.total !== LEGACY_BASELINE_HITS || ref.truncated) {
    warn('legacy-baseline', {
      legacyBaseline: LEGACY_BASELINE_HITS,
      currentCapped: ref.total,
      currentRaw: raw.total,
      truncated: ref.truncated,
      note: '历史基准 37,189 是 uncapped 键名命中数（§2.3 已注记）；当前 raw 74,378 → capped 50,000 truncated',
    });
  }

  /* ---- 真实扩展 ---- */
  server = await startStaticServer(REPO_ROOT);
  chrome = await launchChrome({ extensionDirs: [DIST], windowSize: '1440,900' });
  page = await chrome.openPage();
  errorsBefore = page.exceptions.length;
  logsBefore = page.logs.length;
  await page.setViewport(1440, 900);
  await page.goto(extensionUrl(DIST, 'page.html'), { timeoutMs: 30000 });
  await page.waitFor('document.readyState === "complete"', { timeoutMs: 15000 });
  await new Promise((r) => setTimeout(r, 600));

  /* ---- setup ---- */
  const setup = await runPhase('setup', extSetup);
  report.setup = setup || null;
  if (setup) {
    check('ext:chrome-runtime', setup.hasChromeRuntime === true, { hasChromeRuntime: setup.hasChromeRuntime });
    check('ext:no-dev-hook', setup.hasDevHook === false, { hasDevHook: setup.hasDevHook });
    check('ext:longtask-observer', setup.observer === true, { observer: setup.observer });
    check('ext:import-layer-initial', Boolean(setup.layer) && setup.layer.exists === true && setup.layer.visible === true && setup.layer.mode === 'initial', {
      layer: setup.layer,
      note: '初始空态：导入层可见且 data-mode="initial"',
    });
    check('ext:dom-contract', Boolean(setup.dom) && setup.dom.countText !== null && setup.dom.filters.length === 3, {
      countText: setup.dom && setup.dom.countText,
      filters: setup.dom && setup.dom.filters.map((f) => f.filter),
    });
  }

  /* ---- 1) 粘贴 10MB + 打开搜索面板 ---- */
  const importPhase = setup
    ? await runPhase('import', extImportPhase, { url: `${server.base}/${SAMPLE}` })
    : null;
  if (importPhase) {
    report.import = importPhase;
    metrics.import = {
      sampleBytes: importPhase.sampleBytes,
      firstRowMs: importPhase.firstRowMs,
      rows: importPhase.rows,
      statusRows: importPhase.statusRows,
      panelOpen: importPhase.panelOpen,
      bodyPanelAfterPaste: importPhase.bodyPanelAfterPaste,
      longTasks: importPhase.longTasks,
    };
    check('ext:paste-import', importPhase.rowsAppeared && importPhase.rows > 0 && importPhase.firstRowMs != null, {
      firstRowMs: importPhase.firstRowMs,
      rows: importPhase.rows,
      sampleBytes: importPhase.sampleBytes,
    });
    check('ext:panel-open', importPhase.hasSearchButton && importPhase.panelOpen && importPhase.dom.visibleRows === 0, {
      hasSearchButton: importPhase.hasSearchButton,
      panelOpen: importPhase.panelOpen,
      inputBeforeSearch: importPhase.dom.countText,
      bodyPanelAfterPaste: importPhase.bodyPanelAfterPaste,
    });
    check('ext:no-dev-hook-after-paste', importPhase.hasDevHook === false, { hasDevHook: importPhase.hasDevHook });
    check('ext:import-layer-hidden-after-load', Boolean(importPhase.layerAfterPaste) && importPhase.layerAfterPaste.visible === false, {
      layerAfterPaste: importPhase.layerAfterPaste,
      docAfterPaste: importPhase.docAfterPaste,
      note: '初始空态粘贴导入成功后导入层应隐藏',
    });
  }

  /* ---- 1b) 回归：搜索输入框内粘贴普通文本，不触发全局 JSON 导入 ---- */
  const pasteInputPhase = importPhase
    ? await runPhase('paste-input', extPasteInputPhase, { text: 'min_price_' })
    : null;
  if (pasteInputPhase) {
    report.pasteIntoInput = pasteInputPhase;
    check(
      'ext:paste-into-input-not-imported',
      pasteInputPhase.defaultPrevented === false &&
        pasteInputPhase.toastHidden === true &&
        pasteInputPhase.rowsAfter === pasteInputPhase.rowsBefore &&
        pasteInputPhase.statusAfter === pasteInputPhase.statusBefore &&
        pasteInputPhase.activeIsInput === true &&
        pasteInputPhase.hasDevHook === false,
      {
        defaultPrevented: pasteInputPhase.defaultPrevented,
        toastHidden: pasteInputPhase.toastHidden,
        toastText: pasteInputPhase.toastText,
        rowsBefore: pasteInputPhase.rowsBefore,
        rowsAfter: pasteInputPhase.rowsAfter,
        statusBefore: pasteInputPhase.statusBefore,
        statusAfter: pasteInputPhase.statusAfter,
        activeIsInput: pasteInputPhase.activeIsInput,
      },
    );
  }

  /* ---- 2) 真实输入 → 命中数 → 列表 → Enter 跳转 → 截图 ---- */
  const searchPhase = importPhase
    ? await runPhase('search', extSearchPhase, {
        term: TERM,
        expectedCounts,
        countTimeoutMs: 10000,
        jumpTimeoutMs: 10000,
      })
    : null;
  if (searchPhase) {
    report.search = searchPhase;
    const d = searchPhase.dom || {};
    const afterJump = searchPhase.afterJump || {};
    const countText = d.countText;
    const size = digits(countText);
    metrics.search = {
      countMs: searchPhase.countMs,
      countText,
      matchedExpected: searchPhase.expectedReached,
      posText: d.posText,
      visibleRows: d.visibleRows,
      spacerHeight: d.spacerHeight,
      footText: d.footText,
      jumpMs: searchPhase.jumpMs,
      statusPath: searchPhase.statusPath,
      treeCurrent: afterJump.treeCurrent,
      longTasksAfterSearch: searchPhase.longTasksAfterSearch,
      longTasksAfterJump: searchPhase.longTasksAfterJump,
    };
    check('ext:search-input-event', searchPhase.expectedReached === true && searchPhase.countReachedWithRows === true, {
      expectedCounts,
      countText,
      countMs: searchPhase.countMs,
      note: '真实 input 事件 → 250ms debounce → worker search → 面板渲染',
    });
    check('ext:search-count', expectedCounts.includes(countText), {
      countText,
      expectedCounts,
      reference: { capped: ref, raw },
      legacyBaseline: LEGACY_BASELINE_HITS,
    });
    check('ext:search-count-label', ref.truncated ? String(countText) === refCountText : digits(countText) === ref.total, {
      countText,
      referenceCountText: refCountText,
      truncated: ref.truncated,
    });
    if (countText === formatCount(LEGACY_BASELINE_HITS) && ref.total !== LEGACY_BASELINE_HITS) {
      warn('ext:count-matches-legacy-baseline', { countText, reference: ref.total, raw: raw.total });
    }
    check('ext:result-rows-bounded', d.visibleRows > 0 && d.visibleRows <= 40, {
      visibleRows: d.visibleRows,
      totalRows: d.totalRows,
    });
    check('ext:result-mark-highlight', d.anyMark === true, {
      anyMark: d.anyMark,
      pathMarks: d.pathMarks,
      valueMarks: d.valueMarks,
    });
    check(
      'ext:result-field',
      d.firstFieldText !== null && ['键名', '值'].includes(d.firstFieldText) && d.fieldCount === d.visibleRows && d.fieldTexts.every((t) => t === '键名' || t === '值'),
      {
        firstFieldText: d.firstFieldText,
        fieldTexts: d.fieldTexts,
        fieldCount: d.fieldCount,
        visibleRows: d.visibleRows,
        note: '首个可见 .result .result__field ∈ {键名, 值}',
      },
    );
    check(
      'ext:tree-mark-only-in-hit-rows',
      d.treeMarksOutsideHitRows === 0 && afterJump.treeMarksOutsideHitRows === 0 && afterJump.treeVisibleMarks > 0,
      {
        beforeJump: { treeVisibleMarks: d.treeVisibleMarks, outside: d.treeMarksOutsideHitRows, hidden: d.treeMarksHidden },
        afterJump: {
          treeVisibleMarks: afterJump.treeVisibleMarks,
          treeVisibleHitMarks: afterJump.treeVisibleHitMarks,
          outside: afterJump.treeMarksOutsideHitRows,
          hidden: afterJump.treeMarksHidden,
        },
        note: 'review 修复：可见 <mark> 只在 is-hit 行（hidden 行池残留不计）',
      },
    );
    check('ext:spacer==size*44', size != null && Math.abs((d.spacerHeight || 0) - size * ROW_HEIGHT) <= 1, {
      spacerHeight: d.spacerHeight,
      expected: size != null ? size * ROW_HEIGHT : null,
      countText,
    });
    check('ext:pos-text', Boolean(/^\s*[\d,]+\s*\/\s*[\d,]+\s*$/.test(String(d.posText || ''))), {
      posText: d.posText,
    });
    check('ext:foot', d.footHidden === false && String(d.footText || '').includes('已渲染') && d.footTotal === size, {
      footHidden: d.footHidden,
      footText: d.footText,
      footTotal: d.footTotal,
      size,
    });
    check('ext:enter-jump', searchPhase.jumpAppeared === true && afterJump.treeCurrent === true, {
      jumpAppeared: searchPhase.jumpAppeared,
      treeCurrent: afterJump.treeCurrent,
      jumpMs: searchPhase.jumpMs,
      selectedIndex: afterJump.selectedIndex,
      statusPath: searchPhase.statusPath,
    });
    check('ext:jump-selected-row', afterJump.selectedRow === true && afterJump.selectedIndex === 0, {
      selectedRow: afterJump.selectedRow,
      selectedIndex: afterJump.selectedIndex,
    });
    check('ext:jump-tree-path', String(searchPhase.statusPath || '').toLowerCase().includes(TERM), {
      statusPath: searchPhase.statusPath,
    });
    const searchLong = (searchPhase.longTasksAfterSearch || []).concat(searchPhase.longTasksAfterJump || []);
    check('ext:search-maxLongTask<=50', maxLongTask(searchLong) <= 50, {
      count: searchLong.length,
      maxMs: maxLongTask(searchLong),
      spec: '0 个 >50ms 长任务',
    });
    if (searchLong.length > 0) warn('ext:search-longtasks', searchLong);

    await page.screenshot(path.join(SHOTS, 'extension-search.png'));
    report.screenshots = [path.join(SHOTS, 'extension-search.png')];
  }

  /* ---- 3) 清空输入 → 空态 ---- */
  const clearPhase = searchPhase ? await runPhase('clear', extClearPhase) : null;
  if (clearPhase) {
    report.clear = clearPhase;
    const d = clearPhase.dom || {};
    metrics.clear = {
      clearMs: clearPhase.clearMs,
      emptyText: d.emptyText,
      visibleRows: d.visibleRows,
      countText: d.countText,
      posText: d.posText,
      treeHitRows: d.treeHitRows,
      inputValue: clearPhase.inputValue,
      hasDevHook: clearPhase.hasDevHook,
    };
    check('ext:clear-input', clearPhase.cleared === true && d.visibleRows === 0, {
      cleared: clearPhase.cleared,
      visibleRows: d.visibleRows,
      clearMs: clearPhase.clearMs,
    });
    check('ext:clear-empty-state', d.emptyVisible === true && d.emptyText === '输入关键词搜索键名或字符串值', {
      emptyVisible: d.emptyVisible,
      emptyText: d.emptyText,
    });
    check('ext:clear-controls', digits(d.countText) === 0 && d.prevDisabled === true && d.nextDisabled === true && d.footHidden === true, {
      countText: d.countText,
      prevDisabled: d.prevDisabled,
      nextDisabled: d.nextDisabled,
      footHidden: d.footHidden,
    });
    check('ext:clear-tree-highlight', d.treeHitRows === 0 && d.treeCurrent === false && d.treeVisibleMarks === 0 && d.treeMarksOutsideHitRows === 0, {
      treeHitRows: d.treeHitRows,
      treeCurrent: d.treeCurrent,
      treeVisibleMarks: d.treeVisibleMarks,
      treeMarksOutsideHitRows: d.treeMarksOutsideHitRows,
      treeMarksHidden: d.treeMarksHidden,
    });
    check('ext:clear-no-dev-hook', clearPhase.hasDevHook === false, { hasDevHook: clearPhase.hasDevHook });

    await page.screenshot(path.join(SHOTS, 'extension-search-cleared.png'));
    report.screenshots = (report.screenshots || []).concat(
      path.join(SHOTS, 'extension-search-cleared.png'),
    );
  }

  /* ---- 4) 导入层交互回归（grill-with-docs 收口） ---- */
  const docSame = (a, b) =>
    Boolean(a && b) &&
    a.fileName === b.fileName &&
    a.statusRows === b.statusRows &&
    a.visibleRows === b.visibleRows;

  // 4a) 文档已打开 + 层关闭：body/树粘贴合法 JSON 不导入
  const layerGuardPhase = clearPhase ? await runPhase('import-layer-guard', extImportLayerGuardPhase) : null;
  if (layerGuardPhase) {
    report.importLayerGuard = layerGuardPhase;
    const before = layerGuardPhase.before || {};
    const after = layerGuardPhase.after || {};
    metrics.importLayerGuard = { before, after, paste: layerGuardPhase.paste, layerAfter: layerGuardPhase.layerAfter };
    check(
      'il:paste-guarded-closed-layer',
      Boolean(layerGuardPhase.paste) &&
        layerGuardPhase.paste.defaultPrevented === false &&
        docSame(before, after) &&
        after.toastHidden === true &&
        Boolean(layerGuardPhase.layerAfter) &&
        layerGuardPhase.layerAfter.visible === false,
      {
        defaultPrevented: layerGuardPhase.paste && layerGuardPhase.paste.defaultPrevented,
        before,
        after,
        layerAfter: layerGuardPhase.layerAfter,
        note: '层关闭且有文档：粘贴合法 JSON 也不导入、不 preventDefault',
      },
    );
  }

  // 4b) 入口 1（#importBtn）→ replace 层结构/警示条/dialog/几何/半透明；截图
  const layerOpenPhase = layerGuardPhase ? await runPhase('import-layer-open', extImportLayerOpenPhase) : null;
  if (layerOpenPhase) {
    report.importLayerOpen = layerOpenPhase;
    const layer = layerOpenPhase.layer || {};
    const before = layerOpenPhase.before || {};
    metrics.importLayerOpen = {
      openMs: layerOpenPhase.openMs,
      opened: layerOpenPhase.opened,
      layer,
      doc: layerOpenPhase.doc,
    };
    check(
      'il:entry-importBtn',
      layerOpenPhase.opened === true &&
        layer.visible === true &&
        layer.mode === 'replace' &&
        layer.titleText === '打开新文档' &&
        layer.role === 'dialog' &&
        layer.ariaModal === 'true' &&
        layer.closeVisible === true,
      { opened: layerOpenPhase.opened, layer },
    );
    check(
      'il:warn-shows-current-doc',
      layer.warnVisible === true &&
        String(before.fileName || '').length > 0 &&
        String(layer.warnText || '').includes(String(before.fileName || '')),
      { warnVisible: layer.warnVisible, warnText: layer.warnText, currentFileName: before.fileName },
    );
    check(
      'il:geometry-above-toolbar',
      layer.layerTop != null && layer.toolbarBottom != null && layer.layerTop >= layer.toolbarBottom - 1,
      { layerTop: layer.layerTop, toolbarBottom: layer.toolbarBottom, note: '导入层不盖住工具栏' },
    );
    const alpha = layer.backgroundAlpha;
    const translucentOk = alpha === null || alpha < 1;
    check('il:background-translucent', translucentOk, {
      background: layer.background,
      backgroundAlpha: alpha,
      backdropFilter: layer.backdropFilter,
      note: '背景半透明（不是完全遮挡）',
    });
    if (alpha === null) warn('il:background-unmeasured', { background: layer.background });

    await page.screenshot(path.join(SHOTS, 'extension-import-layer.png'));
    report.screenshots = (report.screenshots || []).concat(path.join(SHOTS, 'extension-import-layer.png'));
  }

  // 4c) 取消：emptyClose / Escape；入口：fileChip / ⌘O
  const layerCancelPhase = layerOpenPhase ? await runPhase('import-layer-cancel', extImportLayerCancelPhase) : null;
  if (layerCancelPhase) {
    report.importLayerCancel = layerCancelPhase;
    const before = layerCancelPhase.before || {};
    metrics.importLayerCancel = {
      hasCloseBtn: layerCancelPhase.hasCloseBtn,
      hasFileChip: layerCancelPhase.hasFileChip,
      fileChipMs: layerCancelPhase.fileChipMs,
      shortcutMs: layerCancelPhase.shortcutMs,
      closedByButton: layerCancelPhase.closedByButton,
      closedByEscape: layerCancelPhase.closedByEscape,
      openedByShortcut: layerCancelPhase.openedByShortcut,
    };
    check(
      'il:cancel-emptyClose',
      layerCancelPhase.closedByButton === true &&
        Boolean(layerCancelPhase.layerAfterClose) &&
        layerCancelPhase.layerAfterClose.visible === false &&
        layerCancelPhase.layerAfterClose.classIsHidden === true &&
        docSame(before, layerCancelPhase.afterClose),
      { closedByButton: layerCancelPhase.closedByButton, layerAfterClose: layerCancelPhase.layerAfterClose, before, afterClose: layerCancelPhase.afterClose },
    );
    check(
      'il:entry-fileChip',
      layerCancelPhase.hasFileChip === true &&
        layerCancelPhase.openedByFileChip === true &&
        Boolean(layerCancelPhase.layerViaFileChip) &&
        layerCancelPhase.layerViaFileChip.visible === true &&
        layerCancelPhase.layerViaFileChip.mode === 'replace' &&
        docSame(before, layerCancelPhase.docViaFileChip),
      { openedByFileChip: layerCancelPhase.openedByFileChip, layerViaFileChip: layerCancelPhase.layerViaFileChip },
    );
    check(
      'il:cancel-escape',
      layerCancelPhase.closedByEscape === true &&
        Boolean(layerCancelPhase.layerAfterEscape) &&
        layerCancelPhase.layerAfterEscape.visible === false &&
        docSame(before, layerCancelPhase.afterEscape),
      { closedByEscape: layerCancelPhase.closedByEscape, layerAfterEscape: layerCancelPhase.layerAfterEscape, afterEscape: layerCancelPhase.afterEscape },
    );
    check(
      'il:entry-cmdO',
      layerCancelPhase.openedByShortcut === true &&
        Boolean(layerCancelPhase.layerViaShortcut) &&
        layerCancelPhase.layerViaShortcut.visible === true &&
        layerCancelPhase.layerViaShortcut.mode === 'replace' &&
        docSame(before, layerCancelPhase.docViaShortcut),
      { openedByShortcut: layerCancelPhase.openedByShortcut, layerViaShortcut: layerCancelPhase.layerViaShortcut },
    );
    check(
      'il:cancel-escape-2',
      layerCancelPhase.closedByEscape2 === true &&
        Boolean(layerCancelPhase.finalLayer) &&
        layerCancelPhase.finalLayer.visible === false &&
        docSame(before, layerCancelPhase.finalDoc),
      { closedByEscape2: layerCancelPhase.closedByEscape2, finalLayer: layerCancelPhase.finalLayer, finalDoc: layerCancelPhase.finalDoc },
    );
  }

  // 4d) replace 层：合法粘贴替换 / 层内 drop 直接导入 / 非法粘贴留层内错误且文档不变；错误截图
  const layerReplacePhase = layerCancelPhase ? await runPhase('import-layer-replace', extImportLayerReplacePhase) : null;
  if (layerReplacePhase) {
    report.importLayerReplace = layerReplacePhase;
    const afterPaste = layerReplacePhase.afterPaste || {};
    const afterLayerDrop = layerReplacePhase.afterLayerDrop || {};
    const afterError = layerReplacePhase.afterError || {};
    metrics.importLayerReplace = {
      replaceMs: layerReplacePhase.replaceMs,
      layerDropMs: layerReplacePhase.layerDropMs,
      errorMs: layerReplacePhase.errorMs,
      paste: layerReplacePhase.paste,
      badPaste: layerReplacePhase.badPaste,
      afterPaste,
      afterLayerDrop,
      afterError,
      errorLayer: layerReplacePhase.errorLayer,
    };
    check(
      'il:replace-paste',
      layerReplacePhase.replaced === true &&
        afterPaste.visibleRows > 0 &&
        String(afterPaste.fileName || '').includes('剪贴板') &&
        Boolean(layerReplacePhase.layerAfterPaste) &&
        layerReplacePhase.layerAfterPaste.visible === false &&
        String(afterPaste.statusRows || '').includes('行'),
      { replaced: layerReplacePhase.replaced, replaceMs: layerReplacePhase.replaceMs, afterPaste, layerAfterPaste: layerReplacePhase.layerAfterPaste },
    );
    check(
      'il:layer-drop-direct',
      layerReplacePhase.layerDropImported === true &&
        String(afterLayerDrop.fileName || '').includes('layer-drop.json') &&
        afterLayerDrop.visibleRows > 0 &&
        Boolean(layerReplacePhase.layerAfterDrop) &&
        layerReplacePhase.layerAfterDrop.visible === false,
      { layerDropImported: layerReplacePhase.layerDropImported, layerDropMs: layerReplacePhase.layerDropMs, afterLayerDrop, layerAfterDrop: layerReplacePhase.layerAfterDrop },
    );
    const errorLayer = layerReplacePhase.errorLayer || {};
    check(
      'il:invalid-paste-stays-open',
      layerReplacePhase.errorShown === true &&
        errorLayer.visible === true &&
        errorLayer.errorVisible === true &&
        /PARSE|解析|JSON/i.test(String(errorLayer.errorText || '')),
      { errorShown: layerReplacePhase.errorShown, errorText: errorLayer.errorText, errorLayer },
    );
    check(
      'il:invalid-paste-doc-unchanged',
      docSame(afterLayerDrop, afterError) && afterError.toastHidden === true,
      { afterLayerDrop, afterError, note: '层内非法粘贴：原文档完全不变、不弹全局 toast' },
    );
    check(
      'il:replace-maxLongTask<=50',
      maxLongTask((layerReplacePhase.longTasksAfterDrop || []).concat(layerReplacePhase.longTasksAfterError || [])) <= 50,
      {
        afterDrop: layerReplacePhase.longTasksAfterDrop,
        afterError: layerReplacePhase.longTasksAfterError,
      },
    );

    await page.screenshot(path.join(SHOTS, 'extension-import-layer-error.png'));
    report.screenshots = (report.screenshots || []).concat(path.join(SHOTS, 'extension-import-layer-error.png'));
  }

  // 4e) 外部拖放 → #emptyPending 二次确认；Esc 取消不导入；#pendingReplace 才替换
  const layerPendingPhase = layerReplacePhase ? await runPhase('import-layer-pending', extImportLayerPendingPhase) : null;
  if (layerPendingPhase) {
    report.importLayerPending = layerPendingPhase;
    const before = layerPendingPhase.before || {};
    const afterExternalDrop = layerPendingPhase.afterExternalDrop || {};
    const afterCancel = layerPendingPhase.afterPendingCancel || {};
    const afterReplace = layerPendingPhase.afterReplace || {};
    metrics.importLayerPending = {
      pendingMs: layerPendingPhase.pendingMs,
      replaceMs: layerPendingPhase.replaceMs,
      pendingLayer: layerPendingPhase.pendingLayer,
      pendingLayer2: layerPendingPhase.pendingLayer2,
      before,
      afterExternalDrop,
      afterPendingCancel: afterCancel,
      afterReplace,
    };
    check(
      'il:external-drop-pending',
      layerPendingPhase.pendingShown === true &&
        Boolean(layerPendingPhase.pendingLayer) &&
        layerPendingPhase.pendingLayer.visible === true &&
        layerPendingPhase.pendingLayer.pendingVisible === true &&
        String(layerPendingPhase.pendingLayer.pendingText || '').includes('external-drop.json') &&
        layerPendingPhase.pendingLayer.mode === 'replace' &&
        docSame(before, afterExternalDrop),
      { pendingShown: layerPendingPhase.pendingShown, pendingLayer: layerPendingPhase.pendingLayer, before, afterExternalDrop },
    );
    check(
      'il:pending-cancel-keeps-doc',
      layerPendingPhase.pendingCancelled === true &&
        Boolean(layerPendingPhase.layerAfterCancel) &&
        layerPendingPhase.layerAfterCancel.visible === false &&
        docSame(before, afterCancel),
      { pendingCancelled: layerPendingPhase.pendingCancelled, layerAfterCancel: layerPendingPhase.layerAfterCancel, before, afterPendingCancel: afterCancel },
    );
    check(
      'il:pending-replace',
      layerPendingPhase.pendingShown2 === true &&
        layerPendingPhase.hasPendingReplace === true &&
        layerPendingPhase.replaced === true &&
        String(afterReplace.fileName || '').includes('external-drop.json') &&
        afterReplace.visibleRows > 0 &&
        Boolean(layerPendingPhase.layerAfterReplace) &&
        layerPendingPhase.layerAfterReplace.visible === false,
      {
        pendingShown2: layerPendingPhase.pendingShown2,
        hasPendingReplace: layerPendingPhase.hasPendingReplace,
        pendingReplaceId: layerPendingPhase.pendingReplaceId,
        replaced: layerPendingPhase.replaced,
        replaceMs: layerPendingPhase.replaceMs,
        afterReplace,
        layerAfterReplace: layerPendingPhase.layerAfterReplace,
      },
    );
    if (layerPendingPhase.pendingReplaceId && layerPendingPhase.pendingReplaceId !== 'pendingReplace') {
      warn('il:pending-replace-id-alias', {
        contractId: 'pendingReplace',
        implementationId: layerPendingPhase.pendingReplaceId,
        note: 'task-9 契约写 #pendingReplace，实现为 #emptyPendingReplace；harness 兼容两者，建议统一命名',
      });
    }
    check('il:pending-maxLongTask<=50', maxLongTask(layerPendingPhase.longTasks || []) <= 50, {
      longTasks: layerPendingPhase.longTasks,
    });
  }

  /* ---- 5) 扩展上下文最终断言 ---- */
  const finalHooks = await runPhase('final', async function pageFinalProbe() {
    return {
      hasDevHook: Boolean(window.__tjv),
      hasChromeRuntime: Boolean(globalThis.chrome && chrome.runtime && chrome.runtime.id),
      url: location.href,
    };
  });
  if (finalHooks) {
    report.finalProbe = finalHooks;
    check('ext:final-no-dev-hook', finalHooks.hasDevHook === false, finalHooks);
    check('ext:final-chrome-runtime', finalHooks.hasChromeRuntime === true, finalHooks);
  }
} catch (error) {
  fatal.push({ phase: 'main', error: String((error && error.stack) || error) });
} finally {
  if (chrome) {
    try {
      await chrome.close();
    } catch (error) {
      warnings.push({ name: 'chrome:close', detail: String((error && error.message) || error) });
    }
  }
  if (server) {
    try {
      await server.close();
    } catch (error) {
      warnings.push({ name: 'server:close', detail: String((error && error.message) || error) });
    }
  }
}

/* ------------------------------------------------------- console + report */

if (page) {
  const exceptions = page.exceptions.slice(errorsBefore);
  const consoleErrors = page.logs
    .slice(logsBefore)
    .filter((entry) => entry.type === 'error')
    .map((entry) => entry.text);
  report.consoleErrors = exceptions;
  report.consoleErrorLogs = consoleErrors;
  check('ext:no-exceptions', exceptions.length === 0, { exceptions });
  check('ext:no-console-error', consoleErrors.length === 0, { consoleErrors });
}

for (const shot of report.screenshots || []) {
  check('screenshot:' + path.basename(shot), existsSync(shot), { path: shot });
}
if (fatal.length > 0) {
  report.fatal = fatal;
  for (const f of fatal) check('fatal:' + f.phase, false, f);
}

report.metrics = metrics;
report.checks = checks;
report.warnings = warnings;
report.passed = checks.filter((c) => c.pass).length;
report.failed = checks.filter((c) => !c.pass).length;
report.ok = report.failed === 0;

const width = Math.min(58, Math.max(...checks.map((c) => c.name.length), 4));
for (const c of checks) {
  const detail = c.detail === undefined ? '' : JSON.stringify(c.detail);
  console.log(`${c.pass ? OK : BAD} ${c.name.padEnd(width)}  ${detail}`);
}
if (warnings.length > 0) {
  console.log('\n⚠ warnings:');
  for (const w of warnings) console.log('  - ' + w.name + ': ' + JSON.stringify(w.detail));
}
console.log('\n--- report ---\n' + JSON.stringify(report, null, 2));
console.log(
  `\nsmoke-extension-search: ${report.ok ? 'OK' : 'FAILED'}  (${report.passed}/${checks.length} checks, ${report.failed} failed)`,
);
process.exitCode = report.ok ? 0 : 1;
