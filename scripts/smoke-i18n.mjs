/**
 * scripts/smoke-i18n.mjs — 界面语言（i18n）真机冒烟（#45 / ADR-0026）。
 *
 *   node build.mjs && node scripts/smoke-i18n.mjs
 *
 * 测：
 *   1) `?lang=en-US` 覆盖：外壳 / 状态栏 / 设置面板 / 菜单全是英文，`<html lang>` 同步；
 *   2) 英文界面里的 worker 诊断（修复摘要 + 逐条 note、正则错误）也本地化；
 *   3) 设置面板第 14 行「语言」切到 zh-CN → 界面**即时**变中文（含已渲染的修复条，证明
 *      worker 侧是结构化数据、页面在渲染时格式化）；
 *   4) 持久化：设置 en-US 后刷新（浏览器语言是 zh-CN）→ 仍是 en-US；
 *   5) `?lang=zh-CN` 覆盖已存设置 en-US（测试/调试口优先级最高）；
 *   6) 0 page 异常 / 0 console error。
 * 截图落 .spike/smoke/i18n-{en,zh}.png。走 HTTP + `window.__tjv`（localStorage 兜底持久化）。
 */
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { launchChrome, REPO_ROOT } from '../prototype/p1/lib/chrome.mjs';
import { startStaticServer } from '../prototype/p1/lib/http.mjs';

const SHOTS = path.join(REPO_ROOT, '.spike', 'smoke');
await mkdir(SHOTS, { recursive: true });

/** 纯 ASCII 夹具（英文界面里不应出现 CJK，文档内容也不能是中文）。 */
const FIXTURE = JSON.stringify({ a: { 'b.c': 'x' }, arr: [10, { k: null }], flag: true });
/** 截断 JSON → 修复条（摘要 + 逐条 note 都来自 worker 的结构化诊断）。 */
const TRUNCATED = '{"a":1,"b":[1,2,{"c":"x"';

const server = await startStaticServer(REPO_ROOT);
const chrome = await launchChrome({ windowSize: '1440,900' });
const report = {};

/** 一段文本里的 CJK 字符数（英文界面的「无中文残留」断言）。 */
const CJK_COUNT = `(text) => (String(text ?? '').match(/[\\u4e00-\\u9fff]/g) ?? []).length`;

