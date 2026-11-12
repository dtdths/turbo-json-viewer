/**
 * core/outline — 大纲页按显示序切页（#40 / ADR-0024 §4）。
 *
 * 契约：`outlinePage(node, path, start, count, order)` 的键序跟随显示顺序，**分页按显示序切**，
 * `total` 不变；数组恒索引序；不缓存、不改值图（ADR-0013 §3 原口径不变）。
 */
import { describe, expect, it } from 'vitest';
import { outlinePage } from '../../../src/core/outline';
import type { JsonKind, SortOrder } from '../../../src/protocol/types';

const OBJECT = { b: 1, a10: 2, a2: 3, Empty: 4 };
const RAW_KEYS = ['b', 'a10', 'a2', 'Empty'];
const ASC_KEYS = ['a2', 'a10', 'b', 'Empty'];
const DESC_KEYS = ['Empty', 'b', 'a10', 'a2'];

function child(key: string, idx: boolean, kind: JsonKind, count: number, path: string) {
  return { key, idx, kind, count, path };
}

function keysOf(node: unknown, order?: SortOrder): string[] {
  return outlinePage(node, '$', 0, 100, order).children.map((item) => item.key);
}

describe('core/outline — 显示排序', () => {
  it('缺省 raw = 值图键序（行为不变）', () => {
    expect(keysOf(OBJECT)).toEqual(RAW_KEYS);
    expect(outlinePage(OBJECT, '$', 0, 100, 'raw').children).toEqual([
      child('b', false, 'number', 0, '$.b'),
      child('a10', false, 'number', 0, '$.a10'),
      child('a2', false, 'number', 0, '$.a2'),
      child('Empty', false, 'number', 0, '$.Empty'),
    ]);
  });

  it('key-asc：自然序（数字段按数值、忽略大小写）', () => {
    expect(keysOf(OBJECT, 'key-asc')).toEqual(ASC_KEYS);
    expect(outlinePage(OBJECT, '$', 0, 100, 'key-asc').children.map((item) => item.path)).toEqual([
      '$.a2',
      '$.a10',
      '$.b',
      '$.Empty',
    ]);
  });

  it('key-desc：升序反序；total 与 start 语义不变', () => {
    const page = outlinePage(OBJECT, '$', 0, 100, 'key-desc');
    expect(page).toMatchObject({ path: '$', kind: 'object', total: 4, start: 0 });
    expect(page.children.map((item) => item.key)).toEqual(DESC_KEYS);
    // total 与顺序无关
    expect(outlinePage(OBJECT, '$', 0, 100, 'key-asc').total).toBe(4);
  });

  it('分页按显示序切页（start/count 语义与 raw 一致）', () => {
    const middle = outlinePage(OBJECT, '$', 1, 2, 'key-asc');
    expect(middle).toMatchObject({ total: 4, start: 1 });
    expect(middle.children.map((item) => item.key)).toEqual(['a10', 'b']);

    const tail = outlinePage(OBJECT, '$', 3, 10, 'key-asc');
    expect(tail.children.map((item) => item.key)).toEqual(['Empty']);

    const beyond = outlinePage(OBJECT, '$', 99, 10, 'key-asc');
    expect(beyond).toMatchObject({ total: 4, start: 4, children: [] });
  });

  it('数组恒索引序（order 不影响数组子项）', () => {
    expect(keysOf([10, 2, 1], 'key-asc')).toEqual(['[0]', '[1]', '[2]']);
    expect(keysOf([10, 2, 1], 'key-desc')).toEqual(['[0]', '[1]', '[2]']);
    expect(outlinePage([10, 2, 1], '$', 1, 1, 'key-desc').children).toEqual([
      child('[1]', true, 'number', 0, '$[1]'),
    ]);
  });

  it('只影响被查询容器：嵌套对象各自按显示序', () => {
    const node = { outer: { z: 1, a: { y: 2, b: 3 } }, x: 4 };
    const root = outlinePage(node, '$', 0, 100, 'key-desc');
    expect(root.children.map((item) => item.key)).toEqual(['x', 'outer']);
    expect(outlinePage(node.outer, '$.outer', 0, 100, 'key-desc').children.map((item) => item.key)).toEqual([
      'z',
      'a',
    ]);
    expect(
      outlinePage(node.outer.a, '$.outer.a', 0, 100, 'key-asc').children.map((item) => item.key),
    ).toEqual(['b', 'y']);
  });

  it('中文 / 非 ASCII 按码元序（升序 + 反序）', () => {
    const node = { 文: 1, a: 2, 中: 3 };
    expect(keysOf(node, 'key-asc')).toEqual(['a', '中', '文']);
    expect(keysOf(node, 'key-desc')).toEqual(['文', '中', 'a']);
  });

  it('整数样式键：raw 保持 JSON.parse 真相，排序只改显示序', () => {
    const node: Record<string, unknown> = JSON.parse('{"b":1,"a":2,"10":3,"2":4}');
    expect(keysOf(node)).toEqual(['2', '10', 'b', 'a']);
    expect(keysOf(node, 'key-asc')).toEqual(['2', '10', 'a', 'b']);
    expect(keysOf(node, 'key-desc')).toEqual(['b', 'a', '10', '2']);
    expect(Object.keys(node)).toEqual(['2', '10', 'b', 'a']); // 值图键序未被改
  });

  it('非法档位归一化为 raw（不抛错）', () => {
    expect(keysOf(OBJECT, 'nope' as unknown as SortOrder)).toEqual(RAW_KEYS);
  });

  it('纯函数：不改值图、每次新数组（不缓存）', () => {
    const node = { b: { z: 1 }, a: 2 };
    const snapshot = JSON.stringify(node);
    const first = outlinePage(node, '$', 0, 10, 'key-asc');
    const second = outlinePage(node, '$', 0, 10, 'key-asc');
    expect(second).toEqual(first);
    expect(first.children).not.toBe(second.children);
    expect(JSON.stringify(node)).toBe(snapshot);
  });

  it('标量 / 空容器：order 不影响既有语义', () => {
    expect(outlinePage(1, '$.s', 0, 10, 'key-desc')).toEqual({
      path: '$.s',
      kind: 'number',
      total: 0,
      start: 0,
      children: [],
    });
    expect(outlinePage({}, '$', 0, 10, 'key-asc')).toEqual({
      path: '$',
      kind: 'object',
      total: 0,
      start: 0,
      children: [],
    });
  });
});
