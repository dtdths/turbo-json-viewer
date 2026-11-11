/**
 * scripts/smoke-expression.mjs — 「表达式视图」真机冒烟（#27 / ADR-0018）。
 *
 *   node build.mjs && node scripts/smoke-expression.mjs
 *
 * 测（14 套里的第 14 套；ADR-0018 §8 的 DOM 契约 + §9 dev hook）：
 *   1) 模式入口：活动栏第 4 个模式按钮打开左面板（标题/aria/示例 2 条通用/CM6 懒加载/执行按钮）；
 *   2) 执行：filter+map 表达式 → 结果根 expr:N、结果条「表达式结果 · expr:1」、状态行「N 项 · X ms」、
 *      结果行引用原值（导出 JSON 逐字比对）；历史入栈；
 *   3) 补全：根字段 / `Math.` / 数组方法（worker 数据源）；
 *   4) 严格模式：元素内部缺字段 → 关闭时跳过并报「已跳过 N 项」；开启时报错；根级缺字段始终报错 + 纠错候选；
 *   5) 行内错误：语法错误显示位置（第 L 行第 C 列），结果条保持；
 *   6) 跳回原文档：点结果行 → 回文档树 + 选中原路径（worker 侧映射）；
 *   7) 导出/复制：结果视图下导出 = 结果 JSON；
 *   8) 截断：严格档 + 超出结果上限 → truncated + 结果条「已截断（上限 50,000）」；
 *   9) stale：文档编辑后重进表达式 → 警告条 + 「重新执行」（不自动重跑）；重跑后恢复；
 *  10) 返回文档树 / 关闭结果条 → 文档视图恢复；
 *  11) 0 长任务 / 0 page 异常 / 0 console error；深/亮截图。
 *
 * 截图落 .spike/smoke/expression-*.png。走 HTTP + `window.__tjv`，与 scripts/smoke-fidelity.mjs 同一 harness。
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { launchChrome, REPO_ROOT } from '../prototype/p1/lib/chrome.mjs';
import { startStaticServer } from '../prototype/p1/lib/http.mjs';

const SHOTS = path.join(REPO_ROOT, '.spike', 'smoke');
await mkdir(SHOTS, { recursive: true });

/** 40 个 item（price 递增，>100 的 20 个）+ 60,000 个数字（截断档用）+ 若干根字段。 */
const FIXTURE = JSON.stringify({
  data: {
    items: Array.from({ length: 40 }, (_, i) => ({ id: i, name: `item-${i}`, price: i * 10 })),
    name: 'fixture',
  },
  big: Array.from({ length: 60_000 }, (_, i) => i),
  meta: { count: 40, ok: true },
});

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

  // ---- phase 0：空态打开表达式面板（无文档：示例只有 2 条通用） ----
  const phase0 = await page.eval(`(async () => {
    const out = {};
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const longTasks = [];
    try {
      const po = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) longTasks.push(Math.round(e.duration));
      });
      po.observe({ entryTypes: ['longtask'] });
      out.hasLongTaskObserver = true;
    } catch (e) { out.hasLongTaskObserver = false; }
    if (!window.__tjv) throw new Error('dev hook missing (chrome API present?)');
    window.__ex = { sleep, longTasks };
    const btn = document.querySelector('.actbtn[data-panel-btn="expression"]');
    out.buttonExists = Boolean(btn);
    out.buttonAria = btn ? btn.getAttribute('aria-label') : null;
    btn.click();
    await sleep(400);
    const host = document.getElementById('expressionPanel');
    out.panel = {
      mode: document.body.dataset.panel ?? null,
      title: document.getElementById('panelTitle').textContent ?? '',
      ariaLabel: host.getAttribute('aria-label'),
      current: btn.getAttribute('aria-current'),
      active: btn.classList.contains('is-active'),
      editorMounted: Boolean(host.querySelector('.cm-editor')),
      runText: document.getElementById('exprRun')?.textContent ?? '',
      strictChecked: document.getElementById('exprStrict')?.checked ?? null,
      errorHidden: document.getElementById('exprError')?.hidden ?? null,
      barHidden: document.getElementById('exprBar')?.hidden ?? null,
    };
    out.state = window.__tjv.expressionState();
    out.missingHooks = ['expressionState','expressionOpen','expressionSetText','expressionRun','expressionRunText','expressionComplete','expressionSetStrict','expressionBack','expressionRerun','expressionLocate','expressionSetBudget']
      .filter((k) => typeof window.__tjv[k] !== 'function');
    out.longTasks = longTasks.slice();
    return out;
  })()`);
  report.boot = phase0;
  await page.screenshot(path.join(SHOTS, 'expression-empty.png'));

  check('setup:dev-hook', phase0.missingHooks.length === 0, { missing: phase0.missingHooks });
  check('setup:longtask-observer', phase0.hasLongTaskObserver === true);
  check(
    'panel:open-empty',
    phase0.buttonExists === true &&
      phase0.buttonAria === '表达式' &&
      phase0.panel.mode === 'expression' &&
      phase0.panel.title === '表达式' &&
      phase0.panel.ariaLabel === '表达式面板' &&
      phase0.panel.current === 'page' &&
      phase0.panel.active === true,
    phase0.panel,
  );
  check(
    'panel:cm6-lazy-mounted',
    phase0.panel.editorMounted === true && String(phase0.panel.runText).includes('执行') && phase0.panel.strictChecked === false,
    { editorMounted: phase0.panel.editorMounted, runText: phase0.panel.runText },
  );
  check(
    'panel:empty-examples-2',
    Array.isArray(phase0.state.examples) && phase0.state.examples.length === 2,
    { examples: phase0.state.examples },
  );

  // ---- phase 1：导入文档 + 打开面板（示例 3 动态 + 2 通用） ----
  const phase1 = await page.eval(`(async () => {
    const out = {};
    const { sleep } = window.__ex;
    const t0 = performance.now();
    await window.__tjv.loadText(${JSON.stringify(FIXTURE)}, 'expr.json');
    out.loadMs = Math.round(performance.now() - t0);
    out.rows = window.__tjv.state().totalRows;
    document.querySelector('.actbtn[data-panel-btn="expression"]').click();
    await sleep(400);
    out.state = window.__tjv.expressionState();
    out.panelMode = document.body.dataset.panel ?? null;
    // 示例点击填入输入框
    const first = document.querySelector('#exprExamples .expr-example');
    out.firstExample = first ? first.textContent : null;
    if (first) { first.click(); await sleep(120); }
    out.textAfterExample = window.__tjv.expressionState().text;
    return out;
  })()`);
  report.load = phase1;
  await page.screenshot(path.join(SHOTS, 'expression-panel.png'));

  check('load:doc-rows', phase1.rows > 0, { rows: phase1.rows, loadMs: phase1.loadMs });
  check(
    'examples:3-dynamic-plus-2-generic',
    Array.isArray(phase1.state.examples) && phase1.state.examples.length === 5 &&
      phase1.state.examples.slice(0, 3).every((e) => typeof e === 'string' && e.includes('$.')),
    { examples: phase1.state.examples },
  );
  check(
    'examples:click-fills-editor',
    Boolean(phase1.firstExample) && phase1.textAfterExample === phase1.firstExample,
    { firstExample: phase1.firstExample, text: phase1.textAfterExample },
  );

  // ---- phase 2：执行 filter+map → 结果根 + 结果条 + 状态行 + 历史 ----
  const phase2 = await page.eval(`(async () => {
    const out = {};
    const { sleep } = window.__ex;
    window.__ex.longTasks.length = 0;
    const expr = '$.data.items.filter(x => x.price > 100).map(x => x.name)';
    const res = await window.__tjv.expressionRunText(expr);
    await sleep(250);
    out.state = res;
    out.bar = {
      hidden: document.getElementById('exprBar').hidden,
      text: document.getElementById('exprBarText').textContent,
      backVisible: !document.getElementById('exprBarBack').hidden,
      rerunHidden: document.getElementById('exprBarRerun').hidden,
      stale: document.getElementById('exprBar').dataset.stale ?? null,
    };
    out.rects = (() => {
      const bar = document.getElementById('exprBar').getBoundingClientRect();
      const scroller = document.querySelector('.tjv-tree').getBoundingClientRect();
      return { barH: Math.round(bar.height), barTop: Math.round(bar.top), treeTop: Math.round(scroller.top) };
    })();
    out.rows = [...document.querySelectorAll('.row[data-path]')].filter((el) => !el.hidden).map((el) => el.dataset.path);
    out.statusRows = document.getElementById('statusRows').textContent;
    out.statusState = document.getElementById('statusState').textContent;
    out.innerStatus = document.getElementById('exprStatus').textContent;
    out.history = window.__tjv.expressionState().history;
    out.longTasks = window.__ex.longTasks.slice();
    return out;
  })()`);
  report.run = phase2;
  await page.screenshot(path.join(SHOTS, 'expression-result.png'));

  check(
    'run:result-root',
    phase2.state?.active === true &&
      /^expr:\d+$/.test(String(phase2.state?.view?.rootId)) &&
      phase2.state?.view?.count === 29 &&
      phase2.state?.view?.kind === 'array',
    { view: phase2.state?.view },
  );
  check(
    'run:bar',
    phase2.bar.hidden === false &&
      String(phase2.bar.text).includes('表达式结果 · expr:') &&
      phase2.bar.backVisible === true &&
      phase2.bar.rerunHidden === true &&
      phase2.bar.stale === null,
    phase2.bar,
  );
  check(
    'run:bar-height-32',
    phase2.rects.barH === 32 && phase2.rects.treeTop >= phase2.rects.barTop + 32,
    phase2.rects,
  );
  check(
    'run:status-line',
    /29 项 · \d+ ms/.test(String(phase2.innerStatus)) && String(phase2.statusState).includes('表达式结果'),
    { innerStatus: phase2.innerStatus, statusState: phase2.statusState },
  );
  check(
    'run:tree-renders-result',
    Array.isArray(phase2.rows) && phase2.rows.includes('$') && phase2.rows.includes('$[0]'),
    { rows: (phase2.rows || []).slice(0, 6) },
  );
  check(
    'run:history',
    Array.isArray(phase2.history) && phase2.history[0] === '$.data.items.filter(x => x.price > 100).map(x => x.name)',
    { history: phase2.history },
  );
  check('run:no-long-task', (phase2.longTasks || []).every((t) => t < 50), { longTasks: phase2.longTasks });

  // ---- phase 3：补全（根字段 / Math / 数组方法） ----
  const phase3 = await page.eval(`(async () => {
    const out = {};
    out.root = await window.__tjv.expressionComplete('da', 2);
    out.math = await window.__tjv.expressionComplete('Math.', 5);
    out.methods = await window.__tjv.expressionComplete('$.data.items.', 13);
    return out;
  })()`);
  report.complete = phase3;
  const labels = (items) => (items || []).map((i) => i.label);
  check('complete:root-field', labels(phase3.root).includes('data') && labels(phase3.root).includes('big'), {
    labels: labels(phase3.root).slice(0, 12),
  });
  check('complete:math', labels(phase3.math).includes('max') && labels(phase3.math).includes('floor'), {
    labels: labels(phase3.math),
  });
  check(
    'complete:methods',
    labels(phase3.methods).includes('filter') && labels(phase3.methods).includes('map') && labels(phase3.methods).includes('length'),
    { labels: labels(phase3.methods).slice(0, 12) },
  );

  // ---- phase 4：严格模式（元素内部缺字段 / 根级缺字段） ----
  const phase4 = await page.eval(`(async () => {
    const out = {};
    const { sleep } = window.__ex;
    // 非严格：元素内部缺字段 → 跳过 40 项，结果空数组
    await window.__tjv.expressionSetStrict(false);
    out.lenient = await window.__tjv.expressionRunText('$.data.items.map(x => x.nope)');
    out.lenientStatus = document.getElementById('exprStatus').textContent;
    out.lenientBarText = document.getElementById('exprBarText').textContent;
    out.lenientError = document.getElementById('exprError').hidden ? null : document.getElementById('exprError').textContent;
    // 严格：同样表达式 → 报错（行内）
    window.__tjv.expressionSetStrict(true);
    out.strict = await window.__tjv.expressionRunText('$.data.items.map(x => x.nope)');
    await sleep(150);
    out.strictError = {
      hidden: document.getElementById('exprError').hidden,
      text: document.getElementById('exprError').textContent,
    };
    // 严格模式不影响根级静态链：始终报错 + 纠错候选
    out.rootMiss = await window.__tjv.expressionRunText('$.data.itemz');
    out.rootMissError = document.getElementById('exprError').textContent;
    // 收尾：恢复非严格 + 清错误
    window.__tjv.expressionSetStrict(false);
    await window.__tjv.expressionRunText('$.data.items');
    await sleep(120);
    return out;
  })()`);
  report.strict = phase4;
  await page.screenshot(path.join(SHOTS, 'expression-strict.png'));

  check(
    'strict:lenient-skips',
    phase4.lenient?.view?.skipped === 40 && phase4.lenient?.view?.count === 0 &&
      String(phase4.lenientBarText).includes('已跳过 40 项'),
    { skipped: phase4.lenient?.view?.skipped, count: phase4.lenient?.view?.count, barText: phase4.lenientBarText },
  );
  check(
    'strict:on-errors',
    phase4.strictError.hidden === false && phase4.strict?.view?.rootId === phase4.lenient?.view?.rootId,
    { strictView: phase4.strict?.view?.rootId, lenientView: phase4.lenient?.view?.rootId, error: phase4.strictError.text },
  );
  check(
    'strict:inline-error',
    phase4.strictError.hidden === false && String(phase4.strictError.text).includes('字段不存在'),
    { hidden: phase4.strictError.hidden, text: phase4.strictError.text },
  );
  check(
    'strict:root-miss-always-errors',
    phase4.rootMissError && String(phase4.rootMissError).includes('字段不存在：itemz') &&
      String(phase4.rootMissError).includes('你是不是想找'),
    { text: phase4.rootMissError },
  );

  // ---- phase 5：行内语法错误（位置） ----
  const phase5 = await page.eval(`(async () => {
    const out = {};
    const { sleep } = window.__ex;
    const before = window.__tjv.expressionState().view;
    out.beforeRoot = before ? before.rootId : null;
    await window.__tjv.expressionRunText('$.data.items.filter(');
    await sleep(150);
    out.error = {
      hidden: document.getElementById('exprError').hidden,
      text: document.getElementById('exprError').textContent,
    };
    out.after = window.__tjv.expressionState();
    out.editorHasLint = Boolean(document.querySelector('#exprEditor .cm-lintRange-error, #exprEditor .cm-lint-marker-error'));
    return out;
  })()`);
  report.syntaxError = phase5;
  check(
    'error:syntax-location',
    phase5.error.hidden === false &&
      String(phase5.error.text).includes('语法错误') &&
      /第 \d+ 行第 \d+ 列/.test(String(phase5.error.text)),
    { text: phase5.error.text },
  );
  check(
    'error:keeps-previous-result',
    phase5.after?.view?.rootId === phase5.beforeRoot && phase5.after?.active === true,
    { beforeRoot: phase5.beforeRoot, afterRoot: phase5.after?.view?.rootId },
  );

  // ---- phase 6：跳回原文档（点结果行 → doc 树 + 选中原路径） ----
  const phase6 = await page.eval(`(async () => {
    const out = {};
    const { sleep } = window.__ex;
    // 先回到 filter 结果（引用原对象）
    await window.__tjv.expressionRunText('$.data.items.filter(x => x.price > 100)');
    await sleep(200);
    out.located = await window.__tjv.expressionLocate('$[0]');
    out.locatedNested = await window.__tjv.expressionLocate('$[0].name');
    out.locatedVirtual = await window.__tjv.expressionLocate('$[0].price');
    const row = document.querySelector('.row[data-path="$[0]"]');
    out.rowExists = Boolean(row);
    if (row) { row.click(); }
    for (let i = 0; i < 80; i++) {
      await sleep(20);
      if (window.__tjv.state().selected) break;
    }
    out.after = {
      selected: window.__tjv.state().selected,
      panel: document.body.dataset.panel ?? null,
      active: window.__tjv.expressionState().active,
      barHidden: document.getElementById('exprBar').hidden,
    };
    return out;
  })()`);
  report.jump = phase6;
  await page.screenshot(path.join(SHOTS, 'expression-jump.png'));

  check(
    'jump:locate-original-paths',
    phase6.located?.path === '$.data.items[11]' &&
      phase6.locatedNested?.path === '$.data.items[11].name' &&
      phase6.locatedVirtual?.path === '$.data.items[11].price',
    { top: phase6.located?.path, nested: phase6.locatedNested?.path, scalar: phase6.locatedVirtual?.path },
  );
  check(
    'jump:click-row-back-to-doc',
    phase6.rowExists === true &&
      String(phase6.after.selected).startsWith('$.data.items[') &&
      phase6.after.panel === 'doc' &&
      phase6.after.active === false &&
      phase6.after.barHidden === true,
    phase6.after,
  );

  // ---- phase 7：导出/复制结果 JSON（结果视图下 session 根 = expr 根） ----
  const phase7 = await page.eval(`(async () => {
    const out = {};
    const { sleep } = window.__ex;
    await window.__tjv.expressionRunText('$.data.items.slice(0, 2).map(x => x.name)');
    await sleep(200);
    out.exported = await window.__tjv.exportDocText();
    out.copy = await window.__tjv.copyResolve('$', 'subtree');
    out.name = window.__tjv.exportState();
    return out;
  })()`);
  report.exportResult = phase7;
  const exportedJson = (() => {
    try {
      return JSON.parse(phase7.exported?.text ?? 'null');
    } catch {
      return 'unparsable';
    }
  })();
  check(
    'export:result-json',
    Array.isArray(exportedJson) && exportedJson.length === 2 && exportedJson[0] === 'item-0',
    { exported: String(phase7.exported?.text ?? '').slice(0, 120) },
  );
  const copiedJson = (() => {
    try {
      return JSON.parse(phase7.copy?.text ?? 'null');
    } catch {
      return null;
    }
  })();
  check(
    'export:copy-result',
    phase7.copy?.text === phase7.exported?.text || (Array.isArray(copiedJson) && copiedJson[0] === 'item-0'),
    { copyText: String(phase7.copy?.text ?? '').slice(0, 120) },
  );

  // ---- phase 8：截断（严格档 + 60k 结果 > 上限 50,000） ----
  const phase8 = await page.eval(`(async () => {
    const out = {};
    const { sleep } = window.__ex;
    out.budgetSet = window.__tjv.expressionSetBudget('strict');
    const res = await window.__tjv.expressionRunText('$.big');
    await sleep(200);
    out.state = res;
    out.barText = document.getElementById('exprBarText').textContent;
    out.truncatedAttr = document.getElementById('exprBar').dataset.truncated ?? null;
    out.innerStatus = document.getElementById('exprStatus').textContent;
    window.__tjv.expressionSetBudget('standard');
    return out;
  })()`);
  report.truncate = phase8;
  await page.screenshot(path.join(SHOTS, 'expression-truncated.png'));

  check(
    'truncate:flags-and-copy',
    phase8.state?.view?.truncated === true &&
      phase8.state?.view?.count === 50_000 &&
      String(phase8.barText).includes('已截断（上限 50,000）') &&
      phase8.truncatedAttr === '1',
    { count: phase8.state?.view?.count, barText: phase8.barText, attr: phase8.truncatedAttr },
  );

  // ---- phase 9：stale（回文档树 → 编辑 → 重进表达式 → 警告条 + 重新执行） ----
  const phase9 = await page.eval(`(async () => {
    const out = {};
    const { sleep } = window.__ex;
    await window.__tjv.expressionRunText('$.data.items.map(x => x.name)');
    await sleep(150);
    out.rootBefore = window.__tjv.expressionState().view?.rootId ?? null;
    out.back = window.__tjv.expressionBack();
    await sleep(150);
    // 文档编辑（docRevision++）
    await window.__tjv.editOpen('$.data.items[0].price');
    await window.__tjv.editApplyText('999');
    await sleep(200);
    out.editCount = window.__tjv.state().editCount;
    // 重进表达式模式：结果恢复但 stale（不自动重跑）
    document.querySelector('.actbtn[data-panel-btn="expression"]').click();
    await sleep(300);
    out.reopened = window.__tjv.expressionState();
    out.bar = {
      hidden: document.getElementById('exprBar').hidden,
      text: document.getElementById('exprBarText').textContent,
      stale: document.getElementById('exprBar').dataset.stale ?? null,
      rerunVisible: !document.getElementById('exprBarRerun').hidden,
    };
    // 点「重新执行」→ 新结果根、stale 清除
    const rerun = document.getElementById('exprBarRerun');
    out.rerunClicked = Boolean(rerun) && !rerun.hidden;
    if (rerun && !rerun.hidden) {
      const before = window.__tjv.expressionState().view?.rootId;
      rerun.click();
      for (let i = 0; i < 100; i++) {
        await sleep(20);
        const s = window.__tjv.expressionState();
        if (s.view && s.view.rootId !== before && s.running === false) break;
      }
      await sleep(120);
      out.afterRerun = {
        view: window.__tjv.expressionState().view,
        stale: document.getElementById('exprBar').dataset.stale ?? null,
        barText: document.getElementById('exprBarText').textContent,
      };
    }
    return out;
  })()`);
  report.stale = phase9;
  await page.screenshot(path.join(SHOTS, 'expression-stale.png'));

  check(
    'stale:rerun-visible-on-reopen',
    phase9.reopened?.active === true &&
      phase9.bar.hidden === false &&
      phase9.bar.stale === '1' &&
      phase9.bar.rerunVisible === true &&
      String(phase9.bar.text).includes('过期'),
    { reopened: phase9.reopened?.stale, bar: phase9.bar },
  );
  check(
    'stale:rerun-refreshes',
    phase9.rerunClicked === true &&
      phase9.afterRerun?.stale === null &&
      phase9.afterRerun?.view?.rootId !== phase9.rootBefore,
    { rerunClicked: phase9.rerunClicked, after: phase9.afterRerun },
  );

  // ---- phase 10：返回文档树 + 浅色截图 + 长任务汇总 ----
  const phase10 = await page.eval(`(async () => {
    const out = {};
    const { sleep } = window.__ex;
    document.getElementById('exprBarBack').click();
    await sleep(250);
    out.afterBack = {
      active: window.__tjv.expressionState().active,
      panel: document.body.dataset.panel ?? null,
      barHidden: document.getElementById('exprBar').hidden,
      rows: window.__tjv.state().totalRows,
      selected: window.__tjv.state().selected,
    };
    // 原文视图 → 打开表达式模式：必须自动切回树视图（结果根在原文视图下不可见）
    await window.__tjv.setViewMode('raw');
    await sleep(250);
    out.rawModeBefore = document.body.dataset.view ?? null;
    await window.__tjv.expressionOpen();
    out.afterOpenFromRaw = { view: document.body.dataset.view ?? null };
    await window.__tjv.expressionRunText('$.meta');
    await sleep(200);
    out.afterRunFromRaw = {
      view: document.body.dataset.view ?? null,
      active: window.__tjv.expressionState().active,
      barHidden: document.getElementById('exprBar').hidden,
    };
    window.__tjv.expressionBack();
    await sleep(150);
    window.__tjv.setSetting('theme', 'light');
    await sleep(200);
    out.theme = document.documentElement.dataset.theme;
    return out;
  })()`);
  report.back = phase10;
  await page.screenshot(path.join(SHOTS, 'expression-light.png'));

  check(
    'back:returns-to-doc-view',
    phase10.afterBack.active === false &&
      phase10.afterBack.panel === 'doc' &&
      phase10.afterBack.barHidden === true &&
      phase10.afterBack.rows > 0,
    phase10.afterBack,
  );
  check(
    'raw-mode:switch-back-to-tree',
    phase10.rawModeBefore === 'raw' &&
      phase10.afterOpenFromRaw.view === 'tree' &&
      phase10.afterRunFromRaw.view === 'tree' &&
      phase10.afterRunFromRaw.active === true &&
      phase10.afterRunFromRaw.barHidden === false,
    { before: phase10.rawModeBefore, open: phase10.afterOpenFromRaw, run: phase10.afterRunFromRaw },
  );
  check('theme:light', phase10.theme === 'light', { theme: phase10.theme });

  const longTasks = phase0.longTasks.concat(phase2.longTasks, []);
  check('longtask:all-below-50ms', longTasks.every((t) => t < 50), { longTasks });

  // ---- phase 11：无损数字（ADR-0020 §6）：BigInt 表达式语义 ----
  const phase11 = await page.eval(`(async () => {
    const out = {};
    const { sleep } = window.__ex;
    await window.__tjv.loadText('{"id":297532588187238660,"rows":[{"v":1},{"v":2},{"v":3000000000000000000}]}', 'lossless-expr.json');
    await sleep(400);
    const rowText = () => document.querySelector('.row[data-path="$"]')?.textContent ?? '';
    out.read = await window.__tjv.expressionRunText('$.id');
    await sleep(150);
    out.readRow = rowText();
    out.add = await window.__tjv.expressionRunText('$.id + 1n');
    await sleep(150);
    out.addRow = rowText();
    out.cmp = await window.__tjv.expressionRunText('$.id > 100');
    await sleep(150);
    out.cmpRow = rowText();
    // 混算 → 确定错误（不清掉上一个结果）
    await window.__tjv.expressionRunText('$.id + 1');
    await sleep(200);
    out.mixed = {
      hidden: document.getElementById('exprError').hidden,
      text: document.getElementById('exprError').textContent,
    };
    out.filter = await window.__tjv.expressionRunText('$.rows.filter(x => x.v > 1)');
    await sleep(150);
    out.filterRow = rowText();
    out.str = await window.__tjv.expressionRunText('String($.id)');
    await sleep(150);
    out.strRow = rowText();
    // JS 数字字面量语义（分隔符 / legacy octal 不经过 JSON 分析器）+ BigInt 除零
    out.sep = await window.__tjv.expressionRunText('1_000');
    await sleep(120);
    out.sepRow = rowText();
    out.octal = await window.__tjv.expressionRunText('0777');
    await sleep(120);
    out.octalRow = rowText();
    await window.__tjv.expressionRunText('1n / 0n');
    await sleep(200);
    out.divZero = { hidden: document.getElementById('exprError').hidden, text: document.getElementById('exprError').textContent };
    return out;
  })()`);
  report.lossless = phase11;

  check(
    'lossless:read-and-arith',
    phase11.read?.view?.kind === 'number' &&
      String(phase11.readRow).includes('297532588187238660') &&
      phase11.add?.view?.kind === 'number' &&
      String(phase11.addRow).includes('297532588187238661'),
    { read: phase11.read?.view?.kind, readRow: phase11.readRow, addRow: phase11.addRow },
  );
  check(
    'lossless:mixed-number-error',
    phase11.mixed?.hidden === false && String(phase11.mixed?.text).includes('超大整数不能进行该运算'),
    phase11.mixed,
  );
  check(
    'lossless:relational-mixed-allowed',
    phase11.cmp?.view?.kind === 'boolean' && String(phase11.cmpRow).includes('true'),
    { kind: phase11.cmp?.view?.kind, row: phase11.cmpRow },
  );
  check(
    'lossless:array-filter',
    phase11.filter?.view?.count === 2 &&
      phase11.filter?.view?.kind === 'array' &&
      String(phase11.filterRow).includes('[…]'),
    { count: phase11.filter?.view?.count, row: phase11.filterRow },
  );
  check(
    'lossless:string-conversion',
    phase11.str?.view?.kind === 'string' && String(phase11.strRow).includes('297532588187238660'),
    { kind: phase11.str?.view?.kind, row: phase11.strRow },
  );
  check(
    'lossless:js-literal-semantics',
    String(phase11.sepRow).includes('1000') && String(phase11.octalRow).includes('511'),
    { sepRow: phase11.sepRow, octalRow: phase11.octalRow },
  );
  check(
    'lossless:bigint-div-zero',
    phase11.divZero?.hidden === false && String(phase11.divZero?.text).includes('除数为 0'),
    phase11.divZero,
  );

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

  for (const shot of [
    'expression-empty.png',
    'expression-panel.png',
    'expression-result.png',
    'expression-strict.png',
    'expression-jump.png',
    'expression-truncated.png',
    'expression-stale.png',
    'expression-light.png',
  ]) {
    check('screenshot:' + shot, existsSync(path.join(SHOTS, shot)), { path: path.join(SHOTS, shot) });
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
console.log(`\nsmoke-expression: ${failed === 0 ? 'OK' : 'FAILED'}  (${passed}/${checks.length} checks, ${failed} failed)`);
process.exitCode = failed === 0 ? 0 : 1;
