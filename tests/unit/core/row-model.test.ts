import { describe, expect, it } from 'vitest';
import { CoreError } from '../../../src/protocol/errors';
import { RowModel, countAllExpandedRows, previewOf, truncateText } from '../../../src/core/row-model';
import { ROOT_PATH } from '../../../src/shared/path';

const DOC = {
  id: 'H-1',
  data: {
    hotel_list: [
      { id: 'h0', price: 100 },
      { id: 'h1', price: 200 },
    ],
    meta: { count: 2, note: '含双早' },
  },
  empty: {},
};

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

describe('RowModel — 初始状态', () => {
  it('根展开、顶层字段可见、容器默认折叠', () => {
    const model = new RowModel(DOC);
    expect(model.totalRows).toBe(4); // 1 + 3 个顶层键
    expect(paths(model)).toEqual([ROOT_PATH, '$.id', '$.data', '$.empty']);
  });

  it('行字段符合协议（根 key=root、depth=0）', () => {
    const [root, id, data, empty] = new RowModel(DOC).window(0, 4);
    expect(root).toMatchObject({
      path: '$',
      depth: 0,
      key: 'root',
      idx: false,
      kind: 'object',
      preview: '{…}',
      count: 3,
      open: true,
      hasChildren: true,
    });
    expect(id).toMatchObject({
      path: '$.id',
      depth: 1,
      key: 'id',
      idx: false,
      kind: 'string',
      preview: '"H-1"',
      count: 0,
      open: false,
      hasChildren: false,
    });
    expect(data).toMatchObject({ key: 'data', kind: 'object', open: false, count: 2 });
    expect(data.preview).toBe('"hotel_list": […], "meta": {…}');
    expect(empty).toMatchObject({ path: '$.empty', kind: 'object', preview: '{}', count: 0, hasChildren: false });
  });

  it('标量根文档：只有一行', () => {
    const model = new RowModel('hello');
    expect(model.totalRows).toBe(1);
    expect(model.window(0, 5)).toEqual([
      {
        path: '$',
        depth: 0,
        key: 'root',
        idx: false,
        kind: 'string',
        preview: '"hello"',
        count: 0,
        open: false,
        hasChildren: false,
      },
    ]);
  });
});

describe('RowModel — 展开/折叠', () => {
  it('toggle 展开对象：totalRows 增加，子行出现在正确位置', () => {
    const model = new RowModel(DOC);
    const result = model.toggle('$.data', true);
    expect(result).toMatchObject({ changed: true, row: 2, totalRows: 6 });
    expect(paths(model)).toEqual([
      '$',
      '$.id',
      '$.data',
      '$.data.hotel_list',
      '$.data.meta',
      '$.empty',
    ]);
  });

  it('折叠后释放可见行；子容器展开态保留，重新展开恢复', () => {
    const model = new RowModel(DOC);
    model.toggle('$.data', true);
    model.toggle('$.data.hotel_list', true);
    expect(model.totalRows).toBe(8);
    expect(paths(model)).toContain('$.data.hotel_list[1]');

    model.toggle('$.data', false);
    expect(model.totalRows).toBe(4);
    expect(model.rowOfPath('$.data.meta')).toBe(-1); // 祖先折叠 → 不可见

    model.toggle('$.data', true);
    expect(model.totalRows).toBe(8); // 嵌套展开态被保留
    expect(paths(model)).toEqual([
      '$',
      '$.id',
      '$.data',
      '$.data.hotel_list',
      '$.data.hotel_list[0]',
      '$.data.hotel_list[1]',
      '$.data.meta',
      '$.empty',
    ]);
  });

  it('重复 toggle 是 no-op（changed=false、totalRows 不变）', () => {
    const model = new RowModel(DOC);
    model.toggle('$.empty', true);
    expect(model.totalRows).toBe(4);
    const again = model.toggle('$.empty', true);
    expect(again).toMatchObject({ changed: false, totalRows: 4 });
  });

  it('根永远 open，折叠根是 no-op', () => {
    const model = new RowModel(DOC);
    expect(model.toggle(ROOT_PATH, false)).toMatchObject({ changed: false, totalRows: 4 });
  });

  it('标量不可 toggle：BAD_COMMAND', () => {
    const model = new RowModel(DOC);
    expect(codeOf(() => model.toggle('$.id', true))).toBe('BAD_COMMAND');
  });

  it('路径不存在：BAD_COMMAND', () => {
    const model = new RowModel(DOC);
    expect(codeOf(() => model.toggle('$.nope', true))).toBe('BAD_COMMAND');
    expect(codeOf(() => model.rowOfPath('$.data.nope'))).toBe('BAD_COMMAND');
  });
});

