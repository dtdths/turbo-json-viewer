/**
 * core/measure — 子树 JSON 字符数下界预扫描的单测。
 *
 * 核心不变式（见 core/measure.ts 文件头的下界论证）：
 *   对任何 JSON 值 v，`jsonSizeLowerBoundChars(v, ∞) <= JSON.stringify(v,null,2).length`
 *   （UTF-16 码元数）`<= Buffer.byteLength(JSON.stringify(v,null,2))`（UTF-8 字节数）。
 * 早停语义：累加跨过 limit 立即返回，返回值 > limit，但不保证等于完整下界。
 */
import { describe, expect, it } from 'vitest';
import { jsonSizeLowerBoundChars } from '../../../src/core/measure';

/** pretty JSON 的 UTF-16 长度（字符数）。 */
function prettyChars(value: unknown): number {
  return JSON.stringify(value, null, 2).length;
}

/** pretty JSON 的 UTF-8 字节数（真实判据口径，同 core/import.ts 的 byteLengthOf）。 */
function prettyBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value, null, 2));
}

/** 断言下界不变式，返回下界供进一步断言。 */
function expectLowerBound(value: unknown): number {
  const lower = jsonSizeLowerBoundChars(value, Number.POSITIVE_INFINITY);
  const chars = prettyChars(value);
  const bytes = prettyBytes(value);
  expect(lower).toBeLessThanOrEqual(chars);
  expect(chars).toBeLessThanOrEqual(bytes); // UTF-8 下每码元 ≥1 字节
  expect(lower).toBeGreaterThanOrEqual(0);
  return lower;
}

/* --------------------------- 确定性伪随机 fixtures --------------------------- */

