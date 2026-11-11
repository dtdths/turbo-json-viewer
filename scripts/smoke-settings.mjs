/**
 * scripts/smoke-settings.mjs — 设置面板 + 视图状态持久化（ADR-0011）真机冒烟。
 *
 *   node build.mjs && node scripts/smoke-settings.mjs
 *
 * 测：
 *   1) 默认值：8 项设置全默认、主题生效、行高 24 / 缩进 16 / 无类型列；
 *   2) 面板：活动栏齿轮 → 左面板切「设置」，标题/aria/8 行顺序/焦点；
 *   3) 逐项即时生效（真实点击面板控件）：主题、行高（spacer 高度同步）、缩进、类型列、
 *      默认复制格式（行尾浮条复制路径）、复制缩进（子树 JSON 4 空格）、
 *      关闭修复（截断直接 PARSE 且文档不变）、关闭自适应展开（小文档保持折叠）；
 *   4) 持久化：刷新页面后 8 项设置 + 主题 + 行高/缩进 CSS + 左面板模式全部恢复；
 *   5) 0 page 异常 / 0 console error。
 * 截图落 .spike/smoke/settings-{panel,applied,reloaded}.png；走 HTTP + `window.__tjv`（localStorage 兜底持久化）。
 */
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { launchChrome, REPO_ROOT } from '../prototype/p1/lib/chrome.mjs';
import { startStaticServer } from '../prototype/p1/lib/http.mjs';

const SHOTS = path.join(REPO_ROOT, '.spike', 'smoke');
await mkdir(SHOTS, { recursive: true });

const FIXTURE = JSON.stringify({ a: { 'b.c': 'x' }, arr: [10, { k: null }], flag: true });
/** 8 个节点：root + a + b.c + arr + [0] + [1] + [1].k + flag（自适应展开 → 8 行） */
const FIXTURE_ROWS = 8;
const DEFAULT_KEYS = [
  'theme',
  'rowHeight',
  'indent',
  'typeColumn',
  'defaultCopyFormat',
  'copyIndent',
  'searchCopyFormat',
  'exportMode',
  'repairTruncated',
  'adaptiveExpand',
  'advBudget',
];