describe('RowModel — 5000 项数组的窗口与行号', () => {
  const big = { items: Array.from({ length: 5000 }, (_, i) => ({ id: i })) };

  it('尾部窗口按 Fenwick 偏移定位', () => {
    const model = new RowModel(big);
    model.toggle('$.items', true);
    expect(model.totalRows).toBe(5002); // 1 根 + 1 数组 + 5000 项
    expect(paths(model, 4998, 4)).toEqual([
      '$.items[4996]',
      '$.items[4997]',
      '$.items[4998]',
      '$.items[4999]',
    ]);
    // 越界裁剪
    expect(paths(model, 5000, 10)).toEqual(['$.items[4998]', '$.items[4999]']);
    expect(model.window(5002, 10)).toEqual([]);
  });

  it('rowOfPath 与窗口坐标一致', () => {
    const model = new RowModel(big);
    model.toggle('$.items', true);
    expect(model.rowOfPath('$.items[0]')).toBe(2);
    expect(model.rowOfPath('$.items[4999]')).toBe(5001);
    expect(model.window(2, 1)[0]?.path).toBe('$.items[0]');
  });

  it('展开中间一项后，其后所有行号右移', () => {
    const model = new RowModel(big);
    model.toggle('$.items', true);
    model.toggle('$.items[1234]', true); // 对象 { id } → +1 行
    expect(model.totalRows).toBe(5003);
    expect(model.rowOfPath('$.items[1234]')).toBe(1236);
    expect(model.rowOfPath('$.items[1234].id')).toBe(1237);
    expect(model.rowOfPath('$.items[1235]')).toBe(1238);
  });
});

describe('RowModel — expandPath', () => {
  it('展开所有祖先（不含自身），返回目标行号', () => {
    const model = new RowModel({ a: { b: { c: 1 } } });
    expect(model.totalRows).toBe(2);
    const result = model.expandPath('$.a.b.c');
    expect(result).toMatchObject({ changed: true, row: 3, totalRows: 4 });
    expect(paths(model)).toEqual(['$', '$.a', '$.a.b', '$.a.b.c']);
    expect(model.rowOfPath('$.a.b.c')).toBe(3);
  });

  it('已展开的祖先不重复展开', () => {
    const model = new RowModel({ a: { b: 1 } });
    model.toggle('$.a', true);
    const result = model.expandPath('$.a.b');
    expect(result).toMatchObject({ changed: false, row: 2, totalRows: 3 });
  });

  it('预算不足时回滚，不留部分修改', () => {
    const model = new RowModel({ a: { b: { c: 1 } } }, { rowBudget: 3 });
    expect(model.totalRows).toBe(2);
    expect(codeOf(() => model.expandPath('$.a.b.c'))).toBe('TOO_MANY_ROWS');
    expect(model.totalRows).toBe(2);
    expect(paths(model)).toEqual(['$', '$.a']);
  });
});

describe('RowModel — 行预算', () => {
  it('展开超预算抛 TOO_MANY_ROWS，模型不变', () => {
    const model = new RowModel({ arr: [1, 2, 3, 4, 5] }, { rowBudget: 4 });
    expect(model.totalRows).toBe(2);
    expect(codeOf(() => model.toggle('$.arr', true))).toBe('TOO_MANY_ROWS');
    expect(model.totalRows).toBe(2);
    expect(paths(model)).toEqual(['$', '$.arr']);
  });
});

