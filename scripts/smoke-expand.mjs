/**
 * scripts/smoke-expand.mjs — 「全部展开 / 全部收起 / 小文档自适应展开」真机冒烟（#9 / ADR-0002 修订）。
 *
 *   node build.mjs && node scripts/smoke-expand.mjs
 *
 * 测：
 *   1) 自适应展开：8 节点小文档加载即全展开（totalRows=8）；收起回默认（4）；再展开回 8。
 *   2) 10MB（595,030 节点，预算内）：默认折叠 → 点「全部展开」→ totalRows>500k、滚回顶部、
 *      渲染行 ≤ overscan+1 屏、选中路径保留（Q7）；点「全部收起」→ 回默认、选中仍保留。
 *   3) 50MB（≈2.96M 节点，超 ROW_BUDGET）：点「全部展开」→ 预算护栏拒绝（totalRows/rowVersion 不变 +
 *      toast 显示 TOO_MANY_ROWS），不产生部分展开。
 *   4) 主线程长任务 / console 错误。
 *
 * 截图落 .spike/smoke/expand-*.png。走 HTTP + `window.__tjv`，与 scripts/smoke.mjs 同一 harness。
 */
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { launchChrome, REPO_ROOT } from '../prototype/p1/lib/chrome.mjs';
import { startStaticServer } from '../prototype/p1/lib/http.mjs';

const SHOTS = path.join(REPO_ROOT, '.spike', 'smoke');
await mkdir(SHOTS, { recursive: true });

const server = await startStaticServer(REPO_ROOT);
const chrome = await launchChrome({ windowSize: '1440,900' });
const report = {};

