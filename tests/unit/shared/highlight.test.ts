import { describe, expect, it } from 'vitest';
import { hitRanges } from '../../../src/shared/highlight';

/** 命中起点列表（断言「下标基于原串」时最直观） */
function starts(text: string, term: string): number[] {
  return hitRanges(text, term).map((range) => range.start);
}

/** 按区间切原串得到的命中文本 */
function slices(text: string, term: string): string[] {
  return hitRanges(text, term).map((range) => text.slice(range.start, range.end));
}

describe('shared/highlight — hitRanges', () => {
  it('ASCII 多处命中按出现顺序返回，区间左闭右开', () => {
    expect(hitRanges('foo bar foo', 'foo')).toEqual([
      { start: 0, end: 3 },
      { start: 8, end: 11 },
    ]);
    expect(slices('foo bar foo', 'foo')).toEqual(['foo', 'foo']);
  });

  it('大小写不敏感（term 大小写两个方向都命中）', () => {
    expect(starts('AbC abc', 'abc')).toEqual([0, 4]);
    expect(hitRanges('abc', 'ABC')).toEqual([{ start: 0, end: 3 }]);
    expect(slices('AbC abc', 'ABC')).toEqual(['AbC', 'abc']);
  });

  it('İ 折叠成两个码元也不会让下标漂移：İstanbul xyz + xyz 从原串 9 开始', () => {
    const text = 'İstanbul xyz';
    // 前提：折叠串确实比原串长（İ → i + U+0307），此刻只用原串下标才是对的
    expect(text.toLowerCase().length).toBe(text.length + 1);
    expect(hitRanges(text, 'xyz')).toEqual([{ start: 9, end: 12 }]);
    expect(slices(text, 'xyz')).toEqual(['xyz']);
  });

  it('ß 与 ẞ 双向按大小写不敏感命中，区间仍基于原串', () => {
    expect(slices('ß', 'ẞ')).toEqual(['ß']);
    expect(slices('ẞ', 'ß')).toEqual(['ẞ']);
    expect(hitRanges('ß', 'ẞ')).toEqual([{ start: 0, end: 1 }]);
    expect(slices('Straße ß', 'ß')).toEqual(['ß', 'ß']);
  });

  it('term 里的正则元字符按字面量匹配（a.b / ( / $ / *）', () => {
    expect(hitRanges('a.b(c)$*', 'a.b')).toEqual([{ start: 0, end: 3 }]);
    expect(hitRanges('axb', 'a.b')).toEqual([]); // `.` 不是通配
    expect(hitRanges('a.b(c)$*', '(')).toEqual([{ start: 3, end: 4 }]);
    expect(hitRanges('a.b(c)$*', '$')).toEqual([{ start: 6, end: 7 }]);
    expect(hitRanges('a.b(c)$*', '*')).toEqual([{ start: 7, end: 8 }]);
    expect(hitRanges('a.b(c)$*', '$*')).toEqual([{ start: 6, end: 8 }]);
    expect(hitRanges('[x] (a+b)', '[x]')).toEqual([{ start: 0, end: 3 }]);
    expect(hitRanges('A+B', 'a+b')).toEqual([{ start: 0, end: 3 }]);
  });

  it('空 term / 空 text / 未命中都返回空数组', () => {
    expect(hitRanges('abc', '')).toEqual([]);
    expect(hitRanges('', 'abc')).toEqual([]);
    expect(hitRanges('', '')).toEqual([]);
    expect(hitRanges('abc', 'z')).toEqual([]);
    expect(hitRanges('abc', 'abcd')).toEqual([]);
    expect(hitRanges('İstanbul', 'xyz')).toEqual([]);
    expect(hitRanges('ABC', 'Ä')).toEqual([]);
  });

  it('CJK 按码元下标命中（一字符一码元）', () => {
    expect(hitRanges('中文测试中文', '中文')).toEqual([
      { start: 0, end: 2 },
      { start: 4, end: 6 },
    ]);
    expect(slices('中文测试中文', '中文')).toEqual(['中文', '中文']);
  });

  it('非 ASCII 的大小写折叠也基于原串下标', () => {
    expect(slices('Ärger ä', 'ä')).toEqual(['Ä', 'ä']);
    expect(hitRanges('Ärger ä', 'ä')).toEqual([
      { start: 0, end: 1 },
      { start: 6, end: 7 },
    ]);
    expect(slices('İİ', 'İ')).toEqual(['İ', 'İ']);
    expect(hitRanges('İİ', 'İ')).toEqual([
      { start: 0, end: 1 },
      { start: 1, end: 2 },
    ]);
  });

  it('命中不重叠：相邻/重叠片段只算一次，然后从命中之后继续', () => {
    expect(hitRanges('aaa', 'aa')).toEqual([{ start: 0, end: 2 }]);
    expect(hitRanges('aaaa', 'aa')).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
    expect(hitRanges('abab', 'ab')).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
  });

  it('所有区间都升序、互不重叠且不越界', () => {
    const cases: Array<[string, string]> = [
      ['foo bar foo', 'foo'],
      ['İstanbul xyz İstanbul', 'xyz'],
      ['aaaa', 'aa'],
      ['中文测试中文', '中文'],
      ['Straße ß', 'ß'],
    ];
    for (const [text, term] of cases) {
      const ranges = hitRanges(text, term);
      let previousEnd = 0;
      for (const range of ranges) {
        expect(range.start).toBeGreaterThanOrEqual(previousEnd);
        expect(range.end).toBeGreaterThan(range.start);
        expect(range.end).toBeLessThanOrEqual(text.length);
        previousEnd = range.end;
      }
    }
  });
});

