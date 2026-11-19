import { describe, expect, it } from 'vitest';
import { CoreError } from '../../../src/protocol/errors';
import type { Path } from '../../../src/protocol/types';
import { parsePath } from '../../../src/shared/path';
import {
  childCountOf,
  countAllExpandedRows,
  isContainer,
  jsonKind,
  previewOf,
  scalarPreview,
  shortPreview,
  summarizeContainer,
  valueAt,
  walkPath,
} from '../../../src/core/json-graph';
import { RowModel } from '../../../src/core/row-model';

/**
 * 旧口径参考实现（**只存在于测试**）：对象走 `Object.keys(container).indexOf(key)`，
 * 也就是重构前 `RowModel.locateChain` 的路径解析。用来把「新实现 = 0 差异」钉住。
 */
function referenceValueAt(root: unknown, path: Path): unknown {
  const segments = parsePath(path);
  let container: unknown = root;
  for (const segment of segments) {
    if (typeof container !== 'object' || container === null) throw notFound(path);
    if (Array.isArray(container)) {
      let slot: number;
      if (segment.kind === 'index') {
        slot = segment.index;
      } else {
        slot = Number(segment.key);
        if (!Number.isInteger(slot) || segment.key.trim() === '') throw notFound(path);
      }
      if (!Number.isInteger(slot) || slot < 0 || slot >= container.length) throw notFound(path);
      container = container[slot];
    } else {
      const key = segment.kind === 'key' ? segment.key : String(segment.index);
      const slot = Object.keys(container).indexOf(key);
      if (slot < 0) throw notFound(path);
      container = (container as Record<string, unknown>)[Object.keys(container)[slot] as string];
    }
  }
  return container;
}

function notFound(path: Path): CoreError {
  return new CoreError({ code: 'BAD_COMMAND', message: `path not found: ${path}` });
}

/** 两次解析的「结果」：命中值或错误码。 */
function outcome(run: () => unknown): { ok: true; value: unknown } | { ok: false; code: string } {
  try {
    return { ok: true, value: run() };
  } catch (error) {
    if (error instanceof CoreError) return { ok: false, code: error.code };
    return { ok: false, code: `THROW:${(error as Error).message}` };
  }
}

/**
 * 边界 fixture：对象用 `JSON.parse` 造（`__proto__` / `constructor` 才会成为**自有**属性），
 * 数组塞满可越界/可强制的下标，另加无损 BigInt（JSON.parse 造不出来）。
 */
function fixture(): unknown {
  const parsed = JSON.parse(
    '{"a":{"b":{"c":{"d":{"e":42}}}},"arr":[10,20,30,40],"list":[[1,2],[3,4]],' +
      '"0":"numeric-zero","a.b":"dotted-key","裸":"unicode","__proto__":{"x":1},"constructor":"own-ctor",' +
      '"empty":{},"emptyArr":[],"scalar":"text","neg":-0.5}',
  ) as Record<string, unknown>;
  parsed.big = 12345678901234567890n;
  return parsed;
}

/** 路径语料：数组 12 种写法 + 对象中毒键/转义键/数字键 + 深嵌套 + 标量中途。 */
const PATHS: Path[] = [
  // 根 / 对象直取
  '$',
  '$.a',
  '$.a.b.c.d.e',
  '$.a.b.c.d.e.f', // 标量中途
  '$.missing',
  '$.empty',
  '$.emptyArr',
  '$.scalar',
  '$.neg',
  '$.big',
  // 中毒键（JSON.parse 造出的自有属性）
  '$.__proto__',
  '$.__proto__.x',
  "$['__proto__']",
  '$.constructor',
  '$.constructor.prototype', // 自有值是字符串 → 标量中途
  '$.toString', // 继承属性 → 不存在
  // 数字键 / 点号键 / 转义键 / Unicode
  '$.0',
  "$['0']",
  "$['a.b']",
  '$.a.b',
  '$.裸',
  "$['裸']",
  // 数组：合法
  '$.arr[0]',
  '$.arr[3]',
  '$.arr[01]',
  '$.arr[ 1 ]',
  '$.arr[0x1]',
  '$.arr[1e2]',
  '$.arr[-0]',
  '$.arr[]',
  '$.arr[1', // 未闭合仍能解析出 1
  "$.arr['1']",
  "$.arr[' 1 ']",
  // 数组：应拒绝
  '$.arr[4]',
  '$.arr[-1]',
  '$.arr[1.5]',
  '$.arr[abc]',
  "$.arr['']",
  "$.arr['length']",
  '$.arr.length',
  // 嵌套数组
  '$.list[1][0]',
  '$.list[2][0]',
  "$.list['0'][1]",
  // 畸形路径串（parsePath 抛普通 Error，不只是 BAD_COMMAND）
  'a.b',
  "$['unclosed",
];

