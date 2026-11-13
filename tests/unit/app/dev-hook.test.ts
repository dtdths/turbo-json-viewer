/**
 * tests/unit/app/dev-hook — 测试钩子的 API 契约与纯快照组装（ADR-0008 修订 2026-11-09）。
 *
 * 目的：把「hook 输出形状 = 13 套冒烟的断言契约」从浏览器冒烟提升为 node 环境单测。
 * 只测纯转发 / 纯快照方法；DOM 点击与布局探针（treeGeometry 的 computed style）仍由浏览器冒烟兜底。
 */
import { describe, expect, it } from 'vitest';
import { createDevHook, type DevHookDeps } from '../../../src/app/dev-hook';
import { DocSession } from '../../../src/app/doc-session';
import { CoreError } from '../../../src/protocol/errors';

/** 83 个成员逐个列出：成员名 / 数量是冒烟脚本的硬契约（Object.keys + required 探测）。 */
const HOOK_MEMBERS = [
  'loadText', 'scrollToPx', 'togglePath', 'expandAll', 'collapseAll', 'state',
  'search', 'searchNext', 'searchPrev', 'searchJump', 'searchMarkStale', 'setSearchFilter',
  'searchPanel', 'searchListScrollTo',
  'outlineState', 'outlineOpen', 'outlineToggle', 'outlineLoadMore', 'outlineJump',
  'editOpen', 'editText', 'editSetText', 'editClickApply', 'editApplyText', 'editClose',
  'undo', 'redo', 'resetEdits', 'exportDocText', 'editBadgeText',
  'ctxOpen', 'ctxClick', 'copyResolve', 'clipboardText', 'toastText',
  'exportState', 'exportMenuOpen', 'exportClick', 'exportChoose',
  'settingsState', 'setSetting', 'settingsOpen', 'treeGeometry',
  'repairState', 'repairToggle', 'repairClose',
  'fidelityState', 'fidelityJump', 'fidelityClose',
  'rawState', 'setViewMode', 'rawScrollTo', 'rawWindowText', 'rawLocate', 'rawRevealAt',
  'rawRepairAt', 'rawCopyText', 'rawCopy',
  // #30 / ADR-0019：双向定位（7 个）
  'locateState', 'rawPathAt', 'rawOffsetOf', 'rawLocateClick', 'treeLocateClick',
  'rawCtxOpen', 'rawCtxClick',
  // #27 / ADR-0018 §9：表达式视图（11 个）
  'expressionState', 'expressionOpen', 'expressionSetText', 'expressionRun', 'expressionRunText',
  'expressionComplete', 'expressionSetStrict', 'expressionBack', 'expressionRerun', 'expressionLocate',
  'expressionSetBudget',
  // #18 / ADR-0009 §9：多文档工作区（6 个）
  'workspaceState', 'tabStripState', 'tabOpen', 'tabImportText', 'tabSwitch', 'tabClose',
  // #43 / ADR-0025：文档概要（1 个）
  'documentProfile',
].sort();

function fakeElement(over: Record<string, unknown> = {}): HTMLElement {
  return {
    hidden: false,
    textContent: '',
    disabled: false,
    dataset: {},
    classList: { contains: () => false },
    getAttribute: () => null,
    querySelectorAll: () => [],
    cloneNode: function () {
      return this;
    },
    ...over,
  } as unknown as HTMLElement;
}