describe('RowModel — replaceNode', () => {
  it('替换展开容器：保留自身展开态，子节点折叠', () => {
    const model = new RowModel({ a: { x: 1, y: 2 }, b: 3 });
    model.toggle('$.a', true);
    expect(model.totalRows).toBe(5);

    const result = model.replaceNode('$.a', { z: 9 });
    expect(result).toMatchObject({ changed: true, totalRows: 4, row: 1 });
    expect(paths(model)).toEqual(['$', '$.a', '$.a.z', '$.b']);
  });

  it('替换折叠容器：保持折叠', () => {
    const model = new RowModel({ a: 1, b: 2 });
    const result = model.replaceNode('$.a', { x: 1 });
    expect(result.totalRows).toBe(3);
    expect(paths(model)).toEqual(['$', '$.a', '$.b']);
    expect(model.window(1, 1)[0]).toMatchObject({ path: '$.a', open: false, count: 1, preview: '"x": 1' });
  });

  it('替换根：行模型重建', () => {
    const model = new RowModel({ a: { x: 1 } });
    model.toggle('$.a', true);
    const result = model.replaceNode(ROOT_PATH, { q: [1, 2] });
    expect(result).toMatchObject({ totalRows: 2, row: 0 });
    expect(paths(model)).toEqual(['$', '$.q']);
  });
});

describe('RowModel — 路径与预览', () => {
  it('非标识符键用括号形式，并能反查行号', () => {
    const model = new RowModel({ 'a b': 1, "it's": { x: true } });
    const rows = model.window(0, 10);
    expect(rows.map((r) => r.path)).toEqual(['$', "$['a b']", "$['it\\'s']"]);
    expect(model.rowOfPath("$['a b']")).toBe(1);
    expect(model.rowOfPath("$['it\\'s']")).toBe(2);
  });

  it('长摘要截断到 90 字符', () => {
    const long = { text: 'x'.repeat(300), b: 2, c: 3, d: 4 };
    const row = new RowModel({ o: long }).window(1, 1)[0];
    expect(row?.preview.length).toBe(90);
    expect(row?.preview.endsWith('…')).toBe(true);
    expect(truncateText('abc', 10)).toBe('abc');
  });

  it('不会被 HTML 转义（DOM 层用 textContent）', () => {
    const model = new RowModel({ html: '<b>&"' });
    expect(model.window(1, 1)[0]?.preview).toBe('"<b>&\\""');
  });

  it('previewOf：空容器 / 展开容器 / 标量', () => {
    expect(previewOf({}, false)).toBe('{}');
    expect(previewOf([], false)).toBe('[]');
    expect(previewOf({ a: 1 }, true)).toBe('{…}');
    expect(previewOf([1], true)).toBe('[…]');
    expect(previewOf(42, false)).toBe('42');
    expect(previewOf(null, false)).toBe('null');
    expect(previewOf(true, false)).toBe('true');
  });

  it('窗口越界/负数/零 count 都裁剪而不是抛错', () => {
    const model = new RowModel(DOC);
    expect(paths(model, -5, 2)).toEqual(['$', '$.id']);
    expect(model.window(0, 0)).toEqual([]);
    expect(model.window(100, 5)).toEqual([]);
  });
});

describe('RowModel — clear', () => {
  it('清空展开态并重新挂载根', () => {
    const model = new RowModel(DOC);
    model.toggle('$.data', true);
    expect(model.totalRows).toBe(6);
    model.clear();
    expect(model.totalRows).toBe(4);
    expect(paths(model)).toEqual(['$', '$.id', '$.data', '$.empty']);
  });
});

describe('countAllExpandedRows — 全展开行数（= 节点数）与早停', () => {
  it('返回全展开后的节点总数（标量为 1）', () => {
    expect(countAllExpandedRows('x', 100)).toBe(1);
    expect(countAllExpandedRows([], 100)).toBe(1);
    expect(countAllExpandedRows(DOC, 100)).toBe(14);
  });

  it('超过 limit 立即返回 limit+1，不遍历全量', () => {
    // 14 个节点的文档：limit 远小于总数 → 返回 limit+1 而不是真实总数
    expect(countAllExpandedRows(DOC, 10)).toBe(11);
    expect(countAllExpandedRows(DOC, 5)).toBe(6);

    // 1 万个元素的数组只允许读前几个元素（用 Proxy 观察真实遍历）
    let indexReads = 0;
    const huge = new Proxy(
      Array.from({ length: 10_000 }, (_, i) => i),
      {
        get(target, prop, receiver) {
          if (typeof prop === 'string' && /^\d+$/.test(prop)) indexReads += 1;
          return Reflect.get(target, prop, receiver);
        },
      },
    );
    expect(countAllExpandedRows(huge, 5)).toBe(6);
    expect(indexReads).toBeLessThan(50);
  });
});

