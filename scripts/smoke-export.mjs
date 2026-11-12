/**
 * scripts/smoke-export.mjs — 导出分体按钮（ADR-0012）真机冒烟。
 *
 *   node build.mjs && node scripts/smoke-export.mjs
 *
 * 测：
 *   1) 分体按钮形态：主按钮「导出」+ 箭头；加载后可用，菜单默认关闭
 *   2) 打开菜单：两项（导出 JSON 文件 / 复制 JSON 到剪贴板）、当前方式带勾、焦点落当前项
 *   3) 键盘：↑↓ 移动、Esc 关闭且焦点回箭头
 *   4) 选「复制 JSON 到剪贴板」→ 剪贴板**逐字**等于导出文本 + toast「已复制：JSON」(success) +
 *      菜单关闭 + 方式记住（主按钮 label 变「复制 JSON 到剪贴板」）
 *   5) 主按钮复用上次方式：再点主按钮仍复制
 *   6) 选「导出 JSON 文件」→ 系统「另存为」桩（ADR-0021）：预填 `sample.json`、写入文本逐字 ==
 *      导出文本、记录下载动作 + 方式变回文件
 *   7) 刷新页面 → 方式保持（持久化到 UiState）+ 主按钮 label 正确
 *   8) 0 page 异常 / 0 console error
 *   9) 菜单交互契约（ADR-0015）：Tab 关闭并焦点回箭头、外部 pointerdown/resize 关闭、
 *      定位不越出视口且锚在箭头下方、选中项后焦点回箭头（动作完成、按钮恢复可聚焦后）
 *  10) 另存为改名联动（ADR-0021）：桩返回 `报告-2024.json` → 文件 chip 与标签名变 `报告-2024`；
 *      取消另存为 → 不导出、不改名（lastAction/chip 不变）
 *  11) JSON 格式化配置（#34 / ADR-0022）：默认档 ≡ JSON.stringify(v,null,2)；紧凑档 ≡
 *      JSON.stringify(v)；转义档非 ASCII → \\uXXXX 且仍是合法 JSON；整份复制与文件导出跟随设置。
 * 截图落 .spike/smoke/export-{menu,toast}.png。
 */
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { launchChrome, REPO_ROOT } from '../prototype/p1/lib/chrome.mjs';
import { startStaticServer } from '../prototype/p1/lib/http.mjs';

const SHOTS = path.join(REPO_ROOT, '.spike', 'smoke');
await mkdir(SHOTS, { recursive: true });

