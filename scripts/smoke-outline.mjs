/**
 * scripts/smoke-outline.mjs — 大纲面板（ADR-0013）真机冒烟。
 *
 *   node build.mjs && node scripts/smoke-outline.mjs
 *
 * 测：
 *   1) 活动栏第 3 个模式「大纲」→ 左面板；无文档空态；关闭/重开保留现场；点已激活按钮回文档；
 *      `UiState.panel` 持久化；
 *   2) 行 = 键 → 类型 → 项数（容器 caret / 标量无 caret / 空容器「0 项」无 caret）；根行恒展开不可折叠；
 *   3) 交互：caret 只改大纲展开态（树行数/滚动/选中不变）；行点击 = 跳树（expandTo + 居中 + 选中 +
 *      `.is-current`）；不可见选中不高亮、展开后自动滚入；键盘 ↑↓（树选中同步、不滚树）/←→（aria-expanded
 *      真翻转）/Enter/End；已加载末行再按 ↓ = 加载下一页；
 *   4) 分页：真点「加载更多」哨兵行 + 键盘翻页，203→403→452 行；spacer = 行数×行高；虚拟化窗口纪律；
 *   5) 行高跟随设置（24→22→24）；换文档重置；编辑（docRevision 变化）刷新回根展开；
 *   6) 10MB 样本：大纲根页 / 展开耗时、面板重开耗时、0 长任务；原文视图下点行 → 先切回树；
 *   7) 刷新后 panel=outline 恢复。
 * 截图落 .spike/smoke/outline-*.png；走 HTTP + `window.__tjv`（扩展内没有 dev hooks）。
 */
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { launchChrome, REPO_ROOT } from '../prototype/p1/lib/chrome.mjs';
import { startStaticServer } from '../prototype/p1/lib/http.mjs';

const SHOTS = path.join(REPO_ROOT, '.spike', 'smoke');
await mkdir(SHOTS, { recursive: true });

/** 三层小文档：标量 a、容器 b（含数组 c）、数组 d（两个对象）、空容器 e */
const SMALL = JSON.stringify({ a: 1, b: { c: [1, 2] }, d: [{ e: 1 }, { e: 2 }], e: {} });
/** 非标识符键：路径转义（`['a.b']`）也要出现在 data-path / 展开跳转上 */
const WEIRD = JSON.stringify({ 'a.b': { c: 1 }, "it's": [1, 2] });
/** 450 项数组：200/200/50 三页 + 哨兵行 */
const PAGED = JSON.stringify({ items: Array.from({ length: 450 }, (_, i) => ({ i })) });
/** 非标识符键在规范路径里的形态（ADR-0010 §2）：`$['a.b']` / `$['it\'s']` */
const WEIRD_PATH = "$['a.b']";
const IT_PATH = "$['it\\'s']";

const server = await startStaticServer(REPO_ROOT);
const chrome = await launchChrome({ windowSize: '1440,900' });
const report = {};
const url = `${server.base}/dist/page.html`;

/** 在页面里注入只读的大纲行快照与交互助手（DOM 契约见 ADR-0013「接口契约」）。 */
const INJECT_ROWS = `window.__outlineRows = () => {
  const rows = [...document.querySelectorAll('.outline-row[data-path]')];
  return rows.map((el) => ({
    path: el.dataset.path,
    depth: Number(el.dataset.depth),
    kind: el.dataset.kind ?? null,
    count: el.dataset.count ?? null,
    more: el.dataset.more ?? null,
    open: el.classList.contains('is-open'),
    current: el.classList.contains('is-current'),
    caret: Boolean(el.querySelector('.outline-row__caret')),
    key: el.querySelector('.outline-row__key')?.textContent ?? null,
    type: el.querySelector('.outline-row__type')?.textContent ?? null,
    countText: el.querySelector('.outline-row__count')?.textContent ?? null,
    role: el.getAttribute('role'),
    level: el.getAttribute('aria-level'),
    expanded: el.getAttribute('aria-expanded'),
    selected: el.getAttribute('aria-selected'),
  }));
};
window.__outlinePaths = () => window.__outlineRows().map((r) => r.path);
window.__outlineClickRow = (p, part) => {
  const row = document.querySelector('.outline-row[data-path="' + CSS.escape(p) + '"]');
  if (!row) return false;
  const target = part === 'caret' ? row.querySelector('.outline-row__caret') : row;
  if (!target) return false;
  target.click();
  return true;
};
window.__outlineKey = (key) => {
  const scroller = document.querySelector('#outlineScroll');
  scroller?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
};
window.__outlineWindowInfo = () => {
  const scroller = document.querySelector('#outlineScroll');
  if (!scroller) return null;
  const spacer = scroller.querySelector('.outline__spacer');
  const firstRow = scroller.querySelector('.outline-row[data-path]');
  const h = window.__tjv;
  return {
    scrollTop: Math.round(scroller.scrollTop),
    clientHeight: scroller.clientHeight,
    rowHeight: h.settingsState().rowHeight,
    viewportRows: Math.floor(scroller.clientHeight / h.settingsState().rowHeight),
    rendered: h.outlineState().panel?.rendered ?? -1,
    foot: document.querySelector('#outlineFoot')?.textContent ?? '',
    scrollHeight: scroller.scrollHeight,
    spacerHeight: spacer ? spacer.offsetHeight : -1,
    firstRowHeight: firstRow ? getComputedStyle(firstRow).height : null,
    activeDescendant: scroller.getAttribute('aria-activedescendant'),
    activeDescendantPath: (() => {
      const id = scroller.getAttribute('aria-activedescendant');
      return id ? (document.getElementById(id)?.dataset.path ?? null) : null;
    })(),
    hasCurrent: Boolean(scroller.querySelector('.outline-row.is-current')),
  };
};
window.__outlineScrollTo = (px) => {
  const scroller = document.querySelector('#outlineScroll');
  scroller.scrollTop = px;
  return scroller.scrollTop;
};
window.__outlineClose = () => {
  document.querySelector('#leftPanel [data-panel-close]')?.click();
};
window.__outlineClickActiveBtn = () => {
  document.querySelector('.actbtn[data-panel-btn="outline"]')?.click();
};
window.__outlineClickSentinel = () => {
  const row = document.querySelector('.outline-row--more');
  if (!row) return false;
  row.click();
  return true;
};`;