try {
  const page = await chrome.openPage();
  const errorsBefore = page.exceptions.length;
  await page.setViewport(1440, 900);
  await page.goto(`${server.base}/dist/page.html`, { timeoutMs: 20000 });
  await page.waitFor('document.readyState === "complete"', { timeoutMs: 10000 });
  await new Promise((r) => setTimeout(r, 400));

  // ---- phase 1：装长任务观察器 + 小文档自适应展开 ----
  const phase1 = await page.eval(`(async () => {
    const out = {};
    const longTasks = [];
    try {
      const po = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) longTasks.push(Math.round(e.duration));
      });
      po.observe({ entryTypes: ['longtask'] });
      out.hasLongTaskObserver = true;
    } catch (e) { out.hasLongTaskObserver = false; }

    if (!window.__tjv) throw new Error('dev hook missing (chrome API present?)');
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const visible = () => [...document.querySelectorAll('.row[data-path]')].filter((el) => !el.hidden);
    const btn = (id) => document.getElementById(id);
    const clickBtn = (id) => {
      const el = btn(id);
      if (!el) throw new Error('button missing: ' + id);
      if (el.disabled) throw new Error('button disabled: ' + id);
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    };
    const waitFirstRow = async (timeout = 30000) => {
      const t0 = performance.now();
      while (performance.now() - t0 < timeout) {
        if (visible().length > 0) return Math.round(performance.now() - t0);
        await sleep(8);
      }
      return null;
    };
    const waitState = async (pred, timeout = 20000) => {
      const t0 = performance.now();
      while (performance.now() - t0 < timeout) {
        const s = window.__tjv.state();
        if (pred(s)) return s;
        await sleep(20);
      }
      return window.__tjv.state();
    };
    window.__smoke = { sleep, visible, btn, clickBtn, waitFirstRow, waitState, longTasks };

    // 1) 自适应展开：{a:1,b:[1,2,3],c:{d:true}} 全展开 8 行（root+a+b+b0+b1+b2+c+d）
    const small = { a: 1, b: [1, 2, 3], c: { d: true } };
    const t0 = performance.now();
    await window.__tjv.loadText(JSON.stringify(small), 'small.json');
    out.smallLoadMs = Math.round(performance.now() - t0);
    await waitFirstRow(5000);
    await sleep(150);
    out.smallAdaptive = window.__tjv.state(); // 期望 totalRows = 8
    out.smallVisibleRows = visible().length;
    out.buttonsEnabled = btn('expandAllBtn')?.disabled === false && btn('collapseAllBtn')?.disabled === false;
    out.buttonsPresent = Boolean(btn('expandAllBtn') && btn('collapseAllBtn'));

    // 收起 → 默认折叠（1 + 顶层字段数 3 = 4）
    clickBtn('collapseAllBtn');
    out.smallCollapsed = await waitState((s) => s.totalRows === 4, 5000);
    // 再展开 → 8
    clickBtn('expandAllBtn');
    out.smallExpandedAgain = await waitState((s) => s.totalRows === 8, 5000);
    return out;
  })()`);
  Object.assign(report, phase1);
  await page.screenshot(path.join(SHOTS, 'expand-adaptive.png'));

  // ---- phase 2：10MB 默认折叠 → 全展开（选中路径保留 + 滚回顶部） ----
  const phase2 = await page.eval(`(async () => {
    const out = {};
    const { sleep, visible, clickBtn, waitState } = window.__smoke;
    const text = await (await fetch('/.spike/samples/10mb.json')).text();
    out.textBytes = text.length;
    const tLoad = performance.now();
    await window.__tjv.loadText(text, '10mb.json');
    out.loadMs = Math.round(performance.now() - tLoad);
    await sleep(300);
    out.collapsed = window.__tjv.state();
    window.__collapsedRows = out.collapsed.totalRows;

    // 选中一个非根可见行，验证 Q7「只保留选中路径」
    const row = visible().find((el) => el.dataset.path !== '$');
    row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await sleep(100);
    out.selectedBefore = window.__tjv.state().selected;

    const samples = [];
    const tSample = performance.now();
    let running = true;
    const tick = () => {
      const s = window.__tjv.state();
      const b = document.getElementById('expandAllBtn');
      const c = document.getElementById('collapseAllBtn');
      samples.push({ t: Math.round(performance.now() - tSample), rows: visible().length, start: s.start, rv: s.rowVersion, total: s.totalRows, btnDisabled: Boolean(b?.disabled || c?.disabled) });
      if (running && performance.now() - tSample < 4000) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    const t0 = performance.now();
    clickBtn('expandAllBtn');
    out.expanded = await waitState((s) => s.totalRows > 500000, 30000);
    out.expandAllMs = Math.round(performance.now() - t0);
    await sleep(250);
    running = false;
    out.expandSamples = samples;
    out.renderedAfterExpand = visible().length;
    out.scrollTopAfterExpand = window.__tjv.state().scrollTop;
    out.selectedAfterExpand = window.__tjv.state().selected;
    return out;
  })()`);
  Object.assign(report, phase2);
  await page.screenshot(path.join(SHOTS, 'expand-all.png'));

  // ---- phase 3：滚到 40% 后全收起 → 回默认（选中保留 + 逐帧无空白/无塌陷闪帧） ----
  const phase3 = await page.eval(`(async () => {
    const { clickBtn, waitState, sleep } = window.__smoke;
    const defaultRows = window.__collapsedRows;
    const scroller = document.getElementById('tree');
    const visibleCount = () => [...document.querySelectorAll('.row[data-path]')].filter((el) => !el.hidden).length;

    // 模拟真实用法：文档展开到 59 万行后先滚到 40%，再点「全部收起」
    window.__tjv.scrollToPx(Math.floor(window.__tjv.state().totalRows * 0.4) * 24);
    await sleep(400);
    const before = window.__tjv.state();

    const samples = [];
    const t0 = performance.now();
    let running = true;
    const tick = () => {
      const s = window.__tjv.state();
      const expandBtn = document.getElementById('expandAllBtn');
      const collapseBtn = document.getElementById('collapseAllBtn');
      samples.push({
        t: Math.round(performance.now() - t0),
        rows: visibleCount(),
        start: s.start,
        rv: s.rowVersion,
        total: s.totalRows,
        scrollTop: Math.round(scroller.scrollTop),
        // 回归（2026-11-02）：命令在途时不得禁用按钮（disabled 有 opacity .45 → 两按钮一起「闪」）
        btnDisabled: Boolean(expandBtn?.disabled || collapseBtn?.disabled),
      });
      if (running && performance.now() - t0 < 3000) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    clickBtn('collapseAllBtn');
    const after = await waitState((s) => s.totalRows === defaultRows, 15000);
    await sleep(250);
    running = false;
    return {
      defaultRows,
      before,
      after,
      samples,
      scrollTopAfterCollapse: window.__tjv.state().scrollTop,
      selectedAfterCollapse: window.__tjv.state().selected,
    };
  })()`);
  report.collapsedDefaultRows = report.collapsed?.totalRows ?? null;
  report.collapsePhase = phase3;
  await page.screenshot(path.join(SHOTS, 'expand-collapse.png'));

  // ---- phase 4：50MB 超预算 → TOO_MANY_ROWS，不部分展开 ----
  const phase4 = await page.eval(`(async () => {
    const out = {};
    const { sleep, clickBtn } = window.__smoke;
    const text = await (await fetch('/.spike/samples/50mb.json')).text();
    out.textBytes = text.length;
    const t0 = performance.now();
    await window.__tjv.loadText(text, '50mb.json');
    out.loadMs = Math.round(performance.now() - t0);
    await sleep(400);
    out.collapsed = window.__tjv.state();
    clickBtn('expandAllBtn');
    await sleep(2000); // 预算 dry-run 在 Worker 内；留足往返
    out.afterReject = window.__tjv.state();
    const toast = document.getElementById('toast');
    out.toastHidden = toast?.hidden ?? null;
    out.toastText = toast?.textContent ?? '';
    return out;
  })()`);
  report.budget = phase4;
  await page.screenshot(path.join(SHOTS, 'expand-budget.png'));

  // ---- 汇总：长任务 / console 错误 ----
  report.longTasks = await page.eval('window.__smoke?.longTasks ?? []');
  report.maxLongTask = report.longTasks.length ? Math.max(...report.longTasks) : 0;
  report.consoleErrors = page.exceptions.slice(errorsBefore);
} finally {
  await chrome.close();
  await server.close();
}

