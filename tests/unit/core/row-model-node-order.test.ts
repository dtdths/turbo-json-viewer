/**
 * RowModel — 单节点子键排序覆盖（#41 / ADR-0024 修订 2026-11-13 / v1.1）。
 *
 * 契约要点：
 *   - 覆盖表 `WeakMap<Container, SortOrder>`：只影响**该容器直接子键**，不向下继承；
 *   - `keysOf` = `覆盖 ?? 全局`（仍懒排序 + keysCache 缓存）；
 *   - `setNodeOrder(path, order | null)`：目标必须对象容器（数组 / 标量 / 路径不存在 → BAD_COMMAND）；
 *     覆盖变化**始终 changed=true**（即使容器折叠）；同覆盖 no-op；
 *   - 全局 `setOrder` **不清覆盖**；编辑替换后新对象天然无覆盖（回全局）；
 *   - `displayOrderAt(path)`：对象容器 → 覆盖 ?? 全局；数组 / 标量 → 全局。只读。
 */
import { describe, expect, it } from 'vitest';
import { CoreError } from '../../../src/protocol/errors';
import { RowModel } from '../../../src/core/row-model';
import { ROOT_PATH } from '../../../src/shared/path';
import type { SortOrder } from '../../../src/protocol/types';

const DOC = {
  b: { z: 1, a: 2, m: 3 }, // raw z,a,m；asc a,m,z；desc z,m,a
  a: { x: 1, y: 2 }, // raw x,y；asc x,y；desc y,x
  arr: [{ a: 1, z: 2 }], // 数组恒索引序；元素对象 raw a,z / desc z,a
  scalar: 5,
};

/** DOC 全展开（13 行）的 raw 行序。 */
const RAW_ALL = [
  ROOT_PATH,
  '$.b',
  '$.b.z',
  '$.b.a',
  '$.b.m',
  '$.a',
  '$.a.x',
  '$.a.y',
  '$.arr',
  '$.arr[0]',
  '$.arr[0].a',
  '$.arr[0].z',
  '$.scalar',
];

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

describe('RowModel — setNodeOrder：只排直接子键', () => {
  it('覆盖一个容器只改它的直接子键行序，其他容器不受影响', () => {
    const model = new RowModel(DOC);
    model.expandAll();
    expect(paths(model)).toEqual(RAW_ALL);

    expect(model.setNodeOrder('$.b', 'key-desc')).toEqual({ row: 1, changed: true, totalRows: 13 });
    expect(paths(model)).toEqual([
      ROOT_PATH,
      '$.b',
      '$.b.z',
      '$.b.m',
      '$.b.a',
      '$.a',
      '$.a.x',
      '$.a.y',
      '$.arr',
      '$.arr[0]',
      '$.arr[0].a',
      '$.arr[0].z',
      '$.scalar',
    ]);
    // 相邻容器仍是 raw / 全局序
    expect(model.displayOrderAt('$.a')).toBe('raw');
    expect(model.totalRows).toBe(13);
  });

  it('不向下继承：根覆盖只改根的直接成员，子树各层仍用全局规则', () => {
    const model = new RowModel(DOC);
    model.expandAll();
    expect(model.setNodeOrder(ROOT_PATH, 'key-desc')).toEqual({ row: 0, changed: true, totalRows: 13 });
    // 根 desc：scalar > b > arr > a；b / arr[0] 的子键仍是 raw
    expect(paths(model)).toEqual([
      ROOT_PATH,
      '$.scalar',
      '$.b',
      '$.b.z',
      '$.b.a',
      '$.b.m',
      '$.arr',
      '$.arr[0]',
      '$.arr[0].a',
      '$.arr[0].z',
      '$.a',
      '$.a.x',
      '$.a.y',
    ]);
    expect(model.displayOrderAt('$')).toBe('key-desc');
    expect(model.displayOrderAt('$.b')).toBe('raw');
    expect(model.displayOrderAt('$.a')).toBe('raw');
  });

  it('数组恒索引序：数组节点 BAD_COMMAND；数组内对象容器可单独覆盖', () => {
    const model = new RowModel(DOC);
    model.expandAll();
    expect(codeOf(() => model.setNodeOrder('$.arr', 'key-desc'))).toBe('BAD_COMMAND');
    expect(model.displayOrderAt('$.arr')).toBe('raw'); // 数组 → 全局

    expect(model.setNodeOrder('$.arr[0]', 'key-desc')).toMatchObject({ row: 9, changed: true });
    // 数组元素顺序不变（[0] 仍是唯一元素、序号不变）
    expect(paths(model).filter((path) => /^\$\.arr\[\d+\]$/.test(path))).toEqual(['$.arr[0]']);
    expect(paths(model).slice(8)).toEqual([
      '$.arr',
      '$.arr[0]',
      '$.arr[0].z',
      '$.arr[0].a',
      '$.scalar',
    ]);
  });
});