try {
  const page = await chrome.openPage();
  const errorsBefore = page.exceptions.length;
  await page.setViewport(1440, 900);

  const runPhase = async (name, expression) => {
    try {
      Object.assign(report, (await page.eval(expression)) ?? {});
    } catch (error) {
      if (!report.errors) report.errors = {};
      report.errors[name] = String(error?.message ?? error);
      console.warn(`⚠️ phase ${name} failed: ${String(error?.message ?? error)}`);
    }
  };

  /* ---------------- phase 1：?lang=en-US 外壳 ---------------- */
  await page.goto(`${server.base}/dist/page.html?lang=en-US`, { timeoutMs: 20000 });
  await page.waitFor('document.readyState === "complete"', { timeoutMs: 20000 });
  await new Promise((r) => setTimeout(r, 600));

  await runPhase(
    'en-shell',
    `(async () => {
      const out = {};
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const cjk = ${CJK_COUNT};
      const h = window.__tjv;
      const text = (id) => document.getElementById(id)?.textContent ?? '';
      out.enShell = {
        htmlLang: document.documentElement.lang,
        locale: h.localeState(),
        activityLabel: document.querySelector('nav.activity')?.getAttribute('aria-label') ?? null,
        importText: text('importBtn'),
        exportText: text('exportBtn'),
        statusRows: text('statusRows'),
        statusState: text('statusState'),
        statusTheme: text('statusTheme'),
        emptyTitle: text('emptyTitle'),
        bodyCjk: cjk(document.body.innerText),
      };
      // 真实点击活动栏齿轮 → 设置面板（14 行 + 语言行）
      document.querySelector('[data-panel-btn="settings"]').click();
      await sleep(250);
      const rows = [...document.querySelectorAll('#settingsPanel [data-setting]')].map((n) => n.dataset.setting ?? '');
      const langRow = document.querySelector('#settingsPanel [data-setting="locale"]');
      out.enSettings = {
        panelTitle: text('panelTitle'),
        rows,
        rowCount: rows.length,
        hasLanguageRow: Boolean(langRow),
        languageValues: langRow
          ? [...langRow.querySelectorAll('[data-value]')].map((n) => n.dataset.value ?? '')
          : [],
        languageLabel: langRow?.querySelector('.settings__label')?.textContent ?? '',
        // 语言行的选项文案是各语言「自称」（简体中文 必然含 CJK，ADR-0026 §3），统计时排除
        panelCjk: cjk(
          [...document.querySelectorAll('#settingsPanel [data-setting]')]
            .filter((n) => n.dataset.setting !== 'locale')
            .map((n) => n.innerText)
            .join(' '),
        ),
        aria: langRow?.getAttribute('role') ?? langRow?.getAttribute('aria-label') ?? null,
      };
      return out;
    })()`,
  );
  await page.screenshot(path.join(SHOTS, 'i18n-en-settings.png'));

  /* ---------------- phase 2：英文界面 + 文档 + 菜单 + 概要 ---------------- */
  await runPhase(
    'en-doc',
    `(async () => {
      const out = {};
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const cjk = ${CJK_COUNT};
      const h = window.__tjv;
      const text = (id) => document.getElementById(id)?.textContent ?? '';
      await h.loadText(${JSON.stringify(FIXTURE)}, 'i18n.json');
      await sleep(500);
      const ctx = h.ctxOpen('$.a');
      await sleep(120);
      out.enDoc = {
        statusRows: text('statusRows'),
        statusState: text('statusState'),
        rows: document.querySelectorAll('.row[data-path]').length,
        selectedMeta: text('selMeta'),
        profileText: text('profilePanel'),
        ctxLabels: (ctx.items ?? []).map((item) => item.label),
        ctxCjk: cjk((ctx.items ?? []).map((item) => item.label + ' ' + item.title).join(' ')),
        tabAddTitle: document.querySelector('#tabAdd')?.getAttribute('title') ?? null,
      };
      h.ctxClick('copy-path');
      await sleep(150);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(100);
      return out;
    })()`,
  );

  /* ---------------- phase 3：worker 诊断（修复摘要 + note）在英文下也本地化 ---------------- */
  await runPhase(
    'en-repair',
    `(async () => {
      const out = {};
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const cjk = ${CJK_COUNT};
      const h = window.__tjv;
      await h.loadText(${JSON.stringify(TRUNCATED)}, 'cut.json');
      await sleep(600);
      h.repairToggle();
      await sleep(200);
      out.enRepair = {
        summary: document.getElementById('repairText')?.textContent ?? '',
        notes: [...document.querySelectorAll('#repairOps .repairbar__op span')].map((n) => n.textContent ?? ''),
        barCjk: cjk(document.getElementById('repairBar')?.innerText ?? ''),
        state: h.repairState(),
      };
      return out;
    })()`,
  );
  await page.screenshot(path.join(SHOTS, 'i18n-en-repair.png'));

  // 亮色 × 英文（主题切换是纯视觉，不影响断言；截完切回深色）
  await runPhase(
    'en-light',
    `(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      document.getElementById('themeToggle')?.click();
      await sleep(250);
      return { enLight: { theme: document.documentElement.dataset.theme } };
    })()`,
  );
  await page.screenshot(path.join(SHOTS, 'i18n-en-light.png'));
  await page.eval(
    `(async () => {
      document.getElementById('themeToggle')?.click();
      await new Promise((r) => setTimeout(r, 200));
    })()`,
  );

  /* ---------------- phase 4：正则错误文案（BAD_PATTERN）英文 ---------------- */
  await runPhase(
    'en-pattern',
    `(async () => {
      const out = {};
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const cjk = ${CJK_COUNT};
      const h = window.__tjv;
      document.querySelector('[data-panel-btn="search"]').click();
      await sleep(200);
      const input = document.getElementById('searchInput');
      if (!input) throw new Error('missing #searchInput');
      input.value = '(';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('searchRegex')?.click();
      await sleep(500);
      const panel = h.searchPanel();
      out.enPattern = {
        patternError: panel.patternError,
        cjk: cjk(panel.patternError ?? ''),
      };
      return out;
    })()`,
  );

  /* ---------------- phase 5：持久化（设置 en-US 覆盖浏览器语言 zh-CN） ---------------- */
  await runPhase(
    'persist-en',
    `(async () => {
      const out = {};
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      document.querySelector('[data-panel-btn="settings"]').click();
      await sleep(250);
      const btn = document.querySelector('#settingsPanel [data-setting="locale"] [data-value="en-US"]');
      if (!btn) throw new Error('missing locale=en-US option');
      btn.click();
      await sleep(500);
      out.persistEn = {
        importText: document.getElementById('importBtn')?.textContent ?? '',
        htmlLang: document.documentElement.lang,
        locale: window.__tjv.localeState(),
      };
      return out;
    })()`,
  );
  await page.goto(`${server.base}/dist/page.html`, { timeoutMs: 20000 });
  await page.waitFor('document.readyState === "complete"', { timeoutMs: 20000 });
  await new Promise((r) => setTimeout(r, 700));
  await runPhase(
    'reloaded',
    `(async () => {
      const h = window.__tjv;
      return {
        reloaded: {
          importText: document.getElementById('importBtn')?.textContent ?? '',
          statusRows: document.getElementById('statusRows')?.textContent ?? '',
          htmlLang: document.documentElement.lang,
          locale: h.localeState(),
        },
      };
    })()`,
  );

  /* ---------------- phase 6：英文界面下打开截断文档 → 设置切 zh-CN 即时全量变中文 ---------------- */
  await runPhase(
    'zh-switch',
    `(async () => {
      const out = {};
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const cjk = ${CJK_COUNT};
      const h = window.__tjv;
      const text = (id) => document.getElementById(id)?.textContent ?? '';
      // 先载入截断文档（英文诊断），展开摘要，再切语言
      await h.loadText(${JSON.stringify(TRUNCATED)}, 'cut.json');
      await sleep(600);
      h.repairToggle();
      await sleep(200);
      const before = {
        importText: text('importBtn'),
        repairSummary: text('repairText'),
      };
      // 打开设置面板 → 点语言 zh-CN
      document.querySelector('[data-panel-btn="settings"]').click();
      await sleep(250);
      const btn = document.querySelector('#settingsPanel [data-setting="locale"] [data-value="zh-CN"]');
      if (!btn) throw new Error('missing locale=zh-CN option');
      btn.click();
      // 语言包是动态 import（本地文件，通常 <50ms），等一小会儿
      await sleep(700);
      out.switchZh = {
        ...before,
        importAfter: text('importBtn'),
        htmlLang: document.documentElement.lang,
        locale: h.localeState(),
        panelTitle: text('panelTitle'),
        statusRows: text('statusRows'),
        statusState: text('statusState'),
        // 已渲染的修复条也应变成中文（worker 只回结构化数据，页面渲染时格式化）
        repairSummary: text('repairText'),
        repairCjk: cjk(
          text('repairText') +
            ' ' +
            [...document.querySelectorAll('#repairOps .repairbar__op span')].map((n) => n.textContent).join(' '),
        ),
        statusTheme: text('statusTheme'),
        selMeta: text('selMeta'),
        settingsLabel: document.querySelector('#settingsPanel [data-setting="locale"] .settings__label')?.textContent ?? '',
        languageValues: [...document.querySelectorAll('#settingsPanel [data-setting="locale"] [data-value]')].map((n) => n.dataset.value ?? ''),
      };
      return out;
    })()`,
  );
  await page.screenshot(path.join(SHOTS, 'i18n-zh.png'));
  // 亮色 × 中文（截完切回深色）
  await runPhase(
    'zh-light',
    `(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      document.getElementById('themeToggle')?.click();
      await sleep(250);
      return { zhLight: { theme: document.documentElement.dataset.theme } };
    })()`,
  );
  await page.screenshot(path.join(SHOTS, 'i18n-zh-light.png'));
  await page.eval(
    `(async () => {
      document.getElementById('themeToggle')?.click();
      await new Promise((r) => setTimeout(r, 200));
    })()`,
  );

  /* ---------------- phase 7：?lang=zh-CN 覆盖已存设置 en-US ---------------- */
  await runPhase(
    'override-prep',
    `(async () => {
      const out = {};
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const btn = document.querySelector('#settingsPanel [data-setting="locale"] [data-value="en-US"]');
      if (!btn) throw new Error('missing locale=en-US option');
      btn.click();
      await sleep(500);
      out.overridePrep = {
        importText: document.getElementById('importBtn')?.textContent ?? '',
        locale: window.__tjv.localeState(),
      };
      return out;
    })()`,
  );
  await page.goto(`${server.base}/dist/page.html?lang=zh-CN`, { timeoutMs: 20000 });
  await page.waitFor('document.readyState === "complete"', { timeoutMs: 20000 });
  await new Promise((r) => setTimeout(r, 700));
  await runPhase(
    'override',
    `(async () => ({
      override: {
        importText: document.getElementById('importBtn')?.textContent ?? '',
        htmlLang: document.documentElement.lang,
        locale: window.__tjv.localeState(),
      },
    }))()`,
  );

  report.consoleErrors = page.exceptions.slice(errorsBefore);
  report.consoleErrorLogs = page.logs.filter((entry) => entry.type === 'error').map((entry) => entry.text);
} finally {
  await chrome.close();
  await server.close();
}