describe('RowModel — expandAll', () => {
  it('预算内一次性全开：totalRows = 节点数，行序/行号/展开标记一致', () => {
    const model = new RowModel(DOC);
    const result = model.expandAll();
    expect(result).toEqual({ changed: true, totalRows: 14 });
    expect(model.totalRows).toBe(14);
    expect(paths(model)).toEqual([
      '$',
      '$.id',
      '$.data',
      '$.data.hotel_list',
      '$.data.hotel_list[0]',
      '$.data.hotel_list[0].id',
      '$.data.hotel_list[0].price',
      '$.data.hotel_list[1]',
      '$.data.hotel_list[1].id',
      '$.data.hotel_list[1].price',
      '$.data.meta',
      '$.data.meta.count',
      '$.data.meta.note',
      '$.empty',
    ]);
    expect(model.rowOfPath('$.data.meta.note')).toBe(12);
    expect(model.window(0, 14).filter((row) => row.open).map((row) => row.path)).toEqual([
      '$',
      '$.data',
      '$.data.hotel_list',
      '$.data.hotel_list[0]',
      '$.data.hotel_list[1]',
      '$.data.meta',
    ]);
    expect(model.window(0, 1)[0]?.preview).toBe('{…}');
  });

  it('超预算抛 TOO_MANY_ROWS 且零部分修改（不半开）', () => {
    const model = new RowModel(DOC, { rowBudget: 10 });
    expect(model.totalRows).toBe(4);
    expect(codeOf(() => model.expandAll())).toBe('TOO_MANY_ROWS');
    expect(model.totalRows).toBe(4);
    expect(paths(model)).toEqual(['$', '$.id', '$.data', '$.empty']);
    expect(model.window(0, 10).map((row) => row.open)).toEqual([true, false, false, false]);
  });

  it('显式 limit 先于模型预算生效（limit 超限同样拒绝）', () => {
    const model = new RowModel(DOC); // 预算充足（1,000,000），但 limit=10 挡住
    expect(codeOf(() => model.expandAll(10))).toBe('TOO_MANY_ROWS');
    expect(model.totalRows).toBe(4);
    expect(model.expandAll(14)).toEqual({ changed: true, totalRows: 14 });
  });

  it('显式 limit 不能绕过模型预算（min(limit, rowBudget)）', () => {
    const model = new RowModel(DOC, { rowBudget: 10 });
    expect(codeOf(() => model.expandAll(1000))).toBe('TOO_MANY_ROWS');
    expect(model.totalRows).toBe(4);
  });

  it('已全开后再次 expandAll 是 no-op；expandAll 之后 toggle 仍可逆', () => {
    const model = new RowModel(DOC);
    model.expandAll();
    expect(model.expandAll()).toEqual({ changed: false, totalRows: 14 });

    expect(model.toggle('$.data', false)).toMatchObject({ changed: true, totalRows: 4 });
    expect(model.rowOfPath('$.data.meta.note')).toBe(-1);
    model.toggle('$.data', true);
    expect(model.totalRows).toBe(14);
    expect(model.rowOfPath('$.data.meta.note')).toBe(12);
  });
});

describe('RowModel — expandIfAtMost（load 自适应展开）', () => {
  it('阈值内全展开并返回 true', () => {
    const model = new RowModel(DOC);
    expect(model.expandIfAtMost(14)).toBe(true);
    expect(model.totalRows).toBe(14);
    expect(model.rowOfPath('$.empty')).toBe(13);
    expect(model.expandIfAtMost(14)).toBe(true); // 已全开：幂等
  });

  it('超阈值不展开、不抛错、返回 false', () => {
    const model = new RowModel(DOC);
    expect(model.expandIfAtMost(13)).toBe(false);
    expect(model.totalRows).toBe(4);
    expect(model.window(0, 10).filter((row) => row.open).map((row) => row.path)).toEqual(['$']);
  });

  it('阈值超过模型预算时按预算封顶（不抛错）', () => {
    const model = new RowModel(DOC, { rowBudget: 10 });
    expect(model.expandIfAtMost(1000)).toBe(false);
    expect(model.totalRows).toBe(4);
  });

  it('标量根：没有可展开内容，返回 false', () => {
    expect(new RowModel('x').expandIfAtMost(500)).toBe(false);
  });
});

