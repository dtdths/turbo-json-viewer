/**
 * scripts/smoke-copy.mjs — 复制四格式（#9 / ADR-0010）真机冒烟。
 *
 *   node build.mjs && node scripts/smoke-copy.mjs
 *
 * 测：
 *   1) 树行右键菜单：固定 7 项顺序（复制子树 JSON / 复制路径 / 复制原始值 / 复制键名 /
 *      展开整棵子树 / 收起整棵子树 / 编辑此节点 JSON）、容器「复制原始值」禁用、根「复制键名」禁用、
 *      数组元素四格式都可用；子树两项只在「有子节点的非根容器」上可用（#22 / ADR-0010 修订）。
 *   2) 四格式文本（`__tjv.copyResolve`，逐字比较）：子树 JSON（2 空格、非标识符键）、根子树、
 *      规范路径（`$['b.c']` / `$['it\'s']`）、原始值（数字 / 去引号去转义的字符串 / 布尔 / null）、
 *      键名（`b.c` / 数组下标 `0`）、容器原值与根键名 → BAD_COMMAND。
 *   3) 真实菜单点击 → toast 反馈 + 菜单关闭 + 剪贴板读回（headless 默认拒绝 readText，脚本经 CDP
 *      给静态服务 origin 授读权限；授权失败则读回为 null、只验 toast/菜单/状态并报告）。
 *   4) 行尾操作浮条（ADR-0010 修订）：2 个真实 `<button>`（aria-label / tabindex=-1）、hover 显示、
 *      点复制 = 子树 JSON 快路径（容器行与标量行）、点编辑 = 打开子树弹层且路径正确。
 *   5) 超大子树（>5MB 标量）→ `copyResolve` 返 TOO_LARGE + 点击复制 toast 引导导出。
 *   6) 复制只读：docRevision / rowVersion / totalRows 不变；0 page 异常 / 0 console error。
 *   7) 菜单交互契约（ADR-0015）：打开焦点落第一可用项、↑↓ 跳过禁用项、Home/End、
 *      Esc/Tab/失焦/外部 pointerdown/resize 关闭、Esc/选中后焦点回树。
 *
 * 截图落 .spike/smoke/copy-*.png；走 HTTP + `window.__tjv`（同 smoke-edit.mjs harness）。
 * 钩子缺失（特性尚未构建）时只报 FAIL，不中断其余断言。
 */
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { launchChrome, REPO_ROOT } from '../prototype/p1/lib/chrome.mjs';
import { startStaticServer } from '../prototype/p1/lib/http.mjs';

const SHOTS = path.join(REPO_ROOT, '.spike', 'smoke');
await mkdir(SHOTS, { recursive: true });

/** 固定菜单契约（ADR-0010 §1 / 修订 2026-11-09 #22 / #30 ADR-0019）：8 项、DOM 顺序即此顺序。 */
const MENU_ACTS = [
  'copy-subtree',
  'copy-path',
  'copy-value',
  'copy-key',
  'expand-subtree',
  'collapse-subtree',
  'edit',
  'locate-raw',
];
const MENU_LABELS = [
  '复制子树 JSON',
  '复制路径',
  '复制原始值',
  '复制键名',
  '展开整棵子树',
  '收起整棵子树',
  '编辑此节点 JSON',
  '在原文中定位',
];

/**
 * 覆盖矩阵：标识符键 / 含点键 / 含撇号键 / 标量数组 + 对象数组元素 / 四种标量。
 * 根是对象（根「原始值」也应禁用，与容器同规则）。
 */
const FIXTURE = {
  a: { 'b.c': 'x' },
  'b.c': 'top',
  "it's": 'line\n"q" \\ tail',
  arr: [10, { k: null }],
  flag: true,
  nil: null,
  num: -1.5,
  str: 'hello',
};

/** 规范路径（src/shared/path.ts）：`$` / `.key` / `['a.b']` / `[i]`。 */
const PATHS = {
  root: '$',
  a: '$.a',
  dotKey: "$['b.c']",
  nestedDot: "$.a['b.c']",
  quoteKey: "$['it\\'s']",
  arr0: '$.arr[0]',
  arr1k: '$.arr[1].k',
  flag: '$.flag',
  nil: '$.nil',
};

