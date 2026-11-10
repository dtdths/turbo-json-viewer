/**
 * scripts/smoke-search.mjs — slice 4（搜索）验收冒烟 v2：HTTP + `window.__tjv` dev hook。
 *
 *   node scripts/smoke-search.mjs [mockSample] [bigSample]
 *   （dist 由 Lead 构建并冻结；本脚本不 build）
 *
 * 覆盖 docs/design/slice4-search-contract.md §6（dist 2026-10-29 20:42 review 修复后）：
 *   - `.mock/1.json` 搜索 `hotel`：hook <100ms、capped 命中 186（140 key + 46 value）、
 *     虚拟列表（行数 ≤40、spacer=size×44、`#searchCount`=未过滤 total / `#searchPos`=n / 过滤后 size、
 *     `.result__field` ∈ {键名, 值}、foot 文案）；
 *   - `searchJump(0)`：hook ≤16.7ms（1 帧，spec 门槛）+ 树 `.row.is-current`；
 *   - prev/next 多轮（含环状）跳转；
 *   - 过滤 all/key/value：size 关系（key+value=total）、DOM counts 稳定（setFilter 不重算）、
 *     pos 分母 = 过滤后 size、`.result__field` 与过滤一致；
 *   - 10MB 全量搜索：raw 74,378 → capped 50,000（truncated）、hook ≤120ms、无 >50ms 长任务；
 *   - 结果列表滚动 0/25/50/95%：渲染行数有界、maxLongTask ≤50；
 *   - truncated（`e` >50k 命中）文案与 `50,000+`；
 *   - stale（dev hook `searchMarkStale()`）：phase='stale'、清空结果/树高亮/树 mark、
 *     文案「文档已修改，请重新搜索」，再搜索恢复 ready；
 *   - 空查询 / 无命中态文案；
 *   - 树 `<mark>` 只出现在 `.row.is-hit` 行（review 修复项）；
 *   - 截图落 `.spike/smoke/search-mock.png`、`.spike/smoke/search-10mb.png`。
 *
 * 命中数口径：历史基准（docs/design/qa-editing-and-search.md §2.3 已注记）为 58 / 37,189；
 * 当前样本按 `src/core/search.ts` 语义（键名 + 字符串值、大小写不敏感、上限 50,000）：
 *   `.mock/1.json` hotel = 186（140 key + 46 value）；
 *   10MB hotel = raw 74,378（37,189 key + 37,189 value）→ capped 50,000 truncated。
 * 期望值来源：`scripts/lib/search-expectations.mjs` 的文档基线常量（样本 bytes+sha256 指纹钉住），
 * 本脚本**不再**自带 reference walk —— 命中语义由 vitest parity oracle 对照独立参考实现保证
 * （`tests/unit/core/search-parity.test.ts` / ADR-0014 修订 2026-11-10）。
 * 历史基准只作为 warning 记录，不与已更新的契约 §6 冲突。
 *
 * 输出：JSON report（关键毫秒数 / 行数 / 长任务 / 命中数）+ 通过项表 + OK/FAIL 退出码。
 * 不引入 npm 依赖；Chrome harness 复用 prototype/p1/lib。
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { launchChrome, REPO_ROOT } from '../prototype/p1/lib/chrome.mjs';
import { startStaticServer } from '../prototype/p1/lib/http.mjs';
import {
  DOCUMENTED_HITS,
  fingerprintText,
  REFERENCE_HITS,
  SAMPLES,
  SEARCH_LIMIT,
} from './lib/search-expectations.mjs';

/* ------------------------------------------------------------------ config */

const MOCK_SAMPLE = process.argv[2] || '.mock/1.json';
const BIG_SAMPLE = process.argv[3] || '.spike/samples/10mb.json';
const MOCK_TERM = 'hotel';
const BIG_TERM = 'hotel';
const NO_HIT_TERM = 'zz-no-such-term-9x';
const TRUNC_TERM = 'e'; // 10MB 上远超 50k 命中 → truncated
const ROW_HEIGHT = 44;
/** 历史基准（旧口径）：docs/design/qa-editing-and-search.md §2.3 已注记；契约 §6 已更新为 186 / raw 74,378。 */
const LEGACY_BASELINE_HITS = { mockHotel: 58, bigHotel: 37_189 };

/**
 * 期望命中数别名（来自 checked-in 文档基线 `scripts/lib/search-expectations.mjs`，不再本地 walk 现算）。
 * 形状与旧 `analyzeHits` 返回值一致（`{total,key,value,truncated}`），后续断言零改动。
 */
const refMock = REFERENCE_HITS.mockHotel;
const rawMock = REFERENCE_HITS.mockHotel; // mock 未截断：raw == capped
const refBig = REFERENCE_HITS.bigHotel.capped;
const rawBig = REFERENCE_HITS.bigHotel.raw;
const refBigE = REFERENCE_HITS.bigHotelE;
const refNoHit = REFERENCE_HITS.noHit;

const SHOTS = path.join(REPO_ROOT, '.spike', 'smoke');
const OK = '✅';
const BAD = '❌';

await mkdir(SHOTS, { recursive: true });

