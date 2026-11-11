import { describe, expect, it } from 'vitest';
import { outlinePage } from '../../../src/core/outline';
import { OUTLINE_PAGE_MAX } from '../../../src/protocol/versions';
import type { JsonKind } from '../../../src/protocol/types';

/** 期望的 OutlineChild（顺序：key / idx / kind / count / path，便于逐条比对）。 */
function child(key: string, idx: boolean, kind: JsonKind, count: number, path: string) {
  return { key, idx, kind, count, path };
}

describe('core/outline — 容器子项枚举', () => {
  it('对象：键原文 + 类型 + 容器项数 + appendKey 路径', () => {
    const page = outlinePage({ a: 1, b: { c: 2 }, arr: [1, 2] }, '$', 0, 10);
    expect(page).toEqual({
      path: '$',
      kind: 'object',
      total: 3,
      start: 0,
      children: [
        child('a', false, 'number', 0, '$.a'),
        child('b', false, 'object', 1, '$.b'),
        child('arr', false, 'array', 2, '$.arr'),
      ],
    });
  });

  it('数组：key 含方括号、idx=true、appendIndex 路径', () => {
    const page = outlinePage([{}, [1], 'x', null, true], '$', 0, 10);
    expect(page.kind).toBe('array');
    expect(page.total).toBe(5);
    expect(page.children).toEqual([
      child('[0]', true, 'object', 0, '$[0]'),
      child('[1]', true, 'array', 1, '$[1]'),
      child('[2]', true, 'string', 0, '$[2]'),
      child('[3]', true, 'null', 0, '$[3]'),
      child('[4]', true, 'boolean', 0, '$[4]'),
    ]);
  });

  it('键序 = 值图顺序（Object.keys，不排序）：整数样式键按 JSON.parse 真相', () => {
    const node = JSON.parse('{"b":1,"a":2,"10":3,"2":4}');
    expect(outlinePage(node, '$', 0, 10).children.map((c) => c.key)).toEqual(['2', '10', 'b', 'a']);
  });

  it('空对象 / 空数组：total 0、children 空', () => {
    expect(outlinePage({}, '$', 0, 10)).toEqual({
      path: '$',
      kind: 'object',
      total: 0,
      start: 0,
      children: [],
    });
    expect(outlinePage([], '$.items', 5, 10)).toEqual({
      path: '$.items',
      kind: 'array',
      total: 0,
      start: 0,
      children: [],
    });
  });

  it('空容器子项：count 0、kind 正确（不可展开由视图决定）', () => {
    expect(outlinePage({ e: {}, a: [] }, '$', 0, 10).children).toEqual([
      child('e', false, 'object', 0, '$.e'),
      child('a', false, 'array', 0, '$.a'),
    ]);
  });

  it('标量节点：合法路径 → total 0、start 0、children 空；kind 反映标量', () => {
    const cases: Array<[value: unknown, kind: JsonKind]> = [
      ['x', 'string'],
      [1, 'number'],
      [true, 'boolean'],
      [false, 'boolean'],
      [null, 'null'],
    ];
    for (const [value, kind] of cases) {
      expect(outlinePage(value, '$.s', 5, 10)).toEqual({
        path: '$.s',
        kind,
        total: 0,
        start: 0,
        children: [],
      });
    }
  });

  it('非标识符键：路径用 appendKey 转义（点 / 引号 / 空白 / 反斜杠 / 空键）', () => {
    const node = { 'a.b': 1, "it's": 2, 'a b': 3, 'a\\b': 4, ok_1: 5, '': 6 };
    expect(outlinePage(node, '$', 0, 10).children.map((c) => c.path)).toEqual([
      "$['a.b']",
      "$['it\\'s']",
      "$['a b']",
      "$['a\\\\b']",
      '$.ok_1',
      "$['']",
    ]);
  });

  it('嵌套容器：可查询任意深度，count 反映该容器子项数', () => {
    const node = { data: { items: [{ id: 1, tags: ['a'] }] } };
    const root = outlinePage(node, '$', 0, 10);
    expect(root.children[0]).toEqual(child('data', false, 'object', 1, '$.data'));

    const items = outlinePage(node.data.items, '$.data.items', 0, 10);
    expect(items).toMatchObject({ path: '$.data.items', kind: 'array', total: 1, start: 0 });
    expect(items.children).toEqual([child('[0]', true, 'object', 2, '$.data.items[0]')]);

    expect(outlinePage(node.data.items[0]?.tags, '$.data.items[0].tags', 0, 10).children).toEqual([
      child('[0]', true, 'string', 0, '$.data.items[0].tags[0]'),
    ]);
  });
});