function fakeDeps(over: Record<string, unknown> = {}): DevHookDeps {
  const session = new DocSession();
  const base = {
    session,
    core: {},
    meta: () => null,
    selected: () => null,
    editingPath: () => null,
    setEditingPath: () => {},
    isRawView: () => false,
    viewModeAttr: () => 'tree',
    rawMetaInfo: () => null,
    fidelityReport: () => null,
    fidelityPending: () => false,
    fidelityIndex: () => 0,
    exportLastAction: () => null,
    exportFileName: () => null,
    documentProfile: async () => null,
    tree: {
      scrollTopPx: () => 0,
      rowHeightPx: () => 24,
      viewportRows: () => 30,
      currentRowRendered: () => false,
      rowInfo: () => null,
    },
    rowSource: {
      snapshot: () => ({ rootId: 'doc', rows: [], start: 0, totalRows: 0, rowVersion: 0, stale: false, scrollTopPx: 0 }),
    },
    rawView: { scrollTopPx: () => 0, viewportRows: () => 30, renderedLines: () => [], flashedLine: () => null },
    rawSource: {
      snapshot: () => ({ rootId: 'doc', mode: 'source', lines: [], truncated: [], start: 0, totalLines: 0, stale: false, scrollTopPx: 0 }),
    },
    searchState: {
      view: () => ({ phase: 'idle', total: 0, size: 0, current: -1, counts: {}, filter: 'all', truncated: false, caseSensitive: false, regex: false, patternError: null }),
      query: '',
      stale: false,
      currentHit: () => null,
    },
    searchPanel: {
      renderedCount: () => 0,
      state: () => ({ rendered: 0, listScrollTop: 0, listScrollHeight: 0, countText: '', posText: '', footText: '' }),
      listScrollTop: () => 0,
      scrollListTo: () => {},
    },
    outlineState: {
      view: () => ({ phase: 'idle', rows: [], selected: null, loadedContainers: 0, loadedChildren: 0 }),
      expandedPaths: () => [],
      isExpanded: () => false,
      setOpen: async () => true,
      loadMore: async () => true,
    },
    outlinePanel: { renderedCount: () => 0, scrollTopPx: () => 0 },
    editState: { count: 0, canUndo: false, canRedo: false },
    subtreeEditor: { isOpen: () => false, getValue: () => '', setValue: () => {}, close: () => {} },
    settings: {
      snapshot: () => ({ theme: 'dark', rowHeight: 24, indent: 8, jsonIndent: 2, escapeUnicode: false }),
      uiState: () => ({ panel: 'doc', railCollapsed: false, viewMode: 'tree' }),
      loadedFromStore: false,
      get: () => 0,
    },
    entries: {
      importText: async () => {},
      toggleNode: async () => {},
      expandAll: async () => {},
      runSearch: async () => true,
      searchNext: async () => -1,
      searchPrev: async () => -1,
      gotoHit: async () => -1,
      applyFilter: () => {},
      markSearchStale: () => false,
      setPanel: () => {},
      jumpToPath: async () => ({ ok: true, row: 0 }),
      openEditor: async () => {},
      applyEditText: async () => {},
      undo: async () => true,
      redo: async () => true,
      resetEdits: async () => true,
      setViewMode: async () => {},
      revealRepairOffset: async () => 1,
      jumpTreeToRaw: async () => -1,
      jumpRawToTree: async () => null,
      locateBusy: () => false,
      locateAnchor: () => null,
      rawCtxMenu: fakeElement(),
      rawCtxOpen: () => {},
      openSettings: () => ({ panel: 'settings', title: '', focused: false, rows: [] }),
      treeGeometry: () => ({
        rowHeight: 24,
        viewportRows: 30,
        totalRows: 0,
        rowHeightCss: '24px',
        rowHeightComputed: '24px',
        indentCss: '8px',
        typeColumnVisible: true,
        spacerHeight: '0px',
      }),
      contextMenu: { menu: fakeElement(), items: () => [], show: () => {}, rowElement: () => null },
      clipboardText: async () => null,
    },
    expression: {
      panel: {
        state: () => ({ text: '', strict: false, running: false, status: '', error: null, examples: [], history: [] }),
      },
      bar: {
        state: () => ({ hidden: true, text: '', stale: false, truncated: false, rerunVisible: false, backVisible: false }),
      },
      view: () => null,
      active: () => false,
      stale: () => false,
      budget: () => 'standard',
      statusState: () => '',
      entries: {
        open: async () => {},
        setText: () => {},
        run: async () => {},
        runText: async () => {},
        complete: async () => [],
        setStrict: () => {},
        back: () => {},
        rerun: async () => {},
        locate: async () => ({ path: null }),
        setBudget: () => false,
      },
    },
    workspace: {
      state: () => ({
        size: 0,
        max: 8,
        activeId: null,
        canAdd: false,
        hidden: true,
        tabs: [],
        strip: {
          hidden: true,
          heightPx: 32,
          role: 'tablist',
          rendered: 0,
          addDisabled: true,
          addTitle: '',
          labels: [],
          selectedId: null,
          layer: { open: false, mode: 'initial' },
        },
      }),
      entries: {
        openNewTab: () => {},
        importText: async () => {},
        switchTab: () => {},
        closeTab: async () => {},
      },
    },
    ui: {
      statusRows: fakeElement({ textContent: '0 行' }),
      editBadge: fakeElement({ hidden: true, textContent: '已修改 0 处' }),
      toast: fakeElement({ hidden: true, textContent: '' }),
      viewTreeBtn: fakeElement() as HTMLButtonElement,
      viewRawBtn: fakeElement() as HTMLButtonElement,
      rawNotice: fakeElement({ textContent: '' }),
      rawMetaLabel: fakeElement({ textContent: '' }),
      rawModeLabel: fakeElement({ textContent: '' }),
      rawCopyBtn: fakeElement() as HTMLButtonElement,
      repairBar: fakeElement({ hidden: true }),
      repairText: fakeElement({ textContent: '' }),
      repairOps: fakeElement({ hidden: true }),
      repairToggle: fakeElement() as HTMLButtonElement,
      repairClose: fakeElement() as HTMLButtonElement,
      repairStatusState: fakeElement({ textContent: '' }),
      fidelityBar: fakeElement({ hidden: true }),
      fidelityNotice: { text: () => '' } as unknown as DevHookDeps['ui']['fidelityNotice'],
      fidelityJump: fakeElement() as HTMLButtonElement,
      fidelityClose: fakeElement() as HTMLButtonElement,
      fidelityPrev: fakeElement({ disabled: true }) as HTMLButtonElement,
      fidelityNext: fakeElement({ disabled: false }) as HTMLButtonElement,
      fidelityCount: fakeElement({ textContent: '' }),
      exportBtn: fakeElement({ textContent: '导出' }) as HTMLButtonElement,
      exportMenu: fakeElement({ hidden: true }),
      exportMenuBtn: fakeElement() as HTMLButtonElement,
      exportMenuItems: () => [],
      currentExportMode: () => 'file',
      chooseExport: () => true,
      openExportMenu: () => {},
      clickExportMain: () => {},
      clipboardMaxBytes: () => 20 * 1024 * 1024,
    },
  };
  return { ...base, ...over } as unknown as DevHookDeps;
}