const SUBTREE_A = JSON.stringify(FIXTURE.a, null, 2); // {\n  "b.c": "x"\n}
const SUBTREE_ROOT = JSON.stringify(FIXTURE, null, 2);
// 自适应展开（≤ ADAPTIVE_EXPAND_ROWS）：root(1) + 8 键 + a.b.c(1) + arr[0..1](2) + arr[1].k(1)
const FIXTURE_ROWS = 13;

const server = await startStaticServer(REPO_ROOT);
const chrome = await launchChrome({ windowSize: '1440,900' });
const report = {};

try {
  // headless CfT 默认拒绝 `navigator.clipboard.readText()`（NotAllowedError）：
  // 用 CDP 给静态服务 origin 授一次读权限，让「剪贴板逐字比对」真正生效；授权失败只是退回 null 读回。
  try {
    await chrome.browser.send('Browser.grantPermissions', {
      origin: server.base,
      permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
    });
    report.clipboardGranted = true;
  } catch {
    report.clipboardGranted = false;
  }

  const page = await chrome.openPage();
  const errorsBefore = page.exceptions.length;
  await page.setViewport(1440, 900);
  await page.goto(`${server.base}/dist/page.html`, { timeoutMs: 20000 });
  await page.waitFor('document.readyState === "complete"', { timeoutMs: 10000 });
  await new Promise((r) => setTimeout(r, 400));

  /** 单个 phase 失败只记入 report.errors，后续 phase 继续（钩子缺失时得到完整 FAIL 列表）。 */
  const runPhase = async (name, expression) => {
    try {
      Object.assign(report, (await page.eval(expression)) ?? {});
    } catch (error) {
      if (!report.errors) report.errors = {};
      report.errors[name] = String(error?.message ?? error);
      console.warn(`⚠️ phase ${name} failed: ${String(error?.message ?? error)}`);
    }
  };

  // ---- phase 1：加载 fixture + 容器行右键（复制原始值应禁用） ----
  await runPhase(
    'container-menu',
    `(async () => {
      const out = {};
      const hook = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const FIXTURE = ${JSON.stringify(FIXTURE)};
      const P = ${JSON.stringify(PATHS)};
      window.__smoke = { sleep, P };
      out.hookTypes = {
        loadText: typeof hook?.loadText,
        state: typeof hook?.state,
        ctxOpen: typeof hook?.ctxOpen,
        ctxClick: typeof hook?.ctxClick,
        copyResolve: typeof hook?.copyResolve,
        clipboardText: typeof hook?.clipboardText,
        toastText: typeof hook?.toastText,
      };
      if (typeof hook?.loadText !== 'function') return out;
      await hook.loadText(JSON.stringify(FIXTURE), 'copy.json');
      await sleep(600); // 自适应展开 + 首帧渲染（给足时间，冒烟要确定性）
      out.loadedState = typeof hook.state === 'function' ? hook.state() : null;
      if (typeof hook.ctxOpen !== 'function') return out;
      out.containerMenu = await hook.ctxOpen(P.a); // 对象容器：复制原始值必须禁用
      return out;
    })()`,
  );
  await page.screenshot(path.join(SHOTS, 'copy-menu-container.png'));

  // ---- phase 2：根行右键（复制键名应禁用） ----
  await runPhase(
    'root-menu',
    `(async () => {
      const out = {};
      const { P } = window.__smoke;
      if (typeof window.__tjv?.ctxOpen !== 'function') return out;
      out.rootMenu = await window.__tjv.ctxOpen(P.root);
      return out;
    })()`,
  );
  await page.screenshot(path.join(SHOTS, 'copy-menu-root.png'));

  // ---- phase 3：数组元素菜单（原始值/键名都可用）+ 四格式逐字文本 ----
  await runPhase(
    'resolve',
    `(async () => {
      const out = {};
      const h = window.__tjv;
      const { P } = window.__smoke;
      if (typeof h?.ctxOpen !== 'function') return out;
      out.arrayMenu = await h.ctxOpen(P.arr0); // 标量元素：复制原始值 / 键名都可用
      const resolve = async (p, format) => {
        try {
          return await h.copyResolve(p, format);
        } catch (e) {
          return { thrown: String(e?.message ?? e) };
        }
      };
      out.subtreeA = await resolve(P.a, 'subtree');
      out.subtreeRoot = await resolve(P.root, 'subtree');
      out.pathDotKey = await resolve(P.dotKey, 'path');
      out.pathNestedDot = await resolve(P.nestedDot, 'path');
      out.pathQuoteKey = await resolve(P.quoteKey, 'path');
      out.valueNumber = await resolve(P.arr0, 'value');
      out.valueString = await resolve(P.quoteKey, 'value');
      out.valueBool = await resolve(P.flag, 'value');
      out.valueNull = await resolve(P.nil, 'value');
      out.keyDot = await resolve(P.dotKey, 'key');
      out.keyIndex = await resolve(P.arr0, 'key');
      out.valueContainer = await resolve(P.a, 'value');
      out.keyRoot = await resolve(P.root, 'key');
      return out;
    })()`,
  );

  // ---- phase 3.5：菜单交互契约（ADR-0015：键盘 / 失焦 / 焦点归还 / 关闭触发） ----
  await runPhase(
    'menu-contract',
    `(async () => {
      const out = {};
      const h = window.__tjv;
      const { P } = window.__smoke;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const menu = document.getElementById('ctxMenu');
      const tree = document.querySelector('#tree [role="tree"]') || document.getElementById('tree');
      const activeAct = () => document.activeElement?.dataset?.act ?? null;
      const press = (key) =>
        document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      const state = () => ({ open: !menu.hidden, focusTree: document.activeElement === tree });
      if (typeof h?.ctxOpen !== 'function' || !tree) return out;

      // 打开焦点 = 第一可用项；↑↓/Home/End 只在可用项间移动
      await h.ctxOpen(P.a);
      out.openFocus = activeAct();
      press('ArrowDown');
      out.arrowDownFocus = activeAct();
      press('End');
      out.endFocus = activeAct();
      press('Home');
      out.homeFocus = activeAct();

      // Esc：关闭 + 焦点回树
      press('Escape');
      out.escape = state();

      // Tab：关闭 + 焦点回树（合成事件不触发默认 Tab 导航）
      await h.ctxOpen(P.a);
      press('Tab');
      out.tab = state();

      // 失焦：焦点移到菜单外 → 关闭
      await h.ctxOpen(P.a);
      tree.focus();
      out.blur = state();

      // 外部 pointerdown：关闭
      await h.ctxOpen(P.a);
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      out.outside = state();

      // window resize：关闭
      await h.ctxOpen(P.a);
      window.dispatchEvent(new Event('resize'));
      out.resize = state();

      // 选中项：关闭 + 焦点回树
      await h.ctxOpen(P.a);
      out.selectClick = await h.ctxClick('copy-path');
      await sleep(120);
      out.select = state();

      // 根菜单：可用项 = copy-subtree / copy-path / edit，↓ 跳过 copy-value / copy-key / 两个子树项
      await h.ctxOpen(P.root);
      out.rootFirst = activeAct();
      press('ArrowDown');
      out.rootSecond = activeAct();
      press('ArrowDown');
      out.rootThird = activeAct();
      press('Escape');
      out.afterRoot = state();
      return { menuContract: out };
    })()`,
  );

  // ---- phase 4：真实菜单点击 → toast + 菜单关闭 + 剪贴板读回 ----
  await runPhase(
    'clipboard',
    `(async () => {
      const out = {};
      const h = window.__tjv;
      const { P } = window.__smoke;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      if (typeof h?.ctxClick !== 'function') return out;
      const clip = async () => {
        try {
          return await h.clipboardText();
        } catch {
          return null;
        }
      };
      const click = async (p, act) => {
        const menu = await h.ctxOpen(p);
        const res = await h.ctxClick(act);
        await sleep(120); // 等剪贴板写入 / toast 落定
        const toast = typeof h.toastText === 'function' ? h.toastText() : '';
        return { menuHidden: menu?.hidden ?? null, res, toast, clipboard: await clip() };
      };
      out.copiesStart = h.state();
      out.pathClick = await click(P.arr1k, 'copy-path');
      out.subtreeClick = await click(P.a, 'copy-subtree');
      out.valueClick = await click(P.arr0, 'copy-value');
      out.keyClick = await click(P.dotKey, 'copy-key');
      out.clipboardReadable = [out.pathClick, out.subtreeClick, out.valueClick, out.keyClick].some(
        (c) => typeof c.clipboard === 'string',
      );
      out.copiesEnd = h.state();
      return out;
    })()`,
  );
  await page.screenshot(path.join(SHOTS, 'copy-toast.png'));

  // ---- phase 4.5：行尾操作浮条（ADR-0010 修订：复制=子树 JSON 快路径 / 编辑=弹层） ----
  const rowActionProbe = await page.eval(`(async () => {
    const out = {};
    const row = document.querySelector('.row[data-path="$.a"]');
    const wrap = row?.querySelector('.row__actions') ?? null;
    const acts = row ? [...row.querySelectorAll('.row__action')] : [];
    out.buttons = acts.map((b) => ({
      tag: b.tagName,
      action: b.dataset.action,
      label: b.getAttribute('aria-label'),
      tabIndex: b.tabIndex,
    }));
    out.ariaHidden = wrap ? wrap.getAttribute('aria-hidden') : 'missing';
    out.opacityBeforeHover = wrap ? getComputedStyle(wrap).opacity : null;
    const box = acts[0]?.getBoundingClientRect();
    out.anchor = box ? { x: box.left + box.width / 2, y: box.top + box.height / 2 } : null;
    return out;
  })()`);
  report.rowActionButtons = rowActionProbe.buttons;
  report.rowActionAriaHidden = rowActionProbe.ariaHidden;
  report.rowActionOpacityBeforeHover = rowActionProbe.opacityBeforeHover;
  if (rowActionProbe.anchor) {
    // 真实指针移入行 → 触发 CSS :hover（浮条 opacity 0→1，过渡 110ms）
    await chrome.browser.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseMoved', x: rowActionProbe.anchor.x, y: rowActionProbe.anchor.y, buttons: 0 },
      page.sessionId,
    );
    await new Promise((r) => setTimeout(r, 260));
  }
  report.rowActionOpacityHover = await page.eval(
    `(() => { const row = document.querySelector('.row[data-path="$.a"]'); const w = row?.querySelector('.row__actions'); return w ? getComputedStyle(w).opacity : null; })()`,
  );
  await page.screenshot(path.join(SHOTS, 'copy-row-actions.png'));

  // 点浮条「复制」：容器行 → 子树 JSON + toast + 选中该行
  report.rowActionCopy = await page.eval(`(async () => {
    const h = window.__tjv;
    const btn = document.querySelector('.row[data-path="$.a"] .row__action[data-action="copy"]');
    if (!btn) return { clicked: false };
    const before = h.toastText();
    btn.click();
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 20));
      if (h.toastText() !== before) break;
    }
    let clipboard = null;
    try { clipboard = await h.clipboardText(); } catch {}
    return {
      clicked: true,
      toast: h.toastText(),
      tone: document.getElementById('toast')?.dataset.tone ?? null,
      clipboard,
      selected: h.state().selected,
    };
  })()`);

  // 点浮条「复制」：标量行 → `10`（不是容器缩进）
  report.rowActionCopyScalar = await page.eval(`(async () => {
    const h = window.__tjv;
    const btn = document.querySelector('.row[data-path="$.arr[0]"] .row__action[data-action="copy"]');
    if (!btn) return { clicked: false };
    const before = h.toastText();
    btn.click();
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 20));
      if (h.toastText() !== before) break;
    }
    let clipboard = null;
    try { clipboard = await h.clipboardText(); } catch {}
    return { clicked: true, toast: h.toastText(), clipboard };
  })()`);

  // 点浮条「编辑」：与双击/F2 同一 openEditor 流程 → 弹层打开、路径正确、可关闭
  report.rowActionEdit = await page.eval(`(async () => {
    const h = window.__tjv;
    const btn = document.querySelector('.row[data-path="$.arr[0]"] .row__action[data-action="edit"]');
    if (!btn) return { clicked: false };
    btn.click();
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 25));
      if (document.getElementById('editModal')?.hidden === false) break;
    }
    const modalOpen = document.getElementById('editModal')?.hidden === false;
    const out = {
      clicked: true,
      modalOpen,
      path: document.getElementById('editPath')?.textContent ?? '',
      text: typeof h.editText === 'function' ? h.editText() : null,
    };
    if (modalOpen) h.editClose();
    await new Promise((r) => setTimeout(r, 80));
    out.closed = document.getElementById('editModal')?.hidden === true;
    return out;
  })()`);


  // ---- phase 5：超大子树（>5MB 标量）→ TOO_LARGE + toast 引导导出 ----
  await runPhase(
    'too-large',
    `(async () => {
      const out = {};
      const h = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      if (typeof h?.copyResolve !== 'function' || typeof h?.ctxOpen !== 'function' || typeof h?.ctxClick !== 'function') {
        return out; // 钩子未实现：跳过 6MB 文档加载，交给检查项报 FAIL
      }
      out.bigStringBytes = 6 * 1024 * 1024;
      const text = JSON.stringify({ big: 'x'.repeat(out.bigStringBytes) });
      out.bigDocChars = text.length;
      await h.loadText(text, 'big.json');
      await sleep(900);
      out.bigState = h.state();
      try {
        out.bigResolve = await h.copyResolve('$.big', 'subtree');
      } catch (e) {
        out.bigResolve = { thrown: String(e?.message ?? e) };
      }
      try {
        out.bigMenu = await h.ctxOpen('$.big');
        out.bigClick = await h.ctxClick('copy-subtree');
      } catch (e) {
        out.bigClick = { thrown: String(e?.message ?? e) };
      }
      await sleep(120);
      out.bigToast = typeof h.toastText === 'function' ? h.toastText() : '';
      out.bigToastTone = document.getElementById('toast')?.dataset.tone ?? null;
      out.bigStateAfter = h.state();
      return out;
    })()`,
  );

  // ---- phase 6：#22 子树菜单项的启用态矩阵（空容器 / 标量 / 根）----
  await runPhase(
    'subtree-contract',
    `(async () => {
      const out = {};
      const h = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      if (typeof h?.ctxOpen !== 'function') return out;
      // 小文档自适应展开：empty 空容器、obj 有子节点的容器、arr 数组容器、str 标量都可见
      const doc = { empty: {}, obj: { k: 1 }, arr: [1, { n: 2 }], str: 'v' };
      await h.loadText(JSON.stringify(doc), 'subtree-menu.json');
      await sleep(600);
      out.state = h.state();
      const menu = async (path) => {
        const res = await h.ctxOpen(path);
        return { hidden: res.hidden, items: res.items };
      };
      out.menuObj = await menu('$.obj');
      out.menuEmpty = await menu('$.empty');
      out.menuScalar = await menu('$.str');
      out.menuRoot = await menu('$');
      return out;
    })()`,
  );

  // ---- 汇总：page 异常 / console error ----
  report.consoleErrors = page.exceptions.slice(errorsBefore);
  report.consoleErrorLogs = page.logs
    .filter((entry) => entry.type === 'error')
    .map((entry) => entry.text);
} finally {
  await chrome.close();
  await server.close();
}

