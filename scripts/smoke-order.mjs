/**
 * scripts/smoke-order.mjs — 子键显示排序（#19 / #40 / ADR-0024）真机冒烟。
 *
 *   node build.mjs && node scripts/smoke-order.mjs
 *
 * 测（显示顺序是 view-only：值图 / 路径 / 复制 / 导出 / 编辑 / 搜索不受影响）：
 *   1) 默认「原始顺序」= 与今天一致（插入序）；
 *   2) 真实点设置面板第 13 行「子键排序」→ 升序 / 降序（切档后选中按路径保留）：根成员与嵌套对象成员按自然序
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

/** 单节点覆盖禁用矩阵用的小文档：单键对象 / 数组 / 标量 / 可排对象 */
const SOLO = '{"only":{"x":1},"arr":[1,2],"z":1,"obj":{"b":1,"a":2}}';

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
window.__orderOutlineRows = () => [...document.querySelectorAll('.outline-row[data-path]')].map((el) => ({
  path: el.dataset.path,
  open: el.classList.contains('is-open'),
}));
window.__orderOutlinePaths = () => window.__orderOutlineRows().map((r) => r.path);
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
      // 选中一个节点：切档后选中必须按**路径**保留（ADR-0024 §5）
      const betaRow = document.querySelector('.row[data-path="$.beta"]');
      if (!betaRow) throw new Error('missing row $.beta');
      betaRow.click();
      await sleep(150);
      const selectedBefore = h.state().selected;
      document.querySelector('#settingsPanel [data-setting="sortOrder"] [data-value="key-desc"]').click();
      await sleep(450);
      out.desc = {
        order: h.settingsState().sortOrder,
        top: window.__orderTopLevel(),
        betaChildren: window.__orderPaths().filter((p) => p.startsWith('$.beta.')),
        totalRows: h.state().totalRows,
        selectedBefore,
        selectedAfter: document.querySelector('.row.is-selected[data-path]')?.dataset.path ?? null,
        stateSelectedAfter: h.state().selected,
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
      out.outline = { paths: window.__orderOutlinePaths(), setting: h.settingsState().sortOrder, state: h.state().rowVersion };
      // 展开大纲里的嵌套容器 $.beta：切档后必须保留展开现场（refreshOrder，不是回根页）
      const caret = document.querySelector('.outline-row[data-path="$.beta"] .outline-row__caret');
      if (!caret) throw new Error('missing outline caret $.beta');
      caret.click();
      await sleep(400);
      const betaOpen = (rows) => rows.find((r) => r.path === '$.beta')?.open ?? false;
      out.outlineExpandedAsc = {
        paths: window.__orderOutlinePaths(),
        betaOpen: betaOpen(window.__orderOutlineRows()),
      };
      await h.setSetting('sortOrder', 'key-desc');
      await sleep(550);
      out.outlineExpandedDesc = {
        paths: window.__orderOutlinePaths(),
        betaOpen: betaOpen(window.__orderOutlineRows()),
      };
      await h.setSetting('sortOrder', 'key-asc');
      await sleep(450);
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

  // ---- phase 6.4：右键菜单截图（v1.1 三项 + 禁用矩阵可视）----
  await runPhase(
    'menu-shot',
    `(async () => {
      const out = {};
      const h = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      await h.setSetting('sortOrder', 'raw');
      await h.setSetting('theme', 'dark');
      await h.loadText(${JSON.stringify(SMALL)}, 'order.json');
      await sleep(450);
      h.ctxOpen('$.beta');
      await sleep(220);
      out.menuHidden = document.getElementById('ctxMenu')?.hidden ?? null;
      return out;
    })()`,
  );
  await page.screenshot(path.join(SHOTS, 'order-menu.png'));
  await runPhase(
    'menu-close',
    `(async () => {
      await window.__tjv.ctxClick('order-global');
      return {};
    })()`,
  );

  // ---- phase 6.5：v1.1 单节点覆盖（右键菜单三档 / 禁用矩阵 / 不继承）----
  await runPhase(
    'node-order',
    `(async () => {
      const out = {};
      const h = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const orderItems = (state) => (state.items ?? []).filter((item) => (item.act ?? '').startsWith('order-'));
      const betaChildren = () => window.__orderPaths().filter((p) => p.startsWith('$.beta.'));
      const top = () => window.__orderTopLevel();

      await h.setSetting('sortOrder', 'raw');
      await h.loadText(${JSON.stringify(SMALL)}, 'order.json');
      await sleep(450);
      out.rawTop = top();

      // 菜单契约：对象容器三项可用、顺序与文案固定
      const menuBeta = h.ctxOpen('$.beta');
      out.menu = { hidden: menuBeta.hidden, items: orderItems(menuBeta) };

      // 禁用矩阵：数组 / 标量 / 单键对象禁用并给 title；可排对象可用
      await h.loadText(${JSON.stringify(SOLO)}, 'solo.json');
      await sleep(450);
      out.disabled = {
        array: orderItems(h.ctxOpen('$.arr')),
        scalar: orderItems(h.ctxOpen('$.z')),
        single: orderItems(h.ctxOpen('$.only')),
        object: orderItems(h.ctxOpen('$.obj')),
      };

      await h.loadText(${JSON.stringify(SMALL)}, 'order.json');
      await sleep(450);

      // 单节点升序：只改 $.beta 直接子键；根顺序不变（不向下继承）
      h.ctxOpen('$.beta');
      out.ascClick = await h.ctxClick('order-asc');
      await sleep(450);
      out.nodeAsc = { betaChildren: betaChildren(), top: top(), toast: h.toastText() };

      // 单节点降序
      h.ctxOpen('$.beta');
      await h.ctxClick('order-desc');
      await sleep(450);
      out.nodeDesc = { betaChildren: betaChildren(), toast: h.toastText() };

      // 恢复全局（beta 回 raw: c,a,b）
      h.ctxOpen('$.beta');
      await h.ctxClick('order-global');
      await sleep(450);
      out.nodeInherit = { betaChildren: betaChildren(), toast: h.toastText() };

      // 根覆盖升序：根成员 asc；beta 自己无覆盖 → 子键仍跟全局 raw（c,a,b）
      h.ctxOpen('$');
      await h.ctxClick('order-asc');
      await sleep(450);
      out.rootAsc = { top: top(), betaChildren: betaChildren() };

      // 全局切档不清覆盖：全局 desc 后根仍 asc
      await h.setSetting('sortOrder', 'key-desc');
      await sleep(500);
      out.globalDescKeepsOverride = { top: top(), global: h.settingsState().sortOrder };

      // 清根覆盖 → 跟随全局 desc
      h.ctxOpen('$');
      await h.ctxClick('order-global');
      await sleep(450);
      out.rootInherit = { top: top() };

      // 大纲跟随单节点覆盖（$.beta 降序，根保持全局 raw）
      await h.setSetting('sortOrder', 'raw');
      await sleep(450);
      h.ctxOpen('$.beta');
      await h.ctxClick('order-desc');
      await sleep(450);
      document.querySelector('[data-panel-btn="outline"]').click();
      await sleep(550);
      // 展开大纲里的 $.beta，才能看到它按覆盖（降序）分出的子项
      document.querySelector('.outline-row[data-path="$.beta"] .outline-row__caret')?.click();
      await sleep(450);
      out.nodeOutline = { paths: window.__orderOutlinePaths() };

      // 表达式结果根可单独覆盖（独立根；清覆盖后回全局）
      await h.expressionRunText('$.beta');
      await sleep(600);
      h.ctxOpen('$');
      await h.ctxClick('order-desc');
      await sleep(500);
      out.exprOverride = { paths: window.__orderPaths(), toast: h.toastText() };
      h.ctxOpen('$');
      await h.ctxClick('order-global');
      await sleep(450);
      out.exprInherit = { paths: window.__orderPaths() };
      h.expressionBack();
      await sleep(250);
      return out;
    })()`,
  );
  await page.screenshot(path.join(SHOTS, 'order-node.png'));

  // ---- phase 6.6：单节点覆盖的按路径锚点（大文档）----
  await runPhase(
    'node-anchor',
    `(async () => {
      const out = {};
      const h = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      await h.setSetting('sortOrder', 'raw');
      await h.loadText(${JSON.stringify(BIG)}, 'big.json');
      await sleep(500);
      // 真实场景：容器行可见（根在顶）时右键覆盖 → 视口不跳、仅其子行重排
      h.scrollToPx(0);
      await sleep(300);
      out.before = { scrollTop: h.state().scrollTop, topPath: window.__orderTopVisible() };
      h.ctxOpen('$');
      out.click = await h.ctxClick('order-desc');
      await sleep(600);
      out.after = {
        scrollTop: h.state().scrollTop,
        topPath: window.__orderTopVisible(),
        firstChildren: window.__orderPaths().filter((p) => p !== '$').slice(0, 3),
      };
      // 收尾：清覆盖并把全局档留在 key-asc（reload 阶段的持久化期望）
      h.ctxOpen('$');
      await h.ctxClick('order-global');
      await sleep(400);
      await h.setSetting('sortOrder', 'key-asc');
      await sleep(450);
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
      // 单节点覆盖是会话态：刷新后同一文档不再有覆盖（beta 子键回全局 raw）
      out.betaChildrenAfterReload = window.__orderPaths().filter((p) => p.startsWith('$.beta.'));
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
  // 切档后选中按路径保留（ADR-0024 §5）
  'desc:selection-kept-by-path':
    report.desc?.selectedBefore === '$.beta' &&
    report.desc?.selectedAfter === '$.beta' &&
    report.desc?.stateSelectedAfter === '$.beta',

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
  // 切档保留大纲展开现场：$.beta 仍展开，子项按新（降序）顺序重取
  'outline:keeps-expansion-on-sort':
    report.outlineExpandedAsc?.betaOpen === true &&
    eq(
      (report.outlineExpandedAsc?.paths ?? []).filter((p) => p.startsWith('$.beta.')),
      ['$.beta.a', '$.beta.b', '$.beta.c'],
    ) &&
    report.outlineExpandedDesc?.betaOpen === true &&
    eq(
      (report.outlineExpandedDesc?.paths ?? []).filter((p) => p.startsWith('$.beta.')),
      ['$.beta.c', '$.beta.b', '$.beta.a'],
    ) &&
    eq((report.outlineExpandedDesc?.paths ?? []).filter(isDirectChild), ROOT_DESC),
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

  // v1.1 单节点覆盖
  'menu:visible-shot': report.menuHidden === false,
  'node:menu-contract':
    report.menu?.hidden === false &&
    eq(
      (report.menu?.items ?? []).map((item) => [item.act, item.label, item.disabled]),
      [
        ['order-asc', '子键升序', false],
        ['order-desc', '子键降序', false],
        ['order-global', '恢复全局排序', false],
      ],
    ),
  'node:disabled-matrix':
    (report.disabled?.array ?? []).length === 3 &&
    (report.disabled?.array ?? []).every((item) => item.disabled === true && (item.title ?? '').length > 0) &&
    (report.disabled?.scalar ?? []).every((item) => item.disabled === true && (item.title ?? '').length > 0) &&
    (report.disabled?.single ?? []).every((item) => item.disabled === true && (item.title ?? '').length > 0) &&
    (report.disabled?.object ?? []).every((item) => item.disabled === false),
  'node:asc-direct-children-only':
    eq(report.nodeAsc?.betaChildren, ['$.beta.a', '$.beta.b', '$.beta.c']) &&
    eq(report.nodeAsc?.top, ROOT_RAW) &&
    (report.nodeAsc?.toast ?? '').includes('升序'),
  'node:desc':
    eq(report.nodeDesc?.betaChildren, ['$.beta.c', '$.beta.b', '$.beta.a']) &&
    (report.nodeDesc?.toast ?? '').includes('降序'),
  'node:inherit':
    eq(report.nodeInherit?.betaChildren, ['$.beta.c', '$.beta.a', '$.beta.b']) &&
    (report.nodeInherit?.toast ?? '').includes('全局'),
  'node:root-override-no-inherit':
    eq(report.rootAsc?.top, ROOT_ASC) && eq(report.rootAsc?.betaChildren, ['$.beta.c', '$.beta.a', '$.beta.b']),
  'node:global-keeps-override':
    report.globalDescKeepsOverride?.global === 'key-desc' &&
    eq(report.globalDescKeepsOverride?.top, ROOT_ASC),
  'node:inherit-follows-global': eq(report.rootInherit?.top, ROOT_DESC),
  'node:outline-follows':
    eq(
      (report.nodeOutline?.paths ?? []).filter((p) => p.startsWith('$.beta.')),
      ['$.beta.c', '$.beta.b', '$.beta.a'],
    ),
  'node:expression-root-override':
    eq((report.exprOverride?.paths ?? []).filter((p) => p !== '$'), ['$.c', '$.b', '$.a']) &&
    eq((report.exprInherit?.paths ?? []).filter((p) => p !== '$'), ['$.c', '$.a', '$.b']),
  'node:viewport-stable-and-rows-reordered':
    report.before?.topPath === '$' &&
    report.after?.topPath === '$' &&
    report.after?.scrollTop === 0 &&
    eq(report.after?.firstChildren, ['$.k300', '$.k299', '$.k298']) &&
    (report.click?.toast ?? '').includes('降序'),
  'node:overrides-are-session-only':
    eq(report.betaChildrenAfterReload, ['$.beta.a', '$.beta.b', '$.beta.c']),

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
