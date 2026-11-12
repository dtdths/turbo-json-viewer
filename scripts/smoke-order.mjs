/**
 * scripts/smoke-order.mjs — 子键显示排序（#19 / #40 / ADR-0024）真机冒烟。
 *
 *   node build.mjs && node scripts/smoke-order.mjs
 *
 * 测（显示顺序是 view-only：值图 / 路径 / 复制 / 导出 / 编辑 / 搜索不受影响）：
 *   1) 默认「原始顺序」= 与今天一致（插入序）；
 *   2) 真实点设置面板第 13 行「子键排序」→ 升序 / 降序：根成员与嵌套对象成员按自然序
 *      （`item2 < item10`、大小写忽略、中文按码元序），数组保持索引序；
 *   3) 大文档切档：按**路径**保持视口锚点（scrollTop 落到该节点新行号）；
 *   4) 大纲面板跟随显示序；搜索结果高亮按 path 跟随、不重跑；
 *   5) 表达式结果树跟随显示序；
 *   6) 复制（子树 JSON）与导出文本仍是**值图键序**（不受显示排序影响）；
 *   7) 刷新后设置持久化；刷新后新 load 的文档直接按规则排序（服务级 order）；
 *   8) 0 长任务 / 0 page 异常 / 0 console error。
 * 截图落 `.spike/smoke/order-{settings,anchor,outline,light}.png`。
 */
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { launchChrome, REPO_ROOT } from '../prototype/p1/lib/chrome.mjs';
import { startStaticServer } from '../prototype/p1/lib/http.mjs';

const SHOTS = path.join(REPO_ROOT, '.spike', 'smoke');
await mkdir(SHOTS, { recursive: true });

const ROW_H = 24;
/** 小文档：对象成员故意乱序（含数字感知 / 大小写 / 中文 / 嵌套对象 / 数组） */
const SMALL = '{"zeta":1,"Alpha":2,"item10":3,"item2":4,"beta":{"c":1,"a":2,"b":3},"arr":["x","y"],"中文":5}';
/** 自适应展开后 13 行（root + 7 成员 + beta 的 3 子项 + arr 的 2 元素 + 中文） */
const SMALL_ROWS = 13;
/** 直接子节点用**规范路径**比对（中文键是非标识符 → `$['中文']`） */
const ROOT_RAW = ['$.zeta', '$.Alpha', '$.item10', '$.item2', '$.beta', '$.arr', "$['中文']"];
/** 自然序：Alpha < arr < beta < item2 < item10 < zeta < 中文（中文 U+4E2D > 'z'） */
const ROOT_ASC = ['$.Alpha', '$.arr', '$.beta', '$.item2', '$.item10', '$.zeta', "$['中文']"];
const ROOT_DESC = [...ROOT_ASC].reverse();
const INDENT_2 = JSON.stringify({ c: 1, a: 2, b: 3 }, null, 2);

/** 大文档：300 个标量键 + 根 = 301 行（< 自适应展开阈值 500 → 全展开） */
const BIG_N = 300;
const BIG = (() => {
  const parts = [];
  for (let i = 1; i <= BIG_N; i++) parts.push(`"k${i}":${i}`);
  return `{${parts.join(',')}}`;
})();
const BIG_ROWS = BIG_N + 1;

const DEFAULT_KEYS = [
  'theme',
  'rowHeight',
  'indent',
  'sortOrder',
  'typeColumn',
  'defaultCopyFormat',
  'jsonIndent',
  'searchCopyFormat',
  'exportMode',
  'repairTruncated',
  'adaptiveExpand',
  'advBudget',
  'escapeUnicode',
];