const checks = {
  // ---- en 外壳 ----
  'en:html-lang': report.enShell?.htmlLang === 'en-US',
  'en:locale-state':
    report.enShell?.locale?.locale === 'en-US' && report.enShell?.locale?.pref === 'auto',
  'en:shell-copy':
    report.enShell?.activityLabel === 'Activity bar' &&
    report.enShell?.importText === 'Import' &&
    report.enShell?.statusRows === 'No document open' &&
    report.enShell?.statusState === 'Read-only · source unchanged' &&
    /Drop in JSON/.test(report.enShell?.emptyTitle ?? ''),
  'en:no-cjk-shell': report.enShell?.bodyCjk === 0,
  'en:status-theme': report.enShell?.statusTheme === 'Dark',
  // ---- en 设置面板：14 行 + 语言行 ----
  'en:settings-14-rows': report.enSettings?.rowCount === 14,
  'en:settings-has-language':
    report.enSettings?.hasLanguageRow === true &&
    JSON.stringify(report.enSettings?.languageValues) === JSON.stringify(['auto', 'en-US', 'zh-CN']) &&
    report.enSettings?.languageLabel === 'Language',
  'en:settings-copy':
    report.enSettings?.panelTitle === 'Settings' && report.enSettings?.panelCjk === 0,
  // ---- en 文档 + 菜单 ----
  'en:doc-copy':
    /^\d+ lines · \d+ rendered$/.test(report.enDoc?.statusRows ?? '') &&
    report.enDoc?.statusState === 'Read-only · source unchanged',
  'en:profile-copy': (report.enDoc?.profileText ?? '').length > 0,
  'en:ctx-menu':
    (report.enDoc?.ctxLabels ?? []).includes('Copy path') && report.enDoc?.ctxCjk === 0,
  // ---- worker 诊断英文 ----
  'en:repair-diagnostic':
    /^Repaired/.test(report.enRepair?.summary ?? '') &&
    (report.enRepair?.notes ?? []).length > 0 &&
    report.enRepair?.barCjk === 0,
  'en:pattern-diagnostic':
    /Invalid regular expression/.test(report.enPattern?.patternError ?? '') &&
    report.enPattern?.cjk === 0,
  // ---- 切 zh 即时生效 ----
  'zh:shell-switched':
    report.switchZh?.importText === 'Import' &&
    report.switchZh?.importAfter === '导入' &&
    report.switchZh?.htmlLang === 'zh-CN' &&
    report.switchZh?.locale?.locale === 'zh-CN',
  'zh:locale-persisted-setting': report.switchZh?.locale?.pref === 'zh-CN',
  'zh:panels-copy':
    report.switchZh?.panelTitle === '设置' &&
    (report.switchZh?.statusState ?? '').includes('只读 · 原文件不变') &&
    report.switchZh?.settingsLabel === '语言',
  'zh:status-theme': report.switchZh?.statusTheme === '深色',
  'zh:worker-diagnostic-rerendered':
    /^已修复/.test(report.switchZh?.repairSummary ?? '') && report.switchZh?.repairCjk >= 2,
  // ---- 持久化 + 覆盖 ----
  'persist:en-after-reload':
    report.reloaded?.htmlLang === 'en-US' &&
    report.reloaded?.importText === 'Import' &&
    report.reloaded?.statusRows === 'No document open' &&
    report.reloaded?.locale?.locale === 'en-US' &&
    report.reloaded?.locale?.pref === 'en-US',
  'override:pref-reset': report.overridePrep?.locale?.pref === 'en-US',
  'override:lang-wins':
    report.override?.htmlLang === 'zh-CN' &&
    report.override?.importText === '导入' &&
    report.override?.locale?.locale === 'zh-CN' &&
    report.override?.locale?.pref === 'en-US',
  // ---- 干净 ----
  'console:no-exception-no-error':
    report.consoleErrors?.length === 0 && report.consoleErrorLogs?.length === 0,
};

if (report.errors) console.log(`\nphase errors: ${JSON.stringify(report.errors, null, 2)}`);
for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? '✅' : '❌'} ${name}`);
const passed = Object.values(checks).filter(Boolean).length;
const total = Object.keys(checks).length;
console.log(`\nsmoke-i18n: ${passed}/${total} ${passed === total ? 'OK' : 'FAILED'}`);
if (passed !== total) {
  console.log('\n--- report ---');
  console.log(JSON.stringify(report, null, 2));
}
process.exitCode = passed === total ? 0 : 1;
