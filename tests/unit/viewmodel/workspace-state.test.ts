import { describe, expect, it } from 'vitest';
import {
  WorkspaceState,
  type TabInput,
  type TabRuntime,
  type WorkspaceView,
} from '../../../src/viewmodel/workspace-state';
import type { DocumentMeta } from '../../../src/protocol/types';

/**
 * 假 runtime：WorkspaceState 只把它当不透明引用搬运，不调用其任何方法，
 * 所以用空对象 + `as never` 即可（单测不碰 CoreApi / 窗口机）。
 */
function fakeRuntime(): TabRuntime {
  return {
    rowSource: {} as never,
    searchState: {} as never,
    editState: {} as never,
    rawSource: {} as never,
  };
}

function docMeta(name: string, bytes: number): DocumentMeta {
  return { name, bytes, source: 'paste' };
}

/** 默认文档快照；多标签用例里用 overrides 改 rootId / 名字 / 版本。 */
function tabInput(overrides: Partial<TabInput> = {}): TabInput {
  return {
    rootId: 'doc:1',
    name: 'doc.json',
    bytes: 128,
    meta: docMeta('doc.json', 128),
    docRevision: 1,
    rowVersion: 1,
    totalRows: 20,
    ...overrides,
  };
}

interface Harness {
  ws: WorkspaceState;
  /** createRuntime 已调用次数 */
  created(): number;
  /** 按创建顺序返回的 runtime 实例 */
  runtimes: TabRuntime[];
}

/** 工作区 + 工厂计数：断言「满上限 add 不创建 runtime」与「每标签一份独立 runtime」。 */
function makeWorkspace(max?: number): Harness {
  const runtimes: TabRuntime[] = [];
  const ws = new WorkspaceState({
    max,
    createRuntime() {
      const runtime = fakeRuntime();
      runtimes.push(runtime);
      return runtime;
    },
  });
  return { ws, created: () => runtimes.length, runtimes };
}

describe('WorkspaceState — 初始空工作区', () => {
  it('空工作区：size 0 / activeId null / ids 空 / 无活动标签 / 标签条隐藏', () => {
    const { ws } = makeWorkspace();

    expect(ws.size).toBe(0);
    expect(ws.activeId).toBeNull();
    expect(ws.ids).toEqual([]);
    expect(ws.active()).toBeNull();
    expect(ws.get('tab:1')).toBeUndefined();

    expect(ws.view()).toEqual({ hidden: true, tabs: [], activeId: null, canAdd: false, max: 8 });
  });
});

describe('WorkspaceState — add 与标签 id', () => {
  it('add 自动激活，id 从 tab:1 起单调递增，顺序 = 添加顺序', () => {
    const { ws } = makeWorkspace();

    const first = ws.add(tabInput({ rootId: 'doc:1', name: 'a.json' }));
    expect(first).not.toBeNull();
    expect(ws.size).toBe(1);
    expect(ws.activeId).toBe('tab:1');
    expect(ws.active()?.rootId).toBe('doc:1');

    const second = ws.add(tabInput({ rootId: 'doc:2', name: 'b.json' }));
    expect(second?.id).toBe('tab:2');
    expect(ws.activeId).toBe('tab:2');
    expect(ws.ids).toEqual(['tab:1', 'tab:2']);

    expect(ws.view().tabs).toEqual([
      { id: 'tab:1', name: 'a.json', active: false },
      { id: 'tab:2', name: 'b.json', active: true },
    ]);
  });

  it('每个标签有自己的 runtime（工厂调用次数 = 标签数，实例互不共享）', () => {
    const { ws, created, runtimes } = makeWorkspace();

    ws.add(tabInput({ rootId: 'doc:1' }));
    ws.add(tabInput({ rootId: 'doc:2' }));

    expect(created()).toBe(2);
    expect(runtimes[0]).not.toBe(runtimes[1]);
    expect(ws.get('tab:1')?.runtime).toBe(runtimes[0]);
    expect(ws.get('tab:2')?.runtime).toBe(runtimes[1]);
  });

  it('remove 后 id 不复用（单调只增）', () => {
    const { ws } = makeWorkspace();

    ws.add(tabInput({ rootId: 'doc:1' }));
    ws.add(tabInput({ rootId: 'doc:2' }));
    const removed = ws.remove('tab:1');
    expect(removed?.removed.id).toBe('tab:1');

    const third = ws.add(tabInput({ rootId: 'doc:3' }));
    expect(third?.id).toBe('tab:3');
    expect(ws.ids).toEqual(['tab:2', 'tab:3']);
  });
});

