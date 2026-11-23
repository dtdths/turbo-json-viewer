/**
 * scripts/smoke-extension.mjs — 以 **真实 unpacked 扩展** 验证 MV3 装配。
 *
 *   node build.mjs && node scripts/smoke-extension.mjs [sample]
 *
 * 检查：manifest 能加载、page 能打开、module worker 由 chrome.runtime.getURL 创建、
 * 粘贴路径（synthetic ClipboardEvent）导入、首帧、长任务、截图。
 */
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, readdirSync } from 'node:fs';
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
    out.fileName = document.querySelector('#tabStrip [aria-selected=true] .tabstrip__title')?.textContent ?? '';
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

  // ---- phase 2：右键菜单投递的页面侧消费（#57 / ADR-0031）----
  // 菜单点击本身无法程序化触发（原生菜单没有 API），这里直接验证约定的数据通路：
  // storage.session 里的一次性 token → page.html#incoming=<token> → 导入成功、token 删掉、hash 抹掉。
  const intake = await chrome.openPage();
  await intake.setViewport(1440, 900);
  await intake.goto(extensionUrl('dist', 'page.html'), { timeoutMs: 30000 });
  await intake.waitFor('document.readyState === "complete"', { timeoutMs: 15000 });
  await new Promise((r) => setTimeout(r, 300));

  const KEY_OK = 'tjv.incoming.smoke-incoming-0001';
  const KEY_ERR = 'tjv.incoming.smoke-incoming-0002';
  report.incoming = { menuTitle: null, imported: false, tokenRemoved: false, hashCleared: false, name: null, rows: 0 };
  report.incomingError = { toastShown: false, text: '' };

  try {
    report.incoming.menuTitle = await intake.eval(
      `(async () => {
        const m = chrome.runtime.getManifest();
        return {
          permission: (m.permissions || []).includes('contextMenus'),
          view: chrome.i18n.getMessage('menuView') || null,
          download: chrome.i18n.getMessage('menuDownload') || null,
          icons: Object.keys(m.icons || {}).sort().join(',') === '128,16,32,48',
          iconsLoad: (await Promise.all(Object.values(m.icons || {}).map((p) => fetch(chrome.runtime.getURL(p)).then((r) => r.ok)))).every(Boolean),
          defaultIcon: Boolean(m.action?.default_icon?.['16'] && m.action?.default_icon?.['32']),
          script: Boolean(m.content_scripts) === false && (m.host_permissions || []).length === 0,
        };
      })()`,
    );
    await intake.eval(
      `chrome.storage.session.set({ '${KEY_OK}': { kind: 'text', text: '{"a":1,"b":[1,2,3]}', createdAt: Date.now() } }).then(() => true)`,
    );
    await intake.goto(`${extensionUrl('dist', 'page.html')}?smoke=1#incoming=smoke-incoming-0001`, {
      timeoutMs: 30000,
    });
    await intake.waitFor("document.querySelector('#tabStrip [aria-selected=true] .tabstrip__title')?.textContent === 'selection.json'", {
      timeoutMs: 15000,
    });
    await new Promise((r) => setTimeout(r, 300));
    Object.assign(report.incoming, {
      imported: true,
      name: await intake.eval("document.querySelector('#tabStrip [aria-selected=true] .tabstrip__title')?.textContent ?? null"),
      rows: await intake.eval("document.querySelectorAll('.row[data-path]:not([hidden])').length"),
      hashCleared: await intake.eval('location.hash === ""'),
      tokenRemoved: await intake.eval(`chrome.storage.session.get('${KEY_OK}').then((b) => !('${KEY_OK}' in b))`),
    });

    // 错误 token（不像 JSON）：开页 toast 解释，而不是静默失败
    await intake.eval(
      `chrome.storage.session.set({ '${KEY_ERR}': { kind: 'error', error: 'not-json', createdAt: Date.now() } }).then(() => true)`,
    );
    await intake.goto(`${extensionUrl('dist', 'page.html')}?smoke=2#incoming=smoke-incoming-0002`, {
      timeoutMs: 30000,
    });
    await intake.waitFor("!document.getElementById('toast').hidden", { timeoutMs: 15000 });
    report.incomingError = {
      toastShown: true,
      text: await intake.eval("document.getElementById('toast').textContent ?? ''"),
    };

    // 下载模式（#63）：导入成功后自动落盘，标签页**不关**（语义 = 先导入再导出）
    const KEY_DL = 'tjv.incoming.smoke-incoming-0003';
    const dlDir = mkdtempSync(path.join(os.tmpdir(), 'tjv-smoke-dl-'));
    await chrome.browser.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: dlDir,
      eventsEnabled: true,
    });
    const began = [];
    const offDownload = chrome.browser.on('Browser.downloadWillBegin', (params) => began.push(params));
    await intake.eval(
      `chrome.storage.session.set({ '${KEY_DL}': { kind: 'text', text: '{"a":1,"b":[1,2,3]}', mode: 'download', createdAt: Date.now() } }).then(() => true)`,
    );
    await intake.goto(`${extensionUrl('dist', 'page.html')}?smoke=3#incoming=smoke-incoming-0003`, {
      timeoutMs: 30000,
    });
    await intake.waitFor("document.querySelector('#tabStrip [aria-selected=true] .tabstrip__title')?.textContent === 'selection.json'", {
      timeoutMs: 15000,
    });
    // 等下载真正落盘（.crdownload 会重命名成 .json）
    for (let i = 0; i < 80 && !readdirSync(dlDir).some((f) => f.endsWith('.json')); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    offDownload?.();
    report.incomingDownload = {
      began: began.length > 0,
      suggested: began[0]?.suggestedFilename ?? null,
      files: readdirSync(dlDir),
      tabOpen: await intake.eval("document.visibilityState !== 'unloaded' && Boolean(document.querySelector('#tabStrip [aria-selected=true] .tabstrip__title')?.textContent)"),
      hashCleared: await intake.eval('location.hash === ""'),
      tokenRemoved: await intake.eval(`chrome.storage.session.get('${KEY_DL}').then((b) => !('${KEY_DL}' in b))`),
      rows: await intake.eval("document.querySelectorAll('.row[data-path]:not([hidden])').length"),
    };
  } catch (error) {
    report.incomingPhaseError = String(error);
  }
} finally {
  await chrome.close();
  await server.close();
}

console.log(JSON.stringify(report, null, 2));
const r = report.result || {};
const inc = report.incoming || {};
const incErr = report.incomingError || {};
const ok =
  r.hasChromeRuntime &&
  !r.hasDevHook &&
  r.firstRowMs != null &&
  r.rows > 0 &&
  inc.menuTitle?.permission === true &&
  inc.menuTitle?.script === true &&
  inc.menuTitle?.icons === true &&
  inc.menuTitle?.iconsLoad === true &&
  inc.menuTitle?.defaultIcon === true &&
  Boolean(inc.menuTitle?.view) &&
  Boolean(inc.menuTitle?.download) &&
  report.incomingDownload?.began === true &&
  report.incomingDownload?.tabOpen === true &&
  report.incomingDownload?.hashCleared === true &&
  report.incomingDownload?.tokenRemoved === true &&
  (report.incomingDownload?.files ?? []).some((f) => f.endsWith('.json')) &&
  inc.imported === true &&
  inc.tokenRemoved === true &&
  inc.hashCleared === true &&
  incErr.toastShown === true &&
  report.consoleErrors?.length === 0;
console.log(ok ? '\nextension smoke: OK' : '\nextension smoke: FAILED');
process.exitCode = ok ? 0 : 1;
