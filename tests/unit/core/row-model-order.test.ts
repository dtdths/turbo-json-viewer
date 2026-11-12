/**
 * RowModel — 子键显示排序（#40 / ADR-0024 §1/§2/§6）。
 *
 * 契约要点：
 *   - `keysOf` 是显示 slot 序的唯一来源；raw 档必须与引入该选项前**逐行一致**。
 *   - 只排对象成员；数组恒索引序。
 *   - `setOrder(order)` 重置键缓存，并重建 `expanded` 集合里每个对象容器的 Fenwick
 *     （子树可见行数与顺序无关 ⇒ 独立 measureChildren 即可）。
 */
import { describe, expect, it } from 'vitest';
import { CoreError } from '../../../src/protocol/errors';
import { RowModel } from '../../../src/core/row-model';
import { ROOT_PATH } from '../../../src/shared/path';

const DOC = {
  b2: { z: 1, a: 2 },
  a10: [3, 1, 2],
  a2: 'x',
  Empty: {},
};

/** 顶层 raw = 值图键序；asc = 自然序（a2 < a10 < b2 < Empty）；desc = 反序。 */
const RAW_TOP = ['$.b2', '$.a10', '$.a2', '$.Empty'];
const ASC_TOP = ['$.a2', '$.a10', '$.b2', '$.Empty'];
const DESC_TOP = ['$.Empty', '$.b2', '$.a10', '$.a2'];

function paths(model: RowModel, start = 0, count = 100): string[] {
  return model.window(start, count).map((row) => row.path);
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(CoreError);
    return (err as CoreError).code;
  }
  throw new Error('expected the call to throw');
}

describe('RowModel — 三档显示顺序（顶层）', () => {
  it('缺省 raw：与值图键序一致', () => {
    expect(paths(new RowModel(DOC))).toEqual([ROOT_PATH, ...RAW_TOP]);
  });

  it('key-asc：数字段按数值、非数字段忽略大小写', () => {
    expect(paths(new RowModel(DOC, { order: 'key-asc' }))).toEqual([ROOT_PATH, ...ASC_TOP]);
  });

  it('key-desc：升序的严格反序', () => {
    expect(paths(new RowModel(DOC, { order: 'key-desc' }))).toEqual([ROOT_PATH, ...DESC_TOP]);
  });
});

describe('RowModel — 展开后的行序', () => {
  it('展开对象容器：子键按显示序；数组保持索引序', () => {
    const model = new RowModel(DOC, { order: 'key-asc' });
    model.toggle('$.b2', true);
    expect(paths(model)).toEqual([
      ROOT_PATH,
      '$.a2',
      '$.a10',
      '$.b2',
      '$.b2.a',
      '$.b2.z',
      '$.Empty',
    ]);

    model.toggle('$.a10', true);
    expect(paths(model)).toEqual([
      ROOT_PATH,
      '$.a2',
      '$.a10',
      '$.a10[0]',
      '$.a10[1]',
      '$.a10[2]',
      '$.b2',
      '$.b2.a',
      '$.b2.z',
      '$.Empty',
    ]);
  });

  it('未展开的容器不参与行序（子项在展开时才按显示序物化）', () => {
    const model = new RowModel(DOC, { order: 'key-desc' });
    expect(paths(model)).toEqual([ROOT_PATH, ...DESC_TOP]);
    expect(model.totalRows).toBe(5);

    model.toggle('$.b2', true);
    expect(paths(model)).toEqual([
      ROOT_PATH,
      '$.Empty',
      '$.b2',
      '$.b2.z',
      '$.b2.a',
      '$.a10',
      '$.a2',
    ]);
  });

  it('数组恒索引序（order 只影响对象成员）', () => {
    const model = new RowModel({ arr: [10, 2, 1], obj: { b: 1, a: 2 } }, { order: 'key-desc' });
    model.toggle('$.arr', true);
    model.toggle('$.obj', true);
    expect(paths(model)).toEqual([
      ROOT_PATH,
      '$.obj',
      '$.obj.b',
      '$.obj.a',
      '$.arr',
      '$.arr[0]',
      '$.arr[1]',
      '$.arr[2]',
    ]);
  });

  it('expandAll / expandIfAtMost：全展开索引按显示序建（不是 Object.keys 顺序）', () => {
    const model = new RowModel(DOC, { order: 'key-desc' });
    expect(model.expandIfAtMost(100)).toBe(true);
    expect(model.totalRows).toBe(10);
    expect(paths(model)).toEqual([
      ROOT_PATH,
      '$.Empty',
      '$.b2',
      '$.b2.z',
      '$.b2.a',
      '$.a10',
      '$.a10[0]',
      '$.a10[1]',
      '$.a10[2]',
      '$.a2',
    ]);
    // 行号 ↔ 路径双向一致（descend 用 Fenwick 的 slot 必须与显示序对齐）
    model.window(0, 20).forEach((row, index) => expect(model.rowOfPath(row.path)).toBe(index));
    // openPaths 也按显示序做确定性前序
    expect(model.openPaths()).toEqual([ROOT_PATH, '$.b2', '$.a10']);
  });

  it('toggleSubtree：子树批量展开按显示序建索引', () => {
    const model = new RowModel(DOC, { order: 'key-asc' });
    expect(model.toggleSubtree('$.b2', true)).toMatchObject({ changed: true, totalRows: 7 });
    expect(paths(model)).toEqual([ROOT_PATH, '$.a2', '$.a10', '$.b2', '$.b2.a', '$.b2.z', '$.Empty']);
  });
});

