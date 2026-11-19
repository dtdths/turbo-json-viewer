import { describe, expect, it } from 'vitest';
import type { RootVersion } from '../../../src/protocol/messages';
import type { DocumentMeta } from '../../../src/protocol/types';
import {
  TabViewState,
  VIEW_FIELD_KEYS,
  VIEW_FIELDS_ALL_CLASSIFIED,
  type TabViewAccessors,
  type TabViewLive,
} from '../../../src/app/tab-view-state';
import { CoreError } from '../../../src/protocol/errors';
import { defaultTabViewData, type ExprViewState, type TabViewData } from '../../../src/viewmodel/tab-view-data';
import {
  WorkspaceState,
  type TabInput,
  type TabRuntime,
} from '../../../src/viewmodel/workspace-state';

/**
 * 假 runtime：`WorkspaceState` 只搬运不调用，空对象即可（同 workspace-state 单测的口径）。
 */
function fakeRuntime(): TabRuntime {
  return {
    rowSource: {} as never,
    searchState: {} as never,
    editState: {} as never,
    rawSource: {} as never,
  };
}

function docMeta(name: string): DocumentMeta {
  return { name, bytes: 64, source: 'paste' };
}

/** 文档快照；多标签用例用 overrides 换 rootId / 名字 / 版本。 */
function tabInput(overrides: Partial<TabInput> = {}): TabInput {
  const name = overrides.name ?? 'doc.json';
  return {
    rootId: 'doc:1',
    name,
    bytes: 64,
    meta: docMeta(name),
    docRevision: 1,
    rowVersion: 1,
    totalRows: 10,
    ...overrides,
  };
}

function version(rootId: string, rowVersion: number, totalRows: number): RootVersion {
  return { rootId, rowVersion, totalRows };
}

function exprView(rootId: string): ExprViewState {
  return {
    rootId,
    docRevision: 1,
    rowVersion: 2,
    totalRows: 3,
    count: 3,
    kind: 'array',
    ms: 4,
    steps: 5,
    truncated: false,
    skipped: 0,
    text: '$.items',
    strict: false,
    budget: 'standard',
    seq: 6,
  };
}

/**
 * 镜像：测试里用一份普通对象替身代替 `main.ts` 的 5 个模块级 `let`。
 * accessor 的 get/set 都记到 `calls`，用来断言「搬运只经由访问器」。
 */
interface Mirrors {
  data: TabViewData;
  calls: { get: string[]; set: string[] };
}

function mirrors(): Mirrors {
  return { data: defaultTabViewData(), calls: { get: [], set: [] } };
}

/** 只取有镜像的字段（滚动位置没有镜像，不能参与镜像侧的 deep equal）。 */
function mirroredOnly(data: TabViewData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of VIEW_FIELD_KEYS) out[key] = data[key];
  return out;
}

function accessorsFor(m: Mirrors): TabViewAccessors {
  const table = {} as Record<string, { get(): unknown; set(value: unknown): void }>;
  for (const key of VIEW_FIELD_KEYS) {
    table[key] = {
      get: () => {
        m.calls.get.push(key);
        return m.data[key];
      },
      set: (value) => {
        m.calls.set.push(key);
        (m.data as unknown as Record<string, unknown>)[key] = value;
      },
    };
  }
  return table as unknown as TabViewAccessors;
}

interface Harness {
  ws: WorkspaceState;
  tabView: TabViewState;
  mirrors: Mirrors;
  live: TabViewLive;
  counters: { treeScroll: number; rawScroll: number; transientResets: number };
}

function makeHarness(max?: number): Harness {
  const m = mirrors();
  const ws = new WorkspaceState({ max, createRuntime: fakeRuntime });
  const counters = { treeScroll: 0, rawScroll: 0, transientResets: 0 };
  const live: TabViewLive = { docRevision: 1, rowVersion: 1, totalRows: 10, selected: null };
  const tabView = new TabViewState({
    workspace: ws,
    fields: accessorsFor(m),
    live: () => ({ ...live }),
    treeScrollTopPx: () => counters.treeScroll,
    rawScrollTopPx: () => counters.rawScroll,
    resetTransient: () => {
      counters.transientResets += 1;
    },
  });
  return { ws, tabView, mirrors: m, live, counters };
}

describe('TabViewData 字段归类', () => {
  it('每个 TabViewData 字段都被显式归类（无遗漏）', () => {
    // 编译期守卫：漏归类会让这个常量的类型变成 false（构建就红），这里再钉一次运行时值
    expect(VIEW_FIELDS_ALL_CLASSIFIED).toBe(true);
  });

  it('镜像字段表覆盖 10 个非滚动字段', () => {
    expect([...VIEW_FIELD_KEYS].sort()).toEqual([
      'anchor',
      'exprErrorState',
      'exprLastText',
      'exprStatusState',
      'exprView',
      'fidelity',
      'fidelityIndex',
      'rawMetaInfo',
      'searchOpts',
      'searchPatternCore',
    ]);
  });
});

