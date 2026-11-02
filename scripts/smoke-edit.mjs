/**
 * scripts/smoke-edit.mjs — 子树 JSON 编辑（slice 5 / #16 / ADR-0006）真机冒烟。
 *
 *   node build.mjs && node scripts/smoke-edit.mjs
 *
 * 测：getNodeJson 打开弹层（CM6 懒加载）→ Apply（数组扩元素/标量改值/对象改结构）→
 *     undo/redo/reset → 修改徽标 → UI Apply 按钮与 lint 禁用作 → PARSE 错误留在弹层 →
 *     搜索 stale → 导出文本与 `-edited` 文件名 → 0 长任务 / 0 console 错误。
 * 截图落 .spike/smoke/edit-*.png；走 HTTP + `window.__tjv`（同 smoke.mjs harness）。
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

  // ---- phase 1：加载小文档 + 打开编辑器（CM6 懒加载） ----
  const phase1 = await page.eval(`(async () => {
    const out = {};
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const longTasks = [];
    try {
      const po = new PerformanceObserver((list) => { for (const e of list.getEntries()) longTasks.push(Math.round(e.duration)); });
      po.observe({ entryTypes: ['longtask'] });
      out.hasLongTaskObserver = true;
    } catch (e) { out.hasLongTaskObserver = false; }
    window.__smoke = { sleep, longTasks, text: (id) => document.getElementById(id)?.textContent ?? '' };
    if (!window.__tjv) throw new Error('dev hook missing');

    await window.__tjv.loadText(JSON.stringify({ a: 1, b: [1, 2, 3], c: { d: true } }), 'edit.json');
    await sleep(300);
    out.loaded = window.__tjv.state();

    const opened = await window.__tjv.editOpen('$.b');
    out.open = opened;
    out.modalHidden = document.getElementById('editModal')?.hidden ?? null;
    out.applyDisabled = document.getElementById('editApply')?.disabled ?? null;
    out.kindText = window.__smoke.text('editKind');
    out.pathText = window.__smoke.text('editPath');
    out.text = window.__tjv.editText();
    return out;
  })()`);
  Object.assign(report, phase1);
  await page.screenshot(path.join(SHOTS, 'edit-open.png'));

  // ---- phase 2：Apply 数组扩元素 → undo → redo ----
  const phase2 = await page.eval(`(async () => {
    const out = {};
    const { sleep } = window.__smoke;
    // 数组加一个元素：8 → 9 行
    out.applied = await window.__tjv.editApplyText('[1, 2, 3, 4]');
    out.modalHiddenAfterApply = document.getElementById('editModal')?.hidden ?? null;
    out.badgeAfterApply = window.__tjv.editBadgeText();
    out.exportAfterApply = await window.__tjv.exportDocText();

    out.undo = await window.__tjv.undo();
    out.undoBadge = window.__tjv.editBadgeText();
    out.redo = await window.__tjv.redo();
    out.redoBadge = window.__tjv.editBadgeText();
    await sleep(150);
    return out;
  })()`);
  Object.assign(report, phase2);

  // ---- phase 3：UI Apply 按钮（改标量）+ lint 禁用 + PARSE 留层 ----
  const phase3 = await page.eval(`(async () => {
    const out = {};
    const { sleep } = window.__smoke;
    // 3a) UI 按钮路径：$ .a 改成 42
    await window.__tjv.editOpen('$.a');
    window.__tjv.editSetText('42');
    await sleep(350); // 等 JSON lint 生效
    out.uiApplyDisabledBefore = document.getElementById('editApply')?.disabled ?? null;
    out.beforeUiApply = window.__tjv.state();
    window.__tjv.editClickApply();
    await sleep(400);
    out.afterUiApply = { modalHidden: document.getElementById('editModal')?.hidden ?? null, ...window.__tjv.state() };
    out.exportAfterUiApply = await window.__tjv.exportDocText();

    // 3b) lint：非法 JSON → Apply 禁用 + 错误条
    await window.__tjv.editOpen('$.c');
    window.__tjv.editSetText('{"d": }');
    await sleep(400);
    out.lintApplyDisabled = document.getElementById('editApply')?.disabled ?? null;
    out.lintErrorHidden = document.getElementById('editError')?.hidden ?? null;
    out.lintDocRevision = window.__tjv.state().docRevision;
    // 3c) 合法但结构变化：{d,e} → 10 行
    out.appliedC = await window.__tjv.editApplyText('{"d": true, "e": 2}');
    out.exportAfterC = await window.__tjv.exportDocText();
    await sleep(150);
    return out;
  })()`);
  Object.assign(report, phase3);
  await page.screenshot(path.join(SHOTS, 'edit-applied.png'));

  // ---- phase 4：PARSE 错误（直接走 app 通道）留层 + 搜索 stale ----
  const phase4 = await page.eval(`(async () => {
    const out = {};
    const { sleep } = window.__smoke;
    // 搜索只匹配键名与字符串值（core/search.ts）：用键名 'b' 造命中
    out.searchBefore = await window.__tjv.search('b');
    // 故意非法 JSON 走 applyEditText：core 抛 PARSE → app setError → 弹层不关
    await window.__tjv.editOpen('$.c');
    out.parseResult = await window.__tjv.editApplyText('{"d": }');
    out.parseErrorText = window.__smoke.text('editError');
    out.parseErrorHidden = document.getElementById('editError')?.hidden ?? null;
    await window.__tjv.editClose();
    await sleep(100);
    // 合法编辑后搜索应 stale
    out.beforeStale = window.__tjv.searchPanel();
    await window.__tjv.editOpen('$.c');
    out.afterValidEdit = await window.__tjv.editApplyText('{"d": true, "e": 2, "f": 3}');
    out.searchAfter = window.__tjv.searchPanel();
    await sleep(150);
    return out;
  })()`);
  Object.assign(report, phase4);

  // ---- phase 5：reset 全部 + 导出（无 -edited） ----
  const phase5 = await page.eval(`(async () => {
    const out = {};
    const { sleep } = window.__smoke;
    out.reset = await window.__tjv.resetEdits();
    out.badgeAfterReset = window.__tjv.editBadgeText();
    out.exportAfterReset = await window.__tjv.exportDocText();
    out.undoAfterReset = await window.__tjv.undo();
    await sleep(150);
    return out;
  })()`);
  Object.assign(report, phase5);
  await page.screenshot(path.join(SHOTS, 'edit-reset.png'));

  report.longTasks = await page.eval('window.__smoke?.longTasks ?? []');
  report.maxLongTask = report.longTasks.length ? Math.max(...report.longTasks) : 0;
  report.consoleErrors = page.exceptions.slice(errorsBefore);
} finally {
  await chrome.close();
  await server.close();
}

console.log(JSON.stringify(report, null, 2));

const baseRows = 8;
const canon = JSON.stringify({ a: 1, b: [1, 2, 3], c: { d: true } }, null, 2);

const checks = {
  'load:small-doc': report.loaded?.totalRows === baseRows,
  'editor:opens-with-canonical-json':
    report.open?.open === true &&
    report.modalHidden === false &&
    report.kindText === 'array' &&
    report.pathText === '$.b' &&
    report.text === JSON.stringify([1, 2, 3], null, 2),
  'apply:array-element': 
    report.applied?.totalRows === baseRows + 1 &&
    report.applied?.editCount === 1 &&
    report.modalHiddenAfterApply === true &&
    report.badgeAfterApply?.hidden === false &&
    report.badgeAfterApply?.text === '已修改 1 处',
  'apply:export-contains-new-value': /"b": \[\n\s+1,\n\s+2,\n\s+3,\n\s+4\n\s+\]/.test(report.exportAfterApply?.text ?? ''),
  'undo:back-to-base': report.undo?.totalRows === baseRows && report.undo?.editCount === 0,
  'redo:reapplied': report.redo?.totalRows === baseRows + 1 && report.redo?.editCount === 1,
  'ui-apply:scalar-changed':
    report.uiApplyDisabledBefore === false &&
    report.afterUiApply?.modalHidden === true &&
    report.afterUiApply?.docRevision === (report.beforeUiApply?.docRevision ?? -1) + 1 &&
    /"a": 42/.test(report.exportAfterUiApply?.text ?? ''),
  'lint:invalid-json-blocks-apply':
    report.lintApplyDisabled === true &&
    report.lintErrorHidden === false &&
    report.lintDocRevision === report.afterUiApply?.docRevision,
  'apply:object-structure': 
    report.appliedC?.totalRows === baseRows + 2 &&
    /"e": 2/.test(report.exportAfterC?.text ?? ''),
  'parse:error-keeps-layer': 
    report.parseResult?.open === true &&
    report.parseErrorHidden === false &&
    /Unexpected|Expected|JSON/i.test(report.parseErrorText ?? ''),
  'search:stale-after-edit': 
    (report.searchBefore?.size ?? 0) > 0 &&
    report.beforeStale?.stale === false &&
    report.searchAfter?.stale === true,
  'reset:clears-edits':
    report.reset?.totalRows === baseRows &&
    report.reset?.editCount === 0 &&
    report.badgeAfterReset?.hidden === true &&
    report.undoAfterReset?.ok === false,
  'export:name-and-content': 
    report.exportAfterApply?.name === 'edit-edited.json' &&
    report.exportAfterReset?.name === 'edit.json' &&
    report.exportAfterReset?.text === canon,
  'perf:no-long-task-no-console-error': report.maxLongTask < 100 && report.consoleErrors?.length === 0,
};

for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? '✅' : '❌'} ${name}`);
const ok = Object.values(checks).every(Boolean);
console.log(ok ? '\nsmoke-edit: OK' : '\nsmoke-edit: FAILED');
process.exitCode = ok ? 0 : 1;
