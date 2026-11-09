/**
 * scripts/smoke-raw.mjs — 原始文本视图（#11 / ADR-0003 修订 2026-11-03）真机冒烟。
 *
 *   node build.mjs && node scripts/smoke-raw.mjs
 *
 * 测：
 *   1) 模式判定与逐字：pretty 源文本 → source 模式（源码行原样）；minified → pretty 模式
 *      （行布局 = JSON.stringify(value,null,2)，窗口行文本逐字相等）；截断文档 → plain 模式；
 *   2) 虚拟化：滚动到底/中段，渲染行数 ≤ 屏行+1+2×overscan，行号是根内绝对行号；
 *      3000 项 minified（>2048 行）跨检查点取窗口仍逐字正确（检查点可重放）；
 *   3) 修复摘要 `at` 跳行（#8 缺口）：点 `@at` → 切原文 → 滚到对应行 + 短暂高亮；
 *   4) 复制原文：逐字读回；>maxBytes 走 TOO_LARGE（不静默截断）；
 *   5) 临时修改：原文视图标注「不含临时修改」；展开/搜索等树动作会把视图切回树（v1 不联动）；
 *   6) 持久化：刷新后 viewMode 恢复；0 page 异常 / 0 console error。
 * 截图落 .spike/smoke/raw-{source,pretty,repair,edited,reloaded}.png；走 HTTP + `window.__tjv`。
 */
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { launchChrome, REPO_ROOT } from '../prototype/p1/lib/chrome.mjs';
import { startStaticServer } from '../prototype/p1/lib/http.mjs';

const SHOTS = path.join(REPO_ROOT, '.spike', 'smoke');
await mkdir(SHOTS, { recursive: true });

/** 多行源文本 → source 模式 */
const PRETTY_OBJ = { a: 1, b: { c: [1, 2] }, d: 'x' };
const PRETTY = JSON.stringify(PRETTY_OBJ, null, 2);
const PRETTY_LINES = PRETTY.split('\n');
/** 多行源文本（约 330 行）→ source 模式滚动/虚拟化 */
const MED_OBJ = { rows: Array.from({ length: 80 }, (_, i) => ({ i, name: `row-${i}`, ok: i % 2 === 0 })) };
const MED_PRETTY = JSON.stringify(MED_OBJ, null, 2);
const MED_PRETTY_LINES = MED_PRETTY.split('\n');
/** minified 且最长行 > 4096（≈11KB 单行）→ pretty 模式，但行数 < 2048（不跨检查点） */
const MID_OBJ = { rows: Array.from({ length: 240 }, (_, i) => ({ i, name: `mid-${i}`, flag: i % 3 === 0 })) };
const MID_MIN = JSON.stringify(MID_OBJ);
const MID_LINES = JSON.stringify(MID_OBJ, null, 2).split('\n');
/** >2048 行（跨检查点）：3000 项对象数组，minified → pretty 行数 ≈ 12000 */
const BIG_OBJ = {
  items: Array.from({ length: 3000 }, (_, i) => ({ i, name: `n${i}`, ok: i % 2 === 0 })),
};
const BIG_MIN = JSON.stringify(BIG_OBJ);
const BIG_LINES = JSON.stringify(BIG_OBJ, null, 2).split('\n');
/** 截断文档：修复后 plain 模式，摘要 ops 的 `at` 是原文本偏移 */
const TRUNCATED = '{"a":1,"b":"hello wor';

const server = await startStaticServer(REPO_ROOT);
const chrome = await launchChrome({ windowSize: '1440,900' });
const report = {};
const url = `${server.base}/dist/page.html`;

