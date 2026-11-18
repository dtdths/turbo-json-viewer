/**
 * shared/word 单测（#53 / ADR-0014 修订）：词字符定义 + 哪一侧强制边界 + 命中判定。
 */
import { describe, expect, it } from 'vitest';
import {
  isWholeWordMatch,
  isWordBoundaryActive,
  isWordCode,
  wordEdges,
} from '../../../src/shared/word';

describe('isWordCode — 词字符 = ASCII [A-Za-z0-9_]', () => {
  it('ASCII 字母 / 数字 / 下划线是词字符', () => {
    for (const ch of ['a', 'Z', '0', '9', '_']) {
      expect(isWordCode(ch.charCodeAt(0)), ch).toBe(true);
    }
  });

  it('空白 / 标点 / 中文 / emoji 都不是词字符', () => {
    for (const ch of [' ', '-', '.', '$', '[', '中', '文', '🏨', 'é']) {
      expect(isWordCode(ch.charCodeAt(0)), ch).toBe(false);
    }
  });
});

describe('wordEdges — 只在查询首/尾是词字符时强制那一侧', () => {
  it('纯 ASCII 词：两侧都强制', () => {
    expect(wordEdges('hotel')).toEqual({ start: true, end: true });
  });

  it('首部标点：只强制右侧', () => {
    expect(wordEdges('$hotel')).toEqual({ start: false, end: true });
  });

  it('尾部标点：只强制左侧', () => {
    expect(wordEdges('hotel!')).toEqual({ start: true, end: false });
  });

  it('中文 / 非 ASCII：两侧都不强制（退化为包含匹配）', () => {
    expect(wordEdges('中文')).toEqual({ start: false, end: false });
    expect(wordEdges('hotel中文')).toEqual({ start: true, end: false });
    expect(wordEdges('中文hotel')).toEqual({ start: false, end: true });
  });

  it('空查询：不强制', () => {
    expect(wordEdges('')).toEqual({ start: false, end: false });
  });

  it('isWordBoundaryActive：两侧都不强制时开关无效', () => {
    expect(isWordBoundaryActive(wordEdges('hotel'))).toBe(true);
    expect(isWordBoundaryActive(wordEdges('中文'))).toBe(false);
    expect(isWordBoundaryActive(wordEdges('!'))).toBe(false);
  });
});

describe('isWholeWordMatch — 命中两侧的边界判定', () => {
  const edges = wordEdges('hotel');

  it('串首/串尾命中算整词', () => {
    expect(isWholeWordMatch('hotel', 0, 5, edges)).toBe(true);
    expect(isWholeWordMatch('a hotel', 2, 7, edges)).toBe(true);
    expect(isWholeWordMatch('hotel x', 0, 5, edges)).toBe(true);
  });

  it('前后贴着词字符 → 不是整词', () => {
    expect(isWholeWordMatch('xhotel', 1, 6, edges)).toBe(false);
    expect(isWholeWordMatch('hotelx', 0, 5, edges)).toBe(false);
    expect(isWholeWordMatch('myhotelx', 2, 7, edges)).toBe(false);
  });

  it('前后是标点 / 空白 / 中文 → 算整词（中文不是词字符）', () => {
    expect(isWholeWordMatch('(hotel)', 1, 6, edges)).toBe(true);
    expect(isWholeWordMatch('hotel的中文', 0, 5, edges)).toBe(true);
    expect(isWholeWordMatch('中文hotel', 2, 7, edges)).toBe(true);
  });

  it('只强制一侧时另一侧不检查', () => {
    const leftOnly = wordEdges('hotel!');
    expect(isWholeWordMatch('hotel!x', 0, 5, leftOnly)).toBe(true);
    expect(isWholeWordMatch('xhotel!', 1, 6, leftOnly)).toBe(false);
  });
});