describe('RowModel — setNodeOrder：清覆盖 / 与全局切档的关系', () => {
  it('清覆盖（null）回到全局序；无覆盖时清覆盖是 no-op', () => {
    const model = new RowModel(DOC, { order: 'key-asc' });
    model.expandAll();
    model.setNodeOrder('$.b', 'key-desc');

    const cleared = model.setNodeOrder('$.b', null);
    expect(cleared).toMatchObject({ changed: true });
    expect(model.displayOrderAt('$.b')).toBe('key-asc');

    // 与「直接按全局 key-asc 构造」逐行一致
    const fresh = new RowModel(DOC, { order: 'key-asc' });
    fresh.expandAll();
    expect(model.window(0, 100)).toEqual(fresh.window(0, 100));
    expect(model.rowOfPath('$.b.a')).toBe(fresh.rowOfPath('$.b.a'));

    expect(model.setNodeOrder('$.b', null)).toMatchObject({ changed: false, totalRows: 13 });
  });

  it('全局 setOrder 不清覆盖：已覆盖节点保持自己的规则，未覆盖节点跟随全局', () => {
    const model = new RowModel(DOC);
    model.expandAll();
    // 显式写一条 raw 覆盖（此刻全局也是 raw → 覆盖本身仍算变化）
    expect(model.setNodeOrder('$.b', 'raw')).toMatchObject({ changed: true });

    expect(model.setOrder('key-desc')).toBe(true);
    expect(model.displayOrderAt('$.b')).toBe('raw');
    expect(model.displayOrderAt('$.a')).toBe('key-desc');
    expect(paths(model)).toEqual([
      ROOT_PATH,
      '$.scalar',
      '$.b',
      '$.b.z',
      '$.b.a',
      '$.b.m',
      '$.arr',
      '$.arr[0]',
      '$.arr[0].z',
      '$.arr[0].a',
      '$.a',
      '$.a.y',
      '$.a.x',
    ]);

    // 清覆盖后该容器改跟全局（desc）
    expect(model.setNodeOrder('$.b', null)).toMatchObject({ changed: true });
    expect(paths(model).slice(1, 6)).toEqual(['$.scalar', '$.b', '$.b.z', '$.b.m', '$.b.a']);
    expect(model.displayOrderAt('$.b')).toBe('key-desc');
  });
});

describe('RowModel — setNodeOrder：no-op / 归一化 / 编辑失效', () => {
  it('同一覆盖是 no-op（不失效、不重建）；非法档位按白名单归一化', () => {
    const model = new RowModel(DOC);
    model.expandAll();
    expect(model.setNodeOrder('$.b', 'key-asc')).toMatchObject({ changed: true, row: 1, totalRows: 13 });
    expect(model.setNodeOrder('$.b', 'key-asc')).toEqual({ row: 1, changed: false, totalRows: 13 });
    expect(model.setNodeOrder('$.a', null)).toEqual({ row: 5, changed: false, totalRows: 13 });

    // 非法值 → raw（不是抛错）
    expect(model.setNodeOrder('$.b', 'nope' as unknown as SortOrder)).toMatchObject({ changed: true });
    expect(model.displayOrderAt('$.b')).toBe('raw');
    expect(model.setNodeOrder('$.b', 'nope' as unknown as SortOrder)).toMatchObject({ changed: false });
  });

  it('编辑替换后覆盖自动失效（覆盖按容器对象存于 WeakMap，新对象无覆盖）', () => {
    const model = new RowModel({ b: { z: 1, a: 2 }, c: { q: 1, p: 2 } }, { order: 'key-asc' });
    model.expandAll();
    model.setNodeOrder('$.b', 'key-desc');
    expect(paths(model)).toEqual([ROOT_PATH, '$.b', '$.b.z', '$.b.a', '$.c', '$.c.p', '$.c.q']);

    model.replaceNode('$.b', { z: 9, a: 8 });
    expect(model.displayOrderAt('$.b')).toBe('key-asc');
    expect(paths(model)).toEqual([ROOT_PATH, '$.b', '$.b.a', '$.b.z', '$.c', '$.c.p', '$.c.q']);

    // 根替换同样失效 → 回全局
    const rootModel = new RowModel({ a: 1, b: 2 });
    rootModel.setNodeOrder(ROOT_PATH, 'key-desc');
    expect(paths(rootModel)).toEqual([ROOT_PATH, '$.b', '$.a']);
    rootModel.replaceNode(ROOT_PATH, { a: 1, b: 2 });
    expect(rootModel.displayOrderAt('$')).toBe('raw');
    expect(paths(rootModel)).toEqual([ROOT_PATH, '$.a', '$.b']);
  });
});