describe('RowModel — setOrder', () => {
  it('切档重排行序；同档 no-op；raw 回到切换前逐行一致', () => {
    const model = new RowModel(DOC);
    model.toggle('$.b2', true);
    model.toggle('$.a10', true);
    const before = model.window(0, 100);

    expect(model.setOrder('key-asc')).toBe(true);
    expect(model.sortOrder).toBe('key-asc');
    expect(paths(model)).toEqual([
      ROOT_PATH,
      '$.a2',
      '$.a10',
      '$.a10[0]',
      '$.a10[1]',
      '$.a10[2]',
      '$.b2',
      '$.b2.a',
      '$.b2.z',
      '$.Empty',
    ]);

    // 同挡 no-op：不重置缓存、不重建索引、返回 false
    expect(model.setOrder('key-asc')).toBe(false);

    expect(model.setOrder('raw')).toBe(true);
    expect(model.window(0, 100)).toEqual(before);
  });

  it('普通构造 + setOrder 与直接以目标档构造逐行等价（含 Fenwick 重建）', () => {
    const pairs: Array<['raw' | 'key-asc' | 'key-desc', 'raw' | 'key-asc' | 'key-desc']> = [
      ['key-asc', 'key-desc'],
      ['key-desc', 'key-asc'],
      ['raw', 'key-asc'],
      ['key-asc', 'raw'],
    ];
    for (const [from, to] of pairs) {
      const model = new RowModel(DOC, { order: from });
      model.expandAll();
      const total = model.totalRows;

      expect(model.setOrder(to)).toBe(true);
      expect(model.totalRows).toBe(total); // 子树行数与顺序无关

      const fresh = new RowModel(DOC, { order: to });
      fresh.expandAll();
      const rows = model.window(0, 100);
      expect(rows).toEqual(fresh.window(0, 100));
      expect(model.window(3, 4)).toEqual(fresh.window(3, 4)); // 跨容器边界的窗口切片
      rows.forEach((row, index) => expect(model.rowOfPath(row.path)).toBe(index));
      expect(model.openPaths()).toEqual(fresh.openPaths());
    }
  });

  it('重排后 toggle / 行号 / 总行数仍自洽（Fenwick 与显示 slot 对齐）', () => {
    const model = new RowModel(DOC, { order: 'key-asc' });
    model.toggle('$.a10', true);
    expect(model.toggle('$.b2', true)).toMatchObject({ row: 6, changed: true, totalRows: 10 });
    expect(model.rowOfPath('$.b2.a')).toBe(7);
    expect(model.rowOfPath('$.b2.z')).toBe(8);
    expect(model.rowOfPath('$.Empty')).toBe(9);

    expect(model.toggle('$.b2', false)).toMatchObject({ row: 6, changed: true, totalRows: 8 });
    expect(model.rowOfPath('$.b2.z')).toBe(-1);
    expect(model.window(6, 2).map((row) => row.path)).toEqual(['$.b2', '$.Empty']);
  });

  it('标量根：切档返回 true（视图状态变了），行仍是一行', () => {
    const model = new RowModel('hello');
    expect(model.setOrder('key-desc')).toBe(true);
    expect(model.totalRows).toBe(1);
    expect(paths(model)).toEqual([ROOT_PATH]);
    expect(model.setOrder('key-desc')).toBe(false);
  });

  it('预算护栏不受切档影响：已有展开态原样保留、不新增行', () => {
    const model = new RowModel(DOC, { order: 'raw', rowBudget: 6 });
    expect(model.totalRows).toBe(5);
    expect(codeOf(() => model.toggle('$.b2', true))).toBe('TOO_MANY_ROWS');

    expect(model.setOrder('key-asc')).toBe(true);
    expect(model.totalRows).toBe(5);
    expect(paths(model)).toEqual([ROOT_PATH, ...ASC_TOP]);
  });
});

