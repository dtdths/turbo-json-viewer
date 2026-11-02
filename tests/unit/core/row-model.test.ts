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