describe('RowModel — setNodeOrder：折叠容器 / Fenwick 一致性', () => {
  it('折叠容器覆盖也 changed=true，展开后按覆盖序；折叠祖先下的隐形容器同样', () => {
    const model = new RowModel(DOC);
    expect(model.totalRows).toBe(5);
    expect(model.setNodeOrder('$.b', 'key-desc')).toEqual({ row: 1, changed: true, totalRows: 5 });
    expect(model.totalRows).toBe(5);

    model.toggle('$.b', true);
    expect(paths(model)).toEqual([ROOT_PATH, '$.b', '$.b.z', '$.b.m', '$.b.a', '$.a', '$.arr', '$.scalar']);

    // 祖先折叠 → 不可见，但覆盖变化仍 changed=true（row=-1）
    expect(model.setNodeOrder('$.arr[0]', 'key-desc')).toEqual({ row: -1, changed: true, totalRows: 8 });
    model.toggle('$.arr', true);
    model.toggle('$.arr[0]', true);
    expect(paths(model)).toEqual([
      ROOT_PATH,
      '$.b',
      '$.b.z',
      '$.b.m',
      '$.b.a',
      '$.a',
      '$.arr',
      '$.arr[0]',
      '$.arr[0].z',
      '$.arr[0].a',
      '$.scalar',
    ]);
    expect(model.displayOrderAt('$.arr[0]')).toBe('key-desc');
  });

  it('覆盖后 Fenwick / descend / rowOfPath 与「等价直达序构造」逐行一致', () => {
    // A：全局 raw + 逐容器覆盖 desc；B：全局 desc + 根覆盖 raw（其余容器跟着全局 desc）
    const a = new RowModel(DOC);
    a.expandAll();
    a.setNodeOrder('$.b', 'key-desc');
    a.setNodeOrder('$.a', 'key-desc');
    a.setNodeOrder('$.arr[0]', 'key-desc');

    const b = new RowModel(DOC, { order: 'key-desc' });
    b.expandAll();
    b.setNodeOrder(ROOT_PATH, 'raw');

    expect(a.totalRows).toBe(13);
    expect(a.window(0, 100)).toEqual(b.window(0, 100));
    expect(a.window(3, 4)).toEqual(b.window(3, 4));
    expect(a.window(8, 5)).toEqual(b.window(8, 5));
    a.window(0, 100).forEach((row, index) => expect(a.rowOfPath(row.path)).toBe(index));
    expect(a.rowOfPath('$.b.z')).toBe(2);

    // 覆盖仍生效：再切全局档，覆盖容器的子键序不变（根跟随新全局档）
    expect(a.setOrder('key-desc')).toBe(true);
    expect(a.displayOrderAt('$.b')).toBe('key-desc');
    expect(a.window(2, 4).map((row) => row.path)).toEqual(['$.b', '$.b.z', '$.b.m', '$.b.a']);
  });
});

