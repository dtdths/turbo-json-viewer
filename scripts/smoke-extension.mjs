/**
 * scripts/smoke-extension.mjs — 以 **真实 unpacked 扩展** 验证 MV3 装配。
 *
 *   node build.mjs && node scripts/smoke-extension.mjs [sample]
 *
 * 检查：manifest 能加载、page 能打开、module worker 由 chrome.runtime.getURL 创建、
 * 粘贴路径（synthetic ClipboardEvent）导入、首帧、长任务、截图。
 */
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { extensionUrl, launchChrome, REPO_ROOT } from '../prototype/p1/lib/chrome.mjs';
import { startStaticServer } from '../prototype/p1/lib/http.mjs';

const sample = process.argv[2] || '.spike/samples/10mb.json';
const SHOTS = path.join(REPO_ROOT, '.spike', 'smoke');
await mkdir(SHOTS, { recursive: true });

const server = await startStaticServer(REPO_ROOT);
const chrome = await launchChrome({ extensionDirs: ['dist'], windowSize: '1440,900' });
const report = {};

try {
  const page = await chrome.openPage();
  const errorsBefore = page.exceptions.length;
  await page.setViewport(1440, 900);
  await page.goto(extensionUrl('dist', 'page.html'), { timeoutMs: 30000 });
  await page.waitFor('document.readyState === "complete"', { timeoutMs: 15000 });
  await new Promise((r) => setTimeout(r, 500));

  const sampleUrl = `${server.base}/${sample}`;
  report.result = await page.eval(`(async () => {
    const out = {};
    out.hasChromeRuntime = Boolean(globalThis.chrome && chrome.runtime && chrome.runtime.id);
    out.hasDevHook = Boolean(window.__tjv);
    out.workerUrl = out.hasChromeRuntime ? chrome.runtime.getURL('worker.js') : null;

    const longTasks = [];
    try {
      const po = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) longTasks.push(Math.round(e.duration));
      });
      po.observe({ entryTypes: ['longtask'] });
    } catch {}

    // 走真实粘贴入口：synthetic ClipboardEvent（文本不进 DOM）
    const text = await (await fetch('${sampleUrl}')).text();
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    const t0 = performance.now();
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt }));
    let firstRowMs = null;
    const deadline = performance.now() + 30000;
    while (performance.now() < deadline) {
      if (document.querySelectorAll('.row[data-path]:not([hidden])').length > 0) {
        firstRowMs = Math.round(performance.now() - t0);
        break;
      }
      await new Promise((r) => setTimeout(r, 8));
    }
    await new Promise((r) => setTimeout(r, 300));
    out.firstRowMs = firstRowMs;
    out.rows = document.querySelectorAll('.row[data-path]:not([hidden])').length;
    out.status = document.querySelector('#statusRows')?.textContent ?? '';
    out.fileName = document.querySelector('#fileName')?.textContent ?? '';
    // 展开两层拿到可滚动的树，供截图与滚动验证
    const clickCaret = async (p) => {
      const row = document.querySelector('.row[data-path="' + p + '"]');
      row?.querySelector('.row__caret')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
    };
    await clickCaret('$.data');
    await clickCaret('$.data.items');
    await clickCaret('$.data.items[0]');
    out.expandedRows = document.querySelectorAll('.row[data-path]:not([hidden])').length;
    out.expandedStatus = document.querySelector('#statusRows')?.textContent ?? '';
    // 选中一个标量行，验证选中态与右侧「选中节点」
    const scalar = document.querySelector('.row[data-path="$.data.items[0].name"]');
    scalar?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    out.selectedPath = document.querySelector('#selPath')?.textContent ?? '';
    out.statusPath = document.querySelector('#statusPath')?.textContent ?? '';
    out.selectedClass = Boolean(document.querySelector('.row.is-selected[data-path="$.data.items[0].name"]'));
    const scroller = document.querySelector('.tjv-tree');
    if (scroller) scroller.scrollTop = 0;
    await new Promise((r) => setTimeout(r, 400));
    out.scrollTop = scroller?.scrollTop ?? 0;
    out.longTasks = longTasks;
    out.maxLongTask = longTasks.length ? Math.max(...longTasks) : 0;
    return out;
  })()`);
  await page.screenshot(path.join(SHOTS, 'extension-main.png'));
  report.consoleErrors = page.exceptions.slice(errorsBefore);
} finally {
  await chrome.close();
  await server.close();
}

console.log(JSON.stringify(report, null, 2));
const r = report.result || {};
const ok = r.hasChromeRuntime && !r.hasDevHook && r.firstRowMs != null && r.rows > 0 && report.consoleErrors?.length === 0;
console.log(ok ? '\nextension smoke: OK' : '\nextension smoke: FAILED');
process.exitCode = ok ? 0 : 1;