const DEFAULTS = {
  theme: 'dark',
  rowHeight: 24,
  indent: 16,
  typeColumn: false,
  defaultCopyFormat: 'subtree',
  copyIndent: 2,
  searchCopyFormat: 'path',
  exportMode: 'file',
  repairTruncated: true,
  adaptiveExpand: true,
  advBudget: 'standard',
};

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

  const runPhase = async (name, expression) => {
    try {
      Object.assign(report, (await page.eval(expression)) ?? {});
    } catch (error) {
      if (!report.errors) report.errors = {};
      report.errors[name] = String(error?.message ?? error);
      console.warn(`⚠️ phase ${name} failed: ${String(error?.message ?? error)}`);
    }
  };

  // ---- phase 0：空态（尚无文档）点齿轮 → 面板必须在遮罩之上可见（bug 回归）----
  await runPhase(
    'empty-open',
    `(async () => {
      const out = {};
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      document.querySelector('[data-panel-btn="settings"]').click();
      await sleep(220);
      const side = document.getElementById('leftPanel').getBoundingClientRect();
      const probe = document.elementFromPoint(side.x + 120, side.y + 200);
      out.emptyState = {
        panel: document.body.dataset.panel ?? null,
        emptyVisible: !document.getElementById('empty')?.classList.contains('is-hidden'),
        // 面板中心点命中的元素必须属于设置面板（而不是被空态遮罩 .empty 盖住）
        panelTopmost: probe ? Boolean(probe.closest('#settingsPanel')) : false,
        rows: [...document.querySelectorAll('#settingsPanel [data-setting]')].map((n) => n.dataset.setting ?? ''),
        sideWidth: Math.round(side.width),
      };
      return out;
    })()`,
  );
  await page.screenshot(path.join(SHOTS, 'settings-empty.png'));
  await runPhase(
    'empty-close',
    `(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      document.querySelector('[data-panel-close]').click();
      await sleep(150);
      return { emptyStateClosed: document.body.dataset.panel ?? null };
    })()`,
  );

  // ---- phase 1：默认值 + 打开设置面板 ----
  await runPhase(
    'boot',
    `(async () => {
      const out = {};
      const h = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      await h.loadText(${JSON.stringify(FIXTURE)}, 'settings.json');
      await sleep(400);
      out.boot = {
        settings: h.settingsState(),
        theme: document.documentElement.dataset.theme,
        geometry: h.treeGeometry(),
        totalRows: h.state().totalRows,
      };
      // 真实点击活动栏齿轮
      document.querySelector('[data-panel-btn="settings"]').click();
      await sleep(150);
      const host = document.getElementById('settingsPanel');
      out.open = {
        panel: document.body.dataset.panel ?? null,
        title: document.getElementById('panelTitle')?.textContent ?? '',
        ariaLabel: host?.getAttribute('aria-label') ?? null,
        rows: [...document.querySelectorAll('#settingsPanel [data-setting]')].map((n) => n.dataset.setting ?? ''),
        focused: host ? host.contains(document.activeElement) || document.activeElement === host : false,
        activeBtn: document.querySelector('[data-panel-btn="settings"]')?.getAttribute('aria-current'),
      };
      return out;
    })()`,
  );
  await page.screenshot(path.join(SHOTS, 'settings-panel.png'));

  // ---- phase 2：逐项改设置（真实点击控件）----
  await runPhase(
    'change',
    `(async () => {
      const out = {};
      const h = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const clickSeg = (key, value) => {
        const btn = document.querySelector('#settingsPanel [data-setting="' + key + '"] [data-value="' + value + '"]');
        if (!btn) throw new Error('missing seg ' + key + '/' + value);
        btn.click();
      };
      const clickCheck = (key) => {
        const box = document.getElementById('setting-' + key);
        if (!box) throw new Error('missing checkbox ' + key);
        box.click();
      };
      const rowCopy = async (pathValue) => {
        const btn = document.querySelector('.row[data-path="' + pathValue + '"] .row__action[data-action="copy"]');
        if (!btn) throw new Error('missing row action ' + pathValue);
        const before = h.toastText();
        btn.click();
        for (let i = 0; i < 25; i++) {
          await sleep(20);
          if (h.toastText() !== before) break;
        }
        let clipboard = null;
        try { clipboard = await h.clipboardText(); } catch {}
        return { toast: h.toastText(), clipboard };
      };

      clickSeg('theme', 'light');
      await sleep(100);
      out.theme = {
        theme: h.settingsState().theme,
        dataset: document.documentElement.dataset.theme,
        status: document.getElementById('statusTheme')?.textContent ?? '',
      };

      clickSeg('rowHeight', '22');
      await sleep(150);
      out.rowHeight = { value: h.settingsState().rowHeight, geometry: h.treeGeometry() };

      clickSeg('indent', '20');
      await sleep(80);
      out.indent = { value: h.settingsState().indent, geometry: h.treeGeometry() };

      clickCheck('typeColumn');
      await sleep(150);
      out.typeColumn = { value: h.settingsState().typeColumn, geometry: h.treeGeometry() };

      // 默认复制格式 = 路径 → 行尾浮条复制应得规范路径
      clickSeg('defaultCopyFormat', 'path');
      await sleep(80);
      out.copyPath = { value: h.settingsState().defaultCopyFormat, ...(await rowCopy('$.arr[1].k')) };

      // 默认复制格式 = 子树 JSON + 缩进 4 → 剪贴板应为 4 空格 JSON
      clickSeg('defaultCopyFormat', 'subtree');
      clickSeg('copyIndent', '4');
      await sleep(80);
      const subtree = await rowCopy('$.a');
      out.copyIndent = { value: h.settingsState().copyIndent, ...subtree };

      // 搜索结果双击复制格式（第 10 项，ADR-0011 修订）：默认路径 → 切子树 JSON → 切回路径
      out.searchCopyFormat = { initial: h.settingsState().searchCopyFormat };
      clickSeg('searchCopyFormat', 'subtree');
      await sleep(80);
      out.searchCopyFormat.afterClick = h.settingsState().searchCopyFormat;
      clickSeg('searchCopyFormat', 'path');
      await sleep(80);
      out.searchCopyFormat.back = h.settingsState().searchCopyFormat;

      // 导出方式（设置面板第 9 项，ADR-0012 修订）：设为复制 → 分体按钮主操作同步
      clickSeg('exportMode', 'clipboard');
      await sleep(120);
      out.exportMode = {
        value: h.settingsState().exportMode,
        splitLabel: h.exportState().mainLabel,
        panelChecked: document
          .querySelector('#settingsPanel [data-setting="exportMode"] [data-value="clipboard"]')
          ?.getAttribute('aria-pressed'),
      };

      // 高级预算档位（设置面板第 11 项，ADR-0018 §7）：默认标准 → 切宽松 → 切回标准
      out.advBudget = { initial: h.settingsState().advBudget };
      clickSeg('advBudget', 'loose');
      await sleep(80);
      out.advBudget.afterClick = h.settingsState().advBudget;
      clickSeg('advBudget', 'standard');
      await sleep(80);
      out.advBudget.back = h.settingsState().advBudget;

      // 关闭自动修复 → 截断文本直接报错，且当前文档不变
      clickCheck('repairTruncated');
      await sleep(80);
      const rowsBefore = h.state().totalRows;
      await h.loadText('{"a":1,"b":"hello wor', 'cut.json').catch(() => {});
      await sleep(350);
      out.repairOff = {
        value: h.settingsState().repairTruncated,
        toast: h.toastText(),
        repair: h.repairState(),
        rowsBefore,
        rowsAfter: h.state().totalRows,
      };

      // 关闭自适应展开 → 小文档保持默认折叠（root + 顶层字段 = 2 行）
      clickCheck('adaptiveExpand');
      await sleep(80);
      await h.loadText(JSON.stringify({ a: [1, 2, 3] }), 'small.json');
      await sleep(400);
      out.adaptiveOff = {
        value: h.settingsState().adaptiveExpand,
        totalRows: h.state().totalRows,
        geometry: h.treeGeometry(),
        settings: h.settingsState(),
      };

      // 收尾：重新打开设置面板（导入会把面板切回文档视图；这里让持久化的 panel=settings）
      document.querySelector('[data-panel-btn="settings"]').click();
      await sleep(120);
      out.endPanel = document.body.dataset.panel ?? null;
      return out;
    })()`,
  );
  await page.screenshot(path.join(SHOTS, 'settings-applied.png'));

  // ---- phase 3：刷新页面 → 设置与布局恢复 ----
  await page.goto(url, { timeoutMs: 20000 });
  await page.waitFor('document.readyState === "complete"', { timeoutMs: 20000 });
  await new Promise((r) => setTimeout(r, 800));
  await runPhase(
    'reload',
    `(async () => {
      const out = {};
      const h = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      await sleep(200);
      out.reloaded = {
        settings: h.settingsState(),
        theme: document.documentElement.dataset.theme,
        geometry: h.treeGeometry(),
        panel: document.body.dataset.panel ?? null,
        activeBtn: document.querySelector('[data-panel-btn="settings"]')?.getAttribute('aria-current'),
        rows: [...document.querySelectorAll('#settingsPanel [data-setting]')].map((n) => n.dataset.setting ?? ''),
      };
      return out;
    })()`,
  );
  await page.screenshot(path.join(SHOTS, 'settings-reloaded.png'));

  // ---- phase 4：响应式断点（ADR-0017 / direction.md §3）----
  // 此时左面板是 settings（持久化恢复），可量三块宽度：1200（≤1320 档）应收 300/284；1440 应回 320/300。
  const measureLayout = `(() => {
    const w = (id) => Math.round(document.getElementById(id).getBoundingClientRect().width);
    return { vw: window.innerWidth, side: w('leftPanel'), rail: w('rail'), tree: w('tree') };
  })()`;
  await page.setViewport(1200, 900);
  await new Promise((r) => setTimeout(r, 300));
  report.breakpointNarrow = await page.eval(measureLayout);
  await page.screenshot(path.join(SHOTS, 'settings-breakpoint-1200.png'));
  await page.setViewport(1440, 900);
  await new Promise((r) => setTimeout(r, 300));
  report.breakpointWide = await page.eval(measureLayout);

  report.consoleErrors = page.exceptions.slice(errorsBefore);
  report.consoleErrorLogs = page.logs
    .filter((entry) => entry.type === 'error')
    .map((entry) => entry.text);
} finally {
  await chrome.close();
  await server.close();
}

