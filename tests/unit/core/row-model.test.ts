import { describe, expect, it } from 'vitest';
import { CoreError } from '../../../src/protocol/errors';
import { RowModel, previewOf, truncateText } from '../../../src/core/row-model';
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