describe('RowModel — collapseAll', () => {
  it('全开后收起：回到「根 + 顶层字段」', () => {
    const model = new RowModel(DOC);
    model.expandAll();
    expect(model.collapseAll()).toEqual({ changed: true, totalRows: 4 });
    expect(paths(model)).toEqual(['$', '$.id', '$.data', '$.empty']);
    expect(model.window(0, 4).map((row) => row.open)).toEqual([true, false, false, false]);
    expect(model.rowOfPath('$.data.meta')).toBe(-1);
  });

  it('已折叠时是 no-op（changed=false，不改变行数）', () => {
    const model = new RowModel(DOC);
    expect(model.collapseAll()).toEqual({ changed: false, totalRows: 4 });
    expect(paths(model)).toEqual(['$', '$.id', '$.data', '$.empty']);
  });

  it('部分展开后收起回默认，且可再次全开（状态可逆）', () => {
    const model = new RowModel(DOC);
    model.toggle('$.data', true);
    expect(model.totalRows).toBe(6);
    expect(model.collapseAll()).toEqual({ changed: true, totalRows: 4 });
    expect(model.expandAll()).toEqual({ changed: true, totalRows: 14 });
    expect(model.rowOfPath('$.data.meta.note')).toBe(12);
  });
});

/* ===================== #22 子树批量展开 / 收起（ADR-0002 修订） ===================== */

/** DOC 全展开（expandAll 结果）的行序：toggleSubtree 的展开口径必须与之一致。 */
const FULL_PATHS = [
  '$',
  '$.id',
  '$.data',
  '$.data.hotel_list',
  '$.data.hotel_list[0]',
  '$.data.hotel_list[0].id',
  '$.data.hotel_list[0].price',
  '$.data.hotel_list[1]',
  '$.data.hotel_list[1].id',
  '$.data.hotel_list[1].price',
  '$.data.meta',
  '$.data.meta.count',
  '$.data.meta.note',
  '$.empty',
];

