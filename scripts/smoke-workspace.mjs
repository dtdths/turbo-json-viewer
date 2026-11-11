/**
 * scripts/smoke-workspace.mjs — 多文档工作区 + 标签条（#18 / ADR-0009）真机冒烟。
 *
 *   node build.mjs && node scripts/smoke-workspace.mjs
 *
 * 测（ADR-0009 §5「验收」）：
 *   1) 单文档：标签条 hidden、零高度、树视口不变（C 形态完全一致）；
 *   2) 第 2 个标签：`＋`/`tabOpen` 打开「新标签」入口层（无覆盖警示）→ 导入后标签条出现
 *      （32px、role=tablist、文件名 + aria-selected、活动标签正确），树视口少 32px；
 *   3) 每标签独立视图态：展开态 / 滚动位置 / 选中 / 搜索命中集互不串味，切回来原样恢复；
 *   4) 替换当前标签：标签数不变、rootId 换新、标签名更新，另一个标签完全不受影响；
 *   5) 关标签：关活动标签 → 相邻标签接管；关到只剩 1 个 → 标签条重新隐藏；
 *      关最后一个 → 回空态（导入层、文件 chip 隐藏、状态栏「未打开文档」）；
 *   6) 软上限 8：满 8 后 `＋` 禁用且 title 变提示；第 9 个开不出来；
 *   7) 内存提示：第 2+ 份大文档（合计 ≥ 50 MB）导入后给一次性 toast；小文档不给；
 *   8) 0 page 异常 / 0 console error。
 *   9) 标签就地改名（#29 / ADR-0021）：双击标题出输入框（全选、禁拖拽）、Esc 取消、
 *      F2 键盘入口、Enter 提交后标签/文件 chip 同步并把原名写进悬停 title、空白提交保持原名。
 * 截图落 .spike/smoke/workspace-{two-tabs,light,empty,rename,rename-light}.png；走 HTTP + `window.__tjv`。
 */
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { launchChrome, REPO_ROOT } from '../prototype/p1/lib/chrome.mjs';
import { startStaticServer } from '../prototype/p1/lib/http.mjs';

const SHOTS = path.join(REPO_ROOT, '.spike', 'smoke');
await mkdir(SHOTS, { recursive: true });

/** A：>500 节点 → 加载默认折叠；用于「展开态 / 滚动」这类需要大文档的断言。 */
const DOC_A = {
  name: 'a.json',
  items: Array.from({ length: 300 }, (_, i) => ({ id: i, label: `item-${i}` })),
  meta: { count: 300 },
};
/** B：小文档（自适应全展开）。 */
const DOC_B = { name: 'b.json', list: [1, 2, 3], flag: true };
/** C：替换导入用。 */
const DOC_C = { name: 'c.json', rows: [1, 2] };

const server = await startStaticServer(REPO_ROOT);
const chrome = await launchChrome({ windowSize: '1440,900' });
const report = {};
const url = `${server.base}/dist/page.html`;