try {
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
  await page.goto(url, { timeoutMs: 20000 });
  await page.waitFor('document.readyState === "complete"', { timeoutMs: 20000 });
  await new Promise((r) => setTimeout(r, 600));

  // 长任务观察器（ADR-0003 修订 §7：原文索引/窗口/切换不得产生主线程长任务）
  await page.eval(`(() => {
    window.__rawLongTasks = [];
    try {
      const po = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) window.__rawLongTasks.push(Math.round(entry.duration));
      });
      po.observe({ entryTypes: ['longtask'] });
      window.__rawHasLongTaskObserver = true;
    } catch {
      window.__rawHasLongTaskObserver = false;
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

  // ---- phase 1：多行源文本 → source 模式（逐字 + 行号 + 虚拟化）----
  await runPhase(
    'source',
    `(async () => {
      const out = {};
      const h = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      await h.loadText(${JSON.stringify(MED_PRETTY)}, 'pretty.json');
      await sleep(400);
      out.source = { before: h.rawState(), tree: h.state() };
      const started = performance.now();
      out.source.open = await h.setViewMode('raw');
      out.source.openMs = Math.round(performance.now() - started);
      await sleep(250);
      out.source.window = await h.rawWindowText(0, ${MED_PRETTY_LINES.length});
      out.source.head = h.rawState();
      // 滚到中段：行号必须继续绝对递增、渲染行数受窗口纪律约束
      h.rawScrollTo(36 * 24);
      await sleep(300);
      out.source.mid = h.rawState();
      // 滚到底
      h.rawScrollTo(10000000);
      await sleep(300);
      out.source.end = h.rawState();
      return out;
    })()`,
  );
  await page.screenshot(path.join(SHOTS, 'raw-source.png'));

  // ---- phase 2：minified 源文本 → pretty 模式（窗口逐字 vs JSON.stringify 参考）----
  await runPhase(
    'pretty',
    `(async () => {
      const out = {};
      const h = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      await h.loadText(${JSON.stringify(MID_MIN)}, 'mid-min.json');
      await sleep(500);
      out.pretty = { open: await h.setViewMode('raw') };
      await sleep(300);
      const total = ${MID_LINES.length};
      out.pretty.totalLines = total;
      out.pretty.window = await h.rawWindowText(0, total);
      h.rawScrollTo(10000000);
      await sleep(300);
      out.pretty.end = h.rawState();
      out.pretty.tail = await h.rawWindowText(Math.max(0, total - 3), 3);
      return out;
    })()`,
  );
  await page.screenshot(path.join(SHOTS, 'raw-pretty.png'));

  // ---- phase 3：3000 项 minified（≈12000 行）→ 跨检查点的窗口仍逐字正确 ----
  await runPhase(
    'big',
    `(async () => {
      const out = {};
      const h = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      await h.loadText(${JSON.stringify(BIG_MIN)}, 'big.json');
      await sleep(700);
      out.big = { open: await h.setViewMode('raw') };
      await sleep(400);
      out.big.totalLines = h.rawState().raw?.totalLines ?? 0;
      // 60% 处（大概率落在检查点边界之后）；用 core 窗口逐字断言，避免 DOM 渲染时序
      const total = ${BIG_LINES.length};
      const starts = [0, 2047, 2048, 2049, Math.floor(total * 0.6), total - 1];
      h.rawScrollTo(Math.floor(total * 0.6) * 24);
      await sleep(350);
      out.big.mid = h.rawState();
      out.big.windows = [];
      for (const start of starts) {
        const window = await h.rawWindowText(start, 3);
        out.big.windows.push({ start, lines: window.lines, truncated: window.truncated ?? [] });
      }
      h.rawScrollTo(100000000);
      await sleep(300);
      out.big.end = h.rawState();
      return out;
    })()`,
  );
  await page.screenshot(path.join(SHOTS, 'raw-big.png'));

  // ---- phase 4：截断文档 → plain 模式 + 修复摘要 at 跳行 ----
  await runPhase(
    'repair',
    `(async () => {
      const out = {};
      const h = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      await h.loadText(${JSON.stringify(TRUNCATED)}, 'cut.json');
      await sleep(500);
      const repair = h.repairState();
      h.repairToggle();
      await sleep(120);
      out.repair = {
        provenance: repair,
        before: h.rawState(),
        atButtons: document.querySelectorAll('.repairbar__at').length,
        at: repair.opsDetail?.[0] ?? null,
      };
      // 真实点击第一个 @at → 切原文 + 定位 + 高亮
      out.repair.click = h.rawRepairAt(0);
      await sleep(500);
      out.repair.after = h.rawState();
      const offset = repair.opsDetail?.[0]?.at ?? 0;
      out.repair.locate = await h.rawLocate(offset);
      // 截图前收起摘要（展开的摘要面板是浮层，会盖住 1 行的原文内容）
      h.repairToggle();
      await sleep(120);
      return out;
    })()`,
  );
  await page.screenshot(path.join(SHOTS, 'raw-repair.png'));

  // ---- phase 5：复制原文（逐字读回 + TOO_LARGE 守卫）----
  await runPhase(
    'copy',
    `(async () => {
      const out = {};
      const h = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      await h.loadText(${JSON.stringify(PRETTY)}, 'copy.json');
      await sleep(400);
      await h.setViewMode('raw');
      await sleep(250);
      out.copy = { action: await h.rawCopy(), refused: await h.rawCopyText(10) };
      try { out.copy.clipboard = await h.clipboardText(); } catch { out.copy.clipboard = null; }
      return out;
    })()`,
  );

  // ---- phase 6：临时修改提示 + 树动作把视图切回树（v1 不联动）----
  await runPhase(
    'edited',
    `(async () => {
      const out = {};
      const h = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      await h.loadText(${JSON.stringify(PRETTY)}, 'edited.json');
      await sleep(400);
      await h.editOpen('$.b');
      await h.editApplyText('{"c":[1,2],"d":"y"}');
      await sleep(250);
      await h.setViewMode('raw');
      await sleep(250);
      out.edited = { state: h.rawState() };
      // 展开全部是树动作：应先把视图切回树
      out.edited.expand = await h.expandAll();
      await sleep(300);
      out.edited.afterExpand = { state: h.rawState(), tree: h.state() };
      // 搜索跳转同样切回树
      await h.setViewMode('raw');
      await sleep(200);
      await h.search('c');
      await h.searchJump(0);
      await sleep(250);
      out.edited.afterSearch = { state: h.rawState() };
      return out;
    })()`,
  );
  await page.screenshot(path.join(SHOTS, 'raw-edited.png'));

  // ---- phase 6.5：读长任务（刷新前；页面重载会清掉 window 状态）----
  await runPhase(
    'perf-before',
    `(() => ({ longTasksBeforeReload: { longTasks: window.__rawLongTasks, hasLongTaskObserver: window.__rawHasLongTaskObserver } }))()`,
  );

  // ---- phase 7：刷新后 viewMode 持久化（最后停在 raw）----
  await runPhase(
    'persist-before',
    `(async () => {
      const h = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      await h.loadText(${JSON.stringify(MID_MIN)}, 'persist.json');
      await sleep(500);
      await h.setViewMode('raw');
      await sleep(250);
      return { persistBefore: { state: { viewMode: h.state().viewMode, ui: h.settingsState().ui } } };
    })()`,
  );
  await page.goto(url, { timeoutMs: 20000 });
  await page.waitFor('document.readyState === "complete"', { timeoutMs: 20000 });
  await new Promise((r) => setTimeout(r, 500));
  await page.eval(`(() => {
    window.__rawLongTasks = [];
    try {
      const po = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) window.__rawLongTasks.push(Math.round(entry.duration));
      });
      po.observe({ entryTypes: ['longtask'] });
      window.__rawHasLongTaskObserver = true;
    } catch {
      window.__rawHasLongTaskObserver = false;
    }
    return true;
  })()`);
  await runPhase(
    'persist-after',
    `(async () => {
      const out = {};
      const h = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      await h.loadText(${JSON.stringify(MID_MIN)}, 'persist.json');
      await sleep(900);
      out.reloaded = {
        state: h.rawState(),
        ui: h.settingsState().ui,
        longTasksAfterReload: { longTasks: window.__rawLongTasks, hasLongTaskObserver: window.__rawHasLongTaskObserver },
      };
      return out;
    })()`,
  );
  await page.screenshot(path.join(SHOTS, 'raw-reloaded.png'));

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

const close = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const renderedBound = (state) =>
  typeof state?.rendered === 'number' &&
  typeof state?.viewportRows === 'number' &&
  state.rendered <= state.viewportRows + 1 + 2 * 8;

const checks = {
  // source 模式
  'source:mode':
    report.source?.open?.raw?.mode === 'source' &&
    report.source?.open?.raw?.damaged !== true &&
    report.source?.open?.raw?.totalLines === MED_PRETTY_LINES.length,
  'source:window-verbatim':
    close(report.source?.window?.lines, MED_PRETTY_LINES) &&
    report.source?.window?.mode === 'source',
  'source:first-line-gutter':
    report.source?.head?.lines?.[0]?.line === 1 && report.source?.head?.lines?.[0]?.text === MED_PRETTY_LINES[0],
  // 首次进入原文视图必须一次给满视口：open 在途时（totalLines 未知）算出的排队目标不能被沿用，
  // 否则首窗被夹成 1 行、只露出第一行 `{`，要切树再切回来才恢复（窗口状态机 refreshStale 回归）。
  'source:first-frame-fills-viewport': (() => {
    const head = report.source?.head;
    const wanted = Math.min(MED_PRETTY_LINES.length, head?.viewportRows ?? 1);
    return typeof head?.rendered === 'number' && head.rendered >= wanted;
  })(),
  'source:rendered-bound': renderedBound(report.source?.head) && renderedBound(report.source?.mid),
  'source:scroll-absolute-lines':
    (report.source?.mid?.start ?? 0) > 0 &&
    report.source?.mid?.lines?.[0]?.line === (report.source?.mid?.start ?? -1) + 1 &&
    (report.source?.end?.start ?? 0) + (report.source?.end?.rendered ?? 0) === MED_PRETTY_LINES.length,

  // pretty 模式（minified）
  'pretty:mode':
    report.pretty?.open?.raw?.mode === 'pretty' &&
    report.pretty?.open?.raw?.totalLines === MID_LINES.length,
  'pretty:window-verbatim': close(report.pretty?.window?.lines, MID_LINES),
  'pretty:tail-verbatim': close(
    report.pretty?.tail?.lines,
    MID_LINES.slice(-3),
  ),
  'pretty:notice': /minified/.test(report.pretty?.end?.notice ?? ''),

  // 大文档：检查点边界 + 虚拟化
  'big:pretty-mode':
    report.big?.open?.raw?.mode === 'pretty' && report.big?.open?.raw?.totalLines === BIG_LINES.length,
  'big:checkpoint-verbatim':
    Array.isArray(report.big?.windows) &&
    report.big.windows.every(({ start, lines }) => close(lines, BIG_LINES.slice(start, start + 3))),
  'big:mid-rendered-bound': renderedBound(report.big?.mid),
  'big:end-line':
    report.big?.end?.lines?.at(-1)?.line === BIG_LINES.length &&
    report.big?.end?.lines?.at(-1)?.text === BIG_LINES[BIG_LINES.length - 1],

  // 截断 → plain + at 跳行
  'repair:plain-mode':
    report.repair?.after?.view === 'raw' &&
    report.repair?.after?.raw?.mode === 'plain' &&
    report.repair?.after?.raw?.damaged === true &&
    report.repair?.atButtons >= 1,
  'repair:jump-line':
    (report.repair?.after?.flash ?? null) !== null &&
    Number(report.repair?.after?.flash) === (report.repair?.locate?.line ?? -2),
  'repair:notice': /被截断/.test(report.repair?.after?.notice ?? ''),

  // 复制原文
  'copy:verbatim':
    /已复制：原始文本/.test(report.copy?.action?.toast ?? '') &&
    (report.copy?.clipboard == null || report.copy.clipboard === PRETTY),
  'copy:too-large':
    report.copy?.refused?.error?.code === 'TOO_LARGE' &&
    typeof report.copy?.refused?.error?.bytes === 'number',

  // 临时修改标注 + 树动作回树
  'edited:notice': /不含临时修改/.test(report.edited?.state?.notice ?? ''),
  'edited:expand-switches-to-tree':
    report.edited?.afterExpand?.state?.view === 'tree' &&
    report.edited?.afterExpand?.state?.mode === 'tree',
  'edited:search-switches-to-tree':
    report.edited?.afterSearch?.state?.view === 'tree' &&
    report.edited?.afterSearch?.state?.mode === 'tree',

  // 持久化
  'persist:ui-viewMode': report.persistBefore?.state?.ui?.viewMode === 'raw',
  'persist:restored':
    report.reloaded?.state?.view === 'raw' &&
    report.reloaded?.state?.mode === 'raw' &&
    report.reloaded?.ui?.viewMode === 'raw' &&
    report.reloaded?.state?.raw?.mode === 'pretty',

  'perf:no-long-task':
    report.longTasksBeforeReload?.hasLongTaskObserver === true &&
    (report.longTasksBeforeReload?.longTasks?.length ?? 1) === 0 &&
    report.reloaded?.longTasksAfterReload?.hasLongTaskObserver === true &&
    (report.reloaded?.longTasksAfterReload?.longTasks?.length ?? 1) === 0,
  'console:no-exception-no-error':
    (report.consoleErrors?.length ?? 0) === 0 && (report.consoleErrorLogs?.length ?? 0) === 0,
};

if (report.errors) console.log(`\nphase errors: ${JSON.stringify(report.errors, null, 2)}`);
for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? '✅' : '❌'} ${name}`);
if (Object.values(checks).some((ok) => !ok)) {
  const debug = {
    source: { mid: report.source?.mid, end: report.source?.end },
    pretty: { end: report.pretty?.end, tail: report.pretty?.tail },
    big: { end: report.big?.end, mid: report.big?.mid },
    repair: { after: report.repair?.after, locate: report.repair?.locate, atButtons: report.repair?.atButtons },
    edited: report.edited,
    reloaded: report.reloaded,
  };
  console.log(`\n--- debug ---\n${JSON.stringify(debug, null, 2)}`);
}
const passed = Object.values(checks).filter(Boolean).length;
const total = Object.keys(checks).length;
console.log(`\nsmoke-raw: ${passed}/${total} ${passed === total ? 'OK' : 'FAILED'}`);
process.exitCode = passed === total ? 0 : 1;