describe('core/outline — 分页与夹取', () => {
  const ARR = Array.from({ length: 10 }, (_, i) => i);

  it('首页 / 中页 / 末页：start 回显实际起点，末页可少于 count', () => {
    const first = outlinePage(ARR, '$.a', 0, 3);
    expect(first).toMatchObject({ total: 10, start: 0 });
    expect(first.children.map((c) => c.key)).toEqual(['[0]', '[1]', '[2]']);

    const mid = outlinePage(ARR, '$.a', 4, 3);
    expect(mid.start).toBe(4);
    expect(mid.children.map((c) => c.key)).toEqual(['[4]', '[5]', '[6]']);
    expect(mid.children.map((c) => c.path)).toEqual(['$.a[4]', '$.a[5]', '$.a[6]']);

    const tail = outlinePage(ARR, '$.a', 8, 3);
    expect(tail.start).toBe(8);
    expect(tail.total).toBe(10);
    expect(tail.children.map((c) => c.key)).toEqual(['[8]', '[9]']);
  });

  it('start 夹到 [0, total]：负数 / 非有限值 → 0；越界 → total 且回空页', () => {
    expect(outlinePage(ARR, '$.a', -5, 3).start).toBe(0);
    expect(outlinePage(ARR, '$.a', -5, 3).children.map((c) => c.key)).toEqual(['[0]', '[1]', '[2]']);
    expect(outlinePage(ARR, '$.a', Number.NaN, 3).start).toBe(0);

    const beyond = outlinePage(ARR, '$.a', 20, 3);
    expect(beyond).toEqual({ path: '$.a', kind: 'array', total: 10, start: 10, children: [] });
  });

  it('count 夹到 [0, OUTLINE_PAGE_MAX] 且不超过剩余项', () => {
    const big = Array.from({ length: 700 }, (_, i) => i);

    const capped = outlinePage(big, '$', 0, OUTLINE_PAGE_MAX + 200);
    expect(capped.total).toBe(700);
    expect(capped.children).toHaveLength(OUTLINE_PAGE_MAX);
    expect(capped.children[0]?.key).toBe('[0]');
    expect(capped.children.at(-1)?.key).toBe(`[${OUTLINE_PAGE_MAX - 1}]`);

    // 剩余项 < max 时按剩余项截断（末页）
    const nearEnd = outlinePage(big, '$', 690, OUTLINE_PAGE_MAX);
    expect(nearEnd.children).toHaveLength(10);
    expect(nearEnd.children[0]?.key).toBe('[690]');

    // count 0 / 负数 / 非有限值 → 空页（start 仍回显夹取后的值）
    expect(outlinePage(big, '$', 3, 0)).toMatchObject({ start: 3, children: [] });
    expect(outlinePage(big, '$', 3, -1)).toMatchObject({ start: 3, children: [] });
    expect(outlinePage(big, '$', 3, Number.NaN)).toMatchObject({ start: 3, children: [] });
  });

  it('纯函数：不改值图、无缓存（重复调用结果一致但每次新数组）', () => {
    const node = { a: { b: 1 }, c: [1, 2] };
    const snapshot = JSON.stringify(node);
    const first = outlinePage(node, '$', 0, 10);
    const second = outlinePage(node, '$', 0, 10);
    expect(second).toEqual(first);
    expect(JSON.stringify(node)).toBe(snapshot);
    expect(first.children).not.toBe(second.children);
  });
});

describe('outline — 无损数字（BigInt，ADR-0020）', () => {
  it('BigInt 子项 kind=number、count=0（不展开）', () => {
    const page = outlinePage({ big: 297532588187238660n, small: 1 }, '$', 0, 10);
    expect(page.children.map((c) => [c.key, c.kind, c.count, c.path])).toEqual([
      ['big', 'number', 0, '$.big'],
      ['small', 'number', 0, '$.small'],
    ]);
  });

  it('BigInt 标量根：kind=number 且 total=0', () => {
    const page = outlinePage(297532588187238660n, '$', 0, 10);
    expect(page).toMatchObject({ kind: 'number', total: 0, start: 0, children: [] });
  });
});