/** mulberry32：测试不引依赖，用确定性 PRNG 造多样值图。 */
function makeRandom(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** 随机 JSON 值：标量/数组/对象混合，含中文、emoji、转义字符、大数字。 */
function randomJson(rand: () => number, depth = 0): unknown {
  if (depth >= 4 || rand() < 0.35) {
    switch (Math.floor(rand() * 6)) {
      case 0:
        return null;
      case 1:
        return rand() < 0.5;
      case 2:
        return Math.floor((rand() - 0.5) * 1e6) / (rand() < 0.5 ? 1 : 1000);
      case 3:
        return '中😀"\\\n\t' + Math.floor(rand() * 100);
      case 4:
        return rand() < 0.5 ? 0 : 1e21;
      default:
        return '';
    }
  }
  if (rand() < 0.5) {
    return Array.from({ length: Math.floor(rand() * 4) }, () => randomJson(rand, depth + 1));
  }
  const obj: Record<string, unknown> = {};
  for (let i = 0, n = Math.floor(rand() * 4); i < n; i++) {
    obj[`k${i} "${i}"`] = randomJson(rand, depth + 1);
  }
  return obj;
}

const FIXTURES: Array<[name: string, value: unknown]> = [
  ['null', null],
  ['true', true],
  ['整数', 12345],
  ['小数', -0.5],
  ['空对象', {}],
  ['空数组', []],
  ['标量对象', { n: 1, s: 'x', b: false, nul: null }],
  ['嵌套容器', { a: [1, [2, { b: [3] }]], c: { d: {}, e: [] } }],
  ['空字符串', { s: '', t: '\\', u: '"' }],
  ['转义与 emoji', { 'a"b': 'line\n"q" \\ \t', emoji: '中文😀🎉', ctrl: '\u0000\u001f' }],
  ['数组中的多字节字符串', ['😀', '中文', '\u007f']],
  ['键含 unicode / 引号', { '键"1': 1, '😀': [null, true, 'z'] }],
  ['大数字 / 极值', [1e21, 1e-7, Number.MAX_SAFE_INTEGER, Number.MIN_VALUE, -0]],
  ['扁平大数组', Array.from({ length: 2000 }, (_, i) => i)],
  ['<script> 等无需转义的字符', { html: '<script>alert(1)</script>' }],
];

describe('jsonSizeLowerBoundChars — 下界不变式', () => {
  for (const [name, value] of FIXTURES) {
    it(`下界 ≤ 字符数 ≤ 字节数：${name}`, () => {
      expectLowerBound(value);
    });
  }

  it('确定性伪随机 fixtures（200 例）', () => {
    const rand = makeRandom(0x5eed);
    for (let i = 0; i < 200; i++) expectLowerBound(randomJson(rand));
  });
});

describe('jsonSizeLowerBoundChars — 边界值', () => {
  it('空容器 / 标量的最短形态', () => {
    expect(jsonSizeLowerBoundChars({}, Number.POSITIVE_INFINITY)).toBe(2); // "{}"
    expect(jsonSizeLowerBoundChars([], Number.POSITIVE_INFINITY)).toBe(2); // "[]"
    expect(jsonSizeLowerBoundChars(null, Number.POSITIVE_INFINITY)).toBe(4); // "null"
    expect(jsonSizeLowerBoundChars('x', Number.POSITIVE_INFINITY)).toBe(3); // "\"x\""
    expect(jsonSizeLowerBoundChars(0, Number.POSITIVE_INFINITY)).toBe(1);
    expect(jsonSizeLowerBoundChars(true, Number.POSITIVE_INFINITY)).toBe(1);
  });

  it('大数字：下界只算 1，实际序列化更长（1e21 → "1e+21"）', () => {
    const lower = expectLowerBound(1e21);
    expect(lower).toBe(1);
    expect(prettyChars(1e21)).toBeGreaterThan(1);
  });

  it('转义字符串：下界用原文长度，序列化只会更长', () => {
    const s = '"\\\n\u0000';
    const lower = jsonSizeLowerBoundChars(s, Number.POSITIVE_INFINITY);
    expect(lower).toBe(s.length + 2);
    expect(lower).toBeLessThan(prettyChars(s)); // 转义（\" \\ \n \u0000）让实际更长
  });

  it('emoji：UTF-16 码元 ≤ UTF-8 字节（代理对 2 码元 → 4 字节）', () => {
    const s = '😀🎉';
    const lower = expectLowerBound(s);
    expect(lower).toBe(s.length + 2);
    expect(prettyChars(s)).toBeLessThan(prettyBytes(s));
  });

  it('深层嵌套 2000 层不爆栈（显式栈迭代）', () => {
    let deep: unknown = null;
    for (let i = 0; i < 2000; i++) deep = [deep];
    const lower = expectLowerBound(deep); // 含 JSON.stringify 的对照，2000 层同样安全
    expect(lower).toBeGreaterThan(2 * 2000); // 每层至少有 "[\n" / "\n]" 的结构字符
  });
});

describe('jsonSizeLowerBoundChars — 早停', () => {
  it('容器结构成本一次性越界：一个成员都不读（Proxy 计数探针）', () => {
    let reads = 0;
    const probe = new Proxy(new Array<number>(100_000).fill(0), {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && /^\d+$/.test(prop)) reads += 1;
        return Reflect.get(target, prop, receiver);
      },
    });
    const lower = jsonSizeLowerBoundChars(probe, 100);
    expect(lower).toBeGreaterThan(100);
    expect(reads).toBe(0); // 10 万元素的结构成本已超 100 → 未展开成员
  });

  it('逐成员累加时跨过 limit 立即返回：不读完所有成员（getter 计数探针）', () => {
    const reads: string[] = [];
    const big: Record<string, unknown> = {};
    for (let i = 0; i < 10; i++) {
      Object.defineProperty(big, `k${i}`, {
        enumerable: true,
        get() {
          reads.push(`k${i}`);
          return 'x'.repeat(1024 * 1024);
        },
      });
    }
    const limit = 2 * 1024 * 1024;
    const lower = jsonSizeLowerBoundChars(big, limit);
    expect(lower).toBeGreaterThan(limit);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.length).toBeLessThan(10); // 每个成员 1MB：读到第 2 个就越界
  });

  it('limit = Infinity：不早停，返回完整下界', () => {
    const value = { a: [1, 2, 3], b: '中文' };
    const bounded = jsonSizeLowerBoundChars(value, Number.POSITIVE_INFINITY);
    const bigLimit = jsonSizeLowerBoundChars(value, Number.MAX_SAFE_INTEGER);
    expect(bounded).toBe(bigLimit);
    expect(bounded).toBeLessThanOrEqual(prettyChars(value));
  });
});
