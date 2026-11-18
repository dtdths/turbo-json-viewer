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
    // 子树编辑弹层入场（#52）：遮罩淡入 + 面板淡入上浮（160ms / --dur）
    const backdrop = getComputedStyle(document.querySelector('#editModal .modal__backdrop'));
    const panel = getComputedStyle(document.querySelector('#editModal .modal__panel'));
    out.modalMotion = {
      backdrop: backdrop.animationName,
      panel: panel.animationName,
      duration: panel.animationDuration,
    };
    out.applyDisabled = document.getElementById('editApply')?.disabled ?? null;
    out.kindText = window.__smoke.text('editKind');
    out.pathText = window.__smoke.text('editPath');
    out.text = window.__tjv.editText();
    return out;
  })()`);
  Object.assign(report, phase1);
  await page.screenshot(path.join(SHOTS, 'edit-open.png'));

  // ---- phase 1b：#47 #3 双击不再进编辑（还给浏览器选词）；F2 / 右键菜单仍是入口 ----
  const phase1b = await page.eval(`(async () => {
    const out = {};
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__tjv.editClose();
    await sleep(120);
    const scroller = document.querySelector('.tjv-tree');
    const row = document.querySelector('.row[data-path="$.c"]');
    // 单击选中（行选中语义不变）
    row.click();
    await sleep(80);
    out.selectedAfterClick = window.__tjv.state().selected;
    // 双击：不再打开编辑弹层（监听已移除）；合成事件不触发浏览器默认选词，只断言「不弹层」
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }));
    await sleep(150);
    out.modalAfterDblClick = document.getElementById('editModal').hidden;
    // F2 仍是入口：选中行上按 F2 → 打开编辑器
    scroller.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true, cancelable: true }));
    await sleep(250);
    out.modalAfterF2 = document.getElementById('editModal').hidden;
    out.editPath = document.getElementById('editPath').textContent;
    window.__tjv.editClose();
    await sleep(120);
    // 右键菜单：编辑项右侧 F2 提示（aria-hidden 视觉提示 + 按钮 aria-keyshortcuts）
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 420, clientY: 320 }));
    await sleep(120);
    const item = document.querySelector('#ctxMenu [data-act="edit"]');
    out.menuOpen = !document.getElementById('ctxMenu').hidden;
    out.menuKey = item.querySelector('.ctxmenu__key')?.textContent ?? null;
    out.menuAria = item.getAttribute('aria-keyshortcuts');
    out.menuKeyHidden = item.querySelector('.ctxmenu__key')?.getAttribute('aria-hidden');
    out.menuWidth = Math.round(document.getElementById('ctxMenu').getBoundingClientRect().width);
    out.menuOverflow = item.scrollWidth > item.clientWidth;
    document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await sleep(80);
    // 还原现场：phase 2 起于「$.b 的编辑器已打开」（与 phase 1 结束时一致）
    await window.__tjv.editOpen('$.b');
    await sleep(200);
    return out;
  })()`);
  Object.assign(report, { phase1b });

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

  // ---- phase 6：无损数字（ADR-0020）：编辑器回填精确大整数 / no-op 不推版本 / 编辑后仍精确 ----
  const phase6 = await page.eval(`(async () => {
    const out = {};
    const { sleep } = window.__smoke;
    await window.__tjv.loadText('{"big":297532588187238660,"nested":{"uid":1234567890123456789}}', 'lossless-edit.json');
    await sleep(400);
    out.losslessLoad = window.__tjv.state();
    out.losslessOpen = await window.__tjv.editOpen('$.nested');
    out.losslessText = window.__tjv.editText();
    // no-op：把回填文本原样 Apply → 不推进版本、不记历史
    out.losslessNoop = await window.__tjv.editApplyText(out.losslessText);
    // 改值（仍是超大整数）→ 推进版本；导出仍是精确十进制（Apply 成功后弹层已关，需重新打开）
    await window.__tjv.editOpen('$.nested');
    out.losslessApplied = await window.__tjv.editApplyText('{"uid": 1234567890123456788}');
    out.losslessExport = await window.__tjv.exportDocText();
    await sleep(150);
    return out;
  })()`);
  Object.assign(report, phase6);
  await page.screenshot(path.join(SHOTS, 'edit-lossless.png'));

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
  'editor:enter-motion':
    report.modalMotion?.backdrop === 'tjv-fade-in' &&
    report.modalMotion?.panel === 'tjv-rise-in' &&
    report.modalMotion?.duration === '0.16s',
  'editor:opens-with-canonical-json':
    report.open?.open === true &&
    report.modalHidden === false &&
    report.kindText === 'array' &&
    report.pathText === '$.b' &&
    report.text === JSON.stringify([1, 2, 3], null, 2),
  // #47 #3：双击不再是编辑入口（还给浏览器选词）；F2 与右键菜单仍是入口，菜单项带 F2 提示
  'dblclick:not-edit-entry':
    report.phase1b?.selectedAfterClick === '$.c' && report.phase1b?.modalAfterDblClick === true,
  'f2:opens-editor': report.phase1b?.modalAfterF2 === false && report.phase1b?.editPath === '$.c',
  'menu:f2-hint':
    report.phase1b?.menuOpen === true &&
    report.phase1b?.menuKey === 'F2' &&
    report.phase1b?.menuAria === 'F2' &&
    report.phase1b?.menuKeyHidden === 'true' &&
    report.phase1b?.menuWidth === 176 &&
    report.phase1b?.menuOverflow === false,
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
  // ---- 无损数字（ADR-0020）：大整数在编辑弹层是精确十进制（不是字符串、不是圆整值）----
  'lossless:editor-shows-exact':
    report.losslessOpen?.open === true &&
    (report.losslessText ?? '').includes('1234567890123456789') &&
    !(report.losslessText ?? '').includes('"1234567890123456789"') &&
    !(report.losslessText ?? '').includes('1234567890123456768'),
  'lossless:noop-does-not-bump':
    report.losslessNoop?.docRevision === report.losslessLoad?.docRevision &&
    report.losslessNoop?.editCount === 0,
  'lossless:edit-keeps-exact':
    report.losslessApplied?.docRevision === (report.losslessLoad?.docRevision ?? 0) + 1 &&
    (report.losslessExport?.text ?? '').includes('"uid": 1234567890123456788') &&
    !(report.losslessExport?.text ?? '').includes('1234567890123456768'),

  'perf:no-long-task-no-console-error': report.maxLongTask < 100 && report.consoleErrors?.length === 0,
};

for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? '✅' : '❌'} ${name}`);
const ok = Object.values(checks).every(Boolean);
console.log(ok ? '\nsmoke-edit: OK' : '\nsmoke-edit: FAILED');
process.exitCode = ok ? 0 : 1;