/** 畸形路径串：`parsePath` 直接抛普通 Error（不是 CoreError）。 */
const MALFORMED: Path[] = ['a.b', "$['unclosed"];

describe('valueAt：与旧口径（Object.keys().indexOf）逐条等价', () => {
  it.each(PATHS)('%s', (path) => {
    const doc = fixture();
    expect(outcome(() => valueAt(doc, path))).toEqual(outcome(() => referenceValueAt(doc, path)));
  });

  it('每一例要么命中、要么是 BAD_COMMAND（畸形路径串除外，见下一条）', () => {
    const doc = fixture();
    for (const path of PATHS.filter((p) => !MALFORMED.includes(p))) {
      const result = outcome(() => valueAt(doc, path));
      if (!result.ok) expect(result.code).toBe('BAD_COMMAND');
    }
  });

  it('畸形路径串仍抛普通 Error（与历史口径一致，由 Worker 边界折算）', () => {
    const doc = fixture();
    for (const path of MALFORMED) {
      expect(outcome(() => valueAt(doc, path))).toMatchObject({ ok: false, code: expect.stringMatching(/^THROW:/) });
    }
  });

  it('根路径返回根值本身（同一引用）', () => {
    const doc = fixture();
    expect(valueAt(doc, '$')).toBe(doc);
  });

  it('非枚举自有属性与旧口径一致（旧口径看 Object.keys，新实现看可枚举性）', () => {
    const doc = fixture() as Record<string, unknown>;
    Object.defineProperty(doc, 'hidden', { value: 1, enumerable: false });
    expect(outcome(() => valueAt(doc, '$.hidden'))).toEqual(outcome(() => referenceValueAt(doc, '$.hidden')));
    expect(outcome(() => valueAt(doc, '$.hidden'))).toMatchObject({ ok: false, code: 'BAD_COMMAND' });
  });

  it('RowModel 的显示序解析也与旧口径一致（三种档）', () => {
    for (const order of ['raw', 'key-asc', 'key-desc'] as const) {
      const model = new RowModel(fixture(), { order });
      for (const path of PATHS) {
        expect(outcome(() => model.valueAt(path)), `${order} ${path}`).toEqual(
          outcome(() => referenceValueAt(model.value, path)),
        );
      }
    }
  });

  it('切档 / 单节点覆盖之后 valueAt 结果不变（显示序只动 slot）', () => {
    const model = new RowModel(fixture());
    const paths = ['$.a.b.c.d.e', '$.arr[2]', '$.__proto__.x', "$['a.b']"];
    const before = paths.map((path) => outcome(() => model.valueAt(path)));
    model.setOrder('key-desc');
    expect(paths.map((path) => outcome(() => model.valueAt(path)))).toEqual(before);
    model.setOrder('raw');
    model.setNodeOrder('$.a', 'key-asc');
    expect(paths.map((path) => outcome(() => model.valueAt(path)))).toEqual(before);
  });
});

