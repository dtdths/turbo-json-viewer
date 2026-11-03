/**
 * scripts/smoke-repair.mjs — 截断 JSON 修复（#8 / ADR-0004 修订）真机冒烟。
 *
 *   node build.mjs && node scripts/smoke-repair.mjs
 *
 * 测：
 *   1) 空态导入「非 EOF 形态」非法 JSON → 导入层报 PARSE、不产生修复痕迹；
 *   2) 合法 JSON → 无修复条、状态栏无角标、导出名不带后缀；
 *   3) 截断 JSON → 修复条出现（32px、role=status、文案含「仅语法闭合」+ provenance counts）、
 *      值图 = 修复后的值、状态栏「已修复截断」、导出名带 `-truncated-repaired`；
 *   4) 摘要展开/收起（ops 逐条）与关闭只隐藏条（角标/导出后缀保留）；
 *   5) 重新导入合法文档 → 修复条消失、状态归零；
 *   6) 0 page 异常 / 0 console error。
 * 截图落 .spike/smoke/repair-{bar,summary,closed}.png；走 HTTP + `window.__tjv`（同 smoke-edit harness）。
 */
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { launchChrome, REPO_ROOT } from '../prototype/p1/lib/chrome.mjs';
import { startStaticServer } from '../prototype/p1/lib/http.mjs';

const SHOTS = path.join(REPO_ROOT, '.spike', 'smoke');
await mkdir(SHOTS, { recursive: true });