describe('WorkspaceState — 活动标签 / activate', () => {
  it('activate 切换活动标签并返回 true，view 的 active 标记同步', () => {
    const { ws } = makeWorkspace();
    ws.add(tabInput({ rootId: 'doc:1' }));
    ws.add(tabInput({ rootId: 'doc:2' }));

    expect(ws.activate('tab:1')).toBe(true);
    expect(ws.activeId).toBe('tab:1');
    expect(ws.active()?.rootId).toBe('doc:1');
    expect(ws.view().tabs.map((tab) => tab.active)).toEqual([true, false]);
  });

  it('activate 未知 id 返回 false，状态不变', () => {
    const { ws } = makeWorkspace();
    ws.add(tabInput({ rootId: 'doc:1' }));

    expect(ws.activate('tab:9')).toBe(false);
    expect(ws.activeId).toBe('tab:1');
    expect(ws.size).toBe(1);
  });

  it('重复 activate 当前标签仍返回 true 并通知（render 幂等）', () => {
    const { ws } = makeWorkspace();
    let notified = 0;
    ws.subscribe(() => {
      notified += 1;
    });
    ws.add(tabInput({ rootId: 'doc:1' }));
    expect(notified).toBe(1);

    expect(ws.activate('tab:1')).toBe(true);
    expect(ws.activeId).toBe('tab:1');
    expect(notified).toBe(2);
  });
});

describe('WorkspaceState — 软上限 max', () => {
  it('默认 max = 8（MAX_DOC_TABS）', () => {
    const { ws } = makeWorkspace();

    expect(ws.max).toBe(8);
    expect(ws.view().max).toBe(8);

    for (let i = 0; i < 8; i += 1) ws.add(tabInput({ rootId: `doc:${i + 1}` }));
    expect(ws.size).toBe(8);
    expect(ws.view().canAdd).toBe(false);
  });

  it('满上限 add 返回 null：不淘汰、不抛、不创建 runtime、活动标签不变', () => {
    const { ws, created } = makeWorkspace(2);
    ws.add(tabInput({ rootId: 'doc:1' }));
    ws.add(tabInput({ rootId: 'doc:2' }));
    expect(created()).toBe(2);

    const overflow = ws.add(tabInput({ rootId: 'doc:3' }));

    expect(overflow).toBeNull();
    expect(ws.size).toBe(2);
    expect(created()).toBe(2);
    expect(ws.activeId).toBe('tab:2');
    expect(ws.ids).toEqual(['tab:1', 'tab:2']);
    expect(ws.view().canAdd).toBe(false);
  });

  it('自定义 max 生效（max = 1 时第二个 add 被拒）', () => {
    const { ws } = makeWorkspace(1);
    expect(ws.max).toBe(1);

    expect(ws.add(tabInput({ rootId: 'doc:1' }))).not.toBeNull();
    expect(ws.add(tabInput({ rootId: 'doc:2' }))).toBeNull();
    expect(ws.size).toBe(1);
  });

  it('canAdd：空态 false；有活动标签且未满 true；满了 false', () => {
    const { ws } = makeWorkspace(2);
    expect(ws.view().canAdd).toBe(false);

    ws.add(tabInput({ rootId: 'doc:1' }));
    expect(ws.view().canAdd).toBe(true);

    ws.add(tabInput({ rootId: 'doc:2' }));
    expect(ws.view().canAdd).toBe(false);

    // 删掉一个后又能加
    ws.remove('tab:2');
    expect(ws.view().canAdd).toBe(true);
  });
});

describe('WorkspaceState — view 隐藏规则', () => {
  it('hidden === (size < 2)：单标签隐藏、双标签显示、删回一个再隐藏', () => {
    const { ws } = makeWorkspace();
    expect(ws.view().hidden).toBe(true);

    ws.add(tabInput({ rootId: 'doc:1' }));
    expect(ws.view().hidden).toBe(true);

    ws.add(tabInput({ rootId: 'doc:2' }));
    expect(ws.view().hidden).toBe(false);

    ws.remove('tab:2');
    expect(ws.view().hidden).toBe(true);
  });
});