async function readJsonSample(rel) {
  const abs = path.resolve(REPO_ROOT, rel);
  if (!existsSync(abs)) throw new Error('sample missing: ' + abs);
  const text = await readFile(abs, 'utf8');
  return { rel, abs, text, bytes: Buffer.byteLength(text), value: JSON.parse(text) };
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
function metric(name, value) {
  metrics[name] = value;
}
function digits(text) {
  const m = /([\d,]+)/.exec(String(text == null ? '' : text));
  return m ? Number(m[1].replace(/,/g, '')) : null;
}
function parsePos(text) {
  const m = /^\s*([\d,]+)\s*\/\s*([\d,]+)\s*$/.exec(String(text == null ? '' : text));
  if (!m) return null;
  return {
    numerator: Number(m[1].replace(/,/g, '')),
    denominator: Number(m[2].replace(/,/g, '')),
  };
}
function maxLongTask(tasks) {
  return (tasks || []).reduce((max, t) => Math.max(max, t.d || 0), 0);
}
function longTasksOf(phase) {
  return (phase && phase.longTasks) || [];
}

/* ======================= page-side (stringified) helpers ================== */

/** 安装 window.__smoke：长任务 observer + 等待 + DOM 快照读取。 */
async function pageSetup() {
  const q = (sel) => document.querySelector(sel);
  const hook = window.__tjv;
  const required = [
    'loadText',
    'state',
    'search',
    'searchNext',
    'searchPrev',
    'searchJump',
    'searchMarkStale',
    'setSearchFilter',
    'searchPanel',
    'searchListScrollTo',
  ];

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
    async waitUntil(fn, timeoutMs = 10000, stepMs = 16) {
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
    /** 可见（非 hidden 且真的参与布局）的 .result 行 */
    visibleResults() {
      return [...document.querySelectorAll('.result')].filter(
        (el) => !el.hidden && el.getClientRects().length > 0,
      );
    },
    /** 路径最后一段的键名（数组下标 → ''）。样本键都是标识符，够用。 */
    leafKey(p) {
      if (!p || p === '$') return '';
      if (p.charAt(p.length - 1) === ']') {
        const start = p.lastIndexOf("['");
        if (start >= 0) return p.slice(start + 2, p.length - 2);
        return '';
      }
      const dot = p.lastIndexOf('.');
      return dot >= 0 ? p.slice(dot + 1) : '';
    },
    /** 打开左侧搜索面板（加载文档后 app 会切回 doc），并让输入框失焦以便同步 value。 */
    async openSearchPanel() {
      if (document.body.dataset.panel !== 'search') {
        const btn = document.querySelector('[data-panel-btn="search"]');
        if (btn) btn.click();
      }
      const ok = await smoke.waitUntil(() => {
        const host = document.getElementById('searchPanel');
        return Boolean(host) && host.offsetHeight > 0;
      }, 3000);
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      return ok;
    },
    /** 搜索面板 DOM 契约快照（§3.1）。 */
    dom() {
      const toNum = (text) => {
        const m = /([\d,]+)/.exec(String(text == null ? '' : text));
        return m ? Number(m[1].replace(/,/g, '')) : null;
      };
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
      const spacerHeight = spacer ? Math.round(spacer.getBoundingClientRect().height * 100) / 100 : null;
      // 树行池里 hidden 行可能残留旧文本（display:none，不可见）；
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
        leafKeys: visible.slice(0, 24).map((el) => smoke.leafKey(el.dataset.path || '')),
        valueTexts: visible.slice(0, 24).map((el) => {
          const node = el.querySelector('.result__value');
          return node ? node.textContent.trim() : '';
        }),
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
        pathMarks: visible.filter((el) => el.querySelector('.result__path mark.result__hit')).length,
        valueMarks: visible.filter((el) => el.querySelector('.result__value mark.result__hit')).length,
        anyMark: Boolean(document.querySelector('mark.result__hit')),
        selectedRow: Boolean(selected),
        selectedIndex: selected ? Number(selected.dataset.index) : null,
        treeHitRows: document.querySelectorAll('.row.is-hit').length,
        treeHitMarks: document.querySelectorAll('.row.is-hit mark').length,
        /** review 修复：可见 mark 只允许出现在 .row.is-hit 行 */
        treeMarks: document.querySelectorAll('.row mark').length,
        treeVisibleMarks,
        treeVisibleHitMarks,
        treeMarksOutsideHitRows: treeVisibleMarks - treeVisibleHitMarks,
        treeMarksHidden: document.querySelectorAll('.row mark').length - treeVisibleMarks,
        treeCurrent: Boolean(document.querySelector('.row.is-current')),
        spacerHeight,
        spacerStyleHeight: spacer ? spacer.style.height : null,
        scrollTop: scroll ? Math.round(scroll.scrollTop) : null,
        scrollHeight: scroll ? Math.round(scroll.scrollHeight) : null,
        clientHeight: scroll ? Math.round(scroll.clientHeight) : null,
        listboxRole: scroll ? scroll.getAttribute('role') : null,
        prevDisabled: prev ? prev.disabled : null,
        nextDisabled: next ? next.disabled : null,
        filters,
        activeFilter: (filters.find((f) => f.on) || {}).filter || null,
      };
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
  window.__smoke = smoke;

  const panelOpen = await smoke.openSearchPanel();
  return {
    hasHook: Boolean(hook),
    hooks: hook ? Object.keys(hook).sort() : [],
    missingHooks: hook ? required.filter((k) => typeof hook[k] !== 'function') : required,
    panelHost: Boolean(document.getElementById('searchPanel')),
    panelOpen,
    observer: smoke.observer,
    bodyPanel: document.body.dataset.panel || null,
    inputPresent: Boolean(document.getElementById('searchInput')),
    dom: smoke.dom(),
  };
}

/** 载入样本 → 打开搜索面板 → 搜索 mock；返回搜索期数据。 */
async function pageMockPhase(cfg) {
  const out = {};
  const text = await (await fetch(cfg.url)).text();
  out.bytes = text.length;
  await window.__tjv.loadText(text, cfg.name);
  out.rowsAppeared = await window.__smoke.waitUntil(
    () => document.querySelectorAll('.row[data-path]:not([hidden])').length > 0,
    30000,
  );
  await window.__smoke.settle(400);
  out.treeRows = document.querySelectorAll('.row[data-path]:not([hidden])').length;
  out.state = window.__tjv.state();
  out.panelOpen = await window.__smoke.openSearchPanel();
  await window.__smoke.settle(120);
  window.__smoke.reset();
  const t0 = performance.now();
  out.search = await window.__tjv.search(cfg.term);
  out.searchMsObserved = Math.round((performance.now() - t0) * 100) / 100;
  await window.__smoke.settle(150);
  out.diag = window.__tjv.searchPanel();
  out.dom = window.__smoke.dom();
  out.inputValue = document.getElementById('searchInput').value;
  out.longTasks = window.__smoke.take();
  return out;
}

/** searchJump(index)：实测毫秒数 + 树 `.row.is-current` 是否出现。 */
async function pageJumpPhase(cfg) {
  const out = {};
  window.__smoke.reset();
  const t0 = performance.now();
  out.jump = await window.__tjv.searchJump(cfg.index);
  out.ms = Math.round((performance.now() - t0) * 100) / 100;
  out.currentAppeared = await window.__smoke.waitUntil(
    () => Boolean(document.querySelector('.row.is-current')),
    5000,
  );
  out.appearMs = Math.round((performance.now() - t0) * 100) / 100;
  await window.__smoke.settle(120);
  out.diag = window.__tjv.searchPanel();
  out.dom = window.__smoke.dom();
  out.treeState = window.__tjv.state();
  out.longTasks = window.__smoke.take();
  return out;
}

/**
 * 双击搜索结果行 = 复制（ADR-0010 修订 / ADR-0011 修订）：默认路径 / 切子树 JSON / 格式不适用三条路径。
 * 双击序列与真实浏览器一致：click(detail=1) → click(detail=2，被 detail>1 守卫吞掉) → dblclick。
 */
async function pageDblCopyPhase() {
  const h = window.__tjv;
  const out = { defaultFormat: null, path: null, defaultClip: null, defaultToast: '', subtree: null, badFormat: null };
  const rows = () => [...document.querySelectorAll('.result[data-path]')];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitToastChange = async (before) => {
    for (let i = 0; i < 30; i++) {
      await sleep(20);
      if (h.toastText() !== before) return;
    }
  };
  const fire = (row) => {
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }));
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }));
  };
  const dbl = async (row) => {
    const before = h.toastText();
    fire(row);
    await waitToastChange(before);
    await window.__smoke.settle(120);
    return { clip: await h.clipboardText(), toast: h.toastText() };
  };

  const first = rows()[0];
  if (!first) return { error: 'no result rows' };
  out.defaultFormat = h.settingsState().searchCopyFormat;
  out.path = String(first.dataset.path);
  const r1 = await dbl(first);
  out.defaultClip = r1.clip;
  out.defaultToast = r1.toast;

  // 切「子树 JSON」→ 双击同一行应得到可解析 JSON
  h.setSetting('searchCopyFormat', 'subtree');
  await sleep(120);
  const r2 = await dbl(rows()[0] ?? first);
  out.subtree = { format: h.settingsState().searchCopyFormat, clip: r2.clip, toast: r2.toast, jsonOk: false };
  try {
    JSON.parse(r2.clip);
    out.subtree.jsonOk = true;
  } catch {
    out.subtree.jsonOk = false;
  }

  // 切「原始值」→ 找一个容器命中（copyResolve(value) 报 BAD_COMMAND）→ 双击应给错误 toast
  h.setSetting('searchCopyFormat', 'value');
  await sleep(120);
  let containerPath = null;
  for (const el of rows()) {
    const p = String(el.dataset.path);
    const r = await h.copyResolve(p, 'value');
    if (r && r.error && r.error.code === 'BAD_COMMAND') {
      containerPath = p;
      break;
    }
  }
  if (containerPath) {
    const target = rows().find((n) => String(n.dataset.path) === containerPath) ?? rows()[0] ?? null;
    if (!target) return { ...out, badFormat: { path: null, toast: '', clip: null, note: 'row vanished' } };
    const before = h.toastText();
    fire(target);
    await waitToastChange(before);
    out.badFormat = { path: containerPath, toast: h.toastText(), clip: await h.clipboardText() };
  } else {
    out.badFormat = { path: null, toast: '', clip: null, note: 'no container hit in current window' };
  }

  // 复原默认，避免影响后续 phase
  h.setSetting('searchCopyFormat', 'path');
  await sleep(80);
  return out;
}

/** prev/next 多轮 + 首尾环状。 */
async function pageNavPhase(cfg) {
  const out = { steps: [] };
  const first = window.__tjv.searchPanel();
  out.size = first.size;
  out.startCurrent = first.current;

  const rec = async (kind, fn) => {
    window.__smoke.reset();
    const t0 = performance.now();
    const r = await fn();
    const ms = Math.round((performance.now() - t0) * 100) / 100;
    const appeared = await window.__smoke.waitUntil(
      () => Boolean(document.querySelector('.row.is-current')),
      5000,
    );
    await window.__smoke.settle(80);
    const d = window.__smoke.dom();
    const diag = window.__tjv.searchPanel();
    out.steps.push({
      kind,
      ms,
      hookMs: r ? r.ms : null,
      index: r ? r.index : null,
      appeared,
      current: diag.current,
      size: diag.size,
      path: diag.path,
      posText: d.posText,
      selectedIndex: d.selectedIndex,
      rendered: diag.rendered,
      visibleRows: d.visibleRows,
      treeCurrent: Boolean(document.querySelector('.row.is-current')),
      longTasks: window.__smoke.take(),
    });
  };

  for (let i = 0; i < cfg.rounds; i++) await rec('next', () => window.__tjv.searchNext());
  for (let i = 0; i < cfg.rounds; i++) await rec('prev', () => window.__tjv.searchPrev());
  await rec('jump-last', () => window.__tjv.searchJump(out.size - 1));
  await rec('next-wrap', () => window.__tjv.searchNext());
  await rec('prev-wrap', () => window.__tjv.searchPrev());
  return out;
}

/** 过滤 all/key/value 快照。 */
async function pageFilterPhase() {
  const out = { steps: [] };
  const snap = async (filter) => {
    window.__smoke.reset();
    const t0 = performance.now();
    const result = window.__tjv.setSearchFilter(filter);
    const ms = Math.round((performance.now() - t0) * 100) / 100;
    await window.__smoke.settle(150);
    out.steps.push({
      filter,
      ms,
      result,
      diag: window.__tjv.searchPanel(),
      dom: window.__smoke.dom(),
      inputValue: document.getElementById('searchInput').value,
      longTasks: window.__smoke.take(),
    });
  };
  await snap('key');
  await snap('value');
  await snap('all');
  return out;
}