console.log(JSON.stringify(report, null, 2));

const item = (menu, act) => (menu?.items ?? []).find((entry) => entry.act === act);
const isEnabled = (menu, act) => item(menu, act)?.disabled === false;
const isDisabled = (menu, act) => item(menu, act)?.disabled === true;
const actsOf = (menu) => (menu?.items ?? []).map((entry) => entry.act);
const labelsOf = (menu) => (menu?.items ?? []).map((entry) => entry.label);
const hookType = (name) => report.hookTypes?.[name];
const bytesOf = (text) => Buffer.byteLength(text, 'utf8');

/** 一次菜单点击：真实点击成功 + 菜单关掉 + toast 含「已复制」与格式名。 */
const clickOk = (click, word) => {
  const toast = click?.res?.toast ?? click?.toast ?? '';
  return (
    click?.res?.clicked === true &&
    click?.res?.hidden === true &&
    /已复制/.test(toast) &&
    toast.includes(word)
  );
};
/** 剪贴板可能读不到（headless 无读权限）→ 只在读到时逐字比对。 */
const clipboardOk = (click, expected) =>
  click?.clipboard == null || click?.clipboard === expected;

const versionsEqual = (before, after) =>
  Boolean(before && after) &&
  before.docRevision === after.docRevision &&
  before.rowVersion === after.rowVersion &&
  before.totalRows === after.totalRows;