describe('WorkspaceState — replace（替换导入）', () => {
  it('保留 id / runtime / 列表位置，更新文档字段，selected 清 null', () => {
    const { ws, created, runtimes } = makeWorkspace();
    ws.add(tabInput({ rootId: 'doc:1', name: 'a.json' }));
    ws.update('tab:1', { selected: '$.a' });
    expect(ws.get('tab:1')?.selected).toBe('$.a');

    const replaced = ws.replace(
      'tab:1',
      tabInput({
        rootId: 'doc:2',
        name: 'b.json',
        bytes: 256,
        meta: docMeta('b.json', 256),
        docRevision: 2,
        rowVersion: 3,
        totalRows: 50,
      }),
    );

    expect(replaced).not.toBeNull();
    expect(replaced?.id).toBe('tab:1');
    expect(ws.size).toBe(1);
    expect(ws.activeId).toBe('tab:1'); // 未改变活动态
    expect(created()).toBe(1); // 不重建 runtime
    expect(ws.get('tab:1')?.runtime).toBe(runtimes[0]);

    const tab = ws.get('tab:1');
    expect(tab?.rootId).toBe('doc:2');
    expect(tab?.name).toBe('b.json');
    expect(tab?.bytes).toBe(256);
    expect(tab?.meta).toEqual(docMeta('b.json', 256));
    expect(tab?.docRevision).toBe(2);
    expect(tab?.rowVersion).toBe(3);
    expect(tab?.totalRows).toBe(50);
    expect(tab?.selected).toBeNull(); // 旧根的 path 对新根无意义
    expect(ws.view().tabs).toEqual([{ id: 'tab:1', name: 'b.json', active: true }]);
  });

  it('未激活标签上 replace：size / activeId 都不变', () => {
    const { ws } = makeWorkspace();
    ws.add(tabInput({ rootId: 'doc:1' }));
    ws.add(tabInput({ rootId: 'doc:2' }));

    ws.replace('tab:1', tabInput({ rootId: 'doc:3', name: 'c.json' }));

    expect(ws.size).toBe(2);
    expect(ws.activeId).toBe('tab:2');
    expect(ws.get('tab:1')?.rootId).toBe('doc:3');
  });

  it('replace 未知 id 返回 null，不通知、不改状态', () => {
    const { ws } = makeWorkspace();
    ws.add(tabInput({ rootId: 'doc:1' }));
    let notified = 0;
    ws.subscribe(() => {
      notified += 1;
    });

    expect(ws.replace('tab:9', tabInput({ rootId: 'doc:2' }))).toBeNull();
    expect(notified).toBe(0);
    expect(ws.size).toBe(1);
    expect(ws.get('tab:1')?.rootId).toBe('doc:1');
  });
});

describe('WorkspaceState — remove（关闭标签）', () => {
  it('remove 非活动标签：activeId 不变，返回 removed 与移除后的 activeId', () => {
    const { ws } = makeWorkspace();
    ws.add(tabInput({ rootId: 'doc:1' }));
    ws.add(tabInput({ rootId: 'doc:2' }));

    const result = ws.remove('tab:1');

    expect(result?.removed.id).toBe('tab:1');
    expect(result?.removed.rootId).toBe('doc:1'); // app 据此发 closeRoot
    expect(result?.activeId).toBe('tab:2');
    expect(ws.activeId).toBe('tab:2');
    expect(ws.size).toBe(1);
  });

  it('remove 活动标签：右邻优先', () => {
    const { ws } = makeWorkspace();
    ws.add(tabInput({ rootId: 'doc:1' }));
    ws.add(tabInput({ rootId: 'doc:2' }));
    ws.add(tabInput({ rootId: 'doc:3' }));
    ws.activate('tab:2');

    const result = ws.remove('tab:2');

    expect(result?.activeId).toBe('tab:3');
    expect(ws.activeId).toBe('tab:3');
    expect(ws.ids).toEqual(['tab:1', 'tab:3']);
  });

  it('remove 活动标签且无右邻：回左邻', () => {
    const { ws } = makeWorkspace();
    ws.add(tabInput({ rootId: 'doc:1' }));
    ws.add(tabInput({ rootId: 'doc:2' }));
    ws.add(tabInput({ rootId: 'doc:3' }));
    ws.activate('tab:3');

    expect(ws.remove('tab:3')?.activeId).toBe('tab:2');
    expect(ws.activeId).toBe('tab:2');
  });

  it('remove 最后一个标签：回空态（activeId null、标签条隐藏）', () => {
    const { ws } = makeWorkspace();
    ws.add(tabInput({ rootId: 'doc:1' }));

    const result = ws.remove('tab:1');

    expect(result?.removed.id).toBe('tab:1');
    expect(result?.activeId).toBeNull();
    expect(ws.activeId).toBeNull();
    expect(ws.size).toBe(0);
    expect(ws.active()).toBeNull();
    expect(ws.view()).toEqual({ hidden: true, tabs: [], activeId: null, canAdd: false, max: 8 });
  });

  it('remove 未知 id 返回 null，不通知、不改状态', () => {
    const { ws } = makeWorkspace();
    ws.add(tabInput({ rootId: 'doc:1' }));
    let notified = 0;
    ws.subscribe(() => {
      notified += 1;
    });

    expect(ws.remove('tab:9')).toBeNull();
    expect(notified).toBe(0);
    expect(ws.size).toBe(1);
  });
});

