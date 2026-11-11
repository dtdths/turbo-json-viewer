/**
 * scripts/smoke-fidelity.mjs — 「保真提示」真机冒烟（#23 / ADR-0003 修订 2026-11-09）。
 *
 *   node build.mjs && node scripts/smoke-fidelity.mjs
 *
 * 测：
 *   1) 精确数量：构造失真 fixture → 条可见、文案「4 处失真（大整数精度 3 处 · 整数键顺序 1 处）」、
 *      高精度小数 / 19 位但可精确表示 / 字符串里的数字 **都不算**。
 *   2) 跳原文：点「查看原文」→ 切原文视图 + flash 行 = rawLocate(hits[0].offset).line + 该行含失真字面量。
 *   3) 无失真文档 → 条不出现、jump 隐藏。
 *   4) 关闭只关条：hidden=true 但报告仍在（status 仍 'found'）。
 *   5) 与修复条并存：截断 + 大整数失真 → 两条都可见且修复条在上（y 更小）。
 *   6) 首帧不回归：10MB 导入 → 首行 < 800ms；扫描在首帧之后（不阻塞），0 长任务 / 0 console error。
 *
 * 截图落 .spike/smoke/fidelity-*.png。走 HTTP + `window.__tjv`，与 scripts/smoke-expand.mjs 同一 harness。
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { launchChrome, REPO_ROOT } from '../prototype/p1/lib/chrome.mjs';
import { startStaticServer } from '../prototype/p1/lib/http.mjs';

const SHOTS = path.join(REPO_ROOT, '.spike', 'smoke');
await mkdir(SHOTS, { recursive: true });

/** 失真 fixture：pretty 打印，行号固定，便于断言 flash 行。 */
const DIRTY = `{
  "big": 1234567890123456789,
  "exp": 1234567890123456789e0,
  "exact": 1000000000000000000,
  "over": 1e400,
  "under": 1e-400,
  "str": "1234567890123456789",
  "dec": 0.1234567890123456789,
  "dupKeys": {
    "1": "a",
    "2": "b",
    "1": "c"
  },
  "reorder": {
    "2": "a",
    "b": "c",
    "1": "d"
  },
  "fine": {
    "1": "a",
    "2": "b",
    "c": "d"
  }
}`;
/** `big` 字面量所在行（1-based） */
const BIG_LINE = 2;
/** 截断 + 大整数失真：验证与修复条并存 */
const TRUNCATED_DIRTY = '{"big":1234567890123456789,"s":"cut tex';

const server = await startStaticServer(REPO_ROOT);
const chrome = await launchChrome({ windowSize: '1440,900' });
const report = {};
const checks = [];

function check(name, pass, detail) {
  checks.push({ name, pass: Boolean(pass), detail });
}

