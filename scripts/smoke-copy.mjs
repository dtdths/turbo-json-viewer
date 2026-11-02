/**
 * scripts/smoke-copy.mjs — 复制四格式（#9 / ADR-0010）真机冒烟。
 *
 *   node build.mjs && node scripts/smoke-copy.mjs
 *
 * 测：
 *   1) 树行右键菜单：固定 5 项顺序（复制子树 JSON / 复制路径 / 复制原始值 / 复制键名 /
 *      编辑此节点 JSON）、容器「复制原始值」禁用、根「复制键名」禁用、数组元素四格式都可用。
 *   2) 四格式文本（`__tjv.copyResolve`，逐字比较）：子树 JSON（2 空格、非标识符键）、根子树、
 *      规范路径（`$['b.c']` / `$['it\'s']`）、原始值（数字 / 去引号去转义的字符串 / 布尔 / null）、
 *      键名（`b.c` / 数组下标 `0`）、容器原值与根键名 → BAD_COMMAND。
 *   3) 真实菜单点击 → toast 反馈 + 菜单关闭 + 剪贴板读回（headless 默认拒绝 readText，脚本经 CDP
 *      给静态服务 origin 授读权限；授权失败则读回为 null、只验 toast/菜单/状态并报告）。
 *   4) 超大子树（>5MB 标量）→ `copyResolve` 返 TOO_LARGE + 点击复制 toast 引导导出。
 *   5) 复制只读：docRevision / rowVersion / totalRows 不变；0 page 异常 / 0 console error。
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

/** 固定菜单契约（ADR-0010 §1）：5 项、DOM 顺序即此顺序。 */
const MENU_ACTS = ['copy-subtree', 'copy-path', 'copy-value', 'copy-key', 'edit'];
const MENU_LABELS = ['复制子树 JSON', '复制路径', '复制原始值', '复制键名', '编辑此节点 JSON'];

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
      out.bigStateAfter = h.state();
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
    isEnabled(report.containerMenu, 'edit'),

  // 根也是对象容器：按 ADR-0010 §1「原始值仅标量」，复制原始值同样禁用
  'menu:root-key-disabled':
    report.rootMenu?.hidden === false &&
    isDisabled(report.rootMenu, 'copy-key') &&
    isDisabled(report.rootMenu, 'copy-value') &&
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
    isEnabled(report.arrayMenu, 'edit'),

  'resolve:subtree-object':
    report.subtreeA?.text === SUBTREE_A &&
    report.subtreeA?.bytes === bytesOf(SUBTREE_A) &&
    report.subtreeA?.format === 'subtree',

  'resolve:subtree-root':
    report.subtreeRoot?.text === SUBTREE_ROOT &&
    report.subtreeRoot?.bytes === bytesOf(SUBTREE_ROOT) &&
    report.subtreeRoot?.format === 'subtree',

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

  'too-large:resolve':
    report.bigResolve?.error?.code === 'TOO_LARGE' &&
    report.bigResolve?.text === undefined,

  // toast 文案由实现决定：只要求提到 5MB 或「导出」（不绑定具体措辞）
  'too-large:menu-toast':
    bigClickRes?.clicked === true &&
    bigClickRes?.hidden === true &&
    (/5\s*MB/i.test(bigToast) || /导出/.test(bigToast)),

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