try {
  const page = await chrome.openPage();
  const errorsBefore = page.exceptions.length;
  await page.setViewport(1440, 900);
  await page.goto(url, { timeoutMs: 20000 });
  await page.waitFor('document.readyState === "complete"', { timeoutMs: 20000 });
  await new Promise((r) => setTimeout(r, 600));
  await page.eval(INJECT_ROWS);

  // 长任务观察器：大纲打开 / 分页 / 滚动 / 跳转都不得造成主线程长任务
  await page.eval(`(() => {
    window.__outlineLongTasks = [];
    try {
      const po = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) window.__outlineLongTasks.push(Math.round(entry.duration));
      });
      po.observe({ entryTypes: ['longtask'] });
      window.__outlineHasLongTaskObserver = true;
    } catch {
      window.__outlineHasLongTaskObserver = false;
    }
    return true;
  })()`);

  const runPhase = async (name, expression) => {
    try {
      Object.assign(report, (await page.eval(expression)) ?? {});
    } catch (error) {
      if (!report.errors) report.errors = {};
      report.errors[name] = String(error?.message ?? error);
      console.warn(`⚠️ phase ${name} failed: ${String(error?.message ?? error)}`);
    }
  };

  // ---- phase 1：无文档 → 大纲空态 + 活动栏激活态 ----
  await runPhase(
    'empty',
    `(async () => {
      const out = {};
      const h = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      window.__outlineClickActiveBtn();
      await sleep(250);
      out.empty = {
        panel: document.body.dataset.panel,
        title: document.querySelector('#panelTitle')?.textContent ?? null,
        btnActive: document.querySelector('.actbtn[data-panel-btn="outline"]')?.classList.contains('is-active') ?? false,
        btnLabel: document.querySelector('.actbtn[data-panel-btn="outline"]')?.getAttribute('aria-label') ?? null,
        emptyText: document.querySelector('#outlineEmpty')?.textContent ?? null,
        state: h.outlineState(),
      };
      return out;
    })()`,
  );
  await page.screenshot(path.join(SHOTS, 'outline-empty.png'));

  // ---- phase 2：小文档 → 根行 / 三层展开 / caret 语义 / 不可见高亮 / 关闭重开 ----
  await runPhase(
    'small',
    `(async () => {
      const out = {};
      const h = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      await h.loadText(${JSON.stringify(SMALL)}, 'small.json');
      await sleep(450);
      h.outlineOpen();
      await sleep(250);
      out.small = {
        state: h.outlineState(),
        rows: window.__outlineRows(),
        root: window.__outlineRows().find((r) => r.path === '$') ?? null,
        scroller: {
          role: document.querySelector('#outlineScroll')?.getAttribute('role') ?? null,
          tabindex: document.querySelector('#outlineScroll')?.getAttribute('tabindex') ?? null,
        },
      };
      // 展开 b（点 caret：只改大纲展开态，树的选中 / 行数 / 滚动都不应变化）
      const treeBefore = { selected: h.state().selected, totalRows: h.state().totalRows, scrollTop: h.state().scrollTop };
      out.small.caretClicked = window.__outlineClickRow('$.b', 'caret');
      await sleep(250);
      out.small.afterExpandB = {
        rows: window.__outlinePaths(),
        selected: h.state().selected,
        treeTotalRows: h.state().totalRows,
        treeScrollTop: h.state().scrollTop,
      };
      out.small.treeBefore = treeBefore;
      // 折叠 b
      window.__outlineClickRow('$.b', 'caret');
      await sleep(250);
      out.small.afterCollapseB = { rows: window.__outlinePaths() };
      // 展开 d → 两个数组元素
      window.__outlineClickRow('$.d', 'caret');
      await sleep(250);
      out.small.afterExpandD = { rows: window.__outlinePaths() };
      // 空容器 e：有「0 项」、无 caret（与树一致）
      out.small.emptyRow = window.__outlineRows().find((r) => r.path === '$.e') ?? null;
      // 根不可折叠：hook 传 open=false 无效，根仍在 expanded / 行数不变
      out.small.rowsBeforeRootToggle = window.__outlinePaths();
      out.small.rootToggle = await h.outlineToggle('$', false);
      await sleep(200);
      out.small.rootAfter = { expanded: h.outlineState().expanded, rows: window.__outlinePaths() };
      // outlineJump hook 形状（{ok,row}）
      out.small.jumpHook = await h.outlineJump('$.b');
      await sleep(350);
      // 不可见选中：b 已折叠 → 跳 $.b.c 时大纲中没有该行，不高亮
      out.small.invisibleJump = await h.outlineJump('$.b.c');
      await sleep(350);
      out.small.afterInvisible = {
        current: h.outlineState().current,
        currentRows: window.__outlineRows().filter((r) => r.current).map((r) => r.path),
      };
      // 展开 b → $.b.c 行出现，应自动滚入并高亮（revealSelected）
      window.__outlineClickRow('$.b', 'caret');
      await sleep(300);
      out.small.afterReveal = {
        rows: window.__outlinePaths(),
        currentRows: window.__outlineRows().filter((r) => r.current).map((r) => r.path),
        activeDescendant: window.__outlineWindowInfo().activeDescendant,
        activeDescendantPath: window.__outlineWindowInfo().activeDescendantPath,
        currentRow: window.__outlineRows().find((r) => r.current) ?? null,
      };
      // 点击行 = 跳树 + 选中 + 大纲高亮
      out.small.rowClicked = window.__outlineClickRow('$.d[1]');
      await sleep(500);
      out.small.afterJump = {
        selected: h.state().selected,
        viewMode: h.state().viewMode,
        treeSelected: document.querySelector('.row.is-selected[data-path="$.d[1]"]')?.dataset.path ?? null,
        outlineCurrent: window.__outlineRows().filter((r) => r.current).map((r) => r.path),
        currentRow: window.__outlineRows().find((r) => r.current) ?? null,
        activeDescendantPath: window.__outlineWindowInfo().activeDescendantPath,
      };
      // 关闭面板 → 现场保留；重开 → 原展开集合与行数不变
      out.small.beforeClose = { rows: window.__outlinePaths(), expanded: h.outlineState().expanded };
      window.__outlineClose();
      await sleep(250);
      out.small.closed = { panel: document.body.dataset.panel, rows: h.outlineState().rows };
      h.outlineOpen();
      await sleep(250);
      out.small.reopened = {
        panel: document.body.dataset.panel,
        rows: window.__outlinePaths(),
        expanded: h.outlineState().expanded,
      };
      // 点已激活的大纲按钮 → 回文档视图
      window.__outlineClickActiveBtn();
      await sleep(250);
      out.small.activeToggle = { panel: document.body.dataset.panel };
      h.outlineOpen();
      await sleep(200);
      return out;
    })()`,
  );
  await page.screenshot(path.join(SHOTS, 'outline-small.png'));

  // ---- phase 3：键盘（↑↓ 移动当前行 / ←→ aria 真翻转 / Enter 跳转 / 树不动） ----
  await runPhase(
    'keyboard',
    `(async () => {
      const out = {};
      const h = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      // 重新载入：重置大纲（根展开、其余折叠）
      await h.loadText(${JSON.stringify(SMALL)}, 'keyboard.json');
      await sleep(450);
      h.outlineOpen();
      await sleep(250);
      document.querySelector('#outlineScroll')?.focus();
      window.__outlineClickRow('$');
      await sleep(250);
      const treeBefore = { totalRows: h.state().totalRows, scrollTop: h.state().scrollTop };
      out.keyboard = { start: h.state().selected, treeBefore };
      window.__outlineKey('ArrowDown');
      await sleep(150);
      out.keyboard.afterDown1 = h.state().selected;
      window.__outlineKey('ArrowDown');
      await sleep(150);
      out.keyboard.afterDown2 = h.state().selected;
      window.__outlineKey('ArrowDown');
      await sleep(150);
      out.keyboard.afterDown3 = h.state().selected;
      out.keyboard.treeAfterDown = { totalRows: h.state().totalRows, scrollTop: h.state().scrollTop };
      // ↑ 回退一行；Home 回首行
      window.__outlineKey('ArrowUp');
      await sleep(150);
      out.keyboard.afterUp = h.state().selected;
      window.__outlineKey('Home');
      await sleep(150);
      out.keyboard.afterHome = h.state().selected;
      // 回到 $.d（下行 3 次）
      for (let i = 0; i < 3; i++) {
        window.__outlineKey('ArrowDown');
        await sleep(120);
      }
      // 当前行 $.d 是容器：←→ 必须真翻转 aria-expanded / .is-open
      out.keyboard.rowBefore = window.__outlineRows().find((r) => r.current) ?? null;
      window.__outlineKey('ArrowRight');
      await sleep(300);
      out.keyboard.afterRight = {
        rows: window.__outlinePaths(),
        row: window.__outlineRows().find((r) => r.current) ?? null,
      };
      window.__outlineKey('ArrowLeft');
      await sleep(300);
      out.keyboard.afterLeft = {
        rows: window.__outlinePaths(),
        row: window.__outlineRows().find((r) => r.current) ?? null,
      };
      window.__outlineKey('Enter');
      await sleep(400);
      out.keyboard.afterEnter = {
        selected: h.state().selected,
        viewMode: h.state().viewMode,
        treeSelected: document.querySelector('.row.is-selected[data-path="$.d"]')?.dataset.path ?? null,
      };
      out.keyboard.focusInPanel = Boolean(document.activeElement?.closest?.('#outlinePanel'));
      return out;
    })()`,
  );

  // ---- phase 4：路径转义（非标识符键） ----
  await runPhase(
    'weird',
    `(async () => {
      const out = {};
      const h = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      await h.loadText(${JSON.stringify(WEIRD)}, 'weird.json');
      await sleep(450);
      h.outlineOpen();
      await sleep(250);
      out.weird = {
        paths: window.__outlinePaths(),
        expandWeird: await h.outlineToggle(${JSON.stringify(WEIRD_PATH)}, true),
        expandIt: await h.outlineToggle(${JSON.stringify(IT_PATH)}, true),
        rows: window.__outlinePaths(),
      };
      return out;
    })()`,
  );

  // ---- phase 5：分页（键盘翻页 + 真点哨兵）/ 虚拟化 / spacer ----
  await runPhase(
    'paging',
    `(async () => {
      const out = {};
      const h = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      await h.loadText(${JSON.stringify(PAGED)}, 'paged.json');
      await sleep(500);
      h.outlineOpen();
      await sleep(250);
      const scroller = document.querySelector('#outlineScroll');
      const toBottom = async () => { scroller.scrollTop = scroller.scrollHeight; await sleep(300); };
      const toTop = async () => { scroller.scrollTop = 0; await sleep(200); };

      out.paging = { root: h.outlineState() };
      out.paging.expand = await h.outlineToggle('$.items', true);
      await sleep(300);
      await toBottom();
      out.paging.page1 = {
        state: h.outlineState(),
        tail: window.__outlineRows().slice(-2),
        hasSentinel: Boolean(document.querySelector('.outline-row--more')),
      };
      // 键盘翻页：End 选到已加载末行 → ↓ = 加载下一页（等价点哨兵）
      await toTop();
      document.querySelector('#outlineScroll')?.focus();
      window.__outlineKey('End');
      await sleep(250);
      out.paging.endSelected = h.state().selected;
      window.__outlineKey('ArrowDown');
      await sleep(400);
      await toBottom();
      out.paging.page2 = {
        state: h.outlineState(),
        hasSentinel: Boolean(document.querySelector('.outline-row--more')),
        selected: h.state().selected,
      };
      // 真点「加载更多」哨兵行（覆盖 handleClick 的 more 分支；此刻已滚到底、哨兵可见）
      out.paging.sentinelClicked = window.__outlineClickSentinel();
      await sleep(400);
      await toBottom();
      out.paging.page3 = {
        state: h.outlineState(),
        hasSentinel: Boolean(document.querySelector('.outline-row--more')),
        lastPath: [...document.querySelectorAll('.outline-row[data-path]')].at(-1)?.dataset.path ?? null,
        info: window.__outlineWindowInfo(),
      };
      // 已到末页：hook 返回 false，不再发请求
      out.paging.moreAtEnd = await h.outlineLoadMore('$.items');
      // 大文档（451 节点 > 500 阈值 → 树默认折叠，totalRows=2）：行点击必须 expandTo 祖先 + 居中
      out.paging.treeBeforeJump = { totalRows: h.state().totalRows, scrollTop: h.state().scrollTop };
      window.__outlineScrollTo(300 * 24);
      await sleep(300);
      out.paging.rowClicked = window.__outlineClickRow('$.items[300]');
      await sleep(600);
      out.paging.rowJump = {
        totalRows: h.state().totalRows,
        scrollTop: h.state().scrollTop,
        treeSelected: document.querySelector('.row.is-selected[data-path="$.items[300]"]')?.dataset.path ?? null,
        selected: h.state().selected,
      };
      // Enter 跳转（End 选到末行后再 Enter）：同样应展开祖先 + 滚动
      h.collapseAll();
      await sleep(400);
      h.outlineOpen();
      await sleep(200);
      document.querySelector('#outlineScroll')?.focus();
      window.__outlineKey('End');
      await sleep(300);
      out.paging.enterSelected = h.state().selected;
      out.paging.treeBeforeEnter = { totalRows: h.state().totalRows, scrollTop: h.state().scrollTop };
      window.__outlineKey('Enter');
      await sleep(600);
      out.paging.enterJump = {
        totalRows: h.state().totalRows,
        scrollTop: h.state().scrollTop,
        treeSelected: document.querySelector('.row.is-selected[data-path="$.items[449]"]')?.dataset.path ?? null,
        selected: h.state().selected,
      };
      // 滚到底的窗口纪律 + spacer 精确高度
      await toBottom();
      out.paging.bottom = { info: window.__outlineWindowInfo(), lastVisible: [...document.querySelectorAll('.outline-row[data-path]')].at(-1)?.dataset.path ?? null };
      await toTop();
      out.paging.top = window.__outlineWindowInfo();
      return out;
    })()`,
  );
  await page.screenshot(path.join(SHOTS, 'outline-paging.png'));

  // ---- phase 6：行高跟随设置（24→22→24） ----
  await runPhase(
    'rowheight',
    `(async () => {
      const out = {};
      const h = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      await h.loadText(${JSON.stringify(SMALL)}, 'rowheight.json');
      await sleep(450);
      h.outlineOpen();
      await sleep(250);
      const rows = h.outlineState().rows;
      out.rowheight = { rows, before: window.__outlineWindowInfo() };
      h.setSetting('rowHeight', 22);
      await sleep(300);
      out.rowheight.after22 = window.__outlineWindowInfo();
      h.setSetting('rowHeight', 24);
      await sleep(300);
      out.rowheight.restored = window.__outlineWindowInfo();
      return out;
    })()`,
  );

  // ---- phase 7：换文档重置 + 编辑（docRevision 变化）后刷新 ----
  await runPhase(
    'reset-edit',
    `(async () => {
      const out = {};
      const h = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      await h.loadText(${JSON.stringify(SMALL)}, 'reset.json');
      await sleep(450);
      h.outlineOpen();
      await sleep(250);
      await h.outlineToggle('$.b', true);
      await sleep(200);
      out.resetEdit = { before: { rows: window.__outlinePaths(), state: h.outlineState() } };
      await h.loadText(JSON.stringify({ x: { y: { z: 1 } } }), 'reset2.json');
      await sleep(500);
      out.resetEdit.afterReloadDoc = { rows: window.__outlinePaths(), state: h.outlineState() };
      // 编辑：打开 $.x.y 改值 → docRevision 变化 → 大纲 refresh 回根展开
      await h.outlineToggle('$.x', true);
      await sleep(250);
      out.resetEdit.beforeEdit = window.__outlinePaths();
      await h.editOpen('$.x.y');
      await h.editApplyText('{"z":2}');
      await sleep(600);
      out.resetEdit.afterEdit = {
        rows: window.__outlinePaths(),
        state: h.outlineState(),
        docRevision: h.state().docRevision,
      };
      return out;
    })()`,
  );

  // ---- phase 8：原文视图下点大纲行 → 切回树；10MB 性能 + 面板重开耗时 ----
  await runPhase(
    'raw-and-perf',
    `(async () => {
      const out = {};
      const h = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      await h.loadText(${JSON.stringify(SMALL)}, 'rawjump.json');
      await sleep(450);
      h.outlineOpen();
      await sleep(250);
      await h.outlineToggle('$.b', true);
      await sleep(250);
      await h.setViewMode('raw');
      await sleep(350);
      out.rawView = { before: h.state().viewMode };
      out.rawView.rowClicked = window.__outlineClickRow('$.b.c');
      await sleep(500);
      out.rawView.after = { viewMode: h.state().viewMode, selected: h.state().selected };

      // 10MB：导入→大纲根页 + 展开 data / items 的耗时
      const text = await (await fetch('/.spike/samples/10mb.json')).text();
      const tLoad = performance.now();
      await h.loadText(text, '10mb.json');
      h.outlineOpen();
      await new Promise((resolve) => {
        const tick = () => (h.outlineState().phase === 'ready' ? resolve() : setTimeout(tick, 10));
        tick();
      });
      out.perf = {
        loadToOutlineReadyMs: Math.round(performance.now() - tLoad),
        root: h.outlineState(),
      };
      const tData = performance.now();
      out.perf.expandData = await h.outlineToggle('$.data', true);
      out.perf.expandDataMs = Math.round(performance.now() - tData);
      const tItems = performance.now();
      out.perf.expandItems = await h.outlineToggle('$.data.items', true);
      out.perf.expandItemsMs = Math.round(performance.now() - tItems);
      const scroller = document.querySelector('#outlineScroll');
      scroller.scrollTop = scroller.scrollHeight;
      await sleep(350);
      out.perf.after = { state: h.outlineState(), tail: window.__outlineRows().slice(-2), info: window.__outlineWindowInfo() };
      // 面板重开耗时（display:none 恢复 + 首窗绘制，ADR「打开面板到首屏 <100ms」）
      window.__outlineClose();
      await sleep(200);
      const tOpen = performance.now();
      h.outlineOpen();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      out.perf.panelOpenMs = Math.round(performance.now() - tOpen);
      out.perf.after = { state: h.outlineState(), tail: window.__outlineRows().slice(-2), info: window.__outlineWindowInfo() };
      return out;
    })()`,
  );
  await page.screenshot(path.join(SHOTS, 'outline-10mb.png'));

  // ---- phase 9：长任务（刷新前）+ 持久化（panel=outline 刷新后恢复） ----
  await runPhase(
    'perf-before',
    `(() => ({ longTasksBeforeReload: { longTasks: window.__outlineLongTasks, hasLongTaskObserver: window.__outlineHasLongTaskObserver } }))()`,
  );
  await runPhase(
    'persist-before',
    `(async () => {
      const h = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      h.outlineOpen();
      await sleep(250);
      return { persistBefore: { panel: document.body.dataset.panel, ui: h.settingsState().ui } };
    })()`,
  );
  await page.goto(url, { timeoutMs: 20000 });
  await page.waitFor('document.readyState === "complete"', { timeoutMs: 20000 });
  await new Promise((r) => setTimeout(r, 500));
  await page.eval(INJECT_ROWS);
  await page.eval(`(() => {
    window.__outlineLongTasks = [];
    try {
      const po = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) window.__outlineLongTasks.push(Math.round(entry.duration));
      });
      po.observe({ entryTypes: ['longtask'] });
      window.__outlineHasLongTaskObserver = true;
    } catch {
      window.__outlineHasLongTaskObserver = false;
    }
    return true;
  })()`);
  await runPhase(
    'persist-after',
    `(async () => {
      const out = {};
      const h = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      h.outlineOpen();
      await sleep(250);
      out.reloaded = {
        panel: document.body.dataset.panel,
        title: document.querySelector('#panelTitle')?.textContent ?? null,
        ui: h.settingsState().ui,
        state: h.outlineState(),
        emptyText: document.querySelector('#outlineEmpty')?.textContent ?? null,
        longTasksAfterReload: { longTasks: window.__outlineLongTasks, hasLongTaskObserver: window.__outlineHasLongTaskObserver },
      };
      // 展开态不持久化：刷新后重新载入文档，只有根展开
      await h.loadText(${JSON.stringify(SMALL)}, 'persist2.json');
      await sleep(500);
      out.reloaded.afterLoad = { expanded: h.outlineState().expanded, rows: window.__outlinePaths() };
      return out;
    })()`,
  );
  await page.screenshot(path.join(SHOTS, 'outline-reloaded.png'));

  report.consoleErrors = page.exceptions.slice(errorsBefore);
  report.consoleErrorLogs = page.logs.filter((entry) => entry.type === 'error');
} finally {
  try {
    await chrome.close();
  } catch {
    /* ignore */
  }
  await server.close();
}