const VALID = JSON.stringify({ a: 1, b: { c: [1, 2] } });
const VALID2 = JSON.stringify({ x: [1, 2, 3], y: 'ok' });
const TRUNCATED = '{"a":1,"b":"hello wor'; // 补 1 个结束引号 + 1 个 `}`
const TRUNCATED_LEN = TRUNCATED.length;

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

  const runPhase = async (name, expression) => {
    try {
      Object.assign(report, (await page.eval(expression)) ?? {});
    } catch (error) {
      if (!report.errors) report.errors = {};
      report.errors[name] = String(error?.message ?? error);
      console.warn(`⚠️ phase ${name} failed: ${String(error?.message ?? error)}`);
    }
  };

  // ---- phase 1：空态 → 非 EOF 形态错误（不可修复，只报错） ----
  await runPhase(
    'unrepairable',
    `(async () => {
      const out = {};
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const err = document.getElementById('emptyError');
      await window.__tjv.loadText('{"a":1}XYZ', 'broken.json').catch(() => {});
      await sleep(250);
      out.unrepairable = {
        layerError: err?.textContent ?? '',
        layerErrorHidden: err?.hidden ?? null,
        emptyVisible: !document.getElementById('empty')?.classList.contains('is-hidden'),
        repair: window.__tjv.repairState(),
      };
      return out;
    })()`,
  );

  // ---- phase 2：合法 JSON → 无修复 ----
  await runPhase(
    'valid',
    `(async () => {
      const out = {};
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      await window.__tjv.loadText(${JSON.stringify(VALID)}, 'ok.json');
      await sleep(350);
      out.valid = { repair: window.__tjv.repairState(), state: window.__tjv.state() };
      return out;
    })()`,
  );

  // ---- phase 3：截断 JSON → 修复条 + 值图 + 角标 + 导出后缀 ----
  await runPhase(
    'repaired',
    `(async () => {
      const out = {};
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      await window.__tjv.loadText(${JSON.stringify(TRUNCATED)}, 'cut.json');
      await sleep(450);
      const bar = document.getElementById('repairBar');
      const rect = bar.getBoundingClientRect();
      out.repaired = {
        repair: window.__tjv.repairState(),
        state: window.__tjv.state(),
        bar: {
          hidden: bar.hidden,
          height: Math.round(rect.height),
          role: bar.getAttribute('role'),
          live: bar.getAttribute('aria-live'),
        },
        rowText: [...document.querySelectorAll('.row[data-path]')]
          .map((row) => row.textContent ?? '')
          .join('|'),
      };
      return out;
    })()`,
  );
  await page.screenshot(path.join(SHOTS, 'repair-bar.png'));

  // ---- phase 4：摘要展开（截图时保持展开，再单独收起） ----
  await runPhase(
    'summary-open',
    `(async () => {
      const out = {};
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const expanded = window.__tjv.repairToggle();
      await sleep(150);
      out.summaryOpen = {
        expanded,
        state: window.__tjv.repairState(),
        opRows: [...document.querySelectorAll('.repairbar__op')].map((n) => n.textContent ?? ''),
        opsHidden: document.getElementById('repairOps')?.hidden ?? null,
      };
      return out;
    })()`,
  );
  await page.screenshot(path.join(SHOTS, 'repair-summary.png'));

  // ---- phase 4.5：摘要收起 ----
  await runPhase(
    'summary-close',
    `(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const collapsed = window.__tjv.repairToggle();
      await sleep(100);
      return { summaryClosed: { collapsed, hidden: document.getElementById('repairOps')?.hidden ?? null } };
    })()`,
  );

  // ---- phase 5：关闭提示条（provenance 保留） ----
  await runPhase(
    'closed',
    `(async () => {
      const out = {};
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const closed = window.__tjv.repairClose();
      await sleep(120);
      out.closed = { closed, state: window.__tjv.repairState() };
      return out;
    })()`,
  );
  await page.screenshot(path.join(SHOTS, 'repair-closed.png'));

  // ---- phase 6：重新导入合法文档 → 修复痕迹清空 ----
  await runPhase(
    'reload',
    `(async () => {
      const out = {};
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      await window.__tjv.loadText(${JSON.stringify(VALID2)}, 'ok2.json');
      await sleep(400);
      out.reloaded = window.__tjv.repairState();
      return out;
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

const checks = {
  // 空态不可修复：导入层显示 PARSE、没有修复痕迹
  'unrepairable:layer-error':
    /PARSE/.test(report.unrepairable?.layerError ?? '') &&
    report.unrepairable?.layerErrorHidden === false &&
    report.unrepairable?.emptyVisible === true,
  'unrepairable:no-repair':
    (report.unrepairable?.repair?.status ?? 'none') === 'none' &&
    report.unrepairable?.repair?.visible === false,

  // 合法文档不产生修复痕迹
  'valid:no-repair':
    report.valid?.repair?.status === 'none' &&
    report.valid?.repair?.visible === false &&
    report.valid?.repair?.exportName === 'ok.json' &&
    (report.valid?.repair?.statusState ?? '') === '只读 · 原文件不变',

  // 截断修复：条可见、文案、计数、导出后缀
  'repair:bar-visible':
    report.repaired?.repair?.status === 'repaired' && report.repaired?.repair?.visible === true,
  'repair:bar-shape-32':
    report.repaired?.bar?.hidden === false &&
    report.repaired?.bar?.height === 32 &&
    report.repaired?.bar?.role === 'status' &&
    report.repaired?.bar?.live === 'polite',
  'repair:summary-and-counts':
    (report.repaired?.repair?.text ?? '').includes('仅语法闭合') &&
    (report.repaired?.repair?.summary ?? '').includes('仅语法闭合') &&
    report.repaired?.repair?.counts?.brackets === 1 &&
    report.repaired?.repair?.counts?.quotes === 1 &&
    report.repaired?.repair?.truncatedAt === TRUNCATED_LEN,
  'repair:ops-present': (report.repaired?.repair?.ops ?? []).length >= 1,
  'repair:status-badge': (report.repaired?.repair?.statusState ?? '').includes('已修复截断'),
  'repair:export-name':
    report.repaired?.repair?.exportName === 'cut-truncated-repaired.json',
  // 值图 = 修复后的值（树里能看到被闭合的字符串内容）
  'repair:value-graph':
    // 修复后值图 = { a:1, b:"hello wor" }，自适应展开后 3 个节点（root + a + b）
    (report.repaired?.rowText ?? '').includes('hello wor') &&
    (report.repaired?.state?.totalRows ?? 0) === 3,

  // 摘要展开/收起
  'repair:summary-toggle':
    report.summaryOpen?.expanded === true &&
    report.summaryOpen?.opsHidden === false &&
    (report.summaryOpen?.opRows ?? []).length === (report.summaryOpen?.state?.ops ?? []).length &&
    (report.summaryOpen?.opRows ?? []).every((text) => text.length > 0) &&
    report.summaryClosed?.collapsed === false &&
    report.summaryClosed?.hidden === true,

  // 关闭只隐藏条：角标与导出后缀保留
  'repair:close-keeps-provenance':
    report.closed?.closed === true &&
    report.closed?.state?.visible === false &&
    report.closed?.state?.status === 'repaired' &&
    (report.closed?.state?.statusState ?? '').includes('已修复截断') &&
    report.closed?.state?.exportName === 'cut-truncated-repaired.json',

  // 重新导入合法文档 → 清空
  'reload:cleared':
    report.reloaded?.status === 'none' &&
    report.reloaded?.visible === false &&
    report.reloaded?.exportName === 'ok2.json' &&
    !(report.reloaded?.statusState ?? '').includes('已修复截断'),

  'console:no-exception-no-error':
    report.consoleErrors?.length === 0 && report.consoleErrorLogs?.length === 0,
};

if (report.errors) console.log(`\nphase errors: ${JSON.stringify(report.errors, null, 2)}`);
for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? '✅' : '❌'} ${name}`);
const passed = Object.values(checks).filter(Boolean).length;
const total = Object.keys(checks).length;
console.log(`\nsmoke-repair: ${passed}/${total} ${passed === total ? 'OK' : 'FAILED'}`);
process.exitCode = passed === total ? 0 : 1;