describe('shared/highlight — 全字匹配（#53 / ADR-0014 修订）', () => {
  const whole = (text: string, term: string) => hitRanges(text, term, { wholeWord: true });

  it('只标整词命中：hotel 不标 myhotel / hotelx', () => {
    expect(whole('hotel myhotel hotelx a hotel', 'hotel')).toEqual([
      { start: 0, end: 5 },
      { start: 23, end: 28 },
    ]);
  });

  it('被拒绝的候选只前进一个码元，后面的真命中不丢', () => {
    expect(whole('myhotel hotel', 'hotel')).toEqual([{ start: 8, end: 13 }]);
    // 叠字：aaa 里没有整词 aa；只前进一个码元不会把后续误判成命中
    expect(whole('aaa', 'aa')).toEqual([]);
    expect(whole('aaaa', 'aa')).toEqual([]);
  });

  it('中文不是词字符：中文查询退化为包含匹配', () => {
    expect(whole('中文测试中文', '中文')).toEqual([
      { start: 0, end: 2 },
      { start: 4, end: 6 },
    ]);
  });

  it('中英混排：两侧非 ASCII 不强制，贴中文算整词', () => {
    expect(whole('中文hotel中文', 'hotel')).toEqual([{ start: 2, end: 7 }]);
    expect(whole('xhotel中文', 'hotel')).toEqual([]);
  });

  it('首/尾标点：只强制对应一侧', () => {
    // 首 `$` 非词字符 → 左侧不查；尾 `l` 是词字符 → 右侧要查（hotelx 不命中）
    expect(whole('($hotel) $hotelx', '$hotel')).toEqual([{ start: 1, end: 7 }]);
    // 尾 `!` 非词字符 → 右侧不查；首 `h` 是词字符 → 左侧要查（xhotel! 不命中）
    expect(whole('hotel!x hotel! xhotel!', 'hotel!')).toEqual([
      { start: 0, end: 6 },
      { start: 8, end: 14 },
    ]);
  });

  it('大小写不敏感与整词叠加', () => {
    expect(whole('HOTEL Hotel hotelX', 'hotel')).toEqual([
      { start: 0, end: 5 },
      { start: 6, end: 11 },
    ]);
  });

  it('wholeWord 关闭 / 两侧都不强制时与普通命中一致', () => {
    expect(hitRanges('myhotel', 'hotel')).toEqual([{ start: 2, end: 7 }]);
    expect(whole('myhotel', '中文')).toEqual([]);
    expect(whole('xhotel', 'hotel!')).toEqual([]);
  });

  it('非 ASCII 路径（İ）上的整词命中仍基于原串下标', () => {
    expect(whole('İstanbul hotel xhotel', 'hotel')).toEqual([{ start: 9, end: 14 }]);
  });
});