try {
  const page = await chrome.openPage();
  const errorsBefore = page.exceptions.length;
  await page.setViewport(1440, 900);
  await page.goto(url, { timeoutMs: 20000 });
  await page.waitFor('document.readyState === "complete"', { timeoutMs: 20000 });
  await new Promise((r) => setTimeout(r, 500));

  const runPhase = async (name, expression) => {
    try {
      Object.assign(report, (await page.eval(expression)) ?? {});
    } catch (error) {
      if (!report.errors) report.errors = {};
      report.errors[name] = String(error?.message ?? error);
      console.warn(`⚠️ phase ${name} failed: ${String(error?.message ?? error)}`);
    }
  };

  /* ---- phase 0：空态（0 标签）---- */
  await runPhase(
    'boot',
    `(async () => {
      const out = {};
      const h = window.__tjv;
      out.boot = h.workspaceState();
      out.bootState = h.state();
      out.bootLayerVisible = !document.getElementById('empty').classList.contains('is-hidden');
      out.bootStripHiddenAttr = document.getElementById('tabStrip').hidden;
      return out;
    })()`,
  );
  await page.screenshot(path.join(SHOTS, 'workspace-empty.png'));

  /* ---- phase 1：单文档（标签条必须隐藏、零视觉变化）---- */
  await runPhase(
    'single',
    `(async () => {
      const out = {};
      const h = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const docA = ${JSON.stringify(DOC_A)};
      await h.loadText(JSON.stringify(docA), 'a.json');
      await sleep(500);
      out.single = h.workspaceState();
      out.singleState = h.state();
      out.singleViewport = document.querySelector('.tjv-tree')?.clientHeight ?? 0;
      out.singleChipHidden = document.getElementById('fileChip').hidden;
      out.singleTab1Id = h.workspaceState().tabs[0]?.id ?? null;
      out.singleRoot = h.workspaceState().tabs[0]?.rootId ?? null;
      return out;
    })()`,
  );

  /* ---- phase 2：开第 2 个标签（＋ → 新标签入口层 → 导入）---- */
  await runPhase(
    'two-tabs',
    `(async () => {
      const out = {};
      const h = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      // 单文档下标签条隐藏 → 走可见入口：导入 → 替换层 → 「在新标签中打开」切换。
      // 先打开左面板（搜索），验证模态入口层真的把左面板一起遮住（用户 2026-11-11 反馈的 bug）
      document.querySelector('[data-panel-btn="search"]').click();
      await sleep(200);
      document.getElementById('importBtn').click();
      await sleep(200);
      const side = document.getElementById('leftPanel').getBoundingClientRect();
      const probe = document.elementFromPoint(side.x + 120, side.y + 200);
      out.replaceLayer = {
        open: !document.getElementById('empty').classList.contains('is-hidden'),
        mode: document.getElementById('empty').dataset.mode ?? null,
        warnHidden: document.getElementById('emptyWarn').hidden,
        toggleText: document.getElementById('emptyModeToggle').textContent,
        layerZ: getComputedStyle(document.getElementById('empty')).zIndex,
        panelDisplay: getComputedStyle(document.getElementById('leftPanel')).display,
        // 左面板中心点命中的元素不属于左面板 = 被遮罩盖住（且点不到）
        panelCovered: !(probe && probe.closest('#leftPanel')),
      };
      document.getElementById('emptyModeToggle').click();
      await sleep(120);
      out.layer = {
        open: !document.getElementById('empty').classList.contains('is-hidden'),
        mode: document.getElementById('empty').dataset.mode ?? null,
      };
      out.layerTitle = document.getElementById('emptyTitle').textContent;
      out.layerWarnHidden = document.getElementById('emptyWarn').hidden;
      out.layerToggleText = document.getElementById('emptyModeToggle').textContent;
      const docB = ${JSON.stringify(DOC_B)};
      out.two = await h.tabImportText(JSON.stringify(docB), 'b.json');
      await sleep(400);
      out.twoState = h.state();
      out.twoViewport = document.querySelector('.tjv-tree')?.clientHeight ?? 0;
      const strip = document.getElementById('tabStrip');
      out.stripDisplay = getComputedStyle(strip).display;
      out.stripRole = strip.getAttribute('role');
      out.stripAria = strip.getAttribute('aria-label');
      out.tabEls = [...strip.querySelectorAll('.tabstrip__tab')].map((el) => ({
        id: el.dataset.tabId,
        role: el.getAttribute('role'),
        selected: el.getAttribute('aria-selected'),
        title: el.querySelector('.tabstrip__title')?.textContent ?? '',
      }));
      out.tab2Id = h.workspaceState().tabs[1]?.id ?? null;
      out.tab2Root = h.workspaceState().tabs[1]?.rootId ?? null;
      out.activeTitleEl = document.getElementById('fileName').textContent;
      return out;
    })()`,
  );

  /* ---- phase 3：每标签独立展开态 / 滚动 / 选中 / 搜索 ---- */
  await runPhase(
    'per-tab-state',
    `(async () => {
      const out = {};
      const h = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const ws = h.workspaceState();
      const tab1 = ws.tabs[0].id;
      const tab2 = ws.tabs[1].id;

      // tab1：全展开 → 滚到 480px → 搜索 + 跳转（产生选中）
      h.tabSwitch(tab1);
      await sleep(300);
      await h.expandAll();
      await sleep(400);
      h.scrollToPx(480);
      await sleep(300);
      out.tab1Expanded = h.state();
      await h.search('id');
      await sleep(400);
      out.tab1Search = h.searchPanel();
      // 跳到较深的命中（保证选中 + 滚动都非默认值，才能验证切换后的恢复）
      await h.searchJump(Math.min(200, (out.tab1Search.size ?? 1) - 1));
      await sleep(400);
      out.tab1Jumped = h.state();
      out.savedSelected = out.tab1Jumped.selected;
      out.savedScroll = out.tab1Jumped.scrollTop;
      out.savedRows = out.tab1Jumped.totalRows;

      // 切到 tab2：必须是 tab2 自己的状态（未展开、无命中、无选中）
      out.toTab2 = h.tabSwitch(tab2);
      await sleep(400);
      out.tab2Fresh = h.state();
      out.tab2Search = h.searchPanel();
      // tab2 自己折一个容器，制造与 tab1 不同的展开态
      await h.togglePath('$.list', false);
      await sleep(250);
      out.tab2Collapsed = h.state();

      // 切回 tab1：展开态 / 滚动 / 选中 / 命中集原样恢复
      out.backToTab1 = h.tabSwitch(tab1);
      await sleep(500);
      out.tab1Restored = h.state();
      out.tab1SearchRestored = h.searchPanel();
      // 搜索面板输入框也要跟着切到该标签的查询词（SearchPanel.render 在未聚焦时同步）
      out.searchInputRestored = document.getElementById('searchInput')?.value ?? null;

      // 再切回 tab2：它自己折叠过的状态还在
      h.tabSwitch(tab2);
      await sleep(400);
      out.tab2Restored = h.state();
      return out;
    })()`,
  );

  /* ---- phase 3.5：表达式结果视图按标签隔离（不跨标签串味、切回可恢复）---- */
  await runPhase(
    'expression',
    `(async () => {
      const out = {};
      const h = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const ws = h.workspaceState();
      const tab1 = ws.tabs[0].id;
      const tab2 = ws.tabs[1].id;
      out.tab2RootNow = ws.tabs[1].rootId;
      h.tabSwitch(tab1);
      await sleep(300);
      await h.expressionOpen();
      await sleep(200);
      out.exprRun = await h.expressionRunText('$');
      out.exprActiveTab1 = h.expressionState().active;
      // M1 回归：结果根上的展开/收起/全部展开必须照常生效（ADR-0018 §1），不能把回包丢掉
      // 结果根是新建 RowModel（默认折叠）→ 展开 $.items 才是「真正变行数」的动作
      const rvBefore = h.state().rowVersion;
      await h.togglePath('$.items', true);
      await sleep(300);
      out.exprToggle = { rv: h.state().rowVersion, rows: h.state().totalRows };
      out.exprToggleApplied = (out.exprToggle.rv ?? 0) > rvBefore;
      await h.expandAll();
      await sleep(400);
      out.exprExpand = { rv: h.state().rowVersion, rows: h.state().totalRows };
      // 切到 tab2：结果视图必须不跟过去、结果条不残留，树回到 tab2 的文档树
      out.exprSwitch = h.tabSwitch(tab2);
      await sleep(350);
      out.exprOnTab2 = {
        active: h.expressionState().active,
        barHidden: document.getElementById('exprBar').hidden,
        treeRoot: h.state().rootId,
      };
      // 切回 tab1：结果视图恢复（左面板仍是表达式）
      h.tabSwitch(tab1);
      await sleep(400);
      out.exprBack = { active: h.expressionState().active, panel: document.body.dataset.panel ?? null };
      // M2 回归：表达式结果视图里导入（替换当前标签）→ 先回文档树，标签存档不得被 expr 版本污染
      const docC = ${JSON.stringify(DOC_C)};
      await h.loadText(JSON.stringify(docC), 'expr-import.json');
      await sleep(500);
      out.exprImport = {
        active: h.expressionState().active,
        barHidden: document.getElementById('exprBar').hidden,
        root: h.state().rootId,
        rows: h.state().totalRows,
      };
      h.tabSwitch(tab2);
      await sleep(300);
      h.tabSwitch(tab1);
      await sleep(450);
      out.exprImportBack = { root: h.state().rootId, rows: h.state().totalRows };
      // 回到 tab2，保持 phase 4 的「活动标签 = tab2」前提
      h.tabSwitch(tab2);
      await sleep(300);
      out.exprBackToTab2 = h.expressionState().active;
      return out;
    })()`,
  );

  /* ---- phase 4：替换当前标签（第 2 个标签换成 C）---- */
  await runPhase(
    'replace',
    `(async () => {
      const out = {};
      const h = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const ws = h.workspaceState();
      out.beforeReplace = ws;
      out.tab1RootBefore = ws.tabs[0].rootId;
      const docC = ${JSON.stringify(DOC_C)};
      await h.loadText(JSON.stringify(docC), 'c.json');
      await sleep(500);
      out.replaced = h.workspaceState();
      out.replacedState = h.state();
      out.replacedLabels = [...document.querySelectorAll('#tabStrip .tabstrip__title')].map((el) => el.textContent);
      out.replacedChip = document.getElementById('fileName').textContent;
      // tab1 完全不受影响
      h.tabSwitch(ws.tabs[0].id);
      await sleep(400);
      out.tab1AfterReplace = h.state();
      return out;
    })()`,
  );

  /* ---- phase 5：关标签（活动 → 相邻接管；只剩 1 个 → 隐藏；关最后 → 空态）---- */
  await runPhase(
    'close',
    `(async () => {
      const out = {};
      const h = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const ws = h.workspaceState();
      const tab1 = ws.tabs[0].id;
      const tab2 = ws.tabs[1].id;
      // 关非活动的 tab1：活动标签仍是 tab2
      out.closeInactive = await h.tabClose(tab1);
      await sleep(250);
      // 关剩下的 tab2 → 空态
      out.closeLast = await h.tabClose(tab2);
      await sleep(400);
      out.empty = h.workspaceState();
      out.emptyState = h.state();
      out.emptyLayerVisible = !document.getElementById('empty').classList.contains('is-hidden');
      out.emptyLayerMode = document.getElementById('empty').dataset.mode ?? null;
      out.emptyChipHidden = document.getElementById('fileChip').hidden;
      out.emptyStatus = document.getElementById('statusRows').textContent;
      out.emptyExportDisabled = document.getElementById('exportBtn').disabled;
      out.emptyStripHiddenAttr = document.getElementById('tabStrip').hidden;
      out.emptyViewport = document.querySelector('.tjv-tree')?.clientHeight ?? 0;
      return out;
    })()`,
  );

  /* ---- phase 6：软上限 8 ---- */
  await runPhase(
    'cap',
    `(async () => {
      const out = {};
      const h = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const docB = ${JSON.stringify(DOC_B)};
      await h.loadText(JSON.stringify(docB), 'one.json');
      await sleep(400);
      out.capAfterFirst = h.workspaceState();
      for (let i = 2; i <= 8; i++) {
        h.tabOpen();
        await sleep(80);
        await h.tabImportText(JSON.stringify({ name: 't' + i }), 't' + i + '.json');
        await sleep(180);
      }
      out.cap = h.workspaceState();
      const addBtn = document.getElementById('tabAdd');
      out.capAddBtn = { disabled: addBtn.disabled, title: addBtn.title };
      // 第 9 个：入口层打不开（canAdd=false）
      h.tabOpen();
      await sleep(120);
      out.capNinth = {
        layerOpen: h.workspaceState().strip.layer.open,
        size: h.workspaceState().size,
        toast: h.toastText(),
      };
      // 逐个关掉，回空态
      let ws = h.workspaceState();
      for (const tab of ws.tabs) {
        await h.tabClose(tab.id);
        await sleep(120);
      }
      out.capClosed = h.workspaceState();
      return out;
    })()`,
  );

  /* ---- phase 7：内存提示（第 2+ 份大文档）+ 截图 ---- */
  await runPhase(
    'memory',
    `(async () => {
      const out = {};
      const h = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const docB = ${JSON.stringify(DOC_B)};
      await h.loadText(JSON.stringify(docB), 'small.json');
      await sleep(400);
      // 第 2 个小文档：不应提示
      h.tabOpen();
      await sleep(80);
      await h.tabImportText(JSON.stringify({ name: 'small2' }), 'small2.json');
      await sleep(300);
      out.smallToast = h.toastText();
      // 关掉小标签，再开 10MB + 50MB（合计 ≥ 50MB → 提示）
      const ws = h.workspaceState();
      await h.tabClose(ws.tabs[1].id);
      await sleep(250);
      const ten = await (await fetch('/.spike/samples/10mb.json')).text();
      await h.loadText(ten, '10mb.json');
      await sleep(1200);
      const fifty = await (await fetch('/.spike/samples/50mb.json')).text();
      h.tabOpen();
      await sleep(120);
      out.fifty = await h.tabImportText(fifty, '50mb.json');
      out.memoryToast = h.toastText();
      return out;
    })()`,
  );
  await page.screenshot(path.join(SHOTS, 'workspace-two-tabs.png'));

  await runPhase(
    'light',
    `(async () => {
      const out = {};
      const h = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const ws = h.workspaceState();
      // 关掉 50MB 标签，再开一个小标签 → 两个轻量文档，亮色截图看标签条
      await h.tabClose(ws.tabs[ws.tabs.length - 1].id);
      await sleep(300);
      h.tabOpen();
      await sleep(120);
      const docB = ${JSON.stringify(DOC_B)};
      await h.tabImportText(JSON.stringify(docB), 'b.json');
      await sleep(300);
      h.setSetting('theme', 'light');
      await sleep(300);
      out.light = h.workspaceState();
      out.lightTheme = document.documentElement.dataset.theme;
      return out;
    })()`,
  );
  await page.screenshot(path.join(SHOTS, 'workspace-light.png'));

  /* ---- phase 8：标签拖拽排序 + 拖放暂存文件后「在新标签中打开」应立即导入 ---- */
  await runPhase(
    'drag',
    `(async () => {
      const out = {};
      const h = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const strip = document.getElementById('tabStrip');
      const tabEls = () => [...strip.querySelectorAll('.tabstrip__tab')];
      out.before = h.workspaceState().tabs.map((tab) => ({ id: tab.id, name: tab.name }));
      out.activeBefore = h.workspaceState().activeId;

      // 拖第 1 个标签到第 2 个之后（合成 HTML5 drag 事件；内部拖拽用 dragId，不依赖文件）
      const src = tabEls()[0];
      const dst = tabEls()[1];
      const dt = new DataTransfer();
      src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      const dstRect = dst.getBoundingClientRect();
      const dropX = dstRect.right - 2;
      const dropY = dstRect.top + 8;
      dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, clientX: dropX, clientY: dropY }));
      out.indicator = {
        hidden: document.querySelector('.tabstrip__drop')?.hidden ?? null,
        index: document.getElementById('tabStripItems')?.dataset.dropIndex ?? null,
      };
      dst.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt, clientX: dropX, clientY: dropY }));
      src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
      await sleep(300);
      out.after = h.workspaceState().tabs.map((tab) => ({ id: tab.id, name: tab.name }));
      out.activeAfter = h.workspaceState().activeId;
      out.activeLabelAfter = document.querySelector('#tabStrip [aria-selected="true"] .tabstrip__title')?.textContent ?? null;

      // 拖文件到文档视图 → 弹层暂存；点「在新标签中打开」应立即以新标签导入并展示（不再要求二次确认）
      const payload = JSON.stringify({ name: 'dropped.json', n: 1 });
      const file = new File([payload], 'dropped.json', { type: 'application/json' });
      const dt2 = new DataTransfer();
      dt2.items.add(file);
      const treeWrap = document.querySelector('.tree-wrap');
      const box = treeWrap.getBoundingClientRect();
      treeWrap.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt2, clientX: box.left + 40, clientY: box.top + 40 }));
      await sleep(300);
      out.pendingLayer = {
        open: !document.getElementById('empty').classList.contains('is-hidden'),
        mode: document.getElementById('empty').dataset.mode ?? null,
        pendingVisible: !document.getElementById('emptyPending').hidden,
        toggleText: document.getElementById('emptyModeToggle').textContent,
      };
      document.getElementById('emptyModeToggle').click();
      await sleep(1200);
      out.dropped = {
        size: h.workspaceState().size,
        layerOpen: !document.getElementById('empty').classList.contains('is-hidden'),
        activeLabel: document.querySelector('#tabStrip [aria-selected="true"] .tabstrip__title')?.textContent ?? null,
        chip: document.getElementById('fileName').textContent,
        names: h.workspaceState().tabs.map((tab) => tab.name),
      };
      return out;
    })()`,
  );

  // ---- 标签就地改名（#29 / ADR-0021）----
  await runPhase(
    'rename-open',
    `(async () => {
      const out = {};
      const h = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      h.setSetting('theme', 'dark');
      await sleep(150);
      const activeId = h.workspaceState().activeId;
      const tabEl = document.querySelector('#tabStrip .tabstrip__tab[data-tab-id="' + activeId + '"]');
      const titleEl = tabEl?.querySelector('.tabstrip__title');
      out.activeId = activeId;
      out.nameBefore = h.workspaceState().tabs.find((tab) => tab.id === activeId)?.name ?? null;
      titleEl?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      await sleep(150);
      const input = tabEl?.querySelector('.tabstrip__rename');
      out.renameOpen = {
        isInput: input?.tagName === 'INPUT',
        value: input?.value ?? null,
        allSelected: input ? input.selectionStart === 0 && input.selectionEnd === input.value.length : false,
        draggable: tabEl?.getAttribute('draggable'),
      };
      return out;
    })()`,
  );
  await page.screenshot(path.join(SHOTS, 'workspace-rename.png'));

  await runPhase(
    'rename-commit',
    `(async () => {
      const out = {};
      const h = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const activeId = h.workspaceState().activeId;
      const tabSel = '#tabStrip .tabstrip__tab[data-tab-id="' + activeId + '"]';
      // Esc：取消，名字不变
      document.querySelector('#tabStrip .tabstrip__rename')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
      await sleep(150);
      out.renameCancel = {
        inputGone: document.querySelector('#tabStrip .tabstrip__rename') === null,
        name: h.workspaceState().tabs.find((tab) => tab.id === activeId)?.name ?? null,
      };
      // F2：键盘入口再进一次编辑，输入新名 + Enter
      document.querySelector(tabSel)?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'F2', bubbles: true }),
      );
      await sleep(150);
      const input2 = document.querySelector('#tabStrip .tabstrip__rename');
      out.renameF2 = { isInput: input2?.tagName === 'INPUT' };
      if (input2) {
        input2.value = '订单 2024.json';
        input2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      }
      await sleep(250);
      const tabAfter = document.querySelector(tabSel);
      out.renameCommit = {
        name: h.workspaceState().tabs.find((tab) => tab.id === activeId)?.name ?? null,
        chip: document.getElementById('fileName').textContent,
        label: tabAfter?.querySelector('.tabstrip__title')?.textContent ?? null,
        tabTitle: tabAfter?.getAttribute('title') ?? null,
      };
      // 空白提交 = 保持原名
      tabAfter?.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }));
      await sleep(150);
      const input3 = document.querySelector('#tabStrip .tabstrip__rename');
      if (input3) {
        input3.value = '   ';
        input3.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      }
      await sleep(200);
      out.renameBlank = {
        name: h.workspaceState().tabs.find((tab) => tab.id === activeId)?.name ?? null,
        label: document.querySelector(tabSel + ' .tabstrip__title')?.textContent ?? null,
      };
      h.setSetting('theme', 'light');
      await sleep(150);
      return out;
    })()`,
  );
  await page.screenshot(path.join(SHOTS, 'workspace-rename-light.png'));

  // 双击**非活动**标签：首击切标签会整条重绘，改名靠第二击（detail=2）兜住靶点更替
  await runPhase(
    'rename-nonactive',
    `(async () => {
      const out = {};
      const h = window.__tjv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const activeBefore = h.workspaceState().activeId;
      const target = h.workspaceState().tabs.find((tab) => tab.id !== activeBefore);
      const titleOf = () =>
        document.querySelector('#tabStrip .tabstrip__tab[data-tab-id="' + target.id + '"] .tabstrip__title');
      titleOf()?.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
      await sleep(200);
      const activated = h.workspaceState().activeId === target.id;
      titleOf()?.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }));
      await sleep(200);
      const input = document.querySelector(
        '#tabStrip .tabstrip__tab[data-tab-id="' + target.id + '"] .tabstrip__rename',
      );
      out.renameNonActive = {
        activated,
        isInput: input?.tagName === 'INPUT',
        value: input?.value ?? null,
        name: target.name,
      };
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(150);
      out.renameNonActive.restored =
        h.workspaceState().tabs.find((tab) => tab.id === target.id)?.name === target.name;
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

const tabIds = report.boot?.tabs ?? [];
const checks = {
  // 空态
  'boot:empty-workspace':
    report.boot?.size === 0 &&
    report.boot?.activeId === null &&
    report.boot?.canAdd === false &&
    report.boot?.hidden === true,
  'boot:empty-layer': report.bootLayerVisible === true && report.bootStripHiddenAttr === true,
  'boot:no-doc': report.bootState?.rootId === null,

  // 单文档：标签条必须隐藏、零视觉变化
  'single:one-tab':
    report.single?.size === 1 &&
    report.single?.hidden === true &&
    report.single?.strip?.hidden === true &&
    report.single?.strip?.rendered === 1,
  'single:zero-height':
    report.single?.strip?.heightPx === 0 &&
    report.single?.strip?.hidden === true &&
    report.single?.strip?.styleHeightPx === 32,
  'single:doc-loaded':
    typeof report.singleRoot === 'string' &&
    /^doc:\d+$/.test(report.singleRoot) &&
    report.singleState?.rootId === report.singleRoot &&
    report.singleChipHidden === false,
  'single:tree-viewport': report.singleViewport > 0,

  // 第 2 个标签
  'tab-add:replace-layer-first':
    report.replaceLayer?.open === true &&
    report.replaceLayer?.mode === 'replace' &&
    report.replaceLayer?.warnHidden === false &&
    report.replaceLayer?.toggleText === '在新标签中打开',
  // 模态入口层必须把左面板一起遮住（z-index 32 > 左面板 31），且左面板确实开着
  'tab-add:layer-covers-left-panel':
    report.replaceLayer?.panelDisplay === 'flex' &&
    report.replaceLayer?.layerZ === '32' &&
    report.replaceLayer?.panelCovered === true,
  'tab-add:new-tab-layer':
    report.layer?.open === true && report.layer?.mode === 'new-tab' && report.layerWarnHidden === true,
  'tab-add:layer-copy':
    report.layerTitle === '在新标签中打开' && report.layerToggleText === '改为替换当前文档',
  'tab-add:two-tabs':
    report.two?.size === 2 &&
    report.two?.hidden === false &&
    report.two?.activeId === report.tab2Id &&
    report.two?.strip?.rendered === 2,
  'tab-add:strip-visible':
    report.stripDisplay !== 'none' && report.stripRole === 'tablist' && report.stripAria === '文档标签',
  'tab-add:strip-height': report.two?.strip?.heightPx === 32 && report.two?.strip?.styleHeightPx === 32,
  'tab-add:tab-a11y':
    report.tabEls?.length === 2 &&
    report.tabEls.every((entry) => entry.role === 'tab') &&
    report.tabEls[0].title === 'a.json' &&
    report.tabEls[1].title === 'b.json' &&
    report.tabEls[0].selected === 'false' &&
    report.tabEls[1].selected === 'true',
  'tab-add:active-is-new':
    report.twoState?.rootId === report.tab2Root &&
    report.tab2Root !== report.singleRoot &&
    report.activeTitleEl === 'b.json',
  'tab-add:tree-viewport-shrinks':
    report.twoViewport > 0 && report.singleViewport - report.twoViewport === 32,

  // 每标签独立视图态
  'per-tab:tab1-expanded': (report.tab1Expanded?.totalRows ?? 0) > 500,
  'per-tab:tab1-search': (report.tab1Search?.size ?? 0) > 0 && report.tab1Search?.phase === 'ready',
  'per-tab:tab1-selected': typeof report.savedSelected === 'string' && report.savedScroll > 0,
  'per-tab:tab2-is-independent':
    report.tab2Fresh?.selected === null &&
    report.tab2Search?.size === 0 &&
    report.tab2Fresh?.totalRows !== report.savedRows,
  'per-tab:tab2-own-toggle':
    (report.tab2Collapsed?.totalRows ?? -1) < (report.tab2Fresh?.totalRows ?? 0) &&
    report.tab2Collapsed?.totalRows > 0,
  'per-tab:back-restores-state':
    report.tab1Restored?.totalRows === report.savedRows &&
    report.tab1Restored?.selected === report.savedSelected &&
    Math.abs((report.tab1Restored?.scrollTop ?? -1) - report.savedScroll) < 2,
  'per-tab:back-restores-search':
    report.tab1SearchRestored?.size === report.tab1Search?.size &&
    report.tab1SearchRestored?.query === report.tab1Search?.query &&
    report.searchInputRestored === report.tab1Search?.query,
  'per-tab:tab2-keeps-toggle':
    report.tab2Restored?.totalRows === report.tab2Collapsed?.totalRows,

  // 表达式结果视图按标签隔离
  'expression:per-tab-active':
    report.exprRun?.active === true && report.exprActiveTab1 === true,
  'expression:switch-hides':
    report.exprOnTab2?.active === false &&
    report.exprOnTab2?.barHidden === true &&
    report.exprOnTab2?.treeRoot === report.tab2RootNow,
  'expression:result-root-expand':
    report.exprToggleApplied === true &&
    (report.exprExpand?.rows ?? 0) > (report.exprToggle?.rows ?? 0) &&
    (report.exprExpand?.rv ?? 0) > (report.exprToggle?.rv ?? 0),
  'expression:import-exits-view':
    report.exprImport?.active === false &&
    report.exprImport?.barHidden === true &&
    (report.exprImport?.rows ?? 99) <= 10,
  'expression:import-keeps-tab-clean':
    report.exprImportBack?.root === report.exprImport?.root &&
    report.exprImportBack?.rows === report.exprImport?.rows,
  'expression:restore-on-back':
    report.exprBack?.active === true &&
    report.exprBack?.panel === 'expression' &&
    report.exprBackToTab2 === false,

  // 替换当前标签
  'replace:same-tab-count':
    report.replaced?.size === 2 &&
    report.replaced?.activeId === report.beforeReplace?.activeId &&
    report.replaced?.tabs?.[1]?.rootId !== report.beforeReplace?.tabs?.[1]?.rootId,
  'replace:new-root-and-name':
    /^doc:\d+$/.test(report.replaced?.tabs?.[1]?.rootId ?? '') &&
    report.replacedLabels?.[1] === 'c.json' &&
    report.replacedChip === 'c.json' &&
    report.replacedState?.rootId === report.replaced?.tabs?.[1]?.rootId,
  'replace:other-tab-untouched':
    report.replaced?.tabs?.[0]?.rootId === report.beforeReplace?.tabs?.[0]?.rootId &&
    report.tab1AfterReplace?.rootId === report.beforeReplace?.tabs?.[0]?.rootId,

  // 关标签
  'close:inactive-stays-active': report.closeInactive?.size === 1 && report.closeInactive?.hidden === true,
  'close:last-to-empty':
    report.closeLast?.size === 0 &&
    report.closeLast?.activeId === null &&
    report.closeLast?.strip?.hidden === true,
  'close:empty-ui':
    report.emptyLayerVisible === true &&
    report.emptyLayerMode === 'initial' &&
    report.emptyChipHidden === true &&
    report.emptyExportDisabled === true &&
    report.emptyStripHiddenAttr === true &&
    report.emptyStatus === '未打开文档',
  'close:empty-no-doc': report.emptyState?.rootId === null && report.emptyViewport > 0,

  // 软上限 8
  'cap:eight-tabs': report.cap?.size === 8 && report.cap?.strip?.rendered === 8,
  'cap:add-disabled':
    report.cap?.canAdd === false &&
    report.capAddBtn?.disabled === true &&
    report.capAddBtn?.title === '最多 8 个标签',
  'cap:ninth-blocked': report.capNinth?.size === 8 && report.capNinth?.layerOpen === false,
  'cap:close-all-empty': report.capClosed?.size === 0 && report.capClosed?.activeId === null,

  // 内存提示
  'memory:small-second-no-hint': !/线性增长/.test(report.smallToast ?? ''),
  'memory:big-second-hint':
    report.fifty?.size === 2 && /内存按文档线性增长/.test(report.memoryToast ?? ''),

  // 亮色主题下标签条仍在
  'light:two-tabs-visible':
    report.lightTheme === 'light' &&
    report.light?.size === 2 &&
    report.light?.hidden === false &&
    report.light?.strip?.heightPx === 32,

  // 标签拖拽排序（#18 修订 2026-11-11）
  'drag:indicator':
    report.indicator?.hidden === false && report.indicator?.index === '2',
  'drag:reorder': (() => {
    const before = report.before ?? [];
    if (before.length < 2) return false;
    // 把第 1 个标签拖到最后 → 期望顺序 = 其余标签依次 + 原第 1 个
    const expected = [...before.slice(1), before[0]].map((tab) => tab.id);
    const actual = (report.after ?? []).map((tab) => tab.id);
    const activeBefore = before.find((tab) => tab.id === report.activeBefore);
    return (
      JSON.stringify(actual) === JSON.stringify(expected) &&
      report.activeAfter === report.activeBefore &&
      report.activeLabelAfter === activeBefore?.name
    );
  })(),
  // 拖文件到文档视图 → 暂存层 → 点「在新标签中打开」应立即新开标签并展示
  'drag:pending-layer':
    report.pendingLayer?.open === true &&
    report.pendingLayer?.mode === 'replace' &&
    report.pendingLayer?.pendingVisible === true &&
    report.pendingLayer?.toggleText === '在新标签中打开',
  'drag:pending-new-tab-immediate':
    report.dropped?.layerOpen === false &&
    report.dropped?.size === (report.before?.length ?? 0) + 1 &&
    report.dropped?.activeLabel === 'dropped.json' &&
    report.dropped?.chip === 'dropped.json' &&
    (report.dropped?.names ?? []).includes('dropped.json'),

  // 标签就地改名（#29 / ADR-0021）
  'rename:inline-open':
    report.renameOpen?.isInput === true &&
    report.renameOpen?.value === report.nameBefore &&
    report.renameOpen?.allSelected === true &&
    report.renameOpen?.draggable === 'false',
  'rename:esc-cancels':
    report.renameCancel?.inputGone === true && report.renameCancel?.name === report.nameBefore,
  'rename:f2-opens': report.renameF2?.isInput === true,
  'rename:commit-syncs-chip-and-tab':
    report.renameCommit?.name === '订单 2024' &&
    report.renameCommit?.label === '订单 2024' &&
    report.renameCommit?.chip === '订单 2024' &&
    report.renameCommit?.tabTitle === '订单 2024（原名：' + report.nameBefore + '）',
  'rename:blank-keeps-name':
    report.renameBlank?.name === '订单 2024' && report.renameBlank?.label === '订单 2024',
  'rename:non-active-tab-opens':
    report.renameNonActive?.activated === true &&
    report.renameNonActive?.isInput === true &&
    report.renameNonActive?.value === report.renameNonActive?.name &&
    report.renameNonActive?.restored === true,

  'console:no-exception-no-error':
    report.consoleErrors?.length === 0 && report.consoleErrorLogs?.length === 0,
};

void tabIds;
if (report.errors) console.log(`\nphase errors: ${JSON.stringify(report.errors, null, 2)}`);
for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? '✅' : '❌'} ${name}`);
const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
const passed = Object.keys(checks).length - failed.length;
const total = Object.keys(checks).length;
console.log(`\nsmoke-workspace: ${passed}/${total} ${failed.length === 0 ? 'OK' : `FAILED ${failed.join(',')}`}`);
process.exitCode = failed.length === 0 ? 0 : 1;