const FIXTURE = { a: { 'b.c': 'x' }, arr: [10, { k: null }] };
const EXPECTED_TEXT = JSON.stringify(FIXTURE, null, 2);
const CLIPBOARD_MAX_BYTES = 20 * 1024 * 1024;

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

  // ---- phase 1：加载文档 + 分体按钮初始态 ----
  await runPhase(
    'boot',
    `(async () => {
      const out = {};
      const h = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      await h.loadText(${JSON.stringify(JSON.stringify(FIXTURE))}, 'sample.json');
      await sleep(400);
      // 系统「另存为」桩（ADR-0021）：无头里没有原生对话框，记录预填名与写入文本
      window.__saveCalls = [];
      window.__saveMode = 'accept';
      window.__saveCustomName = '';
      window.showSaveFilePicker = async (opts) => {
        window.__saveCalls.push({ name: (opts && opts.suggestedName) || null, text: null });
        if (window.__saveMode === 'cancel') throw new DOMException('cancelled', 'AbortError');
        if (window.__saveMode === 'throw') throw new DOMException('blocked by policy', 'NotAllowedError');
        const name = window.__saveMode === 'custom' ? window.__saveCustomName : (opts && opts.suggestedName) || 'x.json';
        return {
          name,
          createWritable: async () => ({
            write: async (text) => {
              window.__saveCalls[window.__saveCalls.length - 1].text = text;
            },
            close: async () => {},
          }),
        };
      };
      out.boot = { export: h.exportState(), state: h.state() };
      return out;
    })()`,
  );

  // ---- phase 2：打开菜单（形态/勾选/焦点）+ 键盘 ----
  await runPhase(
    'menu',
    `(async () => {
      const out = {};
      const h = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      out.menu = h.exportMenuOpen();
      await sleep(120);
      const items = [...document.querySelectorAll('#exportMenu [data-export-mode]')];
      out.menuFocus = {
        expanded: document.getElementById('exportMenuBtn')?.getAttribute('aria-expanded'),
        focused: items.findIndex((n) => n === document.activeElement),
        activeLabel: (document.activeElement?.textContent ?? '').replace('✓', '').trim(),
      };
      // ↓ 移到第二项 → Esc 关闭并焦点回箭头
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      await sleep(60);
      out.afterArrowDown = {
        focused: [...document.querySelectorAll('#exportMenu [data-export-mode]')].findIndex(
          (n) => n === document.activeElement,
        ),
        label: (document.activeElement?.textContent ?? '').replace('✓', '').trim(),
      };
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(80);
      out.afterEscape = {
        menuOpen: h.exportState().menuOpen,
        expanded: document.getElementById('exportMenuBtn')?.getAttribute('aria-expanded'),
        focusOnCaret: document.activeElement === document.getElementById('exportMenuBtn'),
      };
      return out;
    })()`,
  );
  // ---- phase 2b：菜单交互契约（ADR-0015：Tab / 外部 / resize / 定位 / 选中归还） ----
  await runPhase(
    'menu-contract',
    `(async () => {
      const out = {};
      const h = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const menu = document.getElementById('exportMenu');
      const btn = document.getElementById('exportMenuBtn');
      const openMenu = async () => {
        h.exportMenuOpen();
        await sleep(110);
      };
      const state = () => ({
        open: !menu.hidden,
        expanded: btn.getAttribute('aria-expanded'),
        focusOnCaret: document.activeElement === btn,
      });

      // Tab：关闭 + 焦点回箭头（合成事件不触发默认 Tab 导航，因此焦点停在 opener）
      await openMenu();
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      await sleep(60);
      out.tab = state();

      // 外部 pointerdown：关闭
      await openMenu();
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      await sleep(60);
      out.outside = state();

      // window resize：关闭
      await openMenu();
      window.dispatchEvent(new Event('resize'));
      await sleep(60);
      out.resize = state();

      // 定位：不越出视口、锚在箭头下方
      await openMenu();
      const rect = menu.getBoundingClientRect();
      const anchor = btn.getBoundingClientRect();
      out.position = {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        anchorBottom: anchor.bottom,
        viewportW: window.innerWidth,
        viewportH: window.innerHeight,
      };

      // 选中项：动作完成（按钮重新可聚焦）后焦点回箭头
      h.exportChoose('clipboard');
      await sleep(500);
      out.selectFocus = state();
      return { menuContract: out };
    })()`,
  );
  await runPhase(
    'menu-reopen',
    `(async () => {
      const h = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const state = h.exportMenuOpen();
      await sleep(120);
      return { menuOpenState: state };
    })()`,
  );
  await page.screenshot(path.join(SHOTS, 'export-menu.png'));

  // ---- phase 3：选「复制到剪贴板」→ 剪贴板逐字 + toast + 记住方式 ----
  await runPhase(
    'copy',
    `(async () => {
      const out = {};
      const h = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      out.copyChosen = h.exportChoose('clipboard');
      await sleep(400);
      out.copy = {
        export: h.exportState(),
        toast: h.toastText(),
        toastTone: document.getElementById('toast')?.dataset.tone ?? null,
        settingsMode: h.settingsState().exportMode,
        panelChecked: document
          .querySelector('#settingsPanel [data-setting="exportMode"] [data-value="clipboard"]')
          ?.getAttribute('aria-pressed'),
      };
      try { out.copy.clipboard = await h.clipboardText(); } catch { out.copy.clipboard = null; }
      return out;
    })()`,
  );
  await page.screenshot(path.join(SHOTS, 'export-toast.png'));

  // ---- phase 4：主按钮复用「复制」；再切回「文件」并确认下载动作 ----
  await runPhase(
    'main-and-file',
    `(async () => {
      const out = {};
      const h = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      // 主按钮 = 上次方式（clipboard）
      h.exportClick();
      await sleep(400);
      out.mainClipboard = { export: h.exportState(), toast: h.toastText() };
      // 切回文件方式并执行
      const menu = h.exportMenuOpen();
      await sleep(120);
      out.fileMenu = menu;
      h.exportChoose('file');
      await sleep(400);
      out.file = {
        export: h.exportState(),
        toast: h.toastText(),
        saveCalls: window.__saveCalls.slice(),
      };
      return out;
    })()`,
  );

  // ---- phase 4b：另存为改名联动 / 取消零副作用（ADR-0021）----
  await runPhase(
    'rename-from-dialog',
    `(async () => {
      const out = {};
      const h = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      // 用户在系统框里改名 → 保存后按最终文件名反推基名，写回文件 chip / 标签名
      window.__saveCalls.length = 0;
      window.__saveMode = 'custom';
      window.__saveCustomName = '报告-2024.json';
      h.exportChoose('file');
      await sleep(400);
      out.renamePhase = {
        export: h.exportState(),
        chipName: document.getElementById('fileName')?.textContent ?? null,
        tabName: h.workspaceState?.().tabs?.[0]?.name ?? null,
        saveCalls: window.__saveCalls.slice(),
      };
      // 再导出一次并在系统框里取消：零副作用（不导出、不改名）
      window.__saveCalls.length = 0;
      window.__saveMode = 'cancel';
      h.exportChoose('file');
      await sleep(300);
      out.cancelPhase = {
        export: h.exportState(),
        chipName: document.getElementById('fileName')?.textContent ?? null,
        saveCalls: window.__saveCalls.slice(),
      };
      // 系统框 API 存在但被策略拒绝（NotAllowedError）→ 回落普通下载，不中断、不改名
      window.__saveCalls.length = 0;
      window.__saveMode = 'throw';
      h.exportChoose('file');
      await sleep(300);
      out.fallbackPhase = {
        export: h.exportState(),
        chipName: document.getElementById('fileName')?.textContent ?? null,
        saveCalls: window.__saveCalls.slice(),
      };
      return out;
    })()`,
  );

  // ---- phase 7：无损数字（ADR-0020）：导出文本保留大整数精确十进制（无引号）----
  await runPhase(
    'lossless',
    `(async () => {
      const out = {};
      const h = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      await h.loadText('{"big":297532588187238660,"nested":{"uid":1234567890123456789}}', 'lossless-export.json');
      await sleep(500);
      h.exportChoose('clipboard');
      await sleep(600);
      out.lossless = { export: h.exportState(), toast: h.toastText() };
      try { out.lossless.clipboard = await h.clipboardText(); } catch { out.lossless.clipboard = null; }
      return out;
    })()`,
  );

  // ---- phase 7b：JSON 格式化配置（#34 / ADR-0022）：缩进 0/2/4 + 非 ASCII 转义 ----
  await runPhase(
    'format-config',
    `(async () => {
      const out = {};
      const h = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const text = '{"cn":"中文","emoji":"😀","ascii":"a/b","big":297532588187238660,"nested":{"键":[1,"x"]}}';
      await h.loadText(text, 'format.json');
      await sleep(450);
      // 默认档（缩进 2、不转义）：与 JSON.stringify(v, null, 2) 逐字节一致
      out.formatDefault = { settings: h.settingsState(), exportText: await h.exportDocText() };
      // 紧凑档（缩进 0）：与 JSON.stringify(v) 逐字节一致
      h.setSetting('jsonIndent', 0);
      await sleep(80);
      out.formatCompact = { settings: h.settingsState(), exportText: await h.exportDocText() };
      // 4 空格 + 转义非 ASCII：值不变、输出仍是合法 JSON
      h.setSetting('jsonIndent', 4);
      h.setSetting('escapeUnicode', true);
      await sleep(80);
      out.formatEscape4 = { settings: h.settingsState(), exportText: await h.exportDocText() };
      // 整份复制跟随设置：转义 + 紧凑
      h.setSetting('jsonIndent', 0);
      await sleep(80);
      h.exportChoose('clipboard');
      await sleep(600);
      try {
        out.formatCopy = { clipboard: await h.clipboardText(), export: h.exportState() };
      } catch {
        out.formatCopy = { clipboard: null, export: h.exportState() };
      }
      // 文件导出跟随设置：转义 + 紧凑 → 另存为桩写入文本
      window.__saveCalls.length = 0;
      window.__saveMode = 'accept';
      window.__saveCustomName = '';
      h.exportChoose('file');
      await sleep(450);
      out.formatFile = { saveCalls: window.__saveCalls.slice(), export: h.exportState() };
      // 还原默认（收尾，避免影响后续相位的持久化断言）
      h.setSetting('jsonIndent', 2);
      h.setSetting('escapeUnicode', false);
      await sleep(80);
      out.formatRestored = h.settingsState();
      return out;
    })()`,
  );

  // ---- phase 4.5：设置面板改「导出方式」→ 分体按钮主操作/勾选同步（反向同步）----
  await runPhase(
    'panel-sync',
    `(async () => {
      const out = {};
      const h = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const btn = document.querySelector('#settingsPanel [data-setting="exportMode"] [data-value="clipboard"]');
      btn.click();
      await sleep(150);
      out.panelSync = {
        settingsMode: h.settingsState().exportMode,
        export: h.exportState(),
        panelChecked: btn.getAttribute('aria-pressed'),
      };
      return out;
    })()`,
  );

  // ---- phase 5：选回剪贴板方式（只改方式与执行一次），刷新验证持久化 ----
  await runPhase(
    'persist-prepare',
    `(async () => {
      const h = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const menu = h.exportMenuOpen();
      await sleep(120);
      h.exportChoose('clipboard');
      await sleep(400);
      return { persistPrepared: { menu, export: h.exportState() } };
    })()`,
  );
  await page.goto(url, { timeoutMs: 20000 });
  await page.waitFor('document.readyState === "complete"', { timeoutMs: 20000 });
  await new Promise((r) => setTimeout(r, 800));
  await runPhase(
    'persist',
    `(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      await sleep(200);
      return { reloaded: { ...window.__tjv.exportState(), settingsMode: window.__tjv.settingsState().exportMode } };
    })()`,
  );

  report.consoleErrors = page.exceptions.slice(errorsBefore);
  report.consoleErrorLogs = page.logs
    .filter((entry) => entry.type === 'error')
    .map((entry) => entry.text);
} finally {
  await chrome.close();
  await server.close();
}