describe('dev hook — API 契约与纯快照组装', () => {
  it('成员表逐字保持（82 个，顺序无关）', () => {
    const hook = createDevHook(fakeDeps());
    expect(Object.keys(hook).sort()).toEqual(HOOK_MEMBERS);
    for (const key of HOOK_MEMBERS) expect(typeof hook[key]).toBe('function');
  });

  it('state()：会话字段 / 行窗口 / 编辑态 / 视图模式就地组装', () => {
    const deps = fakeDeps({
      selected: () => '$.a',
      tree: { ...fakeDeps().tree, scrollTopPx: () => 48 },
      rowSource: {
        snapshot: () => ({ rootId: 'doc', rows: [{}, {}] as never[], start: 3, totalRows: 100, rowVersion: 5, stale: false, scrollTopPx: 48 }),
      },
      editState: { count: 2, canUndo: true, canRedo: false },
      isRawView: () => true,
    });
    deps.session.land({ rootId: 'doc', docRevision: 4, rowVersion: 5, totalRows: 100 }, { kind: 'document' });
    const hook = createDevHook(deps);
    expect(hook.state()).toEqual({
      rootId: 'doc',
      totalRows: 100,
      rowVersion: 5,
      docRevision: 4,
      selected: '$.a',
      rendered: 2,
      start: 3,
      scrollTop: 48,
      editCount: 2,
      canUndo: true,
      canRedo: false,
      viewMode: 'raw',
    });
  });

  it('searchPanel()：模块自报的计数/文本/滚动几何 + 别名与当前命中路径', () => {
    const deps = fakeDeps({
      searchState: {
        view: () => ({ phase: 'ready', total: 3, size: 3, current: 1, counts: { all: 3, key: 2, value: 1, path: 0 }, filter: 'key', truncated: false, caseSensitive: true, regex: false, patternError: null }),
        query: 'a',
        stale: false,
        currentHit: () => ({ path: '$.a.b' }),
      },
      searchPanel: {
        renderedCount: () => 3,
        state: () => ({ rendered: 3, listScrollTop: 44, listScrollHeight: 132, countText: '3', posText: '2 / 3', footText: '3 条' }),
        listScrollTop: () => 44,
        scrollListTo: () => {},
      },
      tree: { ...fakeDeps().tree, currentRowRendered: () => true },
    });
    const diag = createDevHook(deps).searchPanel();
    expect(diag).toMatchObject({
      phase: 'ready',
      query: 'a',
      total: 3,
      size: 3,
      current: 1,
      counts: { all: 3, key: 2, value: 1, path: 0 },
      filter: 'key',
      caseSensitive: true,
      rendered: 3,
      treeCurrentVisible: true,
      scrollTop: 44,
      scrollHeight: 132,
      listScrollTop: 44,
      listScrollHeight: 132,
      countText: '3',
      posText: '2 / 3',
      footText: '3 条',
      path: '$.a.b',
    });
  });

  it('repairState()：meta 字段 + 修复条 DOM + 导出名组合', () => {
    const deps = fakeDeps({
      meta: () => ({
        name: 'cut.json',
        repair: { status: 'repaired', ops: [{ at: 12 }], summaryText: '补 1 处', counts: { missing: 1 }, truncatedAt: 12 },
      }) as never,
      exportFileName: () => 'cut-truncated-repaired.json',
      ui: {
        ...fakeDeps().ui,
        repairBar: fakeElement({ hidden: false }),
        repairText: fakeElement({ textContent: '已修复 1 处' }),
        repairOps: fakeElement({ hidden: false, querySelectorAll: () => [fakeElement({ textContent: 'op1' })] }),
        repairStatusState: fakeElement({ textContent: '已修复截断' }),
      },
    });
    expect(createDevHook(deps).repairState()).toMatchObject({
      status: 'repaired',
      visible: true,
      text: '已修复 1 处',
      expanded: true,
      ops: ['op1'],
      summary: '补 1 处',
      counts: { missing: 1 },
      truncatedAt: 12,
      exportName: 'cut-truncated-repaired.json',
      statusState: '已修复截断',
    });
  });

  it('fidelityState()：报告 / 在途标记 / 提示条 / 视图模式', () => {
    const deps = fakeDeps({
      fidelityReport: () => ({ status: 'found', counts: { total: 1 }, hits: [{ kind: 'number' }], scanMs: 12, truncated: false }) as never,
      fidelityPending: () => false,
      viewModeAttr: () => 'raw',
      ui: {
        ...fakeDeps().ui,
        fidelityBar: fakeElement({ hidden: false }),
        fidelityNotice: { text: () => '检测到 1 处失真' } as unknown as DevHookDeps['ui']['fidelityNotice'],
        fidelityJump: fakeElement({ hidden: false }),
        statusRows: fakeElement({ textContent: '1,000 行' }),
      },
    });
    expect(createDevHook(deps).fidelityState()).toEqual({
      pending: false,
      status: 'found',
      counts: { total: 1 },
      hits: [{ kind: 'number' }],
      scanMs: 12,
      truncated: false,
      barVisible: true,
      barText: '检测到 1 处失真',
      jumpVisible: true,
      viewMode: 'raw',
      statusRows: '1,000 行',
      index: 0,
      hitCount: 1,
      counterText: '',
      prevDisabled: true,
      nextDisabled: false,
      statusState: '',
    });
  });

  it('settingsState()：设置快照 + ui 状态 + 持久化标记', () => {
    const deps = fakeDeps({
      settings: {
        snapshot: () => ({ theme: 'light', sortOrder: 'raw' }),
        uiState: () => ({ panel: 'search', railCollapsed: true, viewMode: 'raw' }),
        loadedFromStore: true,
        get: () => 0,
      } as never,
    });
    expect(createDevHook(deps).settingsState()).toEqual({
      theme: 'light',
      sortOrder: 'raw',
      ui: { panel: 'search', railCollapsed: true, viewMode: 'raw' },
      loadedFromStore: true,
    });
  });

  it('copyResolve：无文档 → NO_ROOT；core 错误 → 归一化 code/message/bytes', async () => {
    const noRoot = createDevHook(fakeDeps());
    await expect(noRoot.copyResolve('$.a', 'subtree')).resolves.toEqual({
      error: { code: 'NO_ROOT', message: 'no document loaded' },
    });

    const deps = fakeDeps({ core: { copyNode: async () => { throw new CoreError({ code: 'TOO_LARGE', message: 'too big', bytes: 9 }); } } as never });
    deps.session.land({ rootId: 'doc', docRevision: 1, rowVersion: 1, totalRows: 2 }, { kind: 'document' });
    await expect(createDevHook(deps).copyResolve('$.a', 'subtree')).resolves.toEqual({
      error: { code: 'TOO_LARGE', message: 'too big', bytes: 9 },
    });
  });

  it('exportDocText：无文档 → null；有文档 → core 文本 + 导出名', async () => {
    await expect(createDevHook(fakeDeps()).exportDocText()).resolves.toBeNull();

    const deps = fakeDeps({
      core: { exportDoc: async () => ({ text: '{"a":1}', bytes: 7 }) } as never,
      exportFileName: () => 'a-edited.json',
    });
    deps.session.land({ rootId: 'doc', docRevision: 1, rowVersion: 1, totalRows: 2 }, { kind: 'document' });
    await expect(createDevHook(deps).exportDocText()).resolves.toEqual({
      bytes: 7,
      text: '{"a":1}',
      name: 'a-edited.json',
    });
  });

  it('exportDocText：按当前 jsonIndent / escapeUnicode 调 core.exportDoc（#38 / ADR-0022 §7）', async () => {
    const calls: Array<{ rootId: string; indent?: number; escapeUnicode?: boolean }> = [];
    const deps = fakeDeps({
      core: {
        exportDoc: async (rootId: string, indent?: number, escapeUnicode?: boolean) => {
          calls.push({ rootId, indent, escapeUnicode });
          return { text: '{}', bytes: 2 };
        },
      } as never,
      settings: {
        ...fakeDeps().settings,
        get: (key: string) => (key === 'jsonIndent' ? 0 : key === 'escapeUnicode' ? true : 0),
      } as never,
    });
    deps.session.land({ rootId: 'doc', docRevision: 1, rowVersion: 1, totalRows: 2 }, { kind: 'document' });
    await createDevHook(deps).exportDocText();
    expect(calls).toEqual([{ rootId: 'doc', indent: 0, escapeUnicode: true }]);
  });

  it('copyResolve：子树复制 indent 跟随 jsonIndent 设置（#38 / ADR-0022 §3）', async () => {
    const indents: unknown[] = [];
    const deps = fakeDeps({
      core: {
        copyNode: async (cmd: { indent?: number }) => {
          indents.push(cmd.indent);
          return { text: 'json', bytes: 4, format: 'subtree' as const };
        },
      } as never,
      settings: { ...fakeDeps().settings, get: () => 4 } as never,
    });
    deps.session.land({ rootId: 'doc', docRevision: 1, rowVersion: 1, totalRows: 2 }, { kind: 'document' });
    await expect(createDevHook(deps).copyResolve('$.a', 'subtree')).resolves.toEqual({
      text: 'json',
      bytes: 4,
      format: 'subtree',
    });
    expect(indents).toEqual([4]);
  });

  it('纯转发：treeGeometry / editBadgeText / toastText 不重新解释', () => {
    const geometry = { rowHeight: 22, viewportRows: 20, totalRows: 5, rowHeightCss: '22px', rowHeightComputed: '22px', indentCss: '10px', typeColumnVisible: false, spacerHeight: '110px' };
    const deps = fakeDeps({
      entries: { ...fakeDeps().entries, treeGeometry: () => geometry },
      ui: {
        ...fakeDeps().ui,
        editBadge: fakeElement({ hidden: false, textContent: '已修改 2 处' }),
        toast: fakeElement({ hidden: false, textContent: '已复制' }),
      },
    });
    const hook = createDevHook(deps);
    expect(hook.treeGeometry()).toEqual(geometry);
    expect(hook.editBadgeText()).toEqual({ hidden: false, text: '已修改 2 处' });
    expect(hook.toastText()).toBe('已复制');
  });

  it('installDevHook 只在被调用时挂 globalThis.__tjv（模块 import 无副作用）', () => {
    expect((globalThis as { __tjv?: unknown }).__tjv).toBeUndefined();
  });

  /* ---- 多文档工作区（#18 / ADR-0009 §9） ---- */

  it('workspaceState / tabStripState：纯转发，不重新组装', () => {
    const state = {
      size: 2,
      max: 8,
      activeId: 'tab:2',
      canAdd: true,
      hidden: false,
      tabs: [
        { id: 'tab:1', name: 'a.json', active: false, rootId: 'doc:1', docRevision: 1, totalRows: 4, editCount: 0 },
        { id: 'tab:2', name: 'b.json', active: true, rootId: 'doc:2', docRevision: 2, totalRows: 7, editCount: 1 },
      ],
      strip: {
        hidden: false,
        heightPx: 32,
        role: 'tablist',
        rendered: 2,
        addDisabled: false,
        addTitle: '新标签（⌘⇧O）',
        labels: ['a.json', 'b.json'],
        selectedId: 'tab:2',
        layer: { open: false, mode: 'initial' },
      },
    };
    const deps = fakeDeps({ workspace: { state: () => state, entries: fakeDeps().workspace.entries } });
    const hook = createDevHook(deps);
    expect(hook.workspaceState()).toEqual(state);
    expect(hook.tabStripState()).toEqual(state.strip);
  });

  it('tabOpen / tabSwitch / tabClose：转发到 app 入口并回最新工作区快照', async () => {
    const calls: string[] = [];
    let activeId: string | null = null;
    const state = (): never =>
      ({
        size: activeId === null ? 0 : 1,
        max: 8,
        activeId,
        canAdd: true,
        hidden: true,
        tabs: [],
        strip: { hidden: true, heightPx: 32, role: 'tablist', rendered: 0, addDisabled: false, addTitle: '', labels: [], selectedId: null, layer: { open: false, mode: 'initial' } },
      }) as never;
    const deps = fakeDeps({
      workspace: {
        state,
        entries: {
          openNewTab: () => calls.push('open'),
          importText: async () => {
            calls.push('import');
          },
          switchTab: (id: string) => {
            calls.push(`switch:${id}`);
            activeId = id;
          },
          closeTab: async (id: string) => {
            calls.push(`close:${id}`);
            activeId = null;
          },
        },
      },
    });
    const hook = createDevHook(deps);

    expect(hook.tabOpen().canAdd).toBe(true);
    await hook.tabClose('tab:1');
    expect(hook.tabSwitch('tab:2').activeId).toBe('tab:2');
    expect(calls).toEqual(['open', 'close:tab:1', 'switch:tab:2']);
  });

  it('tabImportText：等真实导入完成后再回快照（名字缺省 tab.json）', async () => {
    const names: string[] = [];
    const deps = fakeDeps({
      workspace: {
        ...fakeDeps().workspace,
        entries: {
          ...fakeDeps().workspace.entries,
          importText: async (_text: string, name: string) => {
            names.push(name);
            await Promise.resolve();
          },
        },
      },
    });
    const hook = createDevHook(deps);
    await hook.tabImportText('{"a":1}');
    await hook.tabImportText('{"b":2}', 'b.json');
    expect(names).toEqual(['tab.json', 'b.json']);
  });
});