describe('RowModel — toggleSubtree 展开', () => {
  it('展开整棵子树：行数/行序/展开标记与 expandAll 同口径', () => {
    const model = new RowModel(DOC);
    const result = model.toggleSubtree('$.data', true);
    expect(result).toEqual({ row: 2, changed: true, totalRows: 14 });
    expect(model.totalRows).toBe(14);
    expect(paths(model)).toEqual(FULL_PATHS);
    expect(model.openPaths()).toEqual([
      '$',
      '$.data',
      '$.data.hotel_list',
      '$.data.hotel_list[0]',
      '$.data.hotel_list[1]',
      '$.data.meta',
    ]);
    expect(model.rowOfPath('$.data.meta.note')).toBe(12);
    expect(model.window(2, 1)[0]).toMatchObject({ path: '$.data', open: true, preview: '{…}' });

    // 与「整根 expandAll」逐行等价（口径一致，不是两套规则）
    const viaAll = new RowModel(DOC);
    viaAll.expandAll();
    expect(model.window(0, 20).map((row) => [row.path, row.open])).toEqual(
      viaAll.window(0, 20).map((row) => [row.path, row.open]),
    );
  });

  it('增量展开：已展开的子树被并入，totalRows 只加差量', () => {
    const model = new RowModel(DOC);
    model.toggle('$.data.hotel_list', true); // 惰性展开（data 仍折叠 → 不可见）
    expect(model.totalRows).toBe(4);

    const result = model.toggleSubtree('$.data', true);
    expect(result).toEqual({ row: 2, changed: true, totalRows: 14 });
    expect(model.totalRows).toBe(14);
    expect(paths(model)).toEqual(FULL_PATHS);
  });

  it('目标已展开但深层仍折叠：补齐差量且不重建整模型', () => {
    const model = new RowModel(DOC);
    model.toggle('$.data', true);
    model.toggle('$.data.hotel_list', true); // meta 仍折叠 → 子树未全展开
    expect(model.totalRows).toBe(8);

    const result = model.toggleSubtree('$.data', true);
    expect(result).toEqual({ row: 2, changed: true, totalRows: 14 });
    expect(paths(model)).toEqual(FULL_PATHS);
    expect(model.isOpenAt('$.data.meta')).toBe(true);
  });

  it('已全展开时是 no-op（changed=false、行映射不变）', () => {
    const model = new RowModel(DOC);
    model.expandAll();
    expect(model.toggleSubtree('$.data', true)).toEqual({ row: 2, changed: false, totalRows: 14 });
    expect(model.toggleSubtree('$.data.meta', true)).toEqual({ row: 10, changed: false, totalRows: 14 });
    expect(paths(model)).toEqual(FULL_PATHS);
  });

  it('空容器不参与展开；空容器自身是两个方向的 no-op', () => {
    const model = new RowModel(DOC);
    expect(model.toggleSubtree('$.empty', true)).toEqual({ row: 3, changed: false, totalRows: 4 });
    expect(model.toggleSubtree('$.empty', false)).toEqual({ row: 3, changed: false, totalRows: 4 });
    expect(model.isOpenAt('$.empty')).toBe(false);

    model.toggleSubtree('$.data', true);
    const emptyRow = model.window(0, 20).find((row) => row.path === '$.empty');
    expect(emptyRow).toMatchObject({ kind: 'object', count: 0, open: false, hasChildren: false });
    expect(model.isOpenAt('$.empty')).toBe(false);
  });

  it('子树内被手动 toggle 开的空容器：展开时按 rebuildAllOpen 口径复位', () => {
    const withEmpty = { c: { e: {}, n: 1 } };
    const model = new RowModel(withEmpty);
    expect(model.toggle('$.c.e', true)).toMatchObject({ changed: true, totalRows: 2 });
    expect(model.isOpenAt('$.c.e')).toBe(true);

    const result = model.toggleSubtree('$.c', true);
    expect(result).toEqual({ row: 1, changed: true, totalRows: 4 });
    expect(model.isOpenAt('$.c.e')).toBe(false);
    expect(paths(model)).toEqual(['$', '$.c', '$.c.e', '$.c.n']);
    expect(model.window(0, 4).map((row) => row.open)).toEqual([true, true, false, false]);
  });

  it('根 / 标量 / 坏路径：根 no-op，标量与不存在路径 BAD_COMMAND', () => {
    const model = new RowModel(DOC);
    expect(model.toggleSubtree(ROOT_PATH, true)).toEqual({ row: 0, changed: false, totalRows: 4 });
    expect(model.toggleSubtree(ROOT_PATH, false)).toEqual({ row: 0, changed: false, totalRows: 4 });
    expect(paths(model)).toEqual(['$', '$.id', '$.data', '$.empty']);

    expect(codeOf(() => model.toggleSubtree('$.id', true))).toBe('BAD_COMMAND');
    expect(codeOf(() => model.toggleSubtree('$.id', false))).toBe('BAD_COMMAND');
    expect(codeOf(() => model.toggleSubtree('$.data.nope', true))).toBe('BAD_COMMAND');
  });

  it('不可见节点（祖先折叠）展开：状态写入但 changed=false（可见结果没变）', () => {
    const model = new RowModel(DOC);
    const result = model.toggleSubtree('$.data.meta', true);
    expect(result).toEqual({ row: -1, changed: false, totalRows: 4 });
    expect(model.isOpenAt('$.data.meta')).toBe(true); // 惰性标记已写入

    model.toggle('$.data', true); // 打开祖先 → 惰性展开生效
    expect(model.totalRows).toBe(8); // 根+id+data+hotel_list+meta+count+note+empty
    expect(paths(model)).toEqual([
      '$',
      '$.id',
      '$.data',
      '$.data.hotel_list',
      '$.data.meta',
      '$.data.meta.count',
      '$.data.meta.note',
      '$.empty',
    ]);
  });
});