describe('walkPath：一步一节点，key 与该步节点对齐', () => {
  it('对象路径给出原始键（顺序无关，不按显示序排）', () => {
    const doc = fixture();
    expect(walkPath(doc, '$.a.b').map((step) => step.key)).toEqual(['a', 'b']);
    expect(walkPath(doc, '$.a.b')[1]?.node).toEqual({ c: { d: { e: 42 } } });
    expect(walkPath(doc, '$.a.b.c.d.e')[4]?.node).toBe(42);
  });

  it('数组路径把下标归一成十进制串', () => {
    const doc = fixture();
    expect(walkPath(doc, '$.arr[01]').map((step) => step.key)).toEqual(['arr', '1']);
    expect(walkPath(doc, '$.arr[]').map((step) => step.key)).toEqual(['arr', '0']);
  });

  it('每一步的 parent 就是上一步的 node', () => {
    const doc = fixture();
    const steps = walkPath(doc, '$.list[1][0]');
    expect(steps).toHaveLength(3);
    expect(steps[0]?.parent).toBe(doc);
    expect(steps[1]?.parent).toBe(steps[0]?.node);
    expect(steps[2]?.parent).toBe(steps[1]?.node);
  });
});

describe('IR 原语与预览（与行模型时代逐字一致）', () => {
  it('jsonKind 覆盖 null / 各标量 / 容器 / BigInt', () => {
    expect(jsonKind(null)).toBe('null');
    expect(jsonKind('s')).toBe('string');
    expect(jsonKind(1)).toBe('number');
    expect(jsonKind(1n)).toBe('number');
    expect(jsonKind(true)).toBe('boolean');
    expect(jsonKind({})).toBe('object');
    expect(jsonKind([])).toBe('array');
  });

  it('isContainer / childCountOf', () => {
    expect(isContainer(null)).toBe(false);
    expect(isContainer(1)).toBe(false);
    expect(isContainer({})).toBe(true);
    expect(isContainer([])).toBe(true);
    expect(childCountOf({ a: 1, b: 2 })).toBe(2);
    expect(childCountOf([1, 2, 3])).toBe(3);
  });

  it('scalarPreview：字符串带引号、BigInt 十进制、null/布尔原文', () => {
    expect(scalarPreview('a"b')).toBe('"a\\"b"');
    expect(scalarPreview(12)).toBe('12');
    expect(scalarPreview(12345678901234567890n)).toBe('12345678901234567890');
    expect(scalarPreview(null)).toBe('null');
    expect(scalarPreview(false)).toBe('false');
  });

  it('previewOf：标量 / 空容器 / 展开 / 折叠摘要', () => {
    expect(previewOf(1, false)).toBe('1');
    expect(previewOf({}, false)).toBe('{}');
    expect(previewOf([], false)).toBe('[]');
    expect(previewOf({ a: 1 }, true)).toBe('{…}');
    expect(previewOf({ a: 1, b: 2, c: 3, d: 4 }, false)).toBe('"a": 1, "b": 2, "c": 3, …');
    expect(previewOf([1, 2, 3, 4], false)).toBe('1, 2, 3, …');
  });

  it('summarizeContainer 截断到 SUMMARY_CHARS', () => {
    const long = Object.fromEntries(Array.from({ length: 3 }, (_, i) => [`k${i}`, 'x'.repeat(60)]));
    expect(summarizeContainer(long).endsWith('…')).toBe(true);
  });

  it('shortPreview 截断长标量、容器只给省略号', () => {
    expect(shortPreview({ a: 1 })).toBe('{…}');
    expect(shortPreview([1])).toBe('[…]');
    expect(shortPreview('x'.repeat(200)).length).toBeLessThanOrEqual(80);
  });
});

describe('countAllExpandedRows：全展开 = 节点数，超限早停', () => {
  it('容器逐个计数', () => {
    expect(countAllExpandedRows({ a: 1, b: [2, 3] }, 100)).toBe(5);
    expect(countAllExpandedRows(7, 100)).toBe(1);
  });

  it('超过 limit 立即返回 limit + 1', () => {
    const wide = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, i]));
    expect(countAllExpandedRows(wide, 10)).toBe(11);
    expect(countAllExpandedRows(wide, 1000)).toBe(101);
  });
});