try {
  const page = await chrome.openPage();
  const errorsBefore = page.exceptions.length;
  const logsBefore = page.logs.length;
  await page.setViewport(1440, 900);
  await page.goto(`${server.base}/dist/page.html`, { timeoutMs: 20000 });
  await page.waitFor('document.readyState === "complete"', { timeoutMs: 10000 });
  await new Promise((r) => setTimeout(r, 400));

  // ---- phase 1：装长任务观察器 + 失真文档 ----
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
    const rows = () => [...document.querySelectorAll('.row[data-path]')].filter((el) => !el.hidden);
    const waitFirstRow = async (timeout = 20000) => {
      const t0 = performance.now();
      while (performance.now() - t0 < timeout) {
        if (rows().length > 0) return Math.round(performance.now() - t0);
        await sleep(8);
      }
      return null;
    };
    /** 等扫描结束（pending=false 且 status 非 null） */
    const waitFidelity = async (timeout = 10000) => {
      const t0 = performance.now();
      while (performance.now() - t0 < timeout) {
        const s = window.__tjv.fidelityState();
        if (s.pending === false && s.status !== null) return s;
        await sleep(20);
      }
      return window.__tjv.fidelityState();
    };
    window.__fid = { sleep, rows, waitFirstRow, waitFidelity, longTasks };

    out.hooks = ['fidelityState', 'fidelityJump', 'fidelityClose', 'loadText', 'rawLocate', 'rawState']
      .filter((k) => typeof window.__tjv[k] === 'function');
    out.missingHooks = ['fidelityState', 'fidelityJump', 'fidelityClose', 'loadText', 'rawLocate', 'rawState']
      .filter((k) => typeof window.__tjv[k] !== 'function');

    const tLoad = performance.now();
    await window.__tjv.loadText(${JSON.stringify(DIRTY)}, 'fidelity-dirty.json');
    out.firstRowMs = await waitFirstRow(10000);
    out.loadMs = Math.round(performance.now() - tLoad);
    out.rowsAfterLoad = window.__tjv.state().totalRows;
    out.dirty = await waitFidelity(10000);
    out.barVisibleBefore = out.dirty.barVisible;
    out.longTasks = longTasks.slice();
    return out;
  })()`);
  report.dirty = phase1;
  await page.screenshot(path.join(SHOTS, 'fidelity-bar.png'));

  check('setup:dev-hook', phase1.missingHooks.length === 0, { missing: phase1.missingHooks, hooks: phase1.hooks });
  check('setup:longtask-observer', phase1.hasLongTaskObserver === true, { observer: phase1.hasLongTaskObserver });
  const d = phase1.dirty || {};
  check(
    'dirty:exact-counts',
    d.status === 'found' &&
      d.counts?.total === 5 &&
      d.counts?.number === 4 &&
      d.counts?.precision === 2 &&
      d.counts?.overflow === 1 &&
      d.counts?.underflow === 1 &&
      d.counts?.keyOrder === 1,
    {
      status: d.status,
      counts: d.counts,
      expect: { total: 5, number: 4, precision: 2, overflow: 1, underflow: 1, keyOrder: 1 },
      note: 'big+exp=precision / over=overflow / under=underflow；exact、dec、str 内数字、重复整数键 dupKeys 都不报',
    },
  );
  check(
    'dirty:bar-and-text',
    d.barVisible === true &&
      d.jumpVisible === true &&
      String(d.barText || '').includes('5 处失真') &&
      String(d.barText || '').includes('大整数精度 2 处') &&
      String(d.barText || '').includes('数字上溢 1 处') &&
      String(d.barText || '').includes('数字下溢 1 处') &&
      String(d.barText || '').includes('整数键顺序 1 处'),
    { barVisible: d.barVisible, jumpVisible: d.jumpVisible, barText: d.barText },
  );
  check(
    'dirty:hits-order-and-fields',
    Array.isArray(d.hits) &&
      d.hits.length === 5 &&
      d.hits[0]?.kind === 'number' &&
      d.hits[0]?.reason === 'precision' &&
      d.hits[1]?.reason === 'precision' &&
      d.hits[2]?.reason === 'overflow' &&
      d.hits[3]?.reason === 'underflow' &&
      d.hits[4]?.kind === 'key-order' &&
      d.hits.every((h) => typeof h.offset === 'number' && h.snippet.length <= 48) &&
      d.hits[0].literal === '1234567890123456789' &&
      d.hits[0].parsed === '1234567890123456768',
    { hits: (d.hits || []).map((h) => ({ kind: h.kind, reason: h.reason, offset: h.offset, literal: h.literal, parsed: h.parsed })) },
  );

  // ---- phase 2：点「查看原文」→ 切原文 + flash 到第一个失真的行 ----
  const phase2 = await page.eval(`(async () => {
    const out = {};
    const { sleep } = window.__fid;
    const s = window.__tjv.fidelityState();
    const hit = s.hits && s.hits[0];
    out.hit = hit || null;
    out.locate = hit ? await window.__tjv.rawLocate(hit.offset) : null;
    out.jump = await window.__tjv.fidelityJump();
    await sleep(150);
    out.after = window.__tjv.fidelityState();
    // 精确差异提示（#31 / ADR-0003 修订 2026-11-11 晚）
    out.status = document.getElementById('statusState')?.textContent ?? '';
    return out;
  })()`);
  report.jump = phase2;
  await page.screenshot(path.join(SHOTS, 'fidelity-jump.png'));
  const jump = phase2.jump || {};
  const flashLine = jump.flash === null || jump.flash === undefined ? null : Number(jump.flash);
  const flashText = (jump.lines || []).find((l) => l.line === flashLine)?.text ?? '';
  check('jump:raw-view', jump.mode === 'raw', { mode: jump.mode, view: jump.view });
  check('jump:flash-line', Number.isFinite(flashLine) && flashLine === phase2.locate?.line, {
    flashLine,
    locateLine: phase2.locate?.line,
    hitOffset: phase2.hit?.offset,
  });
  check('jump:flash-line-is-first-hit-line', flashLine === BIG_LINE, { flashLine, expectLine: BIG_LINE });
  check('jump:line-contains-literal', flashText.includes('1234567890123456789'), { flashText: String(flashText).slice(0, 80) });
  check('jump:bar-kept', phase2.after?.barVisible === true, { barVisible: phase2.after?.barVisible });

  // ---- phase 2b：痛点闭环（#30 / ADR-0019）：查看原文 → 原文→树选中 → 树→原文锚点回跳 ----
  const phase2b = await page.eval(`(async () => {
    const out = {};
    const { sleep } = window.__fid;
    const row = document.querySelector('.raw-row[data-line="2"]');
    const button = row && row.querySelector('.raw-row__locate');
    out.gutter = Boolean(button && !button.hidden);
    // 原文 → 树（真实 DOM click）：应切树并选中 $.big
    out.toTree = await window.__tjv.rawLocateClick(2);
    await sleep(150);
    out.state = window.__tjv.state();
    out.anchor = window.__tjv.locateState();
    // 树 → 原文（行尾浮条第三钮）：锚点记忆 → 直接落回第 2 行
    out.toRaw = await window.__tjv.treeLocateClick('$.big');
    await sleep(150);
    out.afterBack = window.__tjv.rawState();
    return out;
  })()`);
  report.locate = phase2b;
  await page.screenshot(path.join(SHOTS, 'fidelity-locate.png'));
  check('locate:gutter-button', phase2b.gutter === true, { gutter: phase2b.gutter });
  check(
    'locate:raw-to-tree',
    phase2b.toTree?.clicked === true && phase2b.state?.selected === '$.big' && phase2b.state?.viewMode === 'tree',
    { clicked: phase2b.toTree?.clicked, selected: phase2b.state?.selected, viewMode: phase2b.state?.viewMode },
  );
  check('locate:anchor-recorded', phase2b.anchor?.anchor?.path === '$.big' && phase2b.anchor?.anchor?.line === 2, {
    anchor: phase2b.anchor?.anchor,
  });
  check(
    'locate:tree-to-raw-anchor',
    phase2b.toRaw?.clicked === true && phase2b.afterBack?.mode === 'raw' && Number(phase2b.afterBack?.flash) === 2,
    { clicked: phase2b.toRaw?.clicked, mode: phase2b.afterBack?.mode, flash: phase2b.afterBack?.flash },
  );

  // ---- phase 2c：多命中导航（#31 / ADR-0003 修订 2026-11-11 晚）：‹ 1/5 › + 精确差异状态栏 ----
  const phase2c = await page.eval(`(async () => {
    const out = {};
    const { sleep } = window.__fid;
    const h = window.__tjv;
    const cnt = () => document.getElementById('fidelityCount')?.textContent ?? '';
    const prev = () => document.getElementById('fidelityPrev');
    const next = () => document.getElementById('fidelityNext');
    const status = () => document.getElementById('statusState')?.textContent ?? '';
    out.navVisible =
      !next().hidden && !prev().hidden && !document.getElementById('fidelityCount').hidden;
    out.initial = { counter: cnt(), prevDisabled: prev().disabled, nextDisabled: next().disabled };
    out.hits = h.fidelityState().hits;
    // 逐条期望行号（offset → rawLocate）
    out.expected = [];
    for (const hit of out.hits) {
      const located = await h.rawLocate(hit.offset);
      out.expected.push(located ? located.line : null);
    }
    out.steps = [];
    for (let k = 0; k < 4; k++) {
      next().click();
      await sleep(320);
      out.steps.push({
        counter: cnt(),
        flash: h.rawState().flash,
        prevDisabled: prev().disabled,
        nextDisabled: next().disabled,
        status: status(),
      });
    }
    out.atLast = { counter: cnt(), nextDisabled: next().disabled, status: status(), flash: h.rawState().flash };
    prev().click();
    await sleep(320);
    out.afterPrev = { counter: cnt(), flash: h.rawState().flash, status: status() };
    out.final = h.fidelityState();
    return { fidNav: out };
  })()`);
  report.nav = phase2c.fidNav;
  await page.screenshot(path.join(SHOTS, 'fidelity-nav.png'));
  const nav = phase2c.fidNav || {};
  const navSteps = nav.steps || [];
  const expectedLines = nav.expected || [];
  check(
    'nav:visible-and-counter',
    nav.navVisible === true && nav.initial?.counter === '1/5' && nav.initial?.prevDisabled === true && nav.initial?.nextDisabled === false,
    { navVisible: nav.navVisible, initial: nav.initial },
  );
  check(
    'nav:next-steps-jump-lines',
    navSteps.length === 4 &&
      JSON.stringify(navSteps.map((s) => s.counter)) === JSON.stringify(['2/5', '3/5', '4/5', '5/5']) &&
      navSteps.every((s, k) => Number(s.flash) === expectedLines[k + 1]),
    { counters: navSteps.map((s) => s.counter), flashes: navSteps.map((s) => s.flash), expectedLines },
  );
  check(
    'nav:last-disables-next',
    nav.atLast?.counter === '5/5' && nav.atLast?.nextDisabled === true && /键顺序/.test(nav.atLast?.status ?? ''),
    { atLast: nav.atLast },
  );
  check(
    'nav:prev-back',
    nav.afterPrev?.counter === '4/5' && Number(nav.afterPrev?.flash) === expectedLines[3] && /下溢/.test(nav.afterPrev?.status ?? ''),
    { afterPrev: nav.afterPrev, expectFlash: expectedLines[3] },
  );
  check(
    'exact:status-explains-precision',
    /→/.test(phase2?.status ?? '') && (phase2?.status ?? '').includes('1234567890123456768'),
    { status: phase2?.status },
  );

  // ---- phase 3：无失真文档 → 条不出现 ----
  const phase3 = await page.eval(`(async () => {
    const out = {};
    await window.__tjv.loadText('{"a":1,"b":[1,2,3],"c":{"d":true}}', 'clean.json');
    out.clean = await window.__fid.waitFidelity(10000);
    out.rows = window.__tjv.state().totalRows;
    return out;
  })()`);
  report.clean = phase3;
  await page.screenshot(path.join(SHOTS, 'fidelity-clean.png'));
  check(
    'clean:no-bar',
    phase3.clean?.status === 'none' && phase3.clean?.counts?.total === 0 && phase3.clean?.barVisible === false && phase3.clean?.jumpVisible === false,
    { status: phase3.clean?.status, counts: phase3.clean?.counts, barVisible: phase3.clean?.barVisible },
  );

  // ---- phase 4：关闭只关条（报告保留） ----
  const phase4 = await page.eval(`(async () => {
    const out = {};
    await window.__tjv.loadText(${JSON.stringify(DIRTY)}, 'fidelity-dirty2.json');
    out.before = await window.__fid.waitFidelity(10000);
    out.closed = window.__tjv.fidelityClose();
    out.after = window.__tjv.fidelityState();
    return out;
  })()`);
  report.close = phase4;
  check(
    'close:hides-bar-keeps-report',
    phase4.before?.barVisible === true && phase4.closed === true && phase4.after?.barVisible === false && phase4.after?.status === 'found' && phase4.after?.counts?.total === 5,
    { closed: phase4.closed, barVisible: phase4.after?.barVisible, status: phase4.after?.status },
  );

  // ---- phase 5：与修复条并存（截断 + 失真）→ 两条都可见，修复条在上 ----
  const phase5 = await page.eval(`(async () => {
    const out = {};
    await window.__tjv.loadText(${JSON.stringify(TRUNCATED_DIRTY)}, 'fidelity-trunc.json');
    await window.__fid.waitFirstRow(10000);
    out.fidelity = await window.__fid.waitFidelity(10000);
    out.repair = window.__tjv.repairState();
    const r = document.getElementById('repairBar').getBoundingClientRect();
    const f = document.getElementById('fidelityBar').getBoundingClientRect();
    out.layout = { repairTop: Math.round(r.top), fidelityTop: Math.round(f.top), repairH: Math.round(r.height), fidelityH: Math.round(f.height) };
    return out;
  })()`);
  report.coexist = phase5;
  await page.screenshot(path.join(SHOTS, 'fidelity-coexist.png'));
  check(
    'coexist:both-bars',
    phase5.repair?.visible === true && phase5.fidelity?.barVisible === true && phase5.fidelity?.counts?.total >= 1,
    { repairVisible: phase5.repair?.visible, fidelityVisible: phase5.fidelity?.barVisible, counts: phase5.fidelity?.counts },
  );
  check(
    'coexist:repair-above-fidelity',
    phase5.layout?.repairTop < phase5.layout?.fidelityTop && phase5.layout?.repairH === 32 && phase5.layout?.fidelityH === 32,
    phase5.layout,
  );

  // ---- phase 6：10MB 首帧不回归 + 扫描不阻塞主线程 ----
  const phase6 = await page.eval(`(async () => {
    const out = {};
    const { sleep } = window.__fid;
    window.__fid.longTasks.length = 0;
    const text = await (await fetch('/.spike/samples/10mb.json')).text();
    const t0 = performance.now();
    await window.__tjv.loadText(text, '10mb.json');
    out.firstRowMs = await window.__fid.waitFirstRow(15000);
    out.loadMs = Math.round(performance.now() - t0);
    out.rows = window.__tjv.state().totalRows;
    // 扫描在首帧之后：等它结束（10MB ≈ 数十 ms）
    out.fidelity = await window.__fid.waitFidelity(10000);
    out.longTasks = window.__fid.longTasks.slice();
    return out;
  })()`);
  report.big = phase6;
  await page.screenshot(path.join(SHOTS, 'fidelity-10mb.png'));

  check('10mb:first-row<800ms', phase6.firstRowMs !== null && phase6.firstRowMs < 800, { firstRowMs: phase6.firstRowMs, loadMs: phase6.loadMs });
  check('10mb:fidelity-scanned', phase6.fidelity?.status === 'none' || phase6.fidelity?.status === 'found', {
    status: phase6.fidelity?.status,
    scanMs: phase6.fidelity?.scanMs,
    counts: phase6.fidelity?.counts,
  });
  check('10mb:no-long-task', (phase6.longTasks || []).every((t) => t < 50), { longTasks: phase6.longTasks });

  // ---- 汇总：page 异常 / console error ----
  const exceptions = page.exceptions.slice(errorsBefore);
  const consoleErrors = page.logs
    .slice(logsBefore)
    .filter((entry) => entry.type === 'error')
    .map((entry) => entry.text);
  report.consoleErrors = exceptions;
  report.consoleErrorLogs = consoleErrors;
  check('page:no-exceptions', exceptions.length === 0, { exceptions });
  check('page:no-console-error', consoleErrors.length === 0, { consoleErrors });

  for (const shot of ['fidelity-bar.png', 'fidelity-jump.png', 'fidelity-locate.png', 'fidelity-nav.png', 'fidelity-clean.png', 'fidelity-coexist.png', 'fidelity-10mb.png']) {
    const file = path.join(SHOTS, shot);
    check('screenshot:' + shot, existsSync(file), { path: file });
  }
} catch (error) {
  report.fatal = String((error && error.stack) || error);
  check('fatal', false, { error: report.fatal });
} finally {
  try {
    await chrome.close();
  } catch {}
  try {
    await server.close();
  } catch {}
}

console.log(JSON.stringify(report, null, 2));
const width = Math.min(58, Math.max(...checks.map((c) => c.name.length), 4));
for (const c of checks) {
  console.log(`${c.pass ? '✅' : '❌'} ${c.name.padEnd(width)}  ${c.detail === undefined ? '' : JSON.stringify(c.detail)}`);
}
const passed = checks.filter((c) => c.pass).length;
const failed = checks.length - passed;
console.log(`\nsmoke-fidelity: ${failed === 0 ? 'OK' : 'FAILED'}  (${passed}/${checks.length} checks, ${failed} failed)`);
process.exitCode = failed === 0 ? 0 : 1;