describe('RowModel — toggleSubtree 收起（深度复位）', () => {
  it('全开状态收起子树：本节点折叠、后代展开态全部释放', () => {
    const model = new RowModel(DOC);
    model.expandAll();
    const result = model.toggleSubtree('$.data', false);
    expect(result).toEqual({ row: 2, changed: true, totalRows: 4 });
    expect(paths(model)).toEqual(['$', '$.id', '$.data', '$.empty']);
    expect(model.isOpenAt('$.data')).toBe(false);
    expect(model.isOpenAt('$.data.meta')).toBe(false);
    expect(model.isOpenAt('$.data.hotel_list')).toBe(false);
    expect(model.rowOfPath('$.data.meta')).toBe(-1);
  });

  it('复位后下次展开只剩一层（不是恢复上次现场）', () => {
    const model = new RowModel(DOC);
    model.expandAll();
    model.toggleSubtree('$.data', false);
    expect(model.toggle('$.data', true)).toMatchObject({ changed: true, totalRows: 6 });
    expect(paths(model)).toEqual(['$', '$.id', '$.data', '$.data.hotel_list', '$.data.meta', '$.empty']);
    expect(model.openPaths()).toEqual(['$', '$.data']);
  });

  it('已收起时是 no-op（changed=false、totalRows 不变）', () => {
    const model = new RowModel(DOC);
    expect(model.toggleSubtree('$.data', false)).toEqual({ row: 2, changed: false, totalRows: 4 });
    expect(model.toggle('$.data', true)).toMatchObject({ changed: true, totalRows: 6 });
  });

  it('已折叠但后代留有惰性展开标记：仍复位，但 changed=false', () => {
    const model = new RowModel(DOC);
    model.toggle('$.data', true);
    model.toggle('$.data.meta', true);
    expect(model.totalRows).toBe(8);
    model.toggle('$.data', false); // 折叠 data：只释放自己的索引，meta 的展开态保留
    expect(model.totalRows).toBe(4);
    expect(model.isOpenAt('$.data.meta')).toBe(true);

    const reset = model.toggleSubtree('$.data', false);
    expect(reset).toEqual({ row: 2, changed: false, totalRows: 4 });
    expect(model.isOpenAt('$.data.meta')).toBe(false); // 惰性标记被复位
    expect(model.isOpenAt('$.data.hotel_list')).toBe(false);
    expect(model.openPaths().length).toBe(1); // 只剩根
  });

  it('子树外展开态不受影响（只动子树）', () => {
    const model = new RowModel(DOC);
    model.expandAll();
    const result = model.toggleSubtree('$.data.meta', false);
    expect(result).toEqual({ row: 10, changed: true, totalRows: 12 });
    expect(paths(model)).toEqual(FULL_PATHS.filter((path) => !path.startsWith('$.data.meta.')));
    expect(model.isOpenAt('$.data.hotel_list')).toBe(true);
    expect(model.isOpenAt('$.data.meta')).toBe(false);
    expect(model.rowOfPath('$.data.hotel_list[1].price')).toBe(9);
  });
});

describe('RowModel — toggleSubtree 预算（原子拒绝）', () => {
  it('超预算抛 TOO_MANY_ROWS，且零部分修改（不半展开）', () => {
    const model = new RowModel(DOC, { rowBudget: 13 });
    expect(codeOf(() => model.toggleSubtree('$.data', true))).toBe('TOO_MANY_ROWS');
    expect(model.totalRows).toBe(4);
    expect(paths(model)).toEqual(['$', '$.id', '$.data', '$.empty']);
    expect(model.openPaths().length).toBe(1);
    expect(model.isOpenAt('$.data')).toBe(false);

    // 拒绝后模型未被污染：小步展开照常
    expect(model.toggle('$.data', true)).toMatchObject({ changed: true, totalRows: 6 });
  });

  it('部分展开下超预算：既有展开态原样保留（不回滚成折叠）', () => {
    const model = new RowModel(DOC, { rowBudget: 13 });
    model.toggle('$.data', true);
    model.toggle('$.data.hotel_list', true);
    expect(model.totalRows).toBe(8); // 根+id+data+hotel_list+[0]+[1]+meta+empty

    expect(codeOf(() => model.toggleSubtree('$.data', true))).toBe('TOO_MANY_ROWS');
    expect(model.totalRows).toBe(8);
    expect(model.isOpenAt('$.data.hotel_list')).toBe(true);
    expect(model.isOpenAt('$.data.meta')).toBe(false);
    expect(model.rowOfPath('$.data.meta')).toBe(6); // meta 仍可见、仍折叠
    expect(paths(model)).toEqual([
      '$',
      '$.id',
      '$.data',
      '$.data.hotel_list',
      '$.data.hotel_list[0]',
      '$.data.hotel_list[1]',
      '$.data.meta',
      '$.empty',
    ]);
  });

  it('大子树 dry-run 早停（不遍历全树、不产生修改）', () => {
    const big = { a: { items: Array.from({ length: 5000 }, (_, i) => ({ id: i })) } };
    const model = new RowModel(big, { rowBudget: 100 });
    expect(codeOf(() => model.toggleSubtree('$.a', true))).toBe('TOO_MANY_ROWS');
    expect(model.totalRows).toBe(2);
    expect(model.openPaths().length).toBe(1);
  });
});