console.log(JSON.stringify(report, null, 2));

const smallAdaptiveOk = report.smallAdaptive?.totalRows === 8 && report.smallVisibleRows === 8;
const smallToggleOk =
  report.smallCollapsed?.totalRows === 4 && report.smallExpandedAgain?.totalRows === 8;
const expandOk =
  report.collapsed?.totalRows > 0 &&
  report.collapsed?.totalRows < 500 &&
  report.expanded?.totalRows > 500000 &&
  report.renderedAfterExpand > 0 &&
  report.renderedAfterExpand <= 60 &&
  report.scrollTopAfterExpand === 0;
const selectionKept =
  report.selectedBefore != null &&
  report.selectedAfterExpand === report.selectedBefore &&
  report.collapsePhase?.selectedAfterCollapse === report.selectedBefore;
const collapseOk = report.collapsePhase?.after?.totalRows === report.collapsedDefaultRows;

// 闪帧回归（2026-11-02）：滚动后收起必须「回顶 + 换版本」原子完成——
// 新 rowVersion 的每一帧都必须 start=0，且任何一帧都不能塌成 0 行（旧实现会出现 1 行/start=2 的闪帧）。
// 展开路径同理：新 rowVersion 帧 start=0、无 0 行帧、且按钮全程不得禁用。
const expandSamples = report.expandSamples ?? [];
const expandNewRv = report.expanded?.rowVersion;
const expandNewRvFrames = expandSamples.filter((s) => s.rv === expandNewRv);
const expandNoFlashFrame =
  expandNewRvFrames.length > 0 &&
  expandNewRvFrames.every((s) => s.start === 0 && s.rows > 0) &&
  expandSamples.every((s) => s.rows > 0) &&
  expandSamples.every((s) => s.btnDisabled === false);

const collapseSamples = report.collapsePhase?.samples ?? [];
const collapseScrolledFirst = report.collapsePhase?.before?.scrollTop > 0;
const collapseNewRv = report.collapsePhase?.after?.rowVersion;
const collapseNewRvFrames = collapseSamples.filter((s) => s.rv === collapseNewRv);
const collapseNoFlashFrame =
  collapseScrolledFirst &&
  collapseNewRvFrames.length > 0 &&
  collapseNewRvFrames.every((s) => s.start === 0 && s.rows > 0) &&
  collapseSamples.every((s) => s.rows > 0) &&
  collapseSamples.every((s) => s.btnDisabled === false);

const budgetRejectOk =
  report.budget?.collapsed?.totalRows > 0 &&
  report.budget?.afterReject?.totalRows === report.budget?.collapsed?.totalRows &&
  report.budget?.afterReject?.rowVersion === report.budget?.collapsed?.rowVersion &&
  report.budget?.toastHidden === false &&
  /TOO_MANY_ROWS/.test(report.budget?.toastText ?? '');
const perfOk = report.maxLongTask < 100 && report.consoleErrors?.length === 0;

const checks = {
  'adaptive:small-doc-fully-expanded': smallAdaptiveOk,
  'adaptive:buttons-enabled': report.buttonsPresent === true && report.buttonsEnabled === true,
  'adaptive:collapse-expand-roundtrip': smallToggleOk,
  '10mb:collapsed-default': report.collapsed?.totalRows > 0 && report.collapsed?.totalRows < 500,
  '10mb:expand-all': expandOk,
  '10mb:selection-kept': selectionKept,
  '10mb:collapse-all': collapseOk,
  '10mb:expand-no-flash-frame': expandNoFlashFrame,
  '10mb:collapse-no-flash-frame': collapseNoFlashFrame,
  '50mb:budget-reject': budgetRejectOk,
  'perf:no-long-task-no-console-error': perfOk,
};
for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? '✅' : '❌'} ${name}`);
const ok = Object.values(checks).every(Boolean);
console.log(ok ? '\nsmoke-expand: OK' : '\nsmoke-expand: FAILED');
process.exitCode = ok ? 0 : 1;