describe('新标签 / 换文档的存档初值', () => {
  it('新标签的存档等于默认值', () => {
    const h = makeHarness();
    const tab = h.ws.add(tabInput());
    expect(tab?.view).toEqual(defaultTabViewData());
  });

  it('两个标签各自持有一份 searchOpts（不共享可变对象）', () => {
    const h = makeHarness();
    const a = h.ws.add(tabInput({ rootId: 'doc:1', name: 'a.json' }));
    const b = h.ws.add(tabInput({ rootId: 'doc:2', name: 'b.json' }));
    expect(a?.view.searchOpts).not.toBe(b?.view.searchOpts);
    a!.view.searchOpts.caseSensitive = true;
    expect(b?.view.searchOpts.caseSensitive).toBe(false);
  });

  it('replace 换文档把存档复位成默认值', () => {
    const h = makeHarness();
    const tab = h.ws.add(tabInput())!;
    tab.view.rawMetaInfo = { lines: 3 } as never;
    tab.view.scrollTopPx = 120;
    h.ws.replace(tab.id, tabInput({ rootId: 'doc:9', name: 'next.json' }));
    expect(tab.view).toEqual(defaultTabViewData());
    expect(tab.selected).toBeNull();
  });
});

describe('capture：镜像 → 存档', () => {
  it('没有活动标签时是 no-op', () => {
    const h = makeHarness();
    expect(() => h.tabView.capture()).not.toThrow();
    expect(h.mirrors.calls.get).toEqual([]);
  });

  it('把 5 个镜像字段经由访问器写进活动标签', () => {
    const h = makeHarness();
    const tab = h.ws.add(tabInput())!;
    h.mirrors.data.rawMetaInfo = { lines: 9 } as never;
    h.mirrors.data.fidelity = { hits: [] } as never;
    h.mirrors.data.exprView = exprView('expr:1');
    h.mirrors.data.anchor = { path: '$.a', line: 7 };
    h.mirrors.data.searchOpts = { caseSensitive: true, regex: true, wholeWord: false };

    h.tabView.capture();

    expect(h.mirrors.calls.get.sort()).toEqual([...VIEW_FIELD_KEYS].sort());
    expect(h.mirrors.calls.set).toEqual([]);
    expect(tab.view.rawMetaInfo).toEqual({ lines: 9 });
    expect(tab.view.fidelity).toEqual({ hits: [] });
    expect(tab.view.exprView?.rootId).toBe('expr:1');
    expect(tab.view.anchor).toEqual({ path: '$.a', line: 7 });
    expect(tab.view.searchOpts).toEqual({ caseSensitive: true, regex: true, wholeWord: false });
  });

  it('滚动位置取自注入的 DOM 读法', () => {
    const h = makeHarness();
    const tab = h.ws.add(tabInput())!;
    h.counters.treeScroll = 260;
    h.counters.rawScroll = 44;
    h.tabView.capture();
    expect(tab.view.scrollTopPx).toBe(260);
    expect(tab.view.rawScrollTopPx).toBe(44);
  });

  it('把 live() 的版本与选中落到 TabState', () => {
    const h = makeHarness();
    const tab = h.ws.add(tabInput())!;
    h.live.docRevision = 3;
    h.live.rowVersion = 7;
    h.live.totalRows = 42;
    h.live.selected = '$.a.b';
    h.tabView.capture();
    expect(tab.docRevision).toBe(3);
    expect(tab.rowVersion).toBe(7);
    expect(tab.totalRows).toBe(42);
    expect(tab.selected).toBe('$.a.b');
  });
});