describe('RowModel — 编辑后按当前显示序重排', () => {
  it('replaceNode 换入的对象：展开态保留、子键按当前档排列', () => {
    const model = new RowModel({ b: { y: 1 }, a: 2 }, { order: 'key-asc' });
    model.toggle('$.b', true);
    expect(paths(model)).toEqual([ROOT_PATH, '$.a', '$.b', '$.b.y']);

    model.replaceNode('$.b', { z: 9, c: 8 });
    expect(paths(model)).toEqual([ROOT_PATH, '$.a', '$.b', '$.b.c', '$.b.z']);

    // 新换入的对象行号可反查
    expect(model.rowOfPath('$.b.c')).toBe(3);
    expect(model.rowOfPath('$.b.z')).toBe(4);
  });

  it('replaceNode 根：整个模型按当前档重建', () => {
    const model = new RowModel({ x: 1 }, { order: 'key-desc' });
    model.replaceNode(ROOT_PATH, { z: 1, a: 2, C: 3 });
    // desc：折小写 a < c < z 的严格反序
    expect(paths(model)).toEqual([ROOT_PATH, '$.z', '$.C', '$.a']);
  });

  it('clear（全收起）后再展开仍按当前档', () => {
    const model = new RowModel(DOC, { order: 'key-desc' });
    model.expandAll();
    model.clear();
    expect(paths(model)).toEqual([ROOT_PATH, ...DESC_TOP]);
    expect(model.toggle('$.b2', true)).toMatchObject({ changed: true });
    expect(model.window(0, 10).map((row) => row.path)).toEqual([
      ROOT_PATH,
      '$.Empty',
      '$.b2',
      '$.b2.z',
      '$.b2.a',
      '$.a10',
      '$.a2',
    ]);
  });
});

describe('RowModel — raw 档逐行等价（不得改变既有行为）', () => {
  const FIXTURES: unknown[] = [
    DOC,
    JSON.parse('{"b":1,"a":2,"10":3,"2":4}'),
    { arr: [1, { z: 1, a: 2 }], n: null, 'a b': 3 },
    'scalar',
    [3, 1, 2],
  ];

  it('缺省 order 与显式 order:"raw" 在 expandAll 后逐行完全一致', () => {
    for (const fixture of FIXTURES) {
      const implicit = new RowModel(fixture);
      implicit.expandAll();
      const explicit = new RowModel(fixture, { order: 'raw' });
      explicit.expandAll();
      expect(implicit.window(0, 200)).toEqual(explicit.window(0, 200));
      expect(implicit.totalRows).toBe(explicit.totalRows);
      expect(implicit.openPaths()).toEqual(explicit.openPaths());
    }
  });

  it('升序 → raw 往返后逐行回到原样（缓存不残留）', () => {
    const model = new RowModel(DOC);
    model.expandAll();
    const before = model.window(0, 100);
    model.setOrder('key-desc');
    expect(model.window(0, 100)).not.toEqual(before);
    model.setOrder('raw');
    expect(model.window(0, 100)).toEqual(before);
  });
});