/** 载入 10MB → 打开面板 → search('hotel')。 */
async function pageBigPhase(cfg) {
  const out = {};
  const text = await (await fetch(cfg.url)).text();
  out.bytes = text.length;
  await window.__tjv.loadText(text, cfg.name);
  out.rowsAppeared = await window.__smoke.waitUntil(
    () => document.querySelectorAll('.row[data-path]:not([hidden])').length > 0,
    60000,
  );
  await window.__smoke.settle(500);
  out.state = window.__tjv.state();
  out.treeRows = document.querySelectorAll('.row[data-path]:not([hidden])').length;
  out.panelOpen = await window.__smoke.openSearchPanel();
  await window.__smoke.settle(150);
  window.__smoke.reset();
  const t0 = performance.now();
  out.search = await window.__tjv.search(cfg.term);
  out.searchMsObserved = Math.round((performance.now() - t0) * 100) / 100;
  await window.__smoke.settle(200);
  out.diag = window.__tjv.searchPanel();
  out.dom = window.__smoke.dom();
  out.inputValue = document.getElementById('searchInput').value;
  out.longTasks = window.__smoke.take();
  return out;
}

/** 结果列表滚动 0/25/50/95%（优先用 dev hook，缺失则直接设 scrollTop）。 */
async function pageScrollPhase(cfg) {
  const out = { steps: [] };
  const scroll = document.getElementById('resultsScroll') || document.querySelector('.results__scroll');
  if (!scroll) return out;
  const maxPx = () => Math.max(0, scroll.scrollHeight - scroll.clientHeight);
  window.__smoke.reset();
  for (const pct of cfg.percents) {
    const target = Math.round((maxPx() * pct) / 100);
    const t0 = performance.now();
    let hookResult = null;
    if (typeof window.__tjv.searchListScrollTo === 'function') {
      hookResult = window.__tjv.searchListScrollTo(target);
    } else {
      scroll.scrollTop = target;
    }
    const applied = await window.__smoke.waitUntil(
      () => Math.abs(scroll.scrollTop - target) <= 2,
      3000,
      10,
    );
    await window.__smoke.settle(120);
    const d = window.__smoke.dom();
    const diag = window.__tjv.searchPanel();
    out.steps.push({
      pct,
      target,
      applied,
      ms: Math.round((performance.now() - t0) * 100) / 100,
      hookReturned: Boolean(hookResult),
      scrollTop: d.scrollTop,
      scrollHeight: d.scrollHeight,
      clientHeight: d.clientHeight,
      firstIndex: d.resultFirstIndex,
      lastIndex: d.resultLastIndex,
      visibleRows: d.visibleRows,
      totalRows: d.totalRows,
      spacerHeight: d.spacerHeight,
      rendered: diag.rendered,
      longTasks: window.__smoke.take(),
    });
  }
  return out;
}

/** truncated 查询（>50k 命中）。 */
async function pageTruncPhase(cfg) {
  const out = {};
  window.__smoke.reset();
  const t0 = performance.now();
  out.search = await window.__tjv.search(cfg.term);
  out.ms = Math.round((performance.now() - t0) * 100) / 100;
  await window.__smoke.settle(150);
  out.diag = window.__tjv.searchPanel();
  out.dom = window.__smoke.dom();
  out.longTasks = window.__smoke.take();
  return out;
}

/** 空查询 / 无命中态。 */
async function pageStatesPhase(cfg) {
  const out = {};
  window.__smoke.reset();
  out.idle = { search: await window.__tjv.search('') };
  await window.__smoke.settle(150);
  out.idle.diag = window.__tjv.searchPanel();
  out.idle.dom = window.__smoke.dom();
  out.idle.inputValue = document.getElementById('searchInput').value;

  out.nohit = { search: await window.__tjv.search(cfg.noHitTerm) };
  await window.__smoke.settle(200);
  out.nohit.diag = window.__tjv.searchPanel();
  out.nohit.dom = window.__smoke.dom();
  out.nohit.inputValue = document.getElementById('searchInput').value;
  out.longTasks = window.__smoke.take();
  return out;
}

/**
 * 搜索选项 Aa / 正则（ADR-0014，2026-11-09）。
 * 全部走真实 UI：输入框 dispatch input（250ms debounce）+ 点击 #searchCase / #searchRegex。
 * fixture 设计成四个模式互不相同的命中数（6 / 2 / 5 / 1），可证伪：
 *   {"Hotel":1,"hotel":2,"HOTEL":3,"list":["HoTel","xhotelx"],"deep":{"Hotel":"v"}}
 */
