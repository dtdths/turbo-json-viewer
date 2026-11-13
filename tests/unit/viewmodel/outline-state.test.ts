/**
 * viewmodel/outline-state 单测 — 大纲状态机（ADR-0013 §5）。
 *
 * 覆盖：open 首屏、展开/折叠（子树页缓存丢弃）、分页 loadMore / 无更多、每容器单飞、
 * epoch 迟到回包丢弃（换文档 / 刷新）、换文档重置、编辑后 refresh、setSelected、
 * 错误降级、view 快照、computeOutlineWindow 边界。
 *
 * 纯 viewmodel 单测：无 DOM、无定时器；数据源用 fake `OutlineSource`（手动 resolve）。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  computeOutlineWindow,
  OutlineState,
  OUTLINE_OVERSCAN,
  OUTLINE_ROW_HEIGHT,
  type OutlineSource,
  type OutlineView,
} from '../../../src/viewmodel/outline-state';
import { OUTLINE_PAGE } from '../../../src/protocol/versions';
import type { JsonKind, OutlineChild, OutlineReply } from '../../../src/protocol/types';

type Req = { rootId: string; path: string; start: number; count: number };

/** 手动应答的 fake source：记录请求，测试自行 resolve / reject。 */
class FakeSource implements OutlineSource {
  readonly requests: Req[] = [];
  private readonly pending = new Map<number, { resolve: (reply: OutlineReply) => void; reject: (error: unknown) => void }>();

