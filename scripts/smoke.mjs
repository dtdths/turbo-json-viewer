/**
 * scripts/smoke.mjs — 骨架 slice 的真机冒烟（headless Chrome + 真实 module worker）。
 *
 *   node build.mjs && node scripts/smoke.mjs [sample]
 *
 * 测：导入→首帧、行窗口渲染、toggle、滚动换窗、主线程长任务；截图落 .spike/smoke/。
 * 走 HTTP + `window.__tjv`（无 chrome API 的 dev hook），不加载扩展，避免每次改代码都要重装。
 */
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { launchChrome, REPO_ROOT } from '../prototype/p1/lib/chrome.mjs';
import { startStaticServer } from '../prototype/p1/lib/http.mjs';

const sample = process.argv[2] || '.spike/samples/10mb.json';
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

  const result = await page.eval(`(async () => {
    const out = {};
    // long-task observer (main thread)
    const longTasks = [];
    try {
      const po = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) longTasks.push(Math.round(e.duration));
      });
      po.observe({ entryTypes: ['longtask'] });
      out.hasLongTaskObserver = true;
    } catch (e) { out.hasLongTaskObserver = false; }

    if (!window.__tjv) throw new Error('dev hook missing (chrome API present?)');
    const text = await (await fetch('/${sample}')).text();
    out.textBytes = text.length;
    const visible = () => [...document.querySelectorAll('.row[data-path]')].filter((el) => !el.hidden);

    const t0 = performance.now();
    const loadPromise = window.__tjv.loadText(text, '${path.basename(sample)}');
    let firstRowMs = null;
    const deadline = performance.now() + 30000;
    while (performance.now() < deadline) {
      if (visible().length > 0) {
        firstRowMs = Math.round(performance.now() - t0);
        break;
      }
      await new Promise((r) => setTimeout(r, 8));
    }
    await loadPromise.catch((e) => { out.loadError = String(e); });
    await new Promise((r) => setTimeout(r, 200));
    out.firstRowMs = firstRowMs;
    out.collapsedDefault = window.__tjv.state();

    // expand deep enough to get a scrollable document
    await window.__tjv.togglePath('$.data', true).catch((e) => { out.toggleDataError = String(e); });
    await new Promise((r) => setTimeout(r, 250));
    await window.__tjv.togglePath('$.data.items', true).catch((e) => { out.toggleItemsError = String(e); });
    await new Promise((r) => setTimeout(r, 300));
    out.expanded = window.__tjv.state();
    out.visibleRows = visible().length;

    // UI click: collapse the first visible container row, then expand it again
    // 根永远展开（ADR-0002），挑一个非根容器行做 UI 折叠测试
    const containerRow = visible().find((el) => el.dataset.path !== '$' && el.querySelector('.row__caret:not(.is-leaf)'));
    if (containerRow) {
      containerRow.querySelector('.row__caret')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
      out.afterUiCollapse = window.__tjv.state();
      const again = visible().find((el) => el.dataset.path !== '$' && el.querySelector('.row__caret:not(.is-leaf)'));
      again?.querySelector('.row__caret')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
      out.afterUiExpand = window.__tjv.state();
    }

    // scroll: jump to ~40% of the document
    const beforeScroll = window.__tjv.state();
    const total = beforeScroll.totalRows || 1;
    window.__tjv.scrollToPx(Math.floor(total * 0.4) * 24);
    await new Promise((r) => setTimeout(r, 400));
    out.afterScroll = window.__tjv.state();
    out.scrollMoved = out.afterScroll.start > beforeScroll.start;
    out.longTasks = longTasks;
    out.maxLongTask = longTasks.length ? Math.max(...longTasks) : 0;
    return out;
  })()`);

  Object.assign(report, result);
  await page.screenshot(path.join(SHOTS, 'after-scroll.png'));
  report.consoleErrors = page.exceptions.slice(errorsBefore);
} finally {
  await chrome.close();
  await server.close();
}

console.log(JSON.stringify(report, null, 2));
const ok =
  report.firstRowMs != null &&
  report.visibleRows > 0 &&
  report.scrollMoved === true &&
  report.afterUiCollapse?.rowVersion > report.expanded?.rowVersion &&
  report.afterUiExpand?.rowVersion > report.afterUiCollapse?.rowVersion &&
  report.afterUiExpand?.totalRows === report.expanded?.totalRows &&
  report.consoleErrors?.length === 0;
console.log(ok ? '\nsmoke: OK' : '\nsmoke: FAILED');
process.exitCode = ok ? 0 : 1;
