/**
 * scripts/smoke-extension-search.mjs — slice 4（搜索）真实 unpacked 扩展验收 v2。
 *
 *   node scripts/smoke-extension-search.mjs [sample]
 *   （dist 由 Lead 构建并冻结；本脚本不 build）
 *
 * 流程（全部走真实 UI，不经 dev hook）：
 *   1. 以真实 unpacked 扩展（`--load-extension dist`）打开 page.html；
 *   2. 断言扩展上下文没有 `window.__tjv`（dev hook 只在 HTTP 下挂）；
 *   3. 粘贴 10MB（synthetic ClipboardEvent + DataTransfer，文本不进 DOM）；
 *   4. 点活动栏 `[data-panel-btn="search"]` 打开搜索面板；
 *   5. 对 `#searchInput` 设 value='hotel' + dispatch `input`（真实 250ms debounce 路径），
 *      轮询 ≤10s 等 `#searchCount` 出现预期命中数（capped 50,000+）；
 *   6. 校验 `.result` 行数 ≤40、`mark.result__hit` 存在、spacer=size×44、`#searchPos`、
 *      `.result__field` ∈ {键名, 值}、树 `<mark>` 只在 is-hit 行；
 *   7. 输入框 dispatch Enter → 等树 `.row.is-current` 出现（真实跳转）；
 *   8. 清空输入（value='' + input 事件）→ 等 `.results__empty` 出现 / 结果行清空 / 树高亮清除；
 *   9. 截图 `.spike/smoke/extension-search.png`（结果+当前命中）与
 *      `.spike/smoke/extension-search-cleared.png`（清空态）；0 console 错误；退出码。
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
  out.hasDevHook = Boolean(window.__tjv);
  out.longTasks = window.__extSmoke.take();
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

  /* ---- 4) 扩展上下文最终断言 ---- */
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