describe('WorkspaceState — update（回包落地同步字段）', () => {
  it('允许的键逐个落地：docRevision / rowVersion / totalRows / meta / name / bytes / selected', () => {
    const { ws } = makeWorkspace();
    ws.add(tabInput({ rootId: 'doc:1', name: 'a.json' }));

    ws.update('tab:1', {
      docRevision: 4,
      rowVersion: 9,
      totalRows: 77,
      meta: docMeta('renamed.json', 512),
      name: 'renamed.json',
      bytes: 512,
      selected: '$.items[3]',
    });

    const tab = ws.get('tab:1');
    expect(tab?.docRevision).toBe(4);
    expect(tab?.rowVersion).toBe(9);
    expect(tab?.totalRows).toBe(77);
    expect(tab?.meta).toEqual(docMeta('renamed.json', 512));
    expect(tab?.name).toBe('renamed.json');
    expect(tab?.bytes).toBe(512);
    expect(tab?.selected).toBe('$.items[3]');
    expect(ws.view().tabs[0]?.name).toBe('renamed.json');
  });

  it('selected 可以清回 null', () => {
    const { ws } = makeWorkspace();
    ws.add(tabInput({ rootId: 'doc:1' }));
    ws.update('tab:1', { selected: '$.a' });

    ws.update('tab:1', { selected: null });

    expect(ws.get('tab:1')?.selected).toBeNull();
  });

  it('只改传入的键，未传的字段保持原值', () => {
    const { ws } = makeWorkspace();
    ws.add(tabInput({ rootId: 'doc:1', name: 'a.json', docRevision: 1, totalRows: 20 }));

    ws.update('tab:1', { rowVersion: 5 });

    expect(ws.get('tab:1')?.docRevision).toBe(1);
    expect(ws.get('tab:1')?.name).toBe('a.json');
    expect(ws.get('tab:1')?.totalRows).toBe(20);
    expect(ws.get('tab:1')?.rowVersion).toBe(5);
  });

  it('未激活标签上 update：activeId 不变', () => {
    const { ws } = makeWorkspace();
    ws.add(tabInput({ rootId: 'doc:1' }));
    ws.add(tabInput({ rootId: 'doc:2' }));

    ws.update('tab:1', { selected: '$.a', docRevision: 2 });

    expect(ws.activeId).toBe('tab:2');
    expect(ws.get('tab:1')?.selected).toBe('$.a');
  });

  it('字段无变化也通知（拍板：只要调用就通知，订阅方 render 幂等）', () => {
    const { ws } = makeWorkspace();
    ws.add(tabInput({ rootId: 'doc:1' }));
    const before = ws.view();
    let notified = 0;
    ws.subscribe(() => {
      notified += 1;
    });

    ws.update('tab:1', {});

    expect(notified).toBe(1);
    expect(ws.view()).toEqual(before);
  });

  it('update 未知 id no-op：不通知、不影响任何标签', () => {
    const { ws } = makeWorkspace();
    ws.add(tabInput({ rootId: 'doc:1' }));
    let notified = 0;
    ws.subscribe(() => {
      notified += 1;
    });

    ws.update('tab:9', { docRevision: 99 });

    expect(notified).toBe(0);
    expect(ws.size).toBe(1);
    expect(ws.get('tab:1')?.docRevision).toBe(1);
  });
});