describe('restore：存档 → 镜像', () => {
  it('把 5 个字段写回镜像，并每次都复位瞬时状态', () => {
    const h = makeHarness();
    const tab = h.ws.add(tabInput())!;
    tab.view.rawMetaInfo = { lines: 9 } as never;
    tab.view.anchor = { path: '$.a', line: 7 };
    tab.view.searchOpts = { caseSensitive: true, regex: false, wholeWord: true };

    h.tabView.restore(tab);

    expect(h.mirrors.data.rawMetaInfo).toEqual({ lines: 9 });
    expect(h.mirrors.data.anchor).toEqual({ path: '$.a', line: 7 });
    expect(h.mirrors.data.searchOpts).toEqual({ caseSensitive: true, regex: false, wholeWord: true });
    expect(h.counters.transientResets).toBe(1);
  });

  it('capture → restore 往返一致（5 个镜像字段逐字回来）', () => {
    const h = makeHarness();
    const tab = h.ws.add(tabInput())!;
    h.counters.treeScroll = 88;
    h.counters.rawScroll = 12;
    h.mirrors.data = {
      ...defaultTabViewData(),
      rawMetaInfo: { lines: 5 } as never,
      fidelity: { hits: [{ path: '$' }] } as never,
      anchor: { path: '$.x', line: 3 },
      searchOpts: { caseSensitive: true, regex: false, wholeWord: true },
    };
    h.tabView.capture();
    expect(tab.view.scrollTopPx).toBe(88);
    expect(tab.view.rawScrollTopPx).toBe(12);

    h.mirrors.data = defaultTabViewData();
    h.tabView.restore(tab);

    // 滚动位置不进镜像（没有对应 `let`），由 restoreActiveTabView 从 active() 直读
    expect(h.mirrors.data.scrollTopPx).toBe(0);
    expect(h.mirrors.data).toMatchObject({
      rawMetaInfo: { lines: 5 },
      fidelity: { hits: [{ path: '$' }] },
      anchor: { path: '$.x', line: 3 },
      searchOpts: { caseSensitive: true, regex: false, wholeWord: true },
    });
  });
});

describe('reset：存档复位', () => {
  it('就地复位并保持 view 引用稳定', () => {
    const h = makeHarness();
    const tab = h.ws.add(tabInput())!;
    const ref = tab.view;
    tab.view.scrollTopPx = 50;
    tab.view.anchor = { path: '$', line: 1 };
    h.tabView.reset(tab);
    expect(tab.view).toBe(ref);
    expect(tab.view).toEqual(defaultTabViewData());
  });
});

describe('syncVersions：存档侧版本扇出', () => {
  it('只更新根匹配的标签版本', () => {
    const h = makeHarness();
    const a = h.ws.add(tabInput({ rootId: 'doc:1', name: 'a.json' }))!;
    const b = h.ws.add(tabInput({ rootId: 'doc:2', name: 'b.json' }))!;
    h.tabView.syncVersions([version('doc:1', 9, 99)]);
    expect(a.rowVersion).toBe(9);
    expect(a.totalRows).toBe(99);
    expect(b.rowVersion).toBe(1);
    expect(b.totalRows).toBe(10);
  });

  it('更新存档里的表达式结果视图坐标（含非活动标签）', () => {
    const h = makeHarness();
    const a = h.ws.add(tabInput({ rootId: 'doc:1', name: 'a.json' }))!;
    const b = h.ws.add(tabInput({ rootId: 'doc:2', name: 'b.json' }))!;
    a.view.exprView = exprView('expr:1');
    b.view.exprView = exprView('expr:2');

    h.tabView.syncVersions([version('expr:1', 11, 111)]);

    expect(a.view.exprView?.rowVersion).toBe(11);
    expect(a.view.exprView?.totalRows).toBe(111);
    expect(b.view.exprView?.rowVersion).toBe(2);
  });

  it('一次处理多个根，互不干扰', () => {
    const h = makeHarness();
    const a = h.ws.add(tabInput({ rootId: 'doc:1', name: 'a.json' }))!;
    a.view.exprView = exprView('expr:1');
    h.tabView.syncVersions([version('doc:1', 5, 50), version('expr:1', 6, 60)]);
    expect(a.rowVersion).toBe(5);
    expect(a.view.exprView?.rowVersion).toBe(6);
  });
});

describe('active：活动标签存档', () => {
  it('返回活动标签的存档对象', () => {
    const h = makeHarness();
    const a = h.ws.add(tabInput({ rootId: 'doc:1', name: 'a.json' }))!;
    expect(h.tabView.active()).toBe(a.view);
  });

  it('空工作区返回 null', () => {
    const h = makeHarness();
    expect(h.tabView.active()).toBeNull();
  });
});

describe('切标签互不串味', () => {
  it('A 的存档不会落到 B 上，切回来又能拿回 A 的', () => {
    const h = makeHarness();
    const a = h.ws.add(tabInput({ rootId: 'doc:1', name: 'a.json' }))!;
    h.mirrors.data.fidelity = { hits: [{ path: '$.a' }] } as never;
    h.counters.treeScroll = 300;
    h.tabView.capture();

    const b = h.ws.add(tabInput({ rootId: 'doc:2', name: 'b.json' }))!;
    h.mirrors.data = defaultTabViewData();
    h.tabView.restore(b);
    expect(h.mirrors.data.fidelity).toBeNull();
    expect(h.tabView.active()?.scrollTopPx).toBe(0);

    h.ws.activate(a.id);
    h.tabView.restore(a);
    expect(h.mirrors.data.fidelity).toEqual({ hits: [{ path: '$.a' }] });
    expect(h.tabView.active()?.scrollTopPx).toBe(300);
  });
});