/** 页面内只读助手（DOM 契约：行 `.row[data-path]`、大纲行 `.outline-row[data-path]`） */
const INJECT = `window.__orderRows = () => [...document.querySelectorAll('.row[data-path]')].map((el) => ({
  path: el.dataset.path,
  top: Number.parseFloat(el.style.top || 'NaN'),
  hit: el.classList.contains('is-hit'),
  selected: el.classList.contains('is-selected'),
  text: el.textContent ?? '',
}));
window.__orderPaths = () => window.__orderRows().map((r) => r.path);
/** 直接子节点判定（规范路径三形态）：$.name（无后续段）/ $['非标识符'] / $[i]。 */
window.__orderIsDirectChild = (p) => {
  if (typeof p !== 'string' || p[0] !== '$') return false;
  const rest = p.slice(1);
  if (rest.startsWith('.')) {
    const name = rest.slice(1);
    return name.length > 0 && !name.includes('.') && !name.includes('[') && !name.includes(']');
  }
  if (rest.startsWith("['")) {
    let i = 3;
    for (; i < rest.length; i++) {
      if (rest[i] === '\\\\') { i += 1; continue; }
      if (rest[i] === "'" && rest[i + 1] === ']') return i + 2 === rest.length;
    }
    return false;
  }
  return /^\\[\\d+\\]$/.test(rest);
};
window.__orderTopLevel = () => window.__orderPaths().filter(window.__orderIsDirectChild);
window.__orderTopVisible = () => {
  const rows = window.__orderRows().filter((r) => Number.isFinite(r.top)).sort((a, b) => a.top - b.top);
  const scrolled = window.__tjv.state().scrollTop;
  const hit = rows.find((r) => r.top <= scrolled && scrolled < r.top + ${ROW_H});
  return hit ? hit.path : (rows[0]?.path ?? null);
};
window.__orderSettingRows = () => [...document.querySelectorAll('#settingsPanel [data-setting]')].map((n) => n.dataset.setting ?? '');
window.__orderOutlinePaths = () => [...document.querySelectorAll('.outline-row[data-path]')].map((el) => el.dataset.path);
window.__orderHitPaths = () => [...document.querySelectorAll('.row.is-hit[data-path]')].map((el) => el.dataset.path);
window.__orderLongTasks = [];
try {
  const po = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) window.__orderLongTasks.push(Math.round(entry.duration));
  });
  po.observe({ entryTypes: ['longtask'] });
} catch {}
`;

const server = await startStaticServer(REPO_ROOT);
const chrome = await launchChrome({ windowSize: '1440,900' });
const report = {};
const url = `${server.base}/dist/page.html`;