/* ------------------------------- 断言 ------------------------------- */

const rowAt = (rows, p) => (rows ?? []).find((row) => row.path === p) ?? null;
const close = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** 虚拟化纪律：渲染行 ≤ 屏行 + 2×overscan（count = min(屏行+2×overscan, size-start)） */
const renderedBound = (info) => info != null && info.rendered > 0 && info.rendered <= info.viewportRows + 2 * 6;

const checks = {
  // 空态 + 活动栏
  'empty:panel': report.empty?.panel === 'outline' && report.empty?.btnActive === true,
  'empty:title': report.empty?.title === '大纲',
  'empty:button-label': report.empty?.btnLabel === '大纲',
  'empty:idle': report.empty?.state?.phase === 'idle' && report.empty?.state?.rows === 0,
  'empty:hint': /导入文档后显示结构大纲/.test(report.empty?.emptyText ?? ''),

  // 小文档结构与行内容
  'small:root':
    report.small?.root?.path === '$' &&
    report.small?.root?.kind === 'object' &&
    report.small?.root?.depth === 0 &&
    report.small?.root?.count === '4' &&
    report.small?.root?.open === true &&
    report.small?.root?.caret === false &&
    report.small?.root?.level === '1',
  'small:paths': close(report.small?.rows?.map((r) => r.path), ['$', '$.a', '$.b', '$.d', '$.e']),
  'small:types-counts':
    rowAt(report.small?.rows, '$.a')?.type === 'number' &&
    rowAt(report.small?.rows, '$.a')?.caret === false &&
    rowAt(report.small?.rows, '$.a')?.countText == null &&
    rowAt(report.small?.rows, '$.b')?.type === 'object' &&
    rowAt(report.small?.rows, '$.b')?.countText === '1 项' &&
    rowAt(report.small?.rows, '$.d')?.type === 'array' &&
    rowAt(report.small?.rows, '$.d')?.countText === '2 项',
  'small:empty-container':
    report.small?.emptyRow?.kind === 'object' &&
    report.small?.emptyRow?.countText === '0 项' &&
    report.small?.emptyRow?.caret === false &&
    report.small?.emptyRow?.expanded === null,
  'small:a11y':
    report.small?.scroller?.role === 'tree' &&
    report.small?.scroller?.tabindex === '0' &&
    rowAt(report.small?.rows, '$.b')?.role === 'treeitem' &&
    rowAt(report.small?.rows, '$.b')?.level === '2' &&
    rowAt(report.small?.rows, '$.b')?.expanded === 'false' &&
    rowAt(report.small?.rows, '$.b')?.selected === 'false',
  'small:root-not-collapsible':
    report.small?.rootToggle?.open === true &&
    (report.small?.rootAfter?.expanded ?? []).includes('$') &&
    close(report.small?.rootAfter?.rows, report.small?.rowsBeforeRootToggle),

  // caret vs 行点击
  'small:caret-expand-only':
    report.small?.caretClicked === true &&
    // DFS：子行紧跟父行（ARIA tree 顺序），不是按层追加
    close(report.small?.afterExpandB?.rows, ['$', '$.a', '$.b', '$.b.c', '$.d', '$.e']) &&
    report.small?.afterExpandB?.selected === report.small?.treeBefore?.selected &&
    report.small?.afterExpandB?.treeTotalRows === report.small?.treeBefore?.totalRows &&
    report.small?.afterExpandB?.treeScrollTop === report.small?.treeBefore?.scrollTop,
  'small:caret-collapse': close(report.small?.afterCollapseB?.rows, ['$', '$.a', '$.b', '$.d', '$.e']),
  'small:nested-expand': close(report.small?.afterExpandD?.rows, ['$', '$.a', '$.b', '$.d', '$.d[0]', '$.d[1]', '$.e']),
  'small:jump-hook': report.small?.jumpHook?.ok === true && report.small?.jumpHook?.row >= 1,
  'small:invisible-no-highlight':
    report.small?.invisibleJump?.ok === true &&
    report.small?.afterInvisible?.current === '$.b.c' &&
    (report.small?.afterInvisible?.currentRows ?? []).length === 0,
  'small:reveal-after-expand':
    report.small?.afterReveal?.currentRows?.length === 1 &&
    report.small?.afterReveal?.currentRows[0] === '$.b.c' &&
    /^outline-row-\d+$/.test(report.small?.afterReveal?.activeDescendant ?? '') &&
    report.small?.afterReveal?.activeDescendantPath === '$.b.c' &&
    report.small?.afterReveal?.currentRow?.selected === 'true',
  'small:row-jump':
    report.small?.afterJump?.selected === '$.d[1]' &&
    report.small?.afterJump?.viewMode === 'tree' &&
    report.small?.afterJump?.treeSelected === '$.d[1]' &&
    close(report.small?.afterJump?.outlineCurrent, ['$.d[1]']) &&
    report.small?.afterJump?.activeDescendantPath === '$.d[1]' &&
    report.small?.afterJump?.currentRow?.selected === 'true',
  'small:close-preserves':
    report.small?.closed?.panel === 'doc' &&
    report.small?.closed?.rows === report.small?.afterReveal?.rows?.length,
  'small:reopen-preserves':
    report.small?.reopened?.panel === 'outline' &&
    close(report.small?.reopened?.rows, report.small?.beforeClose?.rows) &&
    close(report.small?.reopened?.expanded, report.small?.beforeClose?.expanded),
  'small:active-button-back-to-doc': report.small?.activeToggle?.panel === 'doc',

  // 键盘
  'keyboard:arrow-moves':
    report.keyboard?.afterDown1 === '$.a' &&
    report.keyboard?.afterDown2 === '$.b' &&
    report.keyboard?.afterDown3 === '$.d' &&
    report.keyboard?.afterUp === '$.b' &&
    report.keyboard?.afterHome === '$',
  'keyboard:no-tree-move':
    report.keyboard?.treeAfterDown?.totalRows === report.keyboard?.treeBefore?.totalRows &&
    report.keyboard?.treeAfterDown?.scrollTop === report.keyboard?.treeBefore?.scrollTop,
  'keyboard:right-expands':
    report.keyboard?.rowBefore?.open === false &&
    report.keyboard?.rowBefore?.expanded === 'false' &&
    report.keyboard?.afterRight?.row?.open === true &&
    report.keyboard?.afterRight?.row?.expanded === 'true' &&
    close(report.keyboard?.afterRight?.rows, ['$', '$.a', '$.b', '$.d', '$.d[0]', '$.d[1]', '$.e']),
  'keyboard:left-collapses':
    report.keyboard?.afterLeft?.row?.open === false &&
    report.keyboard?.afterLeft?.row?.expanded === 'false' &&
    close(report.keyboard?.afterLeft?.rows, ['$', '$.a', '$.b', '$.d', '$.e']),
  'keyboard:enter-jumps':
    report.keyboard?.afterEnter?.selected === '$.d' &&
    report.keyboard?.afterEnter?.viewMode === 'tree' &&
    report.keyboard?.afterEnter?.treeSelected === '$.d',
  'keyboard:focus-stays': report.keyboard?.focusInPanel === true,

  // 路径转义
  'weird:escaped-path':
    (report.weird?.paths ?? []).includes("$['a.b']") &&
    (report.weird?.paths ?? []).includes("$['it\\'s']") &&
    report.weird?.expandWeird?.ok === true &&
    report.weird?.expandIt?.ok === true &&
    (report.weird?.rows ?? []).includes("$['a.b'].c") &&
    (report.weird?.rows ?? []).includes("$['it\\'s'][0]"),

  // 分页
  'paging:page1':
    report.paging?.page1?.state?.rows === 203 &&
    report.paging?.page1?.state?.loadedChildren === 201 &&
    report.paging?.page1?.hasSentinel === true &&
    report.paging?.page1?.tail?.some((row) => row.more === '1'),
  'paging:keyboard-loadmore':
    report.paging?.endSelected === '$.items[199]' &&
    report.paging?.page2?.state?.rows === 403 &&
    report.paging?.page2?.state?.loadedChildren === 401,
  'paging:sentinel-click':
    report.paging?.sentinelClicked === true &&
    report.paging?.page3?.state?.rows === 452 &&
    report.paging?.page3?.state?.loadedChildren === 451 &&
    report.paging?.page3?.hasSentinel === false &&
    report.paging?.page3?.lastPath === '$.items[449]',
  'paging:spacer-exact':
    report.paging?.page3?.info?.spacerHeight === 452 * 24 &&
    report.paging?.page3?.info?.scrollHeight === 452 * 24,
  'paging:rendered-bound': renderedBound(report.paging?.bottom?.info) && renderedBound(report.paging?.top),
  'paging:bottom-row':
    report.paging?.bottom?.lastVisible === '$.items[449]' &&
    /已渲染 \d+ \/ 452 行/.test(report.paging?.bottom?.info?.foot ?? ''),
  'paging:no-more-at-end': report.paging?.moreAtEnd?.ok === false,
  'paging:row-jump-expand':
    report.paging?.treeBeforeJump?.totalRows === 2 &&
    report.paging?.rowClicked === true &&
    report.paging?.rowJump?.totalRows === 452 &&
    (report.paging?.rowJump?.scrollTop ?? 0) > 0 &&
    report.paging?.rowJump?.treeSelected === '$.items[300]' &&
    report.paging?.rowJump?.selected === '$.items[300]',
  'paging:enter-jumps':
    report.paging?.enterSelected === '$.items[449]' &&
    report.paging?.treeBeforeEnter?.totalRows === 2 &&
    report.paging?.enterJump?.totalRows === 452 &&
    (report.paging?.enterJump?.scrollTop ?? 0) > 0 &&
    report.paging?.enterJump?.treeSelected === '$.items[449]',

  // 行高跟随设置
  'rowheight:default-24':
    report.rowheight?.before?.rowHeight === 24 &&
    report.rowheight?.before?.firstRowHeight === '24px' &&
    report.rowheight?.before?.spacerHeight === report.rowheight?.rows * 24,
  'rowheight:22':
    report.rowheight?.after22?.rowHeight === 22 &&
    report.rowheight?.after22?.firstRowHeight === '22px' &&
    report.rowheight?.after22?.spacerHeight === report.rowheight?.rows * 22,
  'rowheight:restored':
    report.rowheight?.restored?.rowHeight === 24 &&
    report.rowheight?.restored?.firstRowHeight === '24px' &&
    report.rowheight?.restored?.spacerHeight === report.rowheight?.rows * 24,

  // 换文档重置 / 编辑刷新
  'reset:doc-reload': close(report.resetEdit?.afterReloadDoc?.rows, ['$', '$.x']),
  'reset:expanded-only-root': close(report.resetEdit?.afterReloadDoc?.state?.expanded, ['$']),
  'edit:refresh-to-root':
    close(report.resetEdit?.afterEdit?.rows, ['$', '$.x']) &&
    close(report.resetEdit?.afterEdit?.state?.expanded, ['$']) &&
    (report.resetEdit?.afterEdit?.docRevision ?? 0) > 1,

  // 原文视图下跳转
  'raw:jump-switches-back':
    report.rawView?.before === 'raw' &&
    report.rawView?.after?.viewMode === 'tree' &&
    report.rawView?.after?.selected === '$.b.c',

  // 10MB 性能
  'perf:outline-ready':
    report.perf?.root?.phase === 'ready' &&
    report.perf?.root?.rows === 3 &&
    (report.perf?.root?.loadedContainers ?? 0) >= 1 &&
    (report.perf?.loadToOutlineReadyMs ?? 9999) > 0,
  'perf:panel-open': (report.perf?.panelOpenMs ?? 9999) < 100,
  'perf:expand-bound':
    (report.perf?.expandDataMs ?? 9999) < 20 &&
    (report.perf?.expandItemsMs ?? 9999) < 20 &&
    report.perf?.after?.state?.rows === 205,
  'perf:items-page':
    rowAt(report.perf?.after?.tail, '$.data.items[199]')?.kind === 'object' &&
    report.perf?.after?.tail?.some((row) => row.more === '1'),

  // 持久化
  'persist:ui-panel': report.persistBefore?.panel === 'outline' && report.persistBefore?.ui?.panel === 'outline',
  'persist:restored':
    report.reloaded?.panel === 'outline' &&
    report.reloaded?.title === '大纲' &&
    report.reloaded?.ui?.panel === 'outline' &&
    report.reloaded?.state?.phase === 'idle' &&
    /导入文档后显示结构大纲/.test(report.reloaded?.emptyText ?? '') &&
    close(report.reloaded?.afterLoad?.expanded, ['$']),

  // 长任务 / 异常
  'perf:no-long-task':
    report.longTasksBeforeReload?.hasLongTaskObserver === true &&
    (report.longTasksBeforeReload?.longTasks?.length ?? 1) === 0 &&
    report.reloaded?.longTasksAfterReload?.hasLongTaskObserver === true &&
    (report.reloaded?.longTasksAfterReload?.longTasks?.length ?? 1) === 0,
  'console:no-phase-errors': report.errors === undefined,
  'console:no-exception-no-error':
    (report.consoleErrors?.length ?? 0) === 0 && (report.consoleErrorLogs?.length ?? 0) === 0,
};