describe('串味修复：镜像字段按标签存档（#58 ③）', () => {
  it('新标签的 5 个补充字段取默认值', () => {
    const h = makeHarness();
    const tab = h.ws.add(tabInput())!;
    expect(tab.view.exprLastText).toBe('');
    expect(tab.view.exprErrorState).toBeNull();
    expect(tab.view.exprStatusState).toBeNull();
    expect(tab.view.searchPatternCore).toBeNull();
    expect(tab.view.fidelityIndex).toBe(0);
  });

  it('exprLastText 跟着标签走：切到 B 不会拿 A 的表达式来「重新执行」', () => {
    const h = makeHarness();
    const a = h.ws.add(tabInput({ rootId: 'doc:1', name: 'a.json' }))!;
    h.mirrors.data.exprLastText = '$.items[0]';
    h.tabView.capture();

    const b = h.ws.add(tabInput({ rootId: 'doc:2', name: 'b.json' }))!;
    h.mirrors.data = defaultTabViewData();
    h.tabView.restore(b);
    expect(h.mirrors.data.exprLastText).toBe('');

    h.ws.activate(a.id);
    h.tabView.restore(a);
    expect(h.mirrors.data.exprLastText).toBe('$.items[0]');
  });

  it('表达式行内错误 / 状态行不串到另一个标签', () => {
    const h = makeHarness();
    const a = h.ws.add(tabInput({ rootId: 'doc:1', name: 'a.json' }))!;
    h.mirrors.data.exprErrorState = { code: 'PARSE_ERR_SYNTAX', line: 1, column: 3 };
    h.mirrors.data.exprStatusState = { count: 4, ms: 12 };
    h.tabView.capture();

    const b = h.ws.add(tabInput({ rootId: 'doc:2', name: 'b.json' }))!;
    h.mirrors.data = defaultTabViewData();
    h.tabView.restore(b);
    expect(h.mirrors.data.exprErrorState).toBeNull();
    expect(h.mirrors.data.exprStatusState).toBeNull();

    h.ws.activate(a.id);
    h.tabView.restore(a);
    expect(h.mirrors.data.exprErrorState).toEqual({ code: 'PARSE_ERR_SYNTAX', line: 1, column: 3 });
    expect(h.mirrors.data.exprStatusState).toEqual({ count: 4, ms: 12 });
  });

  it('搜索正则解析错误不贴到新标签的 SearchState', () => {
    const h = makeHarness();
    const a = h.ws.add(tabInput({ rootId: 'doc:1', name: 'a.json' }))!;
    h.mirrors.data.searchPatternCore = new CoreError({ code: 'BAD_PATTERN', message: 'bad' });
    h.tabView.capture();

    const b = h.ws.add(tabInput({ rootId: 'doc:2', name: 'b.json' }))!;
    h.mirrors.data = defaultTabViewData();
    h.tabView.restore(b);
    expect(h.mirrors.data.searchPatternCore).toBeNull();

    h.ws.activate(a.id);
    h.tabView.restore(a);
    expect(h.mirrors.data.searchPatternCore?.code).toBe('BAD_PATTERN');
  });

  it('保真报告命中下标按标签各算各的', () => {
    const h = makeHarness();
    const a = h.ws.add(tabInput({ rootId: 'doc:1', name: 'a.json' }))!;
    h.mirrors.data.fidelityIndex = 3;
    h.tabView.capture();

    const b = h.ws.add(tabInput({ rootId: 'doc:2', name: 'b.json' }))!;
    h.mirrors.data = defaultTabViewData();
    h.tabView.restore(b);
    expect(h.mirrors.data.fidelityIndex).toBe(0);

    h.ws.activate(a.id);
    h.tabView.restore(a);
    expect(h.mirrors.data.fidelityIndex).toBe(3);
  });
});

describe('clear：回空态复位镜像', () => {
  it('没有标签时也能把全部镜像复位成默认值', () => {
    const h = makeHarness();
    h.mirrors.data = {
      ...defaultTabViewData(),
      rawMetaInfo: { lines: 3 } as never,
      fidelity: { hits: [] } as never,
      exprView: exprView('expr:1'),
      scrollTopPx: 120,
      rawScrollTopPx: 40,
      searchOpts: { caseSensitive: true, regex: true, wholeWord: true },
      anchor: { path: '$.a', line: 2 },
      exprLastText: '$.items',
      exprErrorState: { code: 'PARSE_ERR_SYNTAX' },
      exprStatusState: { count: 2, ms: 3 },
      searchPatternCore: new CoreError({ code: 'BAD_PATTERN', message: 'bad' }),
      fidelityIndex: 2,
    };

    h.tabView.clear();

    expect(mirroredOnly(h.mirrors.data)).toEqual(mirroredOnly(defaultTabViewData()));
    expect(h.counters.transientResets).toBe(1);
  });
});