describe('WorkspaceState — 订阅与不可变视图', () => {
  it('add / activate / replace / remove / update 各通知一次，且快照反映当前状态', () => {
    const { ws } = makeWorkspace();
    const seen: WorkspaceView[] = [];
    ws.subscribe((view) => {
      seen.push({ ...view, tabs: view.tabs.map((tab) => ({ ...tab })) });
    });

    ws.add(tabInput({ rootId: 'doc:1' })); // 1
    ws.activate('tab:1'); // 2（重复激活也通知）
    ws.replace('tab:1', tabInput({ rootId: 'doc:2', name: 'b.json' })); // 3
    ws.update('tab:1', { selected: '$.a' }); // 4
    ws.remove('tab:1'); // 5

    expect(seen.length).toBe(5);
    expect(seen[0]?.activeId).toBe('tab:1');
    expect(seen[2]?.tabs[0]?.name).toBe('b.json');
    expect(seen[4]?.activeId).toBeNull();
  });

  it('多个订阅者都收到；退订后不再通知；重复退订安全', () => {
    const { ws } = makeWorkspace();
    let a = 0;
    let b = 0;
    const offA = ws.subscribe(() => {
      a += 1;
    });
    ws.subscribe(() => {
      b += 1;
    });

    ws.add(tabInput({ rootId: 'doc:1' }));
    expect([a, b]).toEqual([1, 1]);

    offA();
    offA(); // 重复退订安全
    ws.add(tabInput({ rootId: 'doc:2' }));
    expect([a, b]).toEqual([1, 2]);
  });

  it('view() 每次是新对象 / 新数组，外部改不到内部状态', () => {
    const { ws } = makeWorkspace();
    ws.add(tabInput({ rootId: 'doc:1', name: 'a.json' }));

    const first = ws.view();
    const second = ws.view();
    expect(second).not.toBe(first);
    expect(second.tabs).not.toBe(first.tabs);
    expect(second).toEqual(first);

    // 改快照里的数组 / 对象 / 标量，都不影响下一次 view()
    first.tabs.push({ id: 'tab:99', name: 'hack.json', active: false });
    first.tabs[0]!.name = 'hacked.json';
    first.activeId = 'tab:99';
    expect(ws.view().tabs).toEqual([{ id: 'tab:1', name: 'a.json', active: true }]);
    expect(ws.view().activeId).toBe('tab:1');

    // ids 是副本
    const ids = ws.ids;
    ids.push('tab:99');
    expect(ws.ids).toEqual(['tab:1']);
  });
});

describe('WorkspaceState — 双标签切换保留各自视图状态（组合用例）', () => {
  it('切回 A 后，A 的 selected / 版本字段 / runtime 与 B 各自保留', () => {
    const { ws, runtimes } = makeWorkspace();
    ws.add(tabInput({ rootId: 'doc:1', name: 'a.json', docRevision: 1, rowVersion: 1, totalRows: 10 }));
    ws.update('tab:1', { selected: '$.a', docRevision: 2, rowVersion: 5, totalRows: 12 });
    ws.add(tabInput({ rootId: 'doc:2', name: 'b.json', docRevision: 1, rowVersion: 1, totalRows: 20 }));
    ws.update('tab:2', { selected: '$.b', docRevision: 3, rowVersion: 7, totalRows: 21 });

    // 当前在 B
    expect(ws.activeId).toBe('tab:2');
    expect(ws.active()?.runtime).toBe(runtimes[1]);
    expect(ws.active()?.selected).toBe('$.b');

    // 切回 A：A 的独立状态原样保留，B 的字段不被覆盖
    expect(ws.activate('tab:1')).toBe(true);
    const a = ws.active();
    expect(a?.rootId).toBe('doc:1');
    expect(a?.name).toBe('a.json');
    expect(a?.runtime).toBe(runtimes[0]);
    expect(a?.selected).toBe('$.a');
    expect(a?.docRevision).toBe(2);
    expect(a?.rowVersion).toBe(5);
    expect(a?.totalRows).toBe(12);

    const b = ws.get('tab:2');
    expect(b?.rootId).toBe('doc:2');
    expect(b?.runtime).toBe(runtimes[1]);
    expect(b?.selected).toBe('$.b');
    expect(b?.docRevision).toBe(3);
    expect(b?.rowVersion).toBe(7);
    expect(b?.totalRows).toBe(21);

    // 一次 view 就能拿到活动标记
    expect(ws.view()).toEqual({
      hidden: false,
      tabs: [
        { id: 'tab:1', name: 'a.json', active: true },
        { id: 'tab:2', name: 'b.json', active: false },
      ],
      activeId: 'tab:1',
      canAdd: true,
      max: 8,
    });

    // 替换 B 不影响 A
    ws.replace('tab:2', tabInput({ rootId: 'doc:3', name: 'c.json', docRevision: 1, rowVersion: 1, totalRows: 5 }));
    expect(ws.activeId).toBe('tab:1');
    expect(ws.get('tab:1')?.selected).toBe('$.a');
    expect(ws.get('tab:2')?.rootId).toBe('doc:3');
    expect(ws.get('tab:2')?.selected).toBeNull();
  });
});