try {
  const page = await chrome.openPage();
  const errorsBefore = page.exceptions.length;
  await page.setViewport(1440, 900);
  await page.goto(url, { timeoutMs: 20000 });
  await page.waitFor('document.readyState === "complete"', { timeoutMs: 20000 });
  await new Promise((r) => setTimeout(r, 600));
  await page.eval(INJECT);

  const runPhase = async (name, expression) => {
    try {
      Object.assign(report, (await page.eval(expression)) ?? {});
    } catch (error) {
      if (!report.errors) report.errors = {};
      report.errors[name] = String(error?.message ?? error);
      console.warn(`⚠️ phase ${name} failed: ${String(error?.message ?? error)}`);
    }
  };

  // ---- phase 1：默认原始序 + 复制/导出基线 ----
  await runPhase(
    'raw',
    `(async () => {
      const out = {};
      const h = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      await h.loadText(${JSON.stringify(SMALL)}, 'order.json');
      await sleep(450);
      out.raw = {
        order: h.settingsState().sortOrder,
        top: window.__orderTopLevel(),
        totalRows: h.state().totalRows,
        exportText: (await h.exportDocText())?.text ?? null,
        copyBeta: (await h.copyResolve('$.beta', 'subtree'))?.text ?? null,
      };
      return out;
    })()`,
  );

  // ---- phase 2：真实点击设置面板第 13 行 → 升序 ----
  await runPhase(
    'asc',
    `(async () => {
      const out = {};
      const h = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      document.querySelector('[data-panel-btn="settings"]').click();
      await sleep(150);
      out.settingsRows = window.__orderSettingRows();
      const btn = document.querySelector('#settingsPanel [data-setting="sortOrder"] [data-value="key-asc"]');
      if (!btn) throw new Error('missing sortOrder/key-asc segment');
      btn.click();
      await sleep(450);
      out.asc = {
        order: h.settingsState().sortOrder,
        pressed: btn.getAttribute('aria-pressed'),
        top: window.__orderTopLevel(),
        betaChildren: window.__orderPaths().filter((p) => p.startsWith('$.beta.')),
        arrChildren: window.__orderPaths().filter((p) => p.startsWith('$.arr[')),
        totalRows: h.state().totalRows,
        exportText: (await h.exportDocText())?.text ?? null,
        copyBeta: (await h.copyResolve('$.beta', 'subtree'))?.text ?? null,
      };
      return out;
    })()`,
  );
  await page.screenshot(path.join(SHOTS, 'order-settings.png'));

  // ---- phase 3：降序（真实点击）----
  await runPhase(
    'desc',
    `(async () => {
      const out = {};
      const h = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      document.querySelector('#settingsPanel [data-setting="sortOrder"] [data-value="key-desc"]').click();
      await sleep(450);
      out.desc = {
        order: h.settingsState().sortOrder,
        top: window.__orderTopLevel(),
        betaChildren: window.__orderPaths().filter((p) => p.startsWith('$.beta.')),
        totalRows: h.state().totalRows,
      };
      return out;
    })()`,
  );

  // ---- phase 4：大文档切档按路径保持锚点 ----
  await runPhase(
    'anchor',
    `(async () => {
      const out = {};
      const h = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      await h.loadText(${JSON.stringify(BIG)}, 'big.json');
      await sleep(500);
      await h.setSetting('sortOrder', 'key-asc');
      await sleep(500);
      h.scrollToPx(120 * ${ROW_H});
      await sleep(400);
      out.anchorBefore = { scrollTop: h.state().scrollTop, topPath: window.__orderTopVisible(), totalRows: h.state().totalRows };
      await h.setSetting('sortOrder', 'key-desc');
      await sleep(500);
      out.anchorAfter = { scrollTop: h.state().scrollTop, topPath: window.__orderTopVisible(), totalRows: h.state().totalRows };
      return out;
    })()`,
  );
  await page.screenshot(path.join(SHOTS, 'order-anchor.png'));

  // ---- phase 5：大纲跟随 + 搜索高亮跟随（不重跑）----
  await runPhase(
    'outline-search',
    `(async () => {
      const out = {};
      const h = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      await h.loadText(${JSON.stringify(SMALL)}, 'order.json');
      await sleep(450);
      await h.setSetting('sortOrder', 'key-asc');
      await sleep(450);
      document.querySelector('[data-panel-btn="outline"]').click();
      await sleep(500);
      out.outline = { paths: window.__orderOutlinePaths() };
      document.querySelector('[data-panel-btn="search"]').click();
      await sleep(200);
      const search = await h.search('item');
      await sleep(350);
      out.searchAsc = { hits: window.__orderHitPaths(), found: search?.total ?? search?.size ?? null, order: h.settingsState().sortOrder };
      await h.setSetting('sortOrder', 'key-desc');
      await sleep(450);
      out.searchDesc = { hits: window.__orderHitPaths(), top: window.__orderTopLevel() };
      await h.setSetting('sortOrder', 'key-asc');
      await sleep(450);
      return out;
    })()`,
  );
  await page.screenshot(path.join(SHOTS, 'order-outline.png'));

  // ---- phase 6：表达式结果树跟随 ----
  await runPhase(
    'expression',
    `(async () => {
      const out = {};
      const h = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      await h.expressionRunText('$.beta');
      await sleep(600);
      out.exprAsc = { paths: window.__orderPaths(), order: h.settingsState().sortOrder };
      await h.setSetting('sortOrder', 'key-desc');
      await sleep(500);
      out.exprDesc = { paths: window.__orderPaths() };
      await h.setSetting('sortOrder', 'key-asc');
      await sleep(450);
      h.expressionBack();
      await sleep(250);
      return out;
    })()`,
  );

  // ---- phase 7：刷新 → 持久化 + 新 load 直接按规则 ----
  await page.goto(url, { timeoutMs: 20000 });
  await page.waitFor('document.readyState === "complete"', { timeoutMs: 20000 });
  await new Promise((r) => setTimeout(r, 800));
  await page.eval(INJECT);
  await runPhase(
    'reload',
    `(async () => {
      const out = {};
      const h = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      await sleep(200);
      out.reloaded = { order: h.settingsState().sortOrder, loadedFromStore: h.settingsState().loadedFromStore };
      await h.loadText(${JSON.stringify(SMALL)}, 'order.json');
      await sleep(500);
      out.reloadedAfterLoad = { top: window.__orderTopLevel(), totalRows: h.state().totalRows };
      return out;
    })()`,
  );

  // ---- phase 8：亮色截图 ----
  await runPhase(
    'light',
    `(async () => {
      const out = {};
      const h = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      await h.setSetting('theme', 'light');
      await h.setSetting('sortOrder', 'key-asc');
      await sleep(450);
      out.light = { theme: document.documentElement.dataset.theme, top: window.__orderTopLevel() };
      return out;
    })()`,
  );
  await page.screenshot(path.join(SHOTS, 'order-light.png'));

  report.longTasks = await page.eval('window.__orderLongTasks');
  report.consoleErrors = page.exceptions.slice(errorsBefore);
  report.consoleErrorLogs = page.logs.filter((entry) => entry.type === 'error').map((entry) => entry.text);
} finally {
  await chrome.close();
  await server.close();
}

console.log(JSON.stringify(report, null, 2));

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** 规范路径的直接子节点判定（与页面注入的 __orderIsDirectChild 同口径；Node 侧独立一份）。 */
const isDirectChild = (p) => {
  if (typeof p !== 'string' || p[0] !== '$') return false;
  const rest = p.slice(1);
  if (rest.startsWith('.')) {
    const name = rest.slice(1);
    return name.length > 0 && !name.includes('.') && !name.includes('[') && !name.includes(']');
  }
  if (rest.startsWith("['")) {
    let i = 3;
    for (; i < rest.length; i++) {
      if (rest[i] === '\\') { i += 1; continue; }
      if (rest[i] === "'" && rest[i + 1] === ']') return i + 2 === rest.length;
    }
    return false;
  }
  return /^\[\d+\]$/.test(rest);
};
const maxLongTask = (report.longTasks ?? []).length ? Math.max(...report.longTasks) : 0;