async function pageOptionsPhase(cfg) {
  const out = {};
  window.__smoke.reset();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const input = () => document.getElementById('searchInput');
  const toggle = (id) => document.getElementById(id);
  const setQuery = async (q) => {
    const el = input();
    el.focus();
    el.value = q;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(450); // debounce 250 + worker 往返
  };
  const clickToggle = async (id) => {
    toggle(id).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await sleep(350); // onOptionsChange 直跑（无 debounce）
  };
  const snap = () => ({
    diag: window.__tjv.searchPanel(),
    dom: window.__smoke.dom(),
    inputValue: input().value,
    inputInvalid: input().getAttribute('aria-invalid'),
    errorHidden: document.getElementById('searchPatternError')?.hidden ?? null,
    errorText: document.getElementById('searchPatternError')?.textContent ?? '',
    ariaPressed: {
      case: toggle('searchCase')?.getAttribute('aria-pressed') ?? null,
      regex: toggle('searchRegex')?.getAttribute('aria-pressed') ?? null,
    },
  });

  // 面板打开（必须在 loadText 之后：onLoaded 会把左面板切回「文档」）
  await window.__tjv.loadText(JSON.stringify(cfg.doc), 'options.json');
  await sleep(300);
  if (document.body.dataset.panel !== 'search') {
    document.querySelector('[data-panel-btn="search"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await sleep(200);
  }
  out.panelOpen = document.body.dataset.panel === 'search';

  // 1) 默认：大小写不敏感子串 → 6（键 4 + 值 2）
  await setQuery(cfg.term);
  out.defaultMode = snap();

  // 2) 只开 Aa：大小写敏感子串 → 2（键 hotel 1 + 值 xhotelx 1）
  await clickToggle('searchCase');
  out.caseOnly = snap();

  // 3) Aa 关、开正则（^hotel$，i）→ 5（键 4 + 值 HoTel 1）
  await clickToggle('searchCase');
  await clickToggle('searchRegex');
  await setQuery(cfg.regex);
  out.regexOnly = snap();

  // 4) 正则 + Aa → 1（只有键 hotel）
  await clickToggle('searchCase');
  out.regexCase = snap();

  // 5) 非法正则 → 内联错误 + 结果/树高亮清空（不弹 toast）
  await setQuery(cfg.badRegex);
  out.badPattern = snap();
  out.badPatternToastHidden = document.getElementById('toast')?.hidden ?? null;

  // 6) 灾难性回溯筛查 → 拒绝并提示
  await setQuery(cfg.unsafeRegex);
  out.unsafePattern = snap();

  // 7) Aa 关 + 改回合法正则（^hotel$，i）→ 错误态清除、结果恢复 5
  await clickToggle('searchCase');
  await setQuery(cfg.regex);
  out.recovered = snap();

  // 8) 关正则、清空查询（两开关回默认、错误态与统计归零）
  await clickToggle('searchRegex');
  await setQuery('');
  out.cleared = snap();
  out.longTasks = window.__smoke.take();
  return out;
}

/** stale（review 新增 dev hook）：search 成功 → searchMarkStale() → 再搜索恢复。 */
async function pageStalePhase() {
  const out = {};
  window.__smoke.reset();
  out.before = { search: await window.__tjv.search('hotel') };
  await window.__smoke.settle(150);
  out.before.diag = window.__tjv.searchPanel();
  out.before.dom = window.__smoke.dom();

  const t0 = performance.now();
  out.stale = window.__tjv.searchMarkStale();
  out.ms = Math.round((performance.now() - t0) * 100) / 100;
  await window.__smoke.settle(150);
  out.staleDiag = window.__tjv.searchPanel();
  out.staleDom = window.__smoke.dom();

  out.restored = { search: await window.__tjv.search('hotel') };
  await window.__smoke.settle(200);
  out.restored.diag = window.__tjv.searchPanel();
  out.restored.dom = window.__smoke.dom();
  out.longTasks = window.__smoke.take();
  return out;
}

/* ------------------------------------------------------------- main script */

const report = {
  script: 'scripts/smoke-search.mjs',
  generatedAt: new Date().toISOString(),
  samples: { mock: MOCK_SAMPLE, big: BIG_SAMPLE },
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
  /* ---- 文档基线：checked-in 常量 + 样本身份指纹（本脚本不再自带 reference walk） ---- */
  const mockSample = await readJsonSample(MOCK_SAMPLE);
  const bigSample = await readJsonSample(BIG_SAMPLE);
  const mockFingerprint = fingerprintText(mockSample.text);
  const bigFingerprint = fingerprintText(bigSample.text);
  const mockIdentityOk =
    mockFingerprint.bytes === SAMPLES.mock.bytes && mockFingerprint.sha256 === SAMPLES.mock.sha256;
  const bigIdentityOk =
    bigFingerprint.bytes === SAMPLES.big.bytes && bigFingerprint.sha256 === SAMPLES.big.sha256;
  const baselineConsistent =
    refMock.total === DOCUMENTED_HITS.mockHotel &&
    refMock.truncated === false &&
    rawBig.total === DOCUMENTED_HITS.bigHotelRaw &&
    rawBig.key + rawBig.value === rawBig.total &&
    refBig.total === Math.min(rawBig.total, SEARCH_LIMIT) &&
    refBig.total === DOCUMENTED_HITS.bigHotelCapped &&
    refBigE.total === SEARCH_LIMIT &&
    refNoHit.total === 0;
  report.reference = {
    mock: { sample: MOCK_SAMPLE, term: MOCK_TERM, fingerprint: mockFingerprint, documented: refMock },
    big: { sample: BIG_SAMPLE, term: BIG_TERM, fingerprint: bigFingerprint, documented: { capped: refBig, raw: rawBig } },
    bigE: { term: TRUNC_TERM, documented: refBigE },
    noHit: { term: NO_HIT_TERM, documented: refNoHit },
    baseline: REFERENCE_HITS,
  };
  metric('reference', {
    mockHotelHits: refMock.total,
    mockHotelRaw: rawMock.total,
    bigHotelHits: refBig.total,
    bigHotelRaw: rawBig.total,
    bigHotelRawKey: rawBig.key,
    bigHotelRawValue: rawBig.value,
    bigHotelTruncated: refBig.truncated,
    bigEHits: refBigE.total,
    bigETruncated: refBigE.truncated,
  });
  check('reference:documented', mockIdentityOk && bigIdentityOk && baselineConsistent, {
    mockFingerprint,
    bigFingerprint,
    expectedSamples: SAMPLES,
    documented: DOCUMENTED_HITS,
    baseline: REFERENCE_HITS,
    note: '样本 bytes+sha256 必须与文档基线一致；样本换过 → 按 scripts/lib/search-expectations.mjs 头部流程刷新',
  });
  if (refMock.total !== LEGACY_BASELINE_HITS.mockHotel) {
    warn('legacy-baseline:mock', {
      legacyBaseline: LEGACY_BASELINE_HITS.mockHotel,
      currentReference: refMock.total,
      note: 'docs/design/qa-editing-and-search.md §2.3 历史基准 58 与当前样本不符（已注记；契约 §6 为 186）',
    });
  }
  if (refBig.total !== LEGACY_BASELINE_HITS.bigHotel || refBig.truncated) {
    warn('legacy-baseline:10mb', {
      legacyBaseline: LEGACY_BASELINE_HITS.bigHotel,
      currentCapped: refBig.total,
      currentRaw: rawBig.total,
      truncated: refBig.truncated,
      note: '历史基准 37,189 恰为 uncapped 键名命中数（§2.3 已注记）；当前 capped 50,000 truncated',
    });
  }

  /* ---- HTTP + Chrome ---- */
  server = await startStaticServer(REPO_ROOT);
  chrome = await launchChrome({ windowSize: '1440,900' });
  page = await chrome.openPage();
  errorsBefore = page.exceptions.length;
  logsBefore = page.logs.length;
  await page.setViewport(1440, 900);
  // 双击复制要逐字读回剪贴板（ADR-0010 修订）；与 smoke-settings 同一授权方式
  try {
    await chrome.browser.send('Browser.grantPermissions', {
      origin: server.base,
      permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
    });
    report.clipboardGranted = true;
  } catch {
    report.clipboardGranted = false;
  }
  await page.goto(`${server.base}/dist/page.html`, { timeoutMs: 20000 });
  await page.waitFor('document.readyState === "complete"', { timeoutMs: 10000 });
  await new Promise((r) => setTimeout(r, 500));

  /* ---- setup ---- */
  const setup = await runPhase('setup', pageSetup);
  report.setup = setup || null;
  if (setup) {
    check('setup:dev-hook', setup.hasHook, { hooks: setup.hooks });
    check('setup:hook-contract', setup.missingHooks.length === 0, { missing: setup.missingHooks });
    check('setup:search-panel-host', setup.panelHost && setup.panelOpen, {
      panelHost: setup.panelHost,
      panelOpen: setup.panelOpen,
      bodyPanel: setup.bodyPanel,
    });
    const domContract = setup.dom || { filters: [], countText: null, listboxRole: null };
    check(
      'setup:dom-contract',
      Boolean(setup.dom) &&
        domContract.countText !== null &&
        domContract.filters.length === 3 &&
        domContract.listboxRole === 'listbox',
      {
        filters: domContract.filters.map((f) => f.filter),
        listboxRole: domContract.listboxRole,
        countText: domContract.countText,
      },
    );
    check('setup:longtask-observer', setup.observer === true, { observer: setup.observer });
  }
  const ready = Boolean(setup && setup.hasHook && setup.missingHooks.length === 0);
  if (!ready) {
    warn('setup:not-ready', {
      hint: 'dist 可能未构建/未冻结：先跑 `node build.mjs`；HTTP 页面需暴露 window.__tjv（非扩展）',
    });
  }

  /* ---- 1) .mock/1.json 搜索 ---- */
  const mockPhase = ready
    ? await runPhase('mock', pageMockPhase, {
        url: `${server.base}/${MOCK_SAMPLE}`,
        name: path.basename(MOCK_SAMPLE),
        term: MOCK_TERM,
      })
    : null;
  if (mockPhase) {
    report.mock = mockPhase;
    const s = mockPhase.search || {};
    const d = mockPhase.dom || {};
    const diag = mockPhase.diag || {};
    const total = s.total;
    metric('mock', {
      bytes: mockPhase.bytes,
      treeRows: mockPhase.treeRows,
      searchMs: mockPhase.searchMsObserved,
      hookMs: s.ms,
      hits: total,
      size: s.size,
      phase: s.phase,
      current: s.current,
      rendered: diag.rendered,
      visibleRows: d.visibleRows,
      spacerHeight: d.spacerHeight,
      countText: d.countText,
      posText: d.posText,
      footText: d.footText,
      longTasks: longTasksOf(mockPhase),
    });

    check('mock:load', mockPhase.rowsAppeared && mockPhase.treeRows > 0, {
      treeRows: mockPhase.treeRows,
      bytes: mockPhase.bytes,
    });
    check('mock:search:accepted', s.ok !== false && s.phase === 'ready' && s.stale === false, {
      ok: s.ok,
      phase: s.phase,
      stale: s.stale,
    });
    check('mock:search:ms<100', mockPhase.searchMsObserved < 100 && Number(s.ms) < 100, {
      observedMs: mockPhase.searchMsObserved,
      hookMs: s.ms,
    });
    check('mock:search:hits==reference', total === refMock.total, {
      reference: refMock.total,
      observed: total,
      documented: DOCUMENTED_HITS.mockHotel,
      legacyBaseline: LEGACY_BASELINE_HITS.mockHotel,
      note: '历史基准见 qa-editing-and-search.md §2.3；契约 §6 已更新为 186',
    });
    check('mock:search:size==total(all)', s.size === total && s.current === 0, {
      size: s.size,
      total,
      current: s.current,
    });
    check('mock:render:bounded', diag.rendered > 0 && diag.rendered <= 40 && d.visibleRows > 0 && d.visibleRows <= 40, {
      rendered: diag.rendered,
      visibleRows: d.visibleRows,
    });
    check('mock:spacer==size*44', Math.abs((d.spacerHeight || 0) - (s.size || 0) * ROW_HEIGHT) <= 1, {
      spacerHeight: d.spacerHeight,
      expected: (s.size || 0) * ROW_HEIGHT,
      styleHeight: d.spacerStyleHeight,
    });
    check('mock:count-text==total', digits(d.countText) === total, {
      countText: d.countText,
      expected: total,
    });
    const pos = parsePos(d.posText);
    check('mock:pos-text', Boolean(pos) && pos.denominator === s.size && pos.numerator === s.current + 1, {
      posText: d.posText,
      parsed: pos,
      expected: { numerator: s.current + 1, denominator: s.size },
    });
    check('mock:foot', d.footHidden === false && String(d.footText || '').includes('已渲染') && d.footTotal === s.size, {
      footHidden: d.footHidden,
      footText: d.footText,
      footTotal: d.footTotal,
      size: s.size,
    });
    check('mock:empty-hidden', d.emptyVisible === false, { emptyVisible: d.emptyVisible });
    check('mock:tree-hit-highlight', d.treeHitRows > 0 && d.treeHitMarks > 0, {
      treeHitRows: d.treeHitRows,
      treeHitMarks: d.treeHitMarks,
    });
    check('mock:tree-mark-only-in-hit-rows', d.treeMarksOutsideHitRows === 0 && d.treeVisibleMarks > 0 && d.treeVisibleMarks === d.treeVisibleHitMarks && d.treeMarks === d.treeVisibleMarks, {
      treeVisibleMarks: d.treeVisibleMarks,
      treeVisibleHitMarks: d.treeVisibleHitMarks,
      treeMarksOutsideHitRows: d.treeMarksOutsideHitRows,
      treeMarks: d.treeMarks,
      treeMarksHidden: d.treeMarksHidden,
      note: 'review 修复：可见 <mark> 只在 is-hit 行；hidden 行池已清空文本（幽灵 mark = 0）',
    });
    check('mock:result-field', d.firstFieldText !== null && ['键名', '值'].includes(d.firstFieldText) && d.fieldCount === d.visibleRows && d.fieldTexts.every((t) => t === '键名' || t === '值'), {
      firstFieldText: d.firstFieldText,
      fieldTexts: d.fieldTexts,
      fieldCount: d.fieldCount,
      visibleRows: d.visibleRows,
      note: '首个可见 .result .result__field ∈ {键名, 值}',
    });
    check('mock:input-synced', mockPhase.inputValue === MOCK_TERM, {
      inputValue: mockPhase.inputValue,
    });
    const mockLong = longTasksOf(mockPhase);
    check('mock:longtasks<=50ms', maxLongTask(mockLong) <= 50, {
      count: mockLong.length,
      maxMs: maxLongTask(mockLong),
      tasks: mockLong,
    });
    if (mockLong.length > 0) warn('mock:longtasks', mockLong);

    await page.screenshot(path.join(SHOTS, 'search-mock.png'));
    report.screenshots = [path.join(SHOTS, 'search-mock.png')];
  }

  /* ---- 2) searchJump(0) ---- */
  const jumpPhase = mockPhase
    ? await runPhase('jump', pageJumpPhase, { index: 0 })
    : null;
  if (jumpPhase) {
    report.jump = jumpPhase;
    const d = jumpPhase.dom || {};
    const diag = jumpPhase.diag || {};
    const jump = jumpPhase.jump || {};
    metric('jump', {
      hookMs: jump.ms,
      wallMs: jumpPhase.ms,
      treeAppearMs: jumpPhase.appearMs,
      index: jump.index,
      current: diag.current,
      path: jump.path,
      treeCurrentVisible: diag.treeCurrentVisible,
    });
    check('jump:index', jump.index === 0 && diag.current === 0, {
      index: jump.index,
      current: diag.current,
      path: jump.path,
    });
    check('jump:tree-current', jumpPhase.currentAppeared && d.treeCurrent === true && diag.treeCurrentVisible === true, {
      appeared: jumpPhase.currentAppeared,
      treeCurrent: d.treeCurrent,
      diagTreeCurrent: diag.treeCurrentVisible,
      appearMs: jumpPhase.appearMs,
    });
    check('jump:result-selected', d.selectedRow === true && d.selectedIndex === 0, {
      selectedRow: d.selectedRow,
      selectedIndex: d.selectedIndex,
    });
    check('jump:ms<=16.7', Number(jump.ms) <= 16.7, {
      hookMs: jump.ms,
      wallMs: jumpPhase.ms,
      appearMs: jumpPhase.appearMs,
      spec: '目标 ≤1 帧（16.7ms）；含 worker expandTo 往返',
    });
    if (jumpPhase.appearMs > 50) {
      warn('jump:appear-slow', {
        hookMs: jump.ms,
        appearMs: jumpPhase.appearMs,
        note: 'hook 已返回但树 .row.is-current 出现更晚（异步行窗口），仅供参考',
      });
    }
  }

  /* ---- 2.5) 双击结果行 = 复制（ADR-0010 修订 / ADR-0011 修订） ---- */
  const dblCopyPhase = jumpPhase ? await runPhase('dblcopy', pageDblCopyPhase) : null;
  if (dblCopyPhase) {
    report.dblCopy = dblCopyPhase;
    check(
      'dblcopy:default-path',
      dblCopyPhase.defaultFormat === 'path' &&
        dblCopyPhase.defaultClip === dblCopyPhase.path &&
        /已复制：路径/.test(dblCopyPhase.defaultToast || ''),
      {
        format: dblCopyPhase.defaultFormat,
        path: dblCopyPhase.path,
        clip: dblCopyPhase.defaultClip,
        toast: dblCopyPhase.defaultToast,
      },
    );
    check(
      'dblcopy:subtree-json',
      dblCopyPhase.subtree?.format === 'subtree' &&
        dblCopyPhase.subtree?.jsonOk === true &&
        /已复制：子树 JSON/.test(dblCopyPhase.subtree?.toast || ''),
      {
        format: dblCopyPhase.subtree?.format,
        jsonOk: dblCopyPhase.subtree?.jsonOk,
        toast: dblCopyPhase.subtree?.toast,
      },
    );
    check(
      'dblcopy:format-not-applicable',
      Boolean(dblCopyPhase.badFormat?.path) && /不支持当前复制格式/.test(dblCopyPhase.badFormat?.toast || ''),
      { path: dblCopyPhase.badFormat?.path, toast: dblCopyPhase.badFormat?.toast },
    );
  }

  /* ---- 3) prev/next 多轮（含环状） ---- */
  const navPhase = jumpPhase ? await runPhase('nav', pageNavPhase, { rounds: 5 }) : null;
  if (navPhase) {
    report.nav = navPhase;
    const steps = navPhase.steps || [];
    const size = navPhase.size;
    const forward = steps.slice(0, 5);
    const backward = steps.slice(5, 10);
    const jumpLast = steps[10];
    const nextWrap = steps[11];
    const prevWrap = steps[12];
    const expectForward = [1, 2, 3, 4, 5];
    const expectBackward = [4, 3, 2, 1, 0];
    const forwardOk = forward.length === 5 && forward.every((st, i) => st.current === expectForward[i]);
    const backwardOk = backward.length === 5 && backward.every((st, i) => st.current === expectBackward[i]);
    metric('nav', {
      size,
      steps: steps.length,
      forwardCurrents: forward.map((st) => st.current),
      backwardCurrents: backward.map((st) => st.current),
      maxMs: Math.max(...steps.map((st) => st.ms), 0),
      maxHookMs: Math.max(...steps.map((st) => st.hookMs || 0), 0),
      maxRendered: Math.max(...steps.map((st) => st.rendered || 0), 0),
      maxLongTaskMs: Math.max(...steps.map((st) => maxLongTask(st.longTasks)), 0),
    });
    check('nav:forward', forwardOk, {
      currents: forward.map((st) => st.current),
      expected: expectForward,
    });
    check('nav:backward', backwardOk, {
      currents: backward.map((st) => st.current),
      expected: expectBackward,
    });
    check('nav:jump-last', Boolean(jumpLast) && jumpLast.current === size - 1, {
      current: jumpLast && jumpLast.current,
      expected: size - 1,
    });
    check('nav:wrap-forward', Boolean(nextWrap) && nextWrap.current === 0, {
      current: nextWrap && nextWrap.current,
      expected: 0,
    });
    check('nav:wrap-backward', Boolean(prevWrap) && prevWrap.current === size - 1, {
      current: prevWrap && prevWrap.current,
      expected: size - 1,
    });
    check('nav:tree-current-all', steps.length === 13 && steps.every((st) => st.treeCurrent === true && st.appeared === true), {
      steps: steps.length,
      failed: steps.filter((st) => !(st.treeCurrent && st.appeared)).map((st) => st.kind),
    });
    check('nav:render-bounded', steps.every((st) => st.rendered > 0 && st.rendered <= 40 && st.visibleRows <= 40), {
      maxRendered: Math.max(...steps.map((st) => st.rendered || 0)),
      maxVisible: Math.max(...steps.map((st) => st.visibleRows || 0)),
    });
    check('nav:no-longtask>50ms', steps.every((st) => maxLongTask(st.longTasks) <= 50), {
      worst: steps.reduce((worst, st) => (maxLongTask(st.longTasks) > maxLongTask(worst ? worst.longTasks : []) ? st : worst), null)?.kind || null,
      maxMs: Math.max(...steps.map((st) => maxLongTask(st.longTasks)), 0),
    });
  }

  /* ---- 4) 过滤 all/key/value ---- */
  const filterPhase = navPhase ? await runPhase('filter', pageFilterPhase) : null;
  if (filterPhase) {
    report.filters = filterPhase;
    const steps = Object.fromEntries((filterPhase.steps || []).map((st) => [st.filter, st]));
    const keyStep = steps.key;
    const valueStep = steps.value;
    const allStep = steps.all;
    const sizes = {
      all: allStep ? allStep.result.size : null,
      key: keyStep ? keyStep.result.size : null,
      value: valueStep ? valueStep.result.size : null,
    };
    metric('filters', {
      sizes,
      counts: allStep ? allStep.result.counts || null : null,
      domCounts: allStep ? allStep.dom.filters.map((f) => ({ filter: f.filter, count: digits(f.count) })) : null,
    });
    check('filter:sizes', sizes.key + sizes.value === sizes.all && sizes.all === refMock.total, {
      sizes,
      reference: { all: refMock.total, key: refMock.key, value: refMock.value },
    });
    check('filter:key-dom', Boolean(keyStep) && keyStep.result.size === refMock.key && keyStep.dom.leafKeys.every((k) => k.toLowerCase().includes(MOCK_TERM)) && keyStep.dom.pathMarks === keyStep.dom.visibleRows, {
      size: keyStep && keyStep.result.size,
      expectedSize: refMock.key,
      leafKeys: keyStep && keyStep.dom.leafKeys,
      pathMarks: keyStep && keyStep.dom.pathMarks,
      visibleRows: keyStep && keyStep.dom.visibleRows,
    });
    check('filter:value-dom', Boolean(valueStep) && valueStep.result.size === refMock.value && valueStep.dom.leafKeys.every((k) => !k.toLowerCase().includes(MOCK_TERM)) && valueStep.dom.valueMarks > 0, {
      size: valueStep && valueStep.result.size,
      expectedSize: refMock.value,
      leafKeys: valueStep && valueStep.dom.leafKeys,
      valueMarks: valueStep && valueStep.dom.valueMarks,
      visibleRows: valueStep && valueStep.dom.visibleRows,
    });
    check('filter:active-state', Boolean(keyStep && valueStep && allStep) && keyStep.dom.activeFilter === 'key' && valueStep.dom.activeFilter === 'value' && allStep.dom.activeFilter === 'all' && keyStep.dom.filters.every((f) => (f.filter === 'key') === (f.pressed === 'true')), {
      keyActive: keyStep && keyStep.dom.activeFilter,
      valueActive: valueStep && valueStep.dom.activeFilter,
      allActive: allStep && allStep.dom.activeFilter,
      states: allStep && allStep.dom.filters,
    });
    check('filter:reset', Boolean(allStep) && allStep.result.filter === 'all' && allStep.result.size === allStep.result.total, {
      filter: allStep && allStep.result.filter,
      size: allStep && allStep.result.size,
      total: allStep && allStep.result.total,
    });
    check('filter:count-text', Boolean(allStep) && digits(allStep.dom.countText) === allStep.result.total && digits(allStep.dom.countText) === digits(allStep.dom.filters[0].count), {
      countText: allStep && allStep.dom.countText,
      total: allStep && allStep.result.total,
      domCounts: allStep && allStep.dom.filters,
    });
    check('filter:render-bounded', (filterPhase.steps || []).every((st) => st.diag.rendered > 0 && st.diag.rendered <= 40 && st.dom.visibleRows <= 40), {
      rendered: (filterPhase.steps || []).map((st) => ({ filter: st.filter, rendered: st.diag.rendered, visible: st.dom.visibleRows })),
    });
    // review 修复：顶部 #searchCount = 未过滤 total，而 #searchPos 分母 = 过滤后 size
    check(
      'filter:pos-denominator==size',
      (filterPhase.steps || []).every((st) => {
        const pos = parsePos(st.dom.posText);
        return (
          Boolean(pos) &&
          pos.denominator === st.result.size &&
          digits(st.dom.countText) === st.result.total &&
          pos.numerator === (st.result.current >= 0 ? st.result.current + 1 : 0)
        );
      }),
      {
        steps: (filterPhase.steps || []).map((st) => ({
          filter: st.filter,
          size: st.result.size,
          total: st.result.total,
          countText: st.dom.countText,
          posText: st.dom.posText,
        })),
      },
    );
    // setFilter 不再重算 counts：all/key/value 三个快照里 counts 与 DOM counts 保持稳定
    const countsOf = (st) => (st && st.result.counts ? st.result.counts : null);
    const stableCounts =
      Boolean(allStep && keyStep && valueStep) &&
      JSON.stringify(countsOf(allStep)) === JSON.stringify(countsOf(keyStep)) &&
      JSON.stringify(countsOf(allStep)) === JSON.stringify(countsOf(valueStep)) &&
      countsOf(allStep).all === refMock.total &&
      countsOf(allStep).key === refMock.key &&
      countsOf(allStep).value === refMock.value;
    check('filter:counts-stable', stableCounts && (filterPhase.steps || []).every((st) => digits(st.dom.filters[0].count) === refMock.total && digits(st.dom.filters[1].count) === refMock.key && digits(st.dom.filters[2].count) === refMock.value), {
      counts: { all: countsOf(allStep), key: countsOf(keyStep), value: countsOf(valueStep) },
      domCounts: (filterPhase.steps || []).map((st) => ({ filter: st.filter, counts: st.dom.filters.map((f) => digits(f.count)) })),
      reference: { all: refMock.total, key: refMock.key, value: refMock.value },
    });
    // .result__field 与过滤一致
    check('filter:result-field', Boolean(keyStep && valueStep && allStep) && keyStep.dom.fieldTexts.every((t) => t === '键名') && valueStep.dom.fieldTexts.every((t) => t === '值') && allStep.dom.fieldTexts.every((t) => t === '键名' || t === '值'), {
      keyFields: keyStep && keyStep.dom.fieldTexts,
      valueFields: valueStep && valueStep.dom.fieldTexts,
      allFields: allStep && allStep.dom.fieldTexts,
    });
  }

  /* ---- 4.5) stale（review 新增 dev hook `searchMarkStale()`） ---- */
  const stalePhase = filterPhase ? await runPhase('stale', pageStalePhase) : null;
  if (stalePhase) {
    report.stale = stalePhase;
    const before = stalePhase.before || {};
    const stale = stalePhase.stale || {};
    const stDiag = stalePhase.staleDiag || {};
    const stDom = stalePhase.staleDom || {};
    const restored = stalePhase.restored || {};
    const stPos = parsePos(stDom.posText);
    metric('stale', {
      ms: stalePhase.ms,
      changed: stale.changed,
      phase: stale.phase,
      size: stDiag.size,
      emptyText: stDom.emptyText,
      treeHitRows: stDom.treeHitRows,
      treeVisibleMarks: stDom.treeVisibleMarks,
      treeMarksOutsideHitRows: stDom.treeMarksOutsideHitRows,
      treeMarksHidden: stDom.treeMarksHidden,
      countText: stDom.countText,
      posText: stDom.posText,
      restoredPhase: restored.diag && restored.diag.phase,
      restoredSize: restored.diag && restored.diag.size,
    });
    check(
      'stale:hook',
      stale.phase === 'stale' &&
        stale.changed === true &&
        stDiag.phase === 'stale' &&
        stDiag.stale === true &&
        stDiag.size === 0,
      { before: { phase: before.diag && before.diag.phase, size: before.diag && before.diag.size }, stale, staleDiag: { phase: stDiag.phase, stale: stDiag.stale, size: stDiag.size } },
    );
    check(
      'stale:empty-text',
      stDom.emptyVisible === true && stDom.emptyText === '文档已修改，请重新搜索',
      { emptyVisible: stDom.emptyVisible, emptyText: stDom.emptyText },
    );
    check(
      'stale:controls',
      digits(stDom.countText) === 0 &&
        Boolean(stPos) &&
        stPos.numerator === 0 &&
        stPos.denominator === 0 &&
        stDom.prevDisabled === true &&
        stDom.nextDisabled === true &&
        stDom.footHidden === true,
      {
        countText: stDom.countText,
        posText: stDom.posText,
        prevDisabled: stDom.prevDisabled,
        nextDisabled: stDom.nextDisabled,
        footHidden: stDom.footHidden,
      },
    );
    check(
      'stale:tree-cleared',
      stDom.treeHitRows === 0 &&
        stDom.treeCurrent === false &&
        stDom.treeVisibleMarks === 0 &&
        stDom.treeMarksOutsideHitRows === 0 &&
        stDom.visibleRows === 0,
      {
        treeHitRows: stDom.treeHitRows,
        treeCurrent: stDom.treeCurrent,
        treeVisibleMarks: stDom.treeVisibleMarks,
        treeMarksOutsideHitRows: stDom.treeMarksOutsideHitRows,
        treeMarksHidden: stDom.treeMarksHidden,
        visibleRows: stDom.visibleRows,
      },
    );
    // task-8：原 stale:hidden-pool-residue warning 升级为断言（含 hidden 行池）
    check(
      'stale:tree-mark-total==0',
      stDom.treeMarks === 0 && stDom.treeMarksHidden === 0,
      {
        treeMarks: stDom.treeMarks,
        treeMarksHidden: stDom.treeMarksHidden,
        note: 'stale 后树里 .row mark 总数 === 0（含 hidden 行池）',
      },
    );
    check(
      'stale:restore',
      Boolean(restored.diag) &&
        restored.diag.phase === 'ready' &&
        restored.diag.size === refMock.total &&
        restored.diag.stale === false &&
        Boolean(restored.dom) &&
        restored.dom.visibleRows > 0 &&
        restored.dom.treeHitRows > 0,
      {
        restored: restored.diag ? { phase: restored.diag.phase, size: restored.diag.size, stale: restored.diag.stale } : null,
        expectedSize: refMock.total,
        restoredVisibleRows: restored.dom && restored.dom.visibleRows,
        restoredTreeHitRows: restored.dom && restored.dom.treeHitRows,
        note: 'stale 后再 search(hotel) 恢复 ready/186',
      },
    );
  }

  /* ---- 5) 10MB 全量搜索 ---- */
  const bigPhase = filterPhase
    ? await runPhase('big', pageBigPhase, {
        url: `${server.base}/${BIG_SAMPLE}`,
        name: path.basename(BIG_SAMPLE),
        term: BIG_TERM,
      })
    : null;
  if (bigPhase) {
    report.big = bigPhase;
    const s = bigPhase.search || {};
    const d = bigPhase.dom || {};
    const diag = bigPhase.diag || {};
    metric('big', {
      bytes: bigPhase.bytes,
      totalRows: bigPhase.state ? bigPhase.state.totalRows : null,
      searchMs: bigPhase.searchMsObserved,
      hookMs: s.ms,
      hits: s.total,
      size: s.size,
      truncated: s.truncated,
      rendered: diag.rendered,
      visibleRows: d.visibleRows,
      spacerHeight: d.spacerHeight,
      countText: d.countText,
      longTasks: longTasksOf(bigPhase),
    });
    check('big:load', bigPhase.rowsAppeared && bigPhase.state && bigPhase.state.totalRows > 0, {
      totalRows: bigPhase.state && bigPhase.state.totalRows,
      bytes: bigPhase.bytes,
    });
    check('big:search:hits==reference', s.total === refBig.total && s.truncated === refBig.truncated, {
      reference: { capped: refBig, raw: rawBig },
      observed: { total: s.total, truncated: s.truncated, size: s.size },
      documented: DOCUMENTED_HITS,
      legacyBaseline: LEGACY_BASELINE_HITS.bigHotel,
    });
    check('big:search:ms<=120', Number(s.ms) <= 120, {
      hookMs: s.ms,
      observedMs: bigPhase.searchMsObserved,
      spec: 'hook 43–120ms',
    });
    if (Number(s.ms) < 43) {
      warn('big:search:ms-low', {
        hookMs: s.ms,
        observedMs: bigPhase.searchMsObserved,
        band: '43–120',
        note: '低于 spec 下沿（更快），仅记录',
      });
    }
    const bigLong = longTasksOf(bigPhase);
    check('big:search:maxLongTask<=50', maxLongTask(bigLong) <= 50, {
      count: bigLong.length,
      maxMs: maxLongTask(bigLong),
      tasks: bigLong,
      spec: '0 个 >50ms 长任务',
    });
    check('big:render:bounded', diag.rendered > 0 && diag.rendered <= 40 && d.visibleRows > 0 && d.visibleRows <= 40, {
      rendered: diag.rendered,
      visibleRows: d.visibleRows,
    });
    check('big:spacer==size*44', Math.abs((d.spacerHeight || 0) - (s.size || 0) * ROW_HEIGHT) <= 1, {
      spacerHeight: d.spacerHeight,
      expected: (s.size || 0) * ROW_HEIGHT,
    });
    check('big:count-text', digits(d.countText) === s.total && (s.truncated ? String(d.countText || '').endsWith('+') : true), {
      countText: d.countText,
      total: s.total,
      truncated: s.truncated,
    });
    check('big:foot-truncated', String(d.footText || '').includes('已截断') && String(d.footText || '').includes('50,000'), {
      footText: d.footText,
      footHidden: d.footHidden,
    });
    check('big:empty-hidden', d.emptyVisible === false, { emptyVisible: d.emptyVisible });
    check('big:result-field', d.firstFieldText !== null && ['键名', '值'].includes(d.firstFieldText) && d.fieldCount === d.visibleRows, {
      firstFieldText: d.firstFieldText,
      fieldCount: d.fieldCount,
      visibleRows: d.visibleRows,
    });
    check('big:tree-mark-only-in-hit-rows', d.treeMarksOutsideHitRows === 0 && d.treeVisibleMarks === 0, {
      treeVisibleMarks: d.treeVisibleMarks,
      treeMarksOutsideHitRows: d.treeMarksOutsideHitRows,
      note: '10MB 初始窗口无命中行 → 可见 mark 应为 0',
    });
    // task-8：原 tree:hidden-pool-residue warning 升级为断言（含 hidden 行池）
    check('big:tree-mark-total==0', d.treeMarks === 0 && d.treeMarksHidden === 0, {
      treeMarks: d.treeMarks,
      treeMarksHidden: d.treeMarksHidden,
      note: '10MB 加载后树里 .row mark 总数 === 0（含 hidden 行池）',
    });

    await page.screenshot(path.join(SHOTS, 'search-10mb.png'));
    report.screenshots = (report.screenshots || []).concat(path.join(SHOTS, 'search-10mb.png'));
  }

  /* ---- 6) 结果列表滚动 0/25/50/95% ---- */
  const scrollPhase = bigPhase
    ? await runPhase('scroll', pageScrollPhase, { percents: [0, 25, 50, 95] })
    : null;
  if (scrollPhase) {
    report.scroll = scrollPhase;
    const steps = scrollPhase.steps || [];
    const percentOk = steps.length === 4 && steps.every((st, i) => st.pct === [0, 25, 50, 95][i]);
    const bounded = steps.every((st) => st.rendered > 0 && st.rendered <= 40 && st.visibleRows > 0 && st.visibleRows <= 40);
    const uniqueIdx = new Set(steps.map((st) => st.firstIndex)).size;
    const ordered = steps.every((st, i) => i === 0 || st.firstIndex > steps[i - 1].firstIndex);
    const longs = steps.flatMap((st) => st.longTasks || []);
    metric('scroll', {
      steps: steps.map((st) => ({
        pct: st.pct,
        target: st.target,
        scrollTop: st.scrollTop,
        firstIndex: st.firstIndex,
        lastIndex: st.lastIndex,
        visibleRows: st.visibleRows,
        rendered: st.rendered,
      })),
      maxRendered: Math.max(...steps.map((st) => st.rendered || 0), 0),
      maxVisible: Math.max(...steps.map((st) => st.visibleRows || 0), 0),
      longTasks: longs,
    });
    check('scroll:positions', percentOk && steps.every((st) => st.applied), {
      steps: steps.map((st) => ({ pct: st.pct, applied: st.applied, scrollTop: st.scrollTop, target: st.target })),
    });
    check('scroll:render-bounded<=40', bounded, {
      rendered: steps.map((st) => ({ pct: st.pct, rendered: st.rendered, visible: st.visibleRows })),
    });
    check('scroll:window-moves', uniqueIdx >= 3 && ordered, {
      firstIndexes: steps.map((st) => st.firstIndex),
      unique: uniqueIdx,
    });
    check('scroll:spacer-stable', steps.every((st) => Math.abs((st.spacerHeight || 0) - steps[0].spacerHeight) <= 1), {
      spacerHeights: steps.map((st) => st.spacerHeight),
    });
    check('scroll:maxLongTask<=50', maxLongTask(longs) <= 50, {
      count: longs.length,
      maxMs: maxLongTask(longs),
      tasks: longs,
      spec: '滚动过程 0 个 >50ms 长任务',
    });
  }

  /* ---- 7) truncated（>50k 命中词） ---- */
  const truncPhase = scrollPhase
    ? await runPhase('trunc', pageTruncPhase, { term: TRUNC_TERM })
    : null;
  if (truncPhase) {
    report.truncated = truncPhase;
    const s = truncPhase.search || {};
    const d = truncPhase.dom || {};
    const diag = truncPhase.diag || {};
    metric('truncated', {
      term: TRUNC_TERM,
      ms: truncPhase.ms,
      total: s.total,
      truncated: s.truncated,
      size: s.size,
      countText: d.countText,
      footText: d.footText,
      rendered: diag.rendered,
      reference: refBigE,
    });
    check('trunc:hits==limit', s.total === SEARCH_LIMIT && s.truncated === true, {
      total: s.total,
      truncated: s.truncated,
      limit: SEARCH_LIMIT,
      reference: refBigE,
    });
    check('trunc:count-text-50,000+', String(d.countText || '') === '50,000+', { countText: d.countText });
    check('trunc:foot-hint', d.footHidden === false && String(d.footText || '').includes('已截断') && String(d.footText || '').includes('50,000'), {
      footText: d.footText,
      footHidden: d.footHidden,
    });
    check('trunc:render-bounded', diag.rendered > 0 && diag.rendered <= 40 && d.visibleRows > 0 && d.visibleRows <= 40, {
      rendered: diag.rendered,
      visibleRows: d.visibleRows,
    });
    const truncLong = longTasksOf(truncPhase);
    check('trunc:maxLongTask<=50', maxLongTask(truncLong) <= 50, {
      count: truncLong.length,
      maxMs: maxLongTask(truncLong),
    });
    check('trunc:result-field', d.firstFieldText !== null && ['键名', '值'].includes(d.firstFieldText), {
      firstFieldText: d.firstFieldText,
    });
  }

  /* ---- 8) 空查询 / 无命中态 ---- */
  const statesPhase = truncPhase ? await runPhase('states', pageStatesPhase, { noHitTerm: NO_HIT_TERM }) : null;
  if (statesPhase) {
    report.states = statesPhase;
    const idle = statesPhase.idle || {};
    const nohit = statesPhase.nohit || {};
    const idleDom = idle.dom || {};
    const nohitDom = nohit.dom || {};
    metric('states', {
      idle: { phase: idle.diag && idle.diag.phase, size: idle.diag && idle.diag.size, emptyText: idleDom.emptyText },
      nohit: { phase: nohit.diag && nohit.diag.phase, size: nohit.diag && nohit.diag.size, emptyText: nohitDom.emptyText },
    });
    check('idle:query', idle.search && idle.search.phase === 'idle' && idleDom.emptyVisible === true && idleDom.emptyText === '输入关键词搜索键名或字符串值' && idleDom.visibleRows === 0, {
      phase: idle.search && idle.search.phase,
      emptyText: idleDom.emptyText,
      emptyVisible: idleDom.emptyVisible,
      visibleRows: idleDom.visibleRows,
    });
    check('idle:controls', idleDom.footHidden === true && idleDom.prevDisabled === true && idleDom.nextDisabled === true && digits(idleDom.countText) === 0, {
      footHidden: idleDom.footHidden,
      prevDisabled: idleDom.prevDisabled,
      nextDisabled: idleDom.nextDisabled,
      countText: idleDom.countText,
    });
    check('idle:tree-cleared', idleDom.treeHitRows === 0 && idleDom.treeCurrent === false, {
      treeHitRows: idleDom.treeHitRows,
      treeCurrent: idleDom.treeCurrent,
    });
    check('nohit:query', nohit.search && nohit.search.phase === 'ready' && nohitDom.emptyVisible === true && String(nohitDom.emptyText || '').includes('没有命中') && String(nohitDom.emptyText || '').includes(NO_HIT_TERM) && nohitDom.visibleRows === 0, {
      phase: nohit.search && nohit.search.phase,
      size: nohit.search && nohit.search.size,
      emptyText: nohitDom.emptyText,
      visibleRows: nohitDom.visibleRows,
      reference: refNoHit.total,
    });
    check('nohit:controls', nohitDom.footHidden === true && nohitDom.prevDisabled === true && nohitDom.nextDisabled === true && digits(nohitDom.countText) === 0, {
      footHidden: nohitDom.footHidden,
      prevDisabled: nohitDom.prevDisabled,
      nextDisabled: nohitDom.nextDisabled,
      countText: nohitDom.countText,
    });
  }

  /* ---- 搜索选项 Aa / 正则（ADR-0014；真实点击开关 + 输入框） ---- */
  const optionsPhase = statesPhase
    ? await runPhase('options', pageOptionsPhase, {
        term: 'hotel',
        regex: '^hotel$',
        badRegex: '(',
        unsafeRegex: '(a+)+',
        doc: { Hotel: 1, hotel: 2, HOTEL: 3, list: ['HoTel', 'xhotelx'], deep: { Hotel: 'v' } },
      })
    : null;
  if (optionsPhase) {
    report.options = optionsPhase;
    const d = optionsPhase.defaultMode || {};
    const c = optionsPhase.caseOnly || {};
    const r = optionsPhase.regexOnly || {};
    const rc = optionsPhase.regexCase || {};
    const bad = optionsPhase.badPattern || {};
    const unsafe = optionsPhase.unsafePattern || {};
    const rec = optionsPhase.recovered || {};
    const clr = optionsPhase.cleared || {};
    metric('options', {
      panelOpen: optionsPhase.panelOpen,
      defaultSize: d.diag && d.diag.size,
      caseSize: c.diag && c.diag.size,
      regexSize: r.diag && r.diag.size,
      regexCaseSize: rc.diag && rc.diag.size,
      badError: bad.diag && bad.diag.patternError,
      recoveredSize: rec.diag && rec.diag.size,
    });
    check('options:panel-open', optionsPhase.panelOpen === true, { panelOpen: optionsPhase.panelOpen });
    check(
      'options:default-ci-substring',
      d.diag?.size === 6 && d.diag?.caseSensitive === false && d.diag?.regex === false && d.ariaPressed?.case === 'false' && d.ariaPressed?.regex === 'false',
      { size: d.diag?.size, pressed: d.ariaPressed, expect: 6, note: '键 Hotel/hotel/HOTEL/deep.Hotel 4 + 值 HoTel/xhotelx 2' },
    );
    check(
      'options:case-sensitive',
      c.diag?.size === 2 && c.diag?.caseSensitive === true && c.ariaPressed?.case === 'true' && c.inputInvalid === null,
      { size: c.diag?.size, pressed: c.ariaPressed, expect: 2, note: '键 hotel 1 + 值 xhotelx 1' },
    );
    check(
      'options:regex',
      r.diag?.size === 5 && r.diag?.regex === true && r.diag?.caseSensitive === false && r.ariaPressed?.regex === 'true' && r.inputInvalid === null,
      { size: r.diag?.size, pressed: r.ariaPressed, expect: 5, note: '/^hotel$/i：键 4 + 值 HoTel 1（子串模式不可能有锚点语义）' },
    );
    check(
      'options:regex+case',
      rc.diag?.size === 1 && rc.diag?.regex === true && rc.diag?.caseSensitive === true,
      { size: rc.diag?.size, expect: 1, note: '/^hotel$/：只有键 hotel' },
    );
    check(
      'options:bad-pattern-inline-error',
      typeof bad.diag?.patternError === 'string' &&
        /正则/.test(bad.diag.patternError) &&
        bad.inputInvalid === 'true' &&
        bad.errorHidden === false &&
        bad.dom?.visibleRows === 0 &&
        bad.dom?.treeHitRows === 0,
      {
        error: bad.diag?.patternError,
        inputInvalid: bad.inputInvalid,
        errorHidden: bad.errorHidden,
        visibleRows: bad.dom?.visibleRows,
        treeHitRows: bad.dom?.treeHitRows,
        note: '无效正则 → 内联错误 + 结果/树高亮清空（不是「无命中」态）',
      },
    );
    check(
      'options:bad-pattern-no-toast',
      bad.diag?.phase === 'idle' && optionsPhase.badPatternToastHidden === true,
      { phase: bad.diag?.phase, toastHidden: optionsPhase.badPatternToastHidden },
    );
    check(
      'options:unsafe-pattern-rejected',
      typeof unsafe.diag?.patternError === 'string' && /灾难性回溯/.test(unsafe.diag.patternError),
      { error: unsafe.diag?.patternError, note: '嵌套量词 (a+)+ 被安全筛查拒绝（ADR-0014 §2.4）' },
    );
    check(
      'options:recovered',
      rec.diag?.patternError === null && rec.inputInvalid === null && rec.errorHidden === true && rec.diag?.size === 5,
      { error: rec.diag?.patternError, inputInvalid: rec.inputInvalid, size: rec.diag?.size },
    );
    check(
      'options:cleared',
      clr.diag?.size === 0 && clr.diag?.phase === 'idle' && clr.ariaPressed?.case === 'false' && clr.ariaPressed?.regex === 'false' && clr.diag?.patternError === null,
      { size: clr.diag?.size, phase: clr.diag?.phase, pressed: clr.ariaPressed },
    );
    const optionLong = longTasksOf(optionsPhase);
    check('options:longtasks<=50ms', maxLongTask(optionLong) <= 50, {
      count: optionLong.length,
      maxMs: maxLongTask(optionLong),
    });
    await page.screenshot(path.join(SHOTS, 'search-options.png'));
    report.screenshots = [...(report.screenshots || []), path.join(SHOTS, 'search-options.png')];
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
  check('page:no-exceptions', exceptions.length === 0, { exceptions });
  check('page:no-console-error', consoleErrors.length === 0, { consoleErrors });
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
  `\nsmoke-search: ${report.ok ? 'OK' : 'FAILED'}  (${report.passed}/${checks.length} checks, ${report.failed} failed)`,
);
process.exitCode = report.ok ? 0 : 1;