if (report.errors) console.log(`\nphase errors: ${JSON.stringify(report.errors, null, 2)}`);
for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? '✅' : '❌'} ${name}`);
if (Object.values(checks).some((ok) => !ok)) {
  const debug = {
    empty: report.empty,
    small: {
      rows: report.small?.rows,
      afterExpandB: report.small?.afterExpandB?.rows,
      afterCollapseB: report.small?.afterCollapseB?.rows,
      afterExpandD: report.small?.afterExpandD?.rows,
      emptyRow: report.small?.emptyRow,
      afterInvisible: report.small?.afterInvisible,
      afterReveal: report.small?.afterReveal,
      afterJump: report.small?.afterJump,
      closed: report.small?.closed,
      reopened: report.small?.reopened,
      rootAfter: report.small?.rootAfter,
    },
    keyboard: report.keyboard,
    weird: report.weird,
    weird: report.weird,
    paging: {
      page1: report.paging?.page1,
      page2: report.paging?.page2,
      page3: report.paging?.page3 && { ...report.paging.page3, info: undefined },
      spacer: report.paging?.page3?.info,
      bottom: report.paging?.bottom?.info,
      rowJump: report.paging?.rowJump,
      enterJump: report.paging?.enterJump,
      treeBeforeJump: report.paging?.treeBeforeJump,
      treeBeforeEnter: report.paging?.treeBeforeEnter,
    },
    rowheight: report.rowheight,
    resetEdit: report.resetEdit,
    rawView: report.rawView,
    perf: report.perf
      ? {
          loadToOutlineReadyMs: report.perf.loadToOutlineReadyMs,
          panelOpenMs: report.perf.panelOpenMs,
          expandDataMs: report.perf.expandDataMs,
          expandItemsMs: report.perf.expandItemsMs,
          after: report.perf.after,
        }
      : null,
    reloaded: report.reloaded,
  };
  console.log(`\n--- debug ---\n${JSON.stringify(debug, null, 2)}`);
  await writeFile(path.join(SHOTS, 'outline-report.json'), JSON.stringify({ checks, report, debug }, null, 2));
}
const passed = Object.values(checks).filter(Boolean).length;
const total = Object.keys(checks).length;
console.log(`\nsmoke-outline: ${passed}/${total} ${passed === total ? 'OK' : 'FAILED'}`);
process.exitCode = passed === total ? 0 : 1;