// phase 5 的点击结果直接是 ctxClick 的 { clicked, toast, hidden }；兼容包了一层 res 的形态。
const bigClickRes = report.bigClick?.res ?? report.bigClick;
const bigToast = report.bigToast || bigClickRes?.toast || '';

const checks = {
  'hook:copy-dev-hooks-present': ['ctxOpen', 'ctxClick', 'copyResolve', 'clipboardText', 'toastText'].every(
    (name) => hookType(name) === 'function',
  ),

  'load:fixture-fully-expanded':
    report.loadedState?.totalRows === FIXTURE_ROWS &&
    typeof report.loadedState?.docRevision === 'number' &&
    report.loadedState?.rootId != null &&
    (report.loadedState?.rendered ?? 0) > 0,

  'menu:order-and-labels':
    report.containerMenu?.hidden === false &&
    JSON.stringify(actsOf(report.containerMenu)) === JSON.stringify(MENU_ACTS) &&
    JSON.stringify(labelsOf(report.containerMenu)) === JSON.stringify(MENU_LABELS),

  'menu:container-value-disabled':
    isDisabled(report.containerMenu, 'copy-value') &&
    isEnabled(report.containerMenu, 'copy-key') &&
    isEnabled(report.containerMenu, 'copy-subtree') &&
    isEnabled(report.containerMenu, 'copy-path') &&
    // #22：容器且有子节点 → 两个子树项可用，title 说明「含该节点自身；不含更上层」
    isEnabled(report.containerMenu, 'expand-subtree') &&
    isEnabled(report.containerMenu, 'collapse-subtree') &&
    /含该节点自身/.test(item(report.containerMenu, 'expand-subtree')?.title ?? '') &&
    isEnabled(report.containerMenu, 'edit'),

  // 根也是对象容器：按 ADR-0010 §1「原始值仅标量」，复制原始值同样禁用
  'menu:root-key-disabled':
    report.rootMenu?.hidden === false &&
    isDisabled(report.rootMenu, 'copy-key') &&
    isDisabled(report.rootMenu, 'copy-value') &&
    // #22：根上的子树项禁用（请用工具栏全部展开/收起）
    isDisabled(report.rootMenu, 'expand-subtree') &&
    isDisabled(report.rootMenu, 'collapse-subtree') &&
    isEnabled(report.rootMenu, 'copy-subtree') &&
    isEnabled(report.rootMenu, 'copy-path') &&
    isEnabled(report.rootMenu, 'edit'),

  'menu:array-element-enabled':
    report.arrayMenu?.hidden === false &&
    // ctxOpen(path) 必须自己解析节点类型（与真实右键一致，行上有 data-kind）；若实现要求额外传 kind，
    // 这里会暴露成「标量行的复制原始值被禁用」。
    isEnabled(report.arrayMenu, 'copy-value') &&
    isEnabled(report.arrayMenu, 'copy-key') &&
    isEnabled(report.arrayMenu, 'copy-subtree') &&
    isEnabled(report.arrayMenu, 'copy-path') &&
    // #22：标量行没有可展开的子孙 → 两个子树项禁用
    isDisabled(report.arrayMenu, 'expand-subtree') &&
    isDisabled(report.arrayMenu, 'collapse-subtree') &&
    isEnabled(report.arrayMenu, 'edit'),

  // ---- 菜单交互契约（ADR-0015）：键盘 / 失焦 / 焦点归还 / 关闭触发 ----
  'menu:open-focus-first-enabled': report.menuContract?.openFocus === 'copy-subtree',
  'menu:arrow-down': report.menuContract?.arrowDownFocus === 'copy-path',
  'menu:home-end':
    report.menuContract?.endFocus === 'locate-raw' &&
    report.menuContract?.homeFocus === 'copy-subtree',
  'menu:escape-closes-and-restores-tree-focus':
    report.menuContract?.escape?.open === false && report.menuContract?.escape?.focusTree === true,
  'menu:tab-closes-and-restores-tree-focus':
    report.menuContract?.tab?.open === false && report.menuContract?.tab?.focusTree === true,
  'menu:blur-closes': report.menuContract?.blur?.open === false,
  'menu:outside-pointerdown-closes': report.menuContract?.outside?.open === false,
  'menu:resize-closes': report.menuContract?.resize?.open === false,
  'menu:select-closes-and-restores-tree-focus':
    report.menuContract?.selectClick?.hidden === true &&
    report.menuContract?.select?.open === false &&
    report.menuContract?.select?.focusTree === true,
  'menu:nav-skips-disabled':
    report.menuContract?.rootFirst === 'copy-subtree' &&
    report.menuContract?.rootSecond === 'copy-path' &&
    report.menuContract?.rootThird === 'edit' &&
    report.menuContract?.afterRoot?.open === false,

  'resolve:subtree-object':
    report.subtreeA?.text === SUBTREE_A &&
    report.subtreeA?.bytes === bytesOf(SUBTREE_A) &&
    report.subtreeA?.format === 'subtree',

  'resolve:subtree-root':
    report.subtreeRoot?.text === SUBTREE_ROOT &&
    report.subtreeRoot?.bytes === bytesOf(SUBTREE_ROOT) &&
    report.subtreeRoot?.format === 'subtree',

  // #22：子树两项的启用矩阵——有子节点的容器启用；空容器 / 标量 / 根禁用（title 说明原因）
  'menu:subtree-enable-matrix':
    isEnabled(report.menuObj, 'expand-subtree') &&
    isEnabled(report.menuObj, 'collapse-subtree') &&
    isDisabled(report.menuEmpty, 'expand-subtree') &&
    isDisabled(report.menuEmpty, 'collapse-subtree') &&
    /没有子节点/.test(item(report.menuEmpty, 'expand-subtree')?.title ?? '') &&
    isDisabled(report.menuScalar, 'expand-subtree') &&
    isDisabled(report.menuScalar, 'collapse-subtree') &&
    /只能展开容器/.test(item(report.menuScalar, 'expand-subtree')?.title ?? '') &&
    isDisabled(report.menuRoot, 'expand-subtree') &&
    isDisabled(report.menuRoot, 'collapse-subtree') &&
    /工具栏/.test(item(report.menuRoot, 'expand-subtree')?.title ?? ''),

  'resolve:path-canonical':
    report.pathDotKey?.text === PATHS.dotKey &&
    report.pathDotKey?.format === 'path' &&
    report.pathNestedDot?.text === PATHS.nestedDot &&
    report.pathQuoteKey?.text === PATHS.quoteKey,

  'resolve:value-number':
    report.valueNumber?.text === '10' && report.valueNumber?.format === 'value',

  'resolve:value-string-raw':
    report.valueString?.text === FIXTURE["it's"] &&
    report.valueString?.bytes === bytesOf(FIXTURE["it's"]),

  'resolve:value-boolean-and-null':
    report.valueBool?.text === 'true' && report.valueNull?.text === 'null',

  'resolve:key':
    report.keyDot?.text === 'b.c' && report.keyDot?.format === 'key' && report.keyIndex?.text === '0',

  'resolve:bad-command':
    report.valueContainer?.error?.code === 'BAD_COMMAND' &&
    report.keyRoot?.error?.code === 'BAD_COMMAND',

  'clipboard:path-via-menu':
    clickOk(report.pathClick, '路径') && clipboardOk(report.pathClick, PATHS.arr1k),

  'clipboard:subtree-container-via-menu':
    clickOk(report.subtreeClick, '子树') && clipboardOk(report.subtreeClick, SUBTREE_A),

  'clipboard:value-and-key-via-menu':
    clickOk(report.valueClick, '原始值') &&
    clipboardOk(report.valueClick, '10') &&
    clickOk(report.keyClick, '键名') &&
    clipboardOk(report.keyClick, 'b.c'),

  'row-action:buttons':
    JSON.stringify((report.rowActionButtons ?? []).map((b) => b.tag)) ===
      JSON.stringify(['BUTTON', 'BUTTON', 'BUTTON']) &&
    JSON.stringify((report.rowActionButtons ?? []).map((b) => b.action)) ===
      JSON.stringify(['copy', 'edit', 'raw']) &&
    JSON.stringify((report.rowActionButtons ?? []).map((b) => b.label)) ===
      JSON.stringify(['复制子树 JSON', '编辑此节点 JSON', '在原文中定位']) &&
    (report.rowActionButtons ?? []).every((b) => b.tabIndex === -1),
  // 浮条容器不再 aria-hidden（按钮自带 aria-label，AT 可读）
  'row-action:no-aria-hidden': report.rowActionAriaHidden === null,
  'row-action:visible-on-hover':
    report.rowActionOpacityBeforeHover === '0' && report.rowActionOpacityHover === '1',
  'row-action:copy-subtree':
    report.rowActionCopy?.clicked === true &&
    /已复制/.test(report.rowActionCopy?.toast ?? '') &&
    (report.rowActionCopy?.toast ?? '').includes('子树 JSON') &&
    (report.rowActionCopy?.clipboard == null || report.rowActionCopy?.clipboard === SUBTREE_A) &&
    report.rowActionCopy?.tone === 'success' &&
    report.rowActionCopy?.selected === PATHS.a,
  'row-action:copy-scalar':
    report.rowActionCopyScalar?.clicked === true &&
    (report.rowActionCopyScalar?.clipboard == null || report.rowActionCopyScalar?.clipboard === '10'),
  'row-action:edit-modal':
    report.rowActionEdit?.clicked === true &&
    report.rowActionEdit?.modalOpen === true &&
    report.rowActionEdit?.path === PATHS.arr0 &&
    report.rowActionEdit?.text === '10' &&
    report.rowActionEdit?.closed === true,


  'too-large:resolve':
    report.bigResolve?.error?.code === 'TOO_LARGE' &&
    report.bigResolve?.text === undefined,

  // toast 文案由实现决定：只要求提到 5MB 或「导出」（不绑定具体措辞）
  'too-large:menu-toast':
    bigClickRes?.clicked === true &&
    bigClickRes?.hidden === true &&
    (/5\s*MB/i.test(bigToast) || /导出/.test(bigToast)) &&
    report.bigToastTone === 'error',

  'readonly:copy-does-not-bump-versions':
    versionsEqual(report.copiesStart, report.copiesEnd) &&
    versionsEqual(report.bigState, report.bigStateAfter),

  'console:no-exception-no-error':
    report.consoleErrors?.length === 0 && report.consoleErrorLogs?.length === 0,
};

if (report.clipboardReadable === true) {
  console.log('ℹ️ clipboard readback: readable（四格式剪贴板逐字比对已生效）');
} else {
  console.log('ℹ️ clipboard readback: unavailable → 读回断言跳过（仅验 toast / 菜单 / 状态）');
}
for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? '✅' : '❌'} ${name}`);
const passed = Object.values(checks).filter(Boolean).length;
const total = Object.keys(checks).length;
if (report.errors) console.log(`\nphase errors: ${JSON.stringify(report.errors, null, 2)}`);
console.log(`\nsmoke-copy: ${passed}/${total} ${passed === total ? 'OK' : 'FAILED'}`);
process.exitCode = passed === total ? 0 : 1;