  outline(req: Req): Promise<OutlineReply> {
    const index = this.requests.length;
    this.requests.push({ ...req });
    return new Promise<OutlineReply>((resolve, reject) => {
      this.pending.set(index, { resolve, reject });
    });
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  private take(index: number): { resolve: (reply: OutlineReply) => void; reject: (error: unknown) => void } {
    const entry = this.pending.get(index);
    if (!entry) throw new Error(`没有待应答的请求 #${index}（requests=${this.requests.length}）`);
    this.pending.delete(index);
    return entry;
  }

  resolveAt(index: number, partial: Partial<OutlineReply> = {}): void {
    const entry = this.take(index);
    const req = this.requests[index] as Req;
    entry.resolve({
      rootId: req.rootId,
      path: req.path,
      kind: 'object',
      total: partial.children?.length ?? 0,
      start: req.start,
      children: [],
      ...partial,
    });
  }

  rejectAt(index: number, error: unknown): void {
    this.take(index).reject(error);
  }

  /** 最后一次请求 */
  get last(): Req {
    const req = this.requests.at(-1);
    if (!req) throw new Error('还没有请求');
    return req;
  }
}

/** 对象成员行 */
function child(key: string, kind: JsonKind, count = 0, parent = '$'): OutlineChild {
  return { key, idx: false, kind, count, path: `${parent}.${key}` };
}

/** 数组元素行（key 含方括号） */
function item(index: number, kind: JsonKind, count = 0, parent = '$'): OutlineChild {
  return { key: `[${index}]`, idx: true, kind, count, path: `${parent}[${index}]` };
}

/** 打开文档并应答根页（默认 2 个对象成员）。 */
async function opened(
  source: FakeSource,
  opts: { total?: number; children?: OutlineChild[]; kind?: JsonKind } = {},
): Promise<OutlineState> {
  const state = new OutlineState(source);
  const opening = state.open('r1');
  const children = opts.children ?? [child('a', 'object', 1), child('b', 'number')];
  const total = opts.total ?? children.length;
  source.resolveAt(0, { kind: opts.kind ?? 'object', total, children });
  await opening;
  return state;
}

function paths(view: OutlineView): string[] {
  return view.rows.map((row) => row.path);
}

describe('computeOutlineWindow — 虚拟窗口', () => {
  it('常量：默认行高 24、overscan 6（ADR-0013 §1）', () => {
    expect(OUTLINE_ROW_HEIGHT).toBe(24);
    expect(OUTLINE_OVERSCAN).toBe(6);
  });

  it('size <= 0 → 空窗口（与 scrollTop / viewport 无关）', () => {
    expect(computeOutlineWindow(0, 0, 10)).toEqual({ start: 0, count: 0 });
    expect(computeOutlineWindow(-4, 500, 10)).toEqual({ start: 0, count: 0 });
  });

  it('顶部：start = 0，count = viewportRows + 2*overscan', () => {
    expect(computeOutlineWindow(100, 0, 12)).toEqual({ start: 0, count: 24 });
  });

  it('中间：start = floor(scrollTop / rowHeight) - overscan', () => {
    // 30 行 * 24px = 720px；-6 overscan → 24
    expect(computeOutlineWindow(100, 30 * 24, 12)).toEqual({ start: 24, count: 24 });
  });

  it('尾部：count 被 size - start 截断', () => {
    const window = computeOutlineWindow(40, 38 * 24, 12);
    expect(window).toEqual({ start: 32, count: 8 });
  });

  it('scrollTop 负值 / NaN / viewportRows 非有限 → 归一化', () => {
    expect(computeOutlineWindow(100, -50, 12)).toEqual({ start: 0, count: 24 });
    expect(computeOutlineWindow(100, Number.NaN, 12)).toEqual({ start: 0, count: 24 });
    expect(computeOutlineWindow(100, 0, Number.POSITIVE_INFINITY)).toEqual({ start: 0, count: 12 });
    expect(computeOutlineWindow(100, 0, -3)).toEqual({ start: 0, count: 12 });
  });

  it('rowHeight / overscan 可覆盖（设置面板行高 20–26）', () => {
    expect(computeOutlineWindow(50, 0, 10, { rowHeight: 20 })).toEqual({ start: 0, count: 22 });
    expect(computeOutlineWindow(50, 20 * 20, 10, { rowHeight: 20 })).toEqual({ start: 14, count: 22 });
    expect(computeOutlineWindow(50, 0, 10, { overscan: 0 })).toEqual({ start: 0, count: 10 });
  });

  it('最大行高 26：窗口随行高收缩', () => {
    expect(computeOutlineWindow(200, 26 * 20, 10, { rowHeight: 26 })).toEqual({ start: 14, count: 22 });
  });
});

describe('OutlineState — open 首屏', () => {
  it('初始 idle：无行、selected=null、expanded 空', () => {
    const state = new OutlineState(new FakeSource());
    const view = state.view();
    expect(view.phase).toBe('idle');
    expect(view.rows).toEqual([]);
    expect(view.selected).toBeNull();
    expect(view.rootId).toBeNull();
    expect(state.expandedPaths()).toEqual([]);
  });

  it('open：先 loading（空行），根页回包后 ready 并铺出根行 + 子行', async () => {
    const source = new FakeSource();
    const state = new OutlineState(source);
    const opening = state.open('r1');

    expect(state.view().phase).toBe('loading');
    expect(state.view().rows).toEqual([]);
    expect(source.requests).toHaveLength(1);
    expect(source.requests[0]).toEqual({ rootId: 'r1', path: '$', start: 0, count: OUTLINE_PAGE });

    source.resolveAt(0, {
      kind: 'object',
      total: 2,
      children: [child('a', 'object', 3), child('b', 'string')],
    });
    await opening;

    const view = state.view();
    expect(view.phase).toBe('ready');
    expect(view.rootId).toBe('r1');
    expect(view.selected).toBeNull();
    expect(paths(view)).toEqual(['$', '$.a', '$.b']);

    const root = view.rows[0];
    expect(root).toMatchObject({
      path: '$',
      depth: 0,
      key: '$',
      kind: 'object',
      count: 2,
      open: true,
      expandable: true,
      more: false,
    });

    const a = view.rows[1];
    expect(a).toMatchObject({
      path: '$.a',
      depth: 1,
      key: 'a',
      idx: false,
      kind: 'object',
      count: 3,
      open: false,
      expandable: true,
      more: false,
    });
    const b = view.rows[2];
    expect(b).toMatchObject({ path: '$.b', kind: 'string', count: 0, expandable: false, open: false });

    expect(state.expandedPaths()).toEqual(['$']);
    expect(view.loadedContainers).toBe(1);
    expect(view.loadedChildren).toBe(2);
  });

  it('数组根：子行 key 带方括号、idx=true', async () => {
    const state = await opened(new FakeSource(), {
      kind: 'array',
      total: 2,
      children: [item(0, 'object', 2), item(1, 'null')],
    });
    const view = state.view();
    expect(view.rows.map((row) => row.key)).toEqual(['$', '[0]', '[1]']);
    expect(view.rows[1]?.idx).toBe(true);
    expect(view.rows[1]?.path).toBe('$[0]');
    expect(view.rows[1]?.expandable).toBe(true);
    expect(view.rows[2]?.expandable).toBe(false);
  });

  it('根页 total 大于本页 → 追加「加载更多」哨兵行（depth = 1）', async () => {
    const children = Array.from({ length: OUTLINE_PAGE }, (_v, i) => item(i, 'number'));
    const state = await opened(new FakeSource(), { kind: 'array', total: OUTLINE_PAGE + 37, children });
    const view = state.view();
    expect(view.rows).toHaveLength(1 + OUTLINE_PAGE + 1);
    const sentinel = view.rows.at(-1);
    expect(sentinel).toMatchObject({
      path: '$',
      depth: 1,
      more: true,
      kind: null,
      key: '加载更多（还有 37 项）',
    });
    expect(view.loadedChildren).toBe(OUTLINE_PAGE);
  });

  it('空容器文档：只有根行（0 项、不可展开、无哨兵）', async () => {
    const state = await opened(new FakeSource(), { kind: 'object', total: 0, children: [] });
    const view = state.view();
    expect(paths(view)).toEqual(['$']);
    expect(view.rows[0]).toMatchObject({ kind: 'object', count: 0, expandable: false, open: true });
  });
});

describe('OutlineState — 展开 / 折叠', () => {
  it('展开容器：请求该容器第一页，回包后铺出子行并进入 open 态', async () => {
    const source = new FakeSource();
    const state = await opened(source);
    const expanding = state.setOpen('$.a', true);
    expect(state.view().rows[1]?.open).toBe(true);
    expect(source.last).toEqual({ rootId: 'r1', path: '$.a', start: 0, count: OUTLINE_PAGE });

    source.resolveAt(1, { kind: 'object', total: 1, children: [child('x', 'number', 0, '$.a')] });
    await expanding;

    const view = state.view();
    expect(paths(view)).toEqual(['$', '$.a', '$.a.x', '$.b']);
    expect(view.rows[1]).toMatchObject({ path: '$.a', open: true, kind: 'object' });
    expect(view.rows[2]).toMatchObject({ path: '$.a.x', depth: 2, kind: 'number' });
    expect(state.expandedPaths().sort()).toEqual(['$', '$.a']);
    expect(view.loadedContainers).toBe(2);
    expect(view.loadedChildren).toBe(3);
  });

  it('toggle：展开 ↔ 折叠；空容器 / 标量不可展开', async () => {
    const source = new FakeSource();
    const state = await opened(source, {
      children: [child('a', 'object', 1), child('s', 'string'), child('e', 'object', 0)],
    });

    expect(await state.toggle('$.s')).toBe(false); // 标量
    expect(await state.toggle('$.e')).toBe(false); // 空容器（无 caret）
    expect(source.requests).toHaveLength(1);

    const expanding = state.toggle('$.a');
    source.resolveAt(1, { children: [child('x', 'number', 0, '$.a')], total: 1 });
    expect(await expanding).toBe(true);
    expect(state.isExpanded('$.a')).toBe(true);

    expect(await state.toggle('$.a')).toBe(true);
    expect(state.isExpanded('$.a')).toBe(false);
  });

  it('折叠丢弃子树页缓存与展开项（自身页缓存保留，重展开不再请求）', async () => {
    const source = new FakeSource();
    const state = await opened(source);
    const expandingA = state.setOpen('$.a', true);
    source.resolveAt(1, { total: 1, children: [child('b', 'object', 1, '$.a')] });
    await expandingA;

    const expandingB = state.setOpen('$.a.b', true);
    source.resolveAt(2, { total: 1, children: [child('c', 'number', 0, '$.a.b')] });
    await expandingB;

    expect(state.view().loadedContainers).toBe(3);
    expect(state.view().rows.map((row) => row.path)).toEqual(['$', '$.a', '$.a.b', '$.a.b.c', '$.b']);

    // 折叠 $.a：$.a.b 的展开项与页缓存丢弃，$.a 自身的页缓存保留
    await state.setOpen('$.a', false);
    expect(state.view().loadedContainers).toBe(2); // $ 与 $.a
    expect(state.expandedPaths().sort()).toEqual(['$']);
    expect(paths(state.view())).toEqual(['$', '$.a', '$.b']);
    expect(state.view().rows[1]).toMatchObject({ open: false, kind: 'object' });

    // 重展开：直接用缓存，不再发请求
    const before = source.requests.length;
    const reopening = state.setOpen('$.a', true);
    await reopening;
    expect(source.requests).toHaveLength(before);
    expect(paths(state.view())).toEqual(['$', '$.a', '$.a.b', '$.b']);
    expect(state.view().rows[2]).toMatchObject({ path: '$.a.b', open: false });
  });

  it('根永远展开、不可折叠：setOpen / toggle 都无效', async () => {
    const source = new FakeSource();
    const state = await opened(source);
    expect(await state.setOpen('$', false)).toBe(false);
    expect(await state.toggle('$')).toBe(false);
    expect(state.isExpanded('$')).toBe(true);
    expect(state.view().rows[0]?.open).toBe(true);
    expect(source.requests).toHaveLength(1);
  });

  it('未知路径 / 无文档：setOpen 返回 false 且不发请求', async () => {
    const source = new FakeSource();
    const state = new OutlineState(source);
    expect(await state.setOpen('$.nope', true)).toBe(false);
    expect(source.requests).toHaveLength(0);

    const openedState = await opened(source);
    expect(await openedState.setOpen('$.missing', true)).toBe(false);
    expect(source.requests).toHaveLength(1);
  });
});

describe('OutlineState — 分页 loadMore', () => {
  it('按页追加、末页后无更多、哨兵消失', async () => {
    const first = Array.from({ length: 2 }, (_v, i) => item(i, 'number'));
    const source = new FakeSource();
    const state = new OutlineState(source, { page: 2 });
    const opening = state.open('r1');
    source.resolveAt(0, { kind: 'array', total: 3, children: first });
    await opening;

    expect(state.view().rows.at(-1)).toMatchObject({ more: true });
    const loading = state.loadMore('$');
    expect(source.last).toEqual({ rootId: 'r1', path: '$', start: 2, count: 2 });
    source.resolveAt(1, { kind: 'array', total: 3, start: 2, children: [item(2, 'boolean')] });
    await loading;

    const view = state.view();
    expect(paths(view)).toEqual(['$', '$[0]', '$[1]', '$[2]']);
    expect(view.rows.some((row) => row.more)).toBe(false);
    expect(view.loadedChildren).toBe(3);

    // 无更多：返回 false 且不发请求
    const before = source.requests.length;
    expect(await state.loadMore('$')).toBe(false);
    expect(source.requests).toHaveLength(before);
  });

  it('单飞：同一容器 in-flight 时重复 loadMore 只发一次请求', async () => {
    const children = [item(0, 'number')];
    const source = new FakeSource();
    const state = new OutlineState(source, { page: 1 });
    const opening = state.open('r1');
    source.resolveAt(0, { kind: 'array', total: 3, children });
    await opening;

    const a = state.loadMore('$');
    const b = state.loadMore('$');
    expect(source.requests).toHaveLength(2);
    source.resolveAt(1, { kind: 'array', total: 3, start: 1, children: [item(1, 'number')] });
    await Promise.all([a, b]);

    const view = state.view();
    // 末页仍未到底 → 末尾保留哨兵行（data-path = 所属容器 '$'）
    expect(paths(view)).toEqual(['$', '$[0]', '$[1]', '$']);
    expect(view.rows.at(-1)).toMatchObject({ more: true, path: '$' });
    expect(view.loadedChildren).toBe(2);
  });

  it('未加载 / 未展开容器：loadMore 返回 false 且不发请求', async () => {
    const source = new FakeSource();
    const state = await opened(source);
    expect(await state.loadMore('$.missing')).toBe(false);
    expect(source.requests).toHaveLength(1);
  });
});

describe('OutlineState — epoch / 迟到回包', () => {
  it('换文档（open 竞态）：旧根回包丢弃，新根回包生效', async () => {
    const source = new FakeSource();
    const state = new OutlineState(source);

    const first = state.open('r1');
    const second = state.open('r2');
    expect(state.view().rootId).toBe('r2');
    expect(state.view().phase).toBe('loading');

    // r1 的迟到回包：不改任何状态
    source.resolveAt(0, { rootId: 'r1', total: 99, children: [child('old', 'object', 5)] });
    await first;
    expect(state.view().rootId).toBe('r2');
    expect(state.view().rows).toEqual([]);
    expect(state.view().phase).toBe('loading');

    source.resolveAt(1, { rootId: 'r2', total: 1, children: [child('fresh', 'string')] });
    await second;
    expect(paths(state.view())).toEqual(['$', '$.fresh']);
    expect(state.view().phase).toBe('ready');
  });

  it('刷新击落旧容器的迟到回包（epoch 丢弃）', async () => {
    const source = new FakeSource();
    const state = await opened(source);

    // 展开 $.a，回包挂起
    void state.setOpen('$.a', true);
    expect(source.pendingCount).toBe(1);

    // 编辑触发 refresh：epoch 递增 → 旧 $.a 页回包作废
    const refreshing = state.refresh();
    expect(state.view().phase).toBe('loading');
    source.resolveAt(1, { total: 1, children: [child('stale', 'number', 0, '$.a')] });
    await Promise.resolve();
    await Promise.resolve();
    expect(state.view().rows).toEqual([]);

    // refresh 的根请求在队列末尾（索引 2）
    source.resolveAt(2, { total: 1, children: [child('a', 'object', 1)] });
    await refreshing;

    const view = state.view();
    expect(view.phase).toBe('ready');
    expect(paths(view)).toEqual(['$', '$.a']);
    expect(view.loadedContainers).toBe(1);
    expect(view.loadedChildren).toBe(1);
  });

  it('close：清空状态，在途回包丢弃', async () => {
    const source = new FakeSource();
    const state = new OutlineState(source);
    const opening = state.open('r1');
    state.close();

    expect(state.view().phase).toBe('idle');
    expect(state.view().rows).toEqual([]);
    expect(state.view().rootId).toBeNull();

    source.resolveAt(0, { total: 1, children: [child('a', 'number')] });
    await opening;
    expect(state.view().phase).toBe('idle');
    expect(state.view().rows).toEqual([]);
  });
});

describe('OutlineState — 文档生命周期', () => {
  it('换文档重置：展开现场 / 选中清空，行来自新文档', async () => {
    const source = new FakeSource();
    const state = await opened(source);
    const expanding = state.setOpen('$.a', true);
    source.resolveAt(1, { total: 1, children: [child('x', 'number', 0, '$.a')] });
    await expanding;
    state.setSelected('$.a.x');

    const opening = state.open('r2');
    expect(state.view().phase).toBe('loading');
    expect(state.view().selected).toBeNull();
    expect(state.expandedPaths()).toEqual(['$']);
    expect(state.view().loadedContainers).toBe(0);

    source.resolveAt(2, { rootId: 'r2', total: 1, children: [child('other', 'boolean')] });
    await opening;
    expect(paths(state.view())).toEqual(['$', '$.other']);
    expect(state.view().rows.some((row) => row.path.startsWith('$.a'))).toBe(false);
  });

  it('refresh（编辑）：回到根展开、丢弃子页，selected 保留', async () => {
    const source = new FakeSource();
    const state = await opened(source);
    const expanding = state.setOpen('$.a', true);
    source.resolveAt(1, { total: 1, children: [child('x', 'number', 0, '$.a')] });
    await expanding;
    state.setSelected('$.a');

    const refreshing = state.refresh();
    expect(state.view().phase).toBe('loading');
    expect(state.expandedPaths()).toEqual(['$']);
    expect(state.view().selected).toBe('$.a');

    const rootReqIndex = source.requests.length - 1;
    source.resolveAt(rootReqIndex, {
      total: 1,
      children: [child('a', 'object', 1)],
    });
    await refreshing;

    expect(paths(state.view())).toEqual(['$', '$.a']);
    expect(state.view().phase).toBe('ready');
    expect(state.view().selected).toBe('$.a');
    expect(state.view().loadedContainers).toBe(1);
  });

  it('refresh：无文档时是空操作（不请求）', async () => {
    const source = new FakeSource();
    const state = new OutlineState(source);
    await state.refresh();
    expect(source.requests).toHaveLength(0);
    expect(state.view().phase).toBe('idle');
  });

  it('根页失败：phase=error + error 文案；重试 open 可恢复', async () => {
    const source = new FakeSource();
    const state = new OutlineState(source);
    const opening = state.open('r1');
    source.rejectAt(0, new Error('bad command'));
    await opening;

    expect(state.view().phase).toBe('error');
    expect(state.view().error).toBe('bad command');
    expect(state.view().rows).toEqual([]);

    const retry = state.open('r1');
    source.resolveAt(1, { total: 1, children: [child('a', 'number')] });
    await retry;
    expect(state.view().phase).toBe('ready');
    expect(state.view().error).toBeNull();
    expect(paths(state.view())).toEqual(['$', '$.a']);
  });

  it('非根容器页失败：再次展开会重试，不进入「展开但无子行」死态', async () => {
    const source = new FakeSource();
    const state = await opened(source); // 根页：a(object,1) / b(number)

    const expand = state.setOpen('$.a', true);
    expect(source.last).toMatchObject({ path: '$.a', start: 0 });
    source.rejectAt(1, new Error('timeout'));
    await expand;

    // 展开态已置位但页失败：暂无子行（视图可据此重试）
    expect(state.isExpanded('$.a')).toBe(true);
    expect(paths(state.view())).toEqual(['$', '$.a', '$.b']);

    // 再次 setOpen（等价于折叠后再展开）→ 重新发请求并恢复
    const retry = state.setOpen('$.a', true);
    expect(source.requests).toHaveLength(3);
    source.resolveAt(2, { kind: 'object', total: 1, children: [child('c', 'number', 0, '$.a')] });
    await retry;
    expect(paths(state.view())).toEqual(['$', '$.a', '$.a.c', '$.b']);
  });
});

describe('OutlineState — refreshOrder（#40 / ADR-0024 显示序变化）', () => {
  it('保留展开集合与已加载数量：只重取根 + 已展开容器，不回根页', async () => {
    const source = new FakeSource();
    const state = await opened(source); // 根页：a(object,1) / b(number)
    const expanding = state.setOpen('$.a', true);
    source.resolveAt(1, { total: 1, children: [child('x', 'number', 0, '$.a')] });
    await expanding;
    expect(paths(state.view())).toEqual(['$', '$.a', '$.a.x', '$.b']);

    const refreshing = state.refreshOrder();
    // 只重取根与已展开的 $.a（两次请求），展开集合不重置
    expect(source.requests).toHaveLength(4);
    expect(source.requests[2]).toMatchObject({ path: '$', start: 0 });
    expect(source.requests[3]).toMatchObject({ path: '$.a', start: 0 });
    expect(state.expandedPaths()).toContain('$.a');

    // 新顺序：b 在前、a 在后
    source.resolveAt(2, { total: 2, children: [child('b', 'number'), child('a', 'object', 1)] });
    source.resolveAt(3, { total: 1, children: [child('x', 'number', 0, '$.a')] });
    await refreshing;

    expect(paths(state.view())).toEqual(['$', '$.b', '$.a', '$.a.x']);
    expect(state.expandedPaths()).toContain('$.a');
    expect(state.view().phase).toBe('ready');
  });

  it('无文档 / 根页未就绪 → 空操作（不发请求）', async () => {
    const empty = new OutlineState(new FakeSource());
    await empty.refreshOrder();
    expect(empty.view().phase).toBe('idle');

    const source = new FakeSource();
    const state = new OutlineState(source);
    const opening = state.open('r1'); // 根页在途
    expect(source.requests).toHaveLength(1);
    await state.refreshOrder(); // 根页未 loaded → no-op
    expect(source.requests).toHaveLength(1);
    source.resolveAt(0, { total: 1, children: [child('a', 'number')] });
    await opening;
    expect(paths(state.view())).toEqual(['$', '$.a']);
  });

  it('旧档在途回包按 epoch 丢弃（切档后不串页）', async () => {
    const source = new FakeSource();
    const state = await opened(source);
    const expanding = state.setOpen('$.a', true); // #1 在途
    const refreshing = state.refreshOrder(); // epoch++：根 #2、$.a #3
    source.resolveAt(1, { total: 1, children: [child('stale', 'number', 0, '$.a')] });
    await expanding;
    expect(source.requests).toHaveLength(4);
    source.resolveAt(2, { total: 2, children: [child('b', 'number'), child('a', 'object', 1)] });
    source.resolveAt(3, { total: 1, children: [child('x', 'number', 0, '$.a')] });
    await refreshing;
    expect(paths(state.view()).some((path) => path.includes('stale'))).toBe(false);
    expect(paths(state.view())).toEqual(['$', '$.b', '$.a', '$.a.x']);
  });
});

describe('OutlineState — setSelected / view / 订阅', () => {
  it('setSelected：写入 selected，行不变；同值不重复通知', async () => {
    const state = await opened(new FakeSource());
    const listener = vi.fn();
    state.subscribe(listener);

    state.setSelected('$.a');
    expect(state.view().selected).toBe('$.a');
    expect(listener).toHaveBeenCalledTimes(1);

    state.setSelected('$.a');
    expect(listener).toHaveBeenCalledTimes(1);

    state.setSelected(null);
    expect(state.view().selected).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);

    const off = state.subscribe(listener);
    off();
  });

  it('view 快照：phase / rows / selected / loadedContainers / loadedChildren 一致', async () => {
    const state = await opened(new FakeSource());
    const view = state.view();
    expect(view).toMatchObject({
      phase: 'ready',
      rootId: 'r1',
      loadedContainers: 1,
      loadedChildren: 2,
      error: null,
    });
    expect(view.rows).toHaveLength(3);
    expect(state.rowCount()).toBe(3);
  });

  it('订阅：变化通知、unsubscribe 后不再通知', async () => {
    const source = new FakeSource();
    const state = new OutlineState(source);
    const listener = vi.fn();
    const off = state.subscribe(listener);

    const opening = state.open('r1');
    expect(listener).toHaveBeenCalled(); // open 即通知（loading 帧）
    source.resolveAt(0, { total: 0, children: [] });
    await opening;
    expect(listener).toHaveBeenCalledTimes(2);

    off();
    state.setSelected('$');
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