const checks = {
  // 1) 默认原始序（与今天一致）
  'raw:insertion-order': report.raw?.order === 'raw' && eq(report.raw?.top, ROOT_RAW),
  'raw:rows-and-copy':
    report.raw?.totalRows === SMALL_ROWS &&
    (report.raw?.copyBeta ?? '') === INDENT_2 &&
    (report.raw?.exportText ?? '').indexOf('"zeta"') < (report.raw?.exportText ?? '').indexOf('"Alpha"'),

  // 2) 设置面板第 13 行 + 升序
  'settings:13-rows-with-sort': eq(report.settingsRows, DEFAULT_KEYS),
  'asc:natural-order':
    report.asc?.order === 'key-asc' &&
    eq(report.asc?.top, ROOT_ASC) &&
    report.asc?.pressed === 'true',
  'asc:nested-and-arrays':
    eq(report.asc?.betaChildren, ['$.beta.a', '$.beta.b', '$.beta.c']) &&
    eq(report.asc?.arrChildren, ['$.arr[0]', '$.arr[1]']),
  'asc:totalRows-unchanged': report.asc?.totalRows === SMALL_ROWS,
  'asc:copy-export-keep-value-order':
    (report.asc?.copyBeta ?? '') === INDENT_2 &&
    (report.asc?.exportText ?? '').indexOf('"zeta"') < (report.asc?.exportText ?? '').indexOf('"Alpha"') &&
    (report.asc?.exportText ?? '').indexOf('"c"') < (report.asc?.exportText ?? '').indexOf('"a"'),

  // 3) 降序
  'desc:reverse-order':
    report.desc?.order === 'key-desc' &&
    eq(report.desc?.top, ROOT_DESC) &&
    eq(report.desc?.betaChildren, ['$.beta.c', '$.beta.b', '$.beta.a']) &&
    report.desc?.totalRows === SMALL_ROWS,

  // 4) 大文档切档按路径保持锚点：$.k120 在升序是 row 120，降序后是 row 181
  'anchor:keeps-path': report.anchorBefore?.topPath === '$.k120' && report.anchorAfter?.topPath === '$.k120',
  'anchor:scroll-row':
    report.anchorBefore?.scrollTop === 120 * ROW_H &&
    Math.abs((report.anchorAfter?.scrollTop ?? -1) - 181 * ROW_H) <= ROW_H &&
    report.anchorAfter?.totalRows === BIG_ROWS,

  // 5) 大纲跟随 + 搜索高亮跟随（不重跑）
  'outline:follows-display-order':
    eq((report.outline?.paths ?? []).filter(isDirectChild), ROOT_ASC),
  'outline:has-chinese-bracket-path': (report.outline?.paths ?? []).includes("$['中文']"),
  'search:hits-follow-path':
    eq([...(report.searchAsc?.hits ?? [])].sort(), ['$.item10', '$.item2']) &&
    report.searchAsc?.found === 2 &&
    eq([...(report.searchDesc?.hits ?? [])].sort(), ['$.item10', '$.item2']) &&
    eq(report.searchDesc?.top, ROOT_DESC),

  // 6) 表达式结果树跟随
  'expression:follows-display-order':
    eq((report.exprAsc?.paths ?? []).filter((p) => p !== '$'), ['$.a', '$.b', '$.c']) &&
    report.exprAsc?.order === 'key-asc' &&
    eq((report.exprDesc?.paths ?? []).filter((p) => p !== '$'), ['$.c', '$.b', '$.a']),

  // 7) 持久化 + 刷新后新 load 直接按规则
  'persist:sortOrder':
    report.reloaded?.loadedFromStore === true &&
    report.reloaded?.order === 'key-asc' &&
    eq(report.reloadedAfterLoad?.top, ROOT_ASC) &&
    report.reloadedAfterLoad?.totalRows === SMALL_ROWS,

  // 8) 亮色主题下同样生效
  'light:applies':
    report.light?.theme === 'light' && eq(report.light?.top, ROOT_ASC),

  'perf:no-long-task': maxLongTask < 100,
  'console:no-exception-no-error':
    report.consoleErrors?.length === 0 && report.consoleErrorLogs?.length === 0,
};

if (report.errors) console.log(`\nphase errors: ${JSON.stringify(report.errors, null, 2)}`);
if (maxLongTask >= 100) console.log(`\nlong tasks: ${JSON.stringify(report.longTasks)}`);
for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? '✅' : '❌'} ${name}`);
const passed = Object.values(checks).filter(Boolean).length;
const total = Object.keys(checks).length;
console.log(`\nsmoke-order: ${passed}/${total} ${passed === total ? 'OK' : 'FAILED'}`);
process.exitCode = passed === total ? 0 : 1;