console.log(JSON.stringify(report, null, 2));

const item = (state, mode) => (state?.menuItems ?? []).find((entry) => entry.mode === mode);
const clipboardOk = (state, expected) => state?.clipboard == null || state?.clipboard === expected;

// ---- JSON 格式化配置的期望文本（#34 / ADR-0022；与 phase format-config 的 fixture 同源）----
const FORMAT_TEXT =
  '{"cn":"中文","emoji":"😀","ascii":"a/b","big":297532588187238660,"nested":{"键":[1,"x"]}}';
const FORMAT_VALUE = JSON.parse(FORMAT_TEXT);
/** 序列化文本里所有非 ASCII 字符 → \uXXXX（代理对各一个转义；与序列化器 escape 档同口径） */
const escapeNonAscii = (text) =>
  text.replace(/[\u0080-\uffff]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
const FORMAT_DEFAULT = JSON.stringify(FORMAT_VALUE, null, 2);
const FORMAT_COMPACT = JSON.stringify(FORMAT_VALUE);
const FORMAT_ESCAPE_4 = escapeNonAscii(JSON.stringify(FORMAT_VALUE, null, 4));
const FORMAT_ESCAPE_COMPACT = escapeNonAscii(FORMAT_COMPACT);

const checks = {
  // 初始形态
  // ---- 无损数字（ADR-0020）：导出是裸数字字面量（不是字符串、不是 double 圆整值）----
  'lossless:export-bigint-exact':
    (report.lossless?.clipboard == null ||
      (report.lossless.clipboard.includes('"big": 297532588187238660') &&
        report.lossless.clipboard.includes('"uid": 1234567890123456789') &&
        !report.lossless.clipboard.includes('"297532588187238660"') &&
        !report.lossless.clipboard.includes('297532588187238656'))) &&
    report.lossless?.export?.lastAction?.copied === true,

  'boot:split-button':
    report.boot?.export?.mode === 'file' &&
    report.boot?.export?.menuOpen === false &&
    report.boot?.export?.mainText === '导出' &&
    report.boot?.export?.mainLabel === '导出 JSON 文件' &&
    report.boot?.export?.disabled?.main === false &&
    report.boot?.export?.disabled?.caret === false,
  'boot:menu-items':
    JSON.stringify((report.boot?.export?.menuItems ?? []).map((entry) => entry.mode)) ===
      JSON.stringify(['file', 'clipboard']) &&
    JSON.stringify((report.boot?.export?.menuItems ?? []).map((entry) => entry.label)) ===
      JSON.stringify(['导出 JSON 文件', '复制 JSON 到剪贴板']) &&
    item(report.boot?.export, 'file')?.checked === true &&
    item(report.boot?.export, 'clipboard')?.checked === false,
  'boot:clipboard-guard-wired': report.boot?.export?.clipboardMaxBytes === CLIPBOARD_MAX_BYTES,

  // 菜单打开 / 键盘
  'menu:opens':
    report.menu?.menuOpen === true &&
    report.menuFocus?.expanded === 'true' &&
    report.menuFocus?.focused === 0 &&
    report.menuFocus?.activeLabel === '导出 JSON 文件',
  'menu:arrow-down': report.afterArrowDown?.focused === 1 && report.afterArrowDown?.label === '复制 JSON 到剪贴板',
  'menu:escape-closes-and-restores-focus':
    report.afterEscape?.menuOpen === false &&
    report.afterEscape?.expanded === 'false' &&
    report.afterEscape?.focusOnCaret === true,
  'menu:reopen': report.menuOpenState?.menuOpen === true,
  // ---- 菜单交互契约（ADR-0015）----
  'menu:tab-closes-and-restores-focus':
    report.menuContract?.tab?.open === false &&
    report.menuContract?.tab?.expanded === 'false' &&
    report.menuContract?.tab?.focusOnCaret === true,
  'menu:outside-pointerdown-closes':
    report.menuContract?.outside?.open === false && report.menuContract?.outside?.expanded === 'false',
  'menu:resize-closes': report.menuContract?.resize?.open === false,
  'menu:position-in-viewport':
    Boolean(report.menuContract?.position) &&
    report.menuContract.position.left >= 7.5 &&
    report.menuContract.position.top >= 7.5 &&
    report.menuContract.position.right <= report.menuContract.position.viewportW - 7.5 &&
    report.menuContract.position.bottom <= report.menuContract.position.viewportH - 7.5 &&
    report.menuContract.position.top >= report.menuContract.position.anchorBottom,
  'menu:select-restores-focus':
    report.menuContract?.selectFocus?.open === false && report.menuContract?.selectFocus?.focusOnCaret === true,

  // 复制到剪贴板
  'copy:clipboard-text': clipboardOk(report.copy, EXPECTED_TEXT),
  'copy:toast-and-tone':
    (report.copy?.toast ?? '').includes('已复制') && report.copy?.toastTone === 'success',
  'copy:mode-remembered':
    report.copy?.export?.mode === 'clipboard' &&
    report.copy?.export?.menuOpen === false &&
    report.copy?.export?.mainLabel === '复制 JSON 到剪贴板' &&
    item(report.copy?.export, 'clipboard')?.checked === true &&
    report.copy?.export?.lastAction?.mode === 'clipboard' &&
    report.copy?.export?.lastAction?.copied === true,

  // 双向同步：菜单 → 设置面板回显
  'sync:menu-to-panel':
    report.copy?.settingsMode === 'clipboard' && report.copy?.panelChecked === 'true',

  // 双向同步：设置面板 → 分体按钮 label / 菜单勾选
  'sync:panel-to-button':
    report.panelSync?.settingsMode === 'clipboard' &&
    report.panelSync?.export?.mainLabel === '复制 JSON 到剪贴板' &&
    report.panelSync?.panelChecked === 'true' &&
    (report.panelSync?.export?.menuItems ?? []).find((entry) => entry.mode === 'clipboard')?.checked === true,

  // 主按钮复用上次方式
  'main:reuses-last-mode':
    report.mainClipboard?.export?.lastAction?.mode === 'clipboard' &&
    /已复制/.test(report.mainClipboard?.toast ?? '') &&
    report.mainClipboard?.export?.mode === 'clipboard',

  // 文件方式
  'file:action-recorded':
    report.file?.export?.mode === 'file' &&
    report.file?.export?.mainLabel === '导出 JSON 文件' &&
    report.file?.export?.lastAction?.mode === 'file' &&
    report.file?.export?.lastAction?.name === 'sample.json' &&
    item(report.file?.export, 'file')?.checked === true,

  // ---- 系统另存为（ADR-0021）----
  'file:save-dialog-prefill': report.file?.saveCalls?.[0]?.name === 'sample.json',
  'file:save-written-text': report.file?.saveCalls?.[0]?.text === EXPECTED_TEXT,
  'rename:from-save-dialog':
    report.renamePhase?.chipName === '报告-2024' &&
    report.renamePhase?.tabName === '报告-2024' &&
    report.renamePhase?.export?.lastAction?.mode === 'file' &&
    report.renamePhase?.export?.lastAction?.name === '报告-2024.json' &&
    report.renamePhase?.saveCalls?.[0]?.name === 'sample.json',
  'rename:cancel-no-side-effect':
    report.cancelPhase?.chipName === '报告-2024' &&
    report.cancelPhase?.export?.lastAction?.name === '报告-2024.json' &&
    (report.cancelPhase?.saveCalls ?? []).length === 1,
  'file:policy-blocked-fallback':
    report.fallbackPhase?.chipName === '报告-2024' &&
    report.fallbackPhase?.export?.lastAction?.mode === 'file' &&
    report.fallbackPhase?.export?.lastAction?.name === '报告-2024.json' &&
    (report.fallbackPhase?.saveCalls ?? []).length === 1,

  // 刷新后持久化
  'persist:mode':
    report.reloaded?.mode === 'clipboard' &&
    report.reloaded?.settingsMode === 'clipboard' &&
    report.reloaded?.mainLabel === '复制 JSON 到剪贴板' &&
    item(report.reloaded, 'clipboard')?.checked === true &&
    report.persistPrepared?.export?.mode === 'clipboard',

  // ---- JSON 格式化配置（#34 / ADR-0022）----
  'format:default-bytes':
    report.formatDefault?.settings?.jsonIndent === 2 &&
    report.formatDefault?.settings?.escapeUnicode === false &&
    report.formatDefault?.exportText?.text === FORMAT_DEFAULT,
  'format:compact':
    report.formatCompact?.settings?.jsonIndent === 0 && report.formatCompact?.exportText?.text === FORMAT_COMPACT,
  'format:escape-4':
    report.formatEscape4?.settings?.jsonIndent === 4 &&
    report.formatEscape4?.settings?.escapeUnicode === true &&
    report.formatEscape4?.exportText?.text === FORMAT_ESCAPE_4 &&
    report.formatEscape4?.exportText?.text.includes('\\u4e2d\\u6587') &&
    report.formatEscape4?.exportText?.text.includes('\\ud83d\\ude00') &&
    report.formatEscape4?.exportText?.text.includes('\\u952e') &&
    !report.formatEscape4?.exportText?.text.includes('中'),
  'format:escape-valid-json': (() => {
    try {
      return JSON.stringify(JSON.parse(report.formatEscape4?.exportText?.text ?? '')) === FORMAT_COMPACT;
    } catch {
      return false;
    }
  })(),
  'format:copy-follows-settings':
    report.formatCopy?.export?.lastAction?.mode === 'clipboard' &&
    (report.formatCopy?.clipboard == null || report.formatCopy?.clipboard === FORMAT_ESCAPE_COMPACT),
  'format:file-follows-settings':
    report.formatFile?.export?.lastAction?.mode === 'file' &&
    report.formatFile?.saveCalls?.length === 1 &&
    report.formatFile?.saveCalls?.[0]?.text === FORMAT_ESCAPE_COMPACT,
  'format:settings-restored':
    report.formatRestored?.jsonIndent === 2 && report.formatRestored?.escapeUnicode === false,

  'console:no-exception-no-error':
    report.consoleErrors?.length === 0 && report.consoleErrorLogs?.length === 0,
};

if (report.errors) console.log(`\nphase errors: ${JSON.stringify(report.errors, null, 2)}`);
for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? '✅' : '❌'} ${name}`);
const passed = Object.values(checks).filter(Boolean).length;
const total = Object.keys(checks).length;
console.log(`\nsmoke-export: ${passed}/${total} ${passed === total ? 'OK' : 'FAILED'}`);
process.exitCode = passed === total ? 0 : 1;