describe('RowModel — setNodeOrder / displayOrderAt：根 / 空容器 / 错误', () => {
  it('根允许；空对象允许（写入覆盖）；标量根 / 标量路径 BAD_COMMAND', () => {
    const model = new RowModel({ a: 1, b: 2 });
    expect(model.setNodeOrder(ROOT_PATH, 'key-desc')).toEqual({ row: 0, changed: true, totalRows: 3 });
    expect(paths(model)).toEqual([ROOT_PATH, '$.b', '$.a']);
    expect(model.displayOrderAt('$')).toBe('key-desc');
    expect(model.setNodeOrder(ROOT_PATH, null)).toMatchObject({ row: 0, changed: true });
    expect(paths(model)).toEqual([ROOT_PATH, '$.a', '$.b']);

    const empty = new RowModel({ empty: {} });
    expect(empty.setNodeOrder('$.empty', 'key-desc')).toMatchObject({ row: 1, changed: true });
    expect(empty.displayOrderAt('$.empty')).toBe('key-desc');

    const scalarRoot = new RowModel('x');
    expect(codeOf(() => scalarRoot.setNodeOrder(ROOT_PATH, 'key-desc'))).toBe('BAD_COMMAND');
    expect(scalarRoot.displayOrderAt('$')).toBe('raw');

    expect(codeOf(() => model.setNodeOrder('$.a', 'key-desc'))).toBe('BAD_COMMAND'); // 标量
    expect(codeOf(() => model.setNodeOrder('$.nope', 'key-desc'))).toBe('BAD_COMMAND');
  });

  it('displayOrderAt：对象容器 = 覆盖 ?? 全局；数组 / 标量 = 全局；只读不抛', () => {
    const model = new RowModel(DOC, { order: 'key-asc' });
    expect(model.displayOrderAt('$')).toBe('key-asc');
    expect(model.displayOrderAt('$.arr')).toBe('key-asc'); // 数组 → 全局
    expect(model.displayOrderAt('$.scalar')).toBe('key-asc');
    expect(model.displayOrderAt('$.arr[0]')).toBe('key-asc');

    model.setNodeOrder('$.arr[0]', 'key-desc');
    expect(model.displayOrderAt('$.arr[0]')).toBe('key-desc');
    expect(model.displayOrderAt('$.b')).toBe('key-asc');
    // 只读：不改变行序（模型未展开：只有根的直接子键行）
    expect(paths(model).slice(0, 3)).toEqual([ROOT_PATH, '$.a', '$.arr']);

    expect(codeOf(() => model.displayOrderAt('$.nope'))).toBe('BAD_COMMAND');
    expect(codeOf(() => model.displayOrderAt('$.b.nope'))).toBe('BAD_COMMAND');
    expect(codeOf(() => model.displayOrderAt('$.scalar.deeper'))).toBe('BAD_COMMAND');
  });
});

describe('RowModel — 覆盖的生命周期（视图收起保留 / 编辑替换清）', () => {
  it('纯视图收起（collapseAll / toggleSubtree(false)）不清覆盖；展开后仍按覆盖序', () => {
    const model = new RowModel(DOC);
    model.expandAll();
    model.setNodeOrder('$.b', 'key-asc');

    model.collapseAll();
    expect(model.displayOrderAt('$.b')).toBe('key-asc');
    expect(model.totalRows).toBe(5);

    model.expandAll();
    expect(model.displayOrderAt('$.b')).toBe('key-asc');
    expect(paths(model).slice(1, 5)).toEqual(['$.b', '$.b.a', '$.b.m', '$.b.z']);

    // 子树深度复位也不算编辑：覆盖保留
    model.toggleSubtree('$.b', false);
    expect(model.displayOrderAt('$.b')).toBe('key-asc');
    model.toggle('$.b', true);
    expect(paths(model).slice(1, 5)).toEqual(['$.b', '$.b.a', '$.b.m', '$.b.z']);
  });

  it('编辑替换清覆盖：undo 语义（换回旧对象）也不复活旧覆盖', () => {
    const oldB = { z: 1, a: 2 };
    const model = new RowModel({ b: oldB }, { order: 'key-asc' });
    model.expandAll();
    model.setNodeOrder('$.b', 'key-desc'); // 覆盖 desc：z, a（全局 asc 是 a, z）
    expect(paths(model)).toEqual([ROOT_PATH, '$.b', '$.b.z', '$.b.a']);

    model.replaceNode('$.b', { z: 9, a: 8 }); // 新对象 → 回全局 asc
    expect(model.displayOrderAt('$.b')).toBe('key-asc');
    expect(paths(model)).toEqual([ROOT_PATH, '$.b', '$.b.a', '$.b.z']);

    // undo 语义：把旧对象换回去——旧对象上的覆盖在编辑时已被清 → 仍走全局
    model.replaceNode('$.b', oldB);
    expect(model.displayOrderAt('$.b')).toBe('key-asc');
    expect(paths(model)).toEqual([ROOT_PATH, '$.b', '$.b.a', '$.b.z']);
  });
});