console.log(JSON.stringify(report, null, 2));

const settingsOf = (bag) => bag ?? {};
const SUBTREE_A_4 = JSON.stringify({ 'b.c': 'x' }, null, 4);

const checks = {
  // 空态下点齿轮：面板在遮罩之上（bug #2 回归），关闭后回到文档视图
  'empty-state:panel-over-overlay':
    report.emptyState?.panel === 'settings' &&
    report.emptyState?.emptyVisible === true &&
    report.emptyState?.panelTopmost === true &&
    report.emptyState?.sideWidth === 320 &&
    JSON.stringify(report.emptyState?.rows) === JSON.stringify(DEFAULT_KEYS),
  'empty-state:close':
    report.emptyStateClosed === 'doc',

  // 默认值
  'boot:defaults':
    JSON.stringify(
      Object.fromEntries(DEFAULT_KEYS.map((key) => [key, settingsOf(report.boot?.settings)[key]])),
    ) === JSON.stringify(DEFAULTS) &&
    report.boot?.settings?.loadedFromStore === false,
  'boot:theme-and-geometry':
    report.boot?.theme === 'dark' &&
    report.boot?.geometry?.rowHeight === 24 &&
    report.boot?.geometry?.rowHeightCss === '24px' &&
    report.boot?.geometry?.indentCss === '16px' &&
    report.boot?.totalRows === FIXTURE_ROWS &&
    report.boot?.geometry?.spacerHeight === `${FIXTURE_ROWS * 24}px`,

  // 面板打开
  'panel:open':
    report.open?.panel === 'settings' &&
    report.open?.title === '设置' &&
    report.open?.ariaLabel === '设置' &&
    report.open?.activeBtn === 'page',
  'panel:rows-order': JSON.stringify(report.open?.rows) === JSON.stringify(DEFAULT_KEYS),
  'panel:focus-inside': report.open?.focused === true,

  // 逐项生效
  'set:theme':
    report.theme?.theme === 'light' &&
    report.theme?.dataset === 'light' &&
    report.theme?.status === '亮色',
  'set:rowHeight':
    report.rowHeight?.value === 22 &&
    report.rowHeight?.geometry?.rowHeight === 22 &&
    report.rowHeight?.geometry?.rowHeightCss === '22px' &&
    report.rowHeight?.geometry?.rowHeightComputed === '22px' &&
    report.rowHeight?.geometry?.spacerHeight === `${FIXTURE_ROWS * 22}px`,
  'set:indent': report.indent?.value === 20 && report.indent?.geometry?.indentCss === '20px',
  'set:typeColumn': report.typeColumn?.value === true && report.typeColumn?.geometry?.typeColumnVisible === true,
  'set:copy-format-path':
    report.copyPath?.value === 'path' &&
    /已复制/.test(report.copyPath?.toast ?? '') &&
    (report.copyPath?.toast ?? '').includes('路径') &&
    (report.copyPath?.clipboard == null || report.copyPath?.clipboard === '$.arr[1].k'),
  'set:copy-indent-4':
    report.copyIndent?.value === 4 &&
    (report.copyIndent?.clipboard == null || report.copyIndent?.clipboard === SUBTREE_A_4),
  // 第 10 项设置（ADR-0011 修订）：默认路径、可切换到子树 JSON、可切回
  'set:searchCopyFormat':
    report.searchCopyFormat?.initial === 'path' &&
    report.searchCopyFormat?.afterClick === 'subtree' &&
    report.searchCopyFormat?.back === 'path',
  'set:export-mode':
    report.exportMode?.value === 'clipboard' &&
    report.exportMode?.splitLabel === '复制 JSON 到剪贴板' &&
    report.exportMode?.panelChecked === 'true',
  // 第 11 项设置（ADR-0018 §7）：默认标准、可切宽松、可切回
  'set:advBudget':
    report.advBudget?.initial === 'standard' &&
    report.advBudget?.afterClick === 'loose' &&
    report.advBudget?.back === 'standard',
  'set:repair-off':
    report.repairOff?.value === false &&
    /PARSE/.test(report.repairOff?.toast ?? '') &&
    report.repairOff?.repair?.status === 'none' &&
    report.repairOff?.repair?.visible === false &&
    report.repairOff?.rowsAfter === report.repairOff?.rowsBefore,
  'set:adaptive-off':
    report.adaptiveOff?.value === false &&
    report.adaptiveOff?.totalRows === 2 &&
    report.adaptiveOff?.geometry?.spacerHeight === '44px',

  // 刷新后恢复
  'persist:settings':
    report.reloaded?.settings?.loadedFromStore === true &&
    JSON.stringify(
      Object.fromEntries(DEFAULT_KEYS.map((key) => [key, settingsOf(report.reloaded?.settings)[key]])),
    ) ===
      JSON.stringify({
        theme: 'light',
        rowHeight: 22,
        indent: 20,
        typeColumn: true,
        defaultCopyFormat: 'subtree',
        copyIndent: 4,
        searchCopyFormat: 'path',
        exportMode: 'clipboard',
        repairTruncated: false,
        adaptiveExpand: false,
        advBudget: 'standard',
      }),
  'persist:theme':
    report.reloaded?.theme === 'light' && report.reloaded?.settings?.theme === 'light',
  'persist:geometry':
    report.reloaded?.geometry?.rowHeightCss === '22px' &&
    report.reloaded?.geometry?.rowHeight === 22 &&
    report.reloaded?.geometry?.indentCss === '20px' &&
    report.endPanel === 'settings',
  'persist:panel':
    report.reloaded?.panel === 'settings' &&
    report.reloaded?.activeBtn === 'page' &&
    JSON.stringify(report.reloaded?.rows) === JSON.stringify(DEFAULT_KEYS),

  // 响应式断点（ADR-0017 / direction.md §3）：≤1320 收 300/284（树 568 = 1200-48-300-284），1440 回 320/300
  'breakpoint:narrow-applies':
    report.breakpointNarrow?.vw === 1200 &&
    report.breakpointNarrow?.side === 300 &&
    report.breakpointNarrow?.rail === 284 &&
    report.breakpointNarrow?.tree === 568,
  'breakpoint:wide-default':
    report.breakpointWide?.vw === 1440 &&
    report.breakpointWide?.side === 320 &&
    report.breakpointWide?.rail === 300,

  'console:no-exception-no-error':
    report.consoleErrors?.length === 0 && report.consoleErrorLogs?.length === 0,
};

if (report.errors) console.log(`\nphase errors: ${JSON.stringify(report.errors, null, 2)}`);
for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? '✅' : '❌'} ${name}`);
const passed = Object.values(checks).filter(Boolean).length;
const total = Object.keys(checks).length;
console.log(`\nsmoke-settings: ${passed}/${total} ${passed === total ? 'OK' : 'FAILED'}`);
process.exitCode = passed === total ? 0 : 1;