describe('RowModel — toggleSubtree 深嵌套（迭代实现）', () => {
  it('2000 层子树展开/收起不爆栈', () => {
    let nested: unknown = { leaf: 1 };
    for (let i = 0; i < 2000; i++) nested = { a: nested };
    const model = new RowModel({ root: nested });

    expect(model.toggleSubtree('$.root', true)).toMatchObject({ row: 1, changed: true, totalRows: 2003 });
    expect(model.totalRows).toBe(2003);
    expect(paths(model, 0, 3)).toEqual(['$', '$.root', '$.root.a']);

    expect(model.toggleSubtree('$.root', false)).toMatchObject({ row: 1, changed: true, totalRows: 2 });
    expect(model.totalRows).toBe(2);
  });
});

describe('RowModel — 展开态 path 口径（ADR-0002 修订 2026-11-09）', () => {
  it('根恒 open；标量与折叠容器 false；展开后 true', () => {
    const model = new RowModel(DOC);
    expect(model.isOpenAt(ROOT_PATH)).toBe(true);
    expect(model.isOpenAt('$.id')).toBe(false); // 标量
    expect(model.isOpenAt('$.data')).toBe(false); // 容器但折叠
    expect(model.toggle('$.data', true).changed).toBe(true);
    expect(model.isOpenAt('$.data')).toBe(true);
  });

  it('标量根文档：isOpenAt($) 仍是 true（根永远 open）', () => {
    expect(new RowModel('hello').isOpenAt(ROOT_PATH)).toBe(true);
  });

  it('非法路径按 valueAt 同口径抛 BAD_COMMAND（标量路径不抛）', () => {
    const model = new RowModel(DOC);
    expect(codeOf(() => model.isOpenAt('$.nope'))).toBe('BAD_COMMAND');
    expect(codeOf(() => model.isOpenAt('$.id.deep'))).toBe('BAD_COMMAND');
  });

  it('openPaths()：确定性前序，且包含折叠祖先下的惰性展开标记', () => {
    const model = new RowModel(DOC);
    model.toggleSubtree('$.data.meta', true); // data 折叠 → meta 是隐形展开标记
    expect(model.totalRows).toBe(4); // 可见行没变
    expect(model.isOpenAt('$.data.meta')).toBe(true);
    expect(model.openPaths()).toEqual(['$', '$.data.meta']);

    model.toggle('$.data', true); // 打开祖先：标记生效
    expect(model.openPaths()).toEqual(['$', '$.data', '$.data.meta']);

    model.expandAll();
    expect(model.openPaths()).toEqual([
      '$',
      '$.data',
      '$.data.hotel_list',
      '$.data.hotel_list[0]',
      '$.data.hotel_list[1]',
      '$.data.meta',
    ]);
  });

  it('openPaths()：collapseAll 后只剩根；空容器永不进集合', () => {
    const model = new RowModel(DOC);
    model.expandAll();
    model.collapseAll();
    expect(model.openPaths()).toEqual(['$']);
    expect(model.isOpenAt('$.empty')).toBe(false); // 空容器不是展开态
  });
});
