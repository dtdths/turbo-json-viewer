import { describe, expect, it } from 'vitest';
import { analyzeNumberLiteral } from '../../../src/core/number-literal';
import {
  deepEqualJson,
  LosslessParseError,
  parseLossless,
  serializeLossless,
} from '../../../src/core/lossless-json';

/** 小端确定性伪随机（无外部依赖；只用于差分 fuzz 的样本生成）。 */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function randInt(rng: () => number, max: number): number {
  return Math.floor(rng() * max);
}

function randString(rng: () => number): string {
  const pool = ['a', 'b', '中', 'é', '\n', '\t', '"', '\\', '/', '😀', ' '];
  let out = '';
  const n = randInt(rng, 6);
  for (let i = 0; i < n; i += 1) out += pool[randInt(rng, pool.length)];
  return out;
}

/** 生成普通 JSON 值（数字都在安全范围内 / 小数），用于与 JSON.parse 差分对拍。 */
function randJson(rng: () => number, depth: number): unknown {
  if (depth <= 0) {
    const pick = randInt(rng, 5);
    if (pick === 0) return null;
    if (pick === 1) return rng() < 0.5;
    if (pick === 2) return randString(rng);
    if (pick === 3) return randInt(rng, 2_000_000) - 1_000_000;
    return Number((rng() * 2000 - 1000).toFixed(6));
  }
  const pick = randInt(rng, 4);
  if (pick === 0) {
    const n = randInt(rng, 4);
    const arr: unknown[] = [];
    for (let i = 0; i < n; i += 1) arr.push(randJson(rng, depth - 1));
    return arr;
  }
  if (pick === 1) {
    const n = randInt(rng, 4);
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < n; i += 1) obj[`k${i}_${randInt(rng, 100)}`] = randJson(rng, depth - 1);
    return obj;
  }
  return randJson(rng, 0);
}

/** 深比较（number/bigint 严格区分；键序敏感）。 */
function expectSame(actual: unknown, expected: unknown): void {
  if (typeof expected === 'number' || typeof expected === 'bigint') {
    expect(actual).toBe(expected);
    return;
  }
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual)).toBe(true);
    const a = actual as unknown[];
    expect(a.length).toBe(expected.length);
    for (let i = 0; i < expected.length; i += 1) expectSame(a[i], expected[i]);
    return;
  }
  if (expected !== null && typeof expected === 'object') {
    expect(actual !== null && typeof actual === 'object' && !Array.isArray(actual)).toBe(true);
    const a = actual as Record<string, unknown>;
    const e = expected as Record<string, unknown>;
    expect(Object.keys(a)).toEqual(Object.keys(e));
    for (const key of Object.keys(e)) expectSame(a[key], e[key]);
    return;
  }
  expect(actual).toBe(expected);
}

describe('lossless-json — parseLossless 与 JSON.parse 对拍（ADR-0020 §4.3 硬不变式）', () => {
  it('差分 fuzz：1000 个普通 JSON 文档逐节点等价（结构/键序/字符串）', () => {
    const rng = makeRng(20261111);
    for (let n = 0; n < 1000; n += 1) {
      const value = randJson(rng, 4);
      const text = JSON.stringify(value);
      const parsed = parseLossless(text);
      const baseline = JSON.parse(text) as unknown;
      expectSame(parsed, baseline);
    }
  });

  it('固定语料：标量/容器/转义/空白', () => {
    const corpus = [
      'null',
      'true',
      'false',
      '0',
      '-0',
      '1.5',
      '-1e-7',
      '""',
      '"a\\u0041\\n\\"b\\\\"',
      '"\\ud800"', // 孤立代理项：JSON.parse 接受，parser 也必须接受
      '"x\\udc00y"',
      '[]',
      '{}',
      '[1,2,[3,{"a":null}]]',
      '{"a":1,"b":[true,false]}',
      '  {"x": [ 1 , 2 ] }  ',
      '{"dup":1,"dup":2}',
    ];
    for (const text of corpus) {
      expectSame(parseLossless(text), JSON.parse(text) as unknown);
    }
  });

  it('语法拒绝面与 JSON.parse 逐例一致', () => {
    const invalid = [
      '',
      ' ',
      '{',
      '}',
      '[',
      ']',
      '[1,]',
      '{"a":1,}',
      '{"a"}',
      '{"a":}',
      '{a:1}',
      "'a'",
      'tru',
      'fals',
      'nul',
      'Infinity',
      'NaN',
      '01',
      '-01',
      '+1',
      '.5',
      '1.',
      '1e',
      '1e+',
      '/*c*/1',
      '1 // c',
      '\uFEFF{}',
      '{"a":1} trailing',
      '"unterminated',
      '"bad \\x"',
      '"\u0001"',
    ];
    for (const text of invalid) {
      expect(() => JSON.parse(text), `JSON.parse 应拒绝: ${JSON.stringify(text)}`).toThrow();
      expect(() => parseLossless(text), `parseLossless 应拒绝: ${JSON.stringify(text)}`).toThrow();
    }
  });

  it('大整数无损：树/值的精确性（用户报告的原始 bug）', () => {
    expect(parseLossless('297532588187238660')).toBe(297532588187238660n);
    expect(parseLossless('1234567890123456789')).toBe(1234567890123456789n);
    expect(parseLossless('-297532588187238660')).toBe(-297532588187238660n);
    // double 路径会得到 ...656；无损路径必须精确
    expect(JSON.parse('297532588187238660')).toBe(297532588187238660);
    expect((parseLossless('297532588187238660') as bigint).toString()).toBe('297532588187238660');
  });

  it('1e400 → BigInt 10^400；导出 401 位整数后本 parser 可无损再导入（ADR §10.2）', () => {
    const big = 10n ** 400n;
    expect(parseLossless('1e400')).toBe(big);
    const text = serializeLossless({ n: big }, 2) as string;
    expect(text).toContain(big.toString()); // 裸数字字面量（无引号、无 n）
    expect(text.length).toBeGreaterThan(400);
    expect(parseLossless(text)).toEqual({ n: big }); // 导出 → 再导入精确一致
  });

  it('1e10001 → Infinity（展开位数超 cap）', () => {
    expect(parseLossless('1e10001')).toBe(Infinity);
  });

  it('高精度小数保持 Number（已知差距，与 JSON.parse 相同）', () => {
    const text = '0.1234567890123456789';
    expect(parseLossless(text)).toBe(JSON.parse(text) as number);
    expect(typeof parseLossless(text)).toBe('number');
  });

  it('深嵌套：1,000,000 层不爆栈（ADR-0020 §4.3#3；显式栈）', () => {
    const depth = 1_000_000;
    const text = '['.repeat(depth) + ']'.repeat(depth);
    const root = parseLossless(text);
    let node: unknown = root;
    let count = 0;
    while (Array.isArray(node) && node.length === 1) {
      node = node[0];
      count += 1;
    }
    expect(count).toBe(depth - 1);
  });

  it('边界：重复键最后赢、__proto__ 是 own property 且不污染原型、-0', () => {
    expect(parseLossless('{"a":1,"a":2}')).toEqual({ a: 2 });

    const obj = parseLossless('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
    expect(Object.getPrototypeOf(obj)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(obj, '__proto__')).toBe(true);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();

    // 重复 __proto__ 也要按「最后赢」且仍不污染原型
    const dup = parseLossless('{"__proto__":1,"__proto__":2}') as Record<string, unknown>;
    expect(Object.getPrototypeOf(dup)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(dup, '__proto__')).toBe(true);
    expect((dup as { __proto__?: unknown }).__proto__).toBe(2);

    const zero = parseLossless('-0');
    expect(Object.is(zero, -0)).toBe(true);
  });

  it('错误带 position/line/column（供 PARSE 行列）', () => {
    const text = '{\n  "a": 1,\n  "b": }\n';
    try {
      parseLossless(text);
      throw new Error('应当抛出');
    } catch (err) {
      expect(err).toBeInstanceOf(LosslessParseError);
      const e = err as LosslessParseError;
      expect(e.line).toBe(3);
      expect(e.column).toBeGreaterThanOrEqual(7);
      expect(e.message).toContain('position');
      expect(e.message).toContain('(line 3 column');
    }
  });
});

describe('lossless-json — serializeLossless（ADR-0020 §4.4）', () => {
  it('无 BigInt 时与 JSON.stringify 逐字节相同（含缩进 0/2/4/undefined 与转义）', () => {
    const values: unknown[] = [
      null,
      true,
      false,
      0,
      -0,
      1.5,
      1e21,
      '',
      'a"b\\c\n\t/😀',
      [],
      {},
      [1, 'x', null, [2, { a: 3 }]],
      { a: 1, b: [true, false], c: { d: null } },
      { '中': '文', 'esc"': '\\' },
    ];
    for (const value of values) {
      for (const indent of [undefined, 0, 2, 4, 10, -1] as const) {
        expect(serializeLossless(value, indent)).toBe(JSON.stringify(value, null, indent));
      }
    }
  });

  it('BigInt → 裸十进制数字（合法 JSON 数字，无引号无 n）', () => {
    expect(serializeLossless({ a: 297532588187238660n })).toBe('{"a":297532588187238660}');
    expect(serializeLossless([1n, -2n], 2)).toBe('[\n  1,\n  -2\n]');
    expect(serializeLossless(10n ** 400n)).toBe((10n ** 400n).toString());
  });

  it('输出是合法 JSON 数字：标准 JSON.parse 能读（会圆整），本 parser 能无损再读', () => {
    const text = serializeLossless({ id: 297532588187238660n }) as string;
    expect(JSON.parse(text)).toEqual({ id: 297532588187238660 }); // double 圆整后的最短往返串
    expect(parseLossless(text)).toEqual({ id: 297532588187238660n });
  });

  it('顶层 undefined/function → undefined；数组内 → null；对象内跳过', () => {
    expect(serializeLossless(undefined)).toBeUndefined();
    expect(serializeLossless(() => 1)).toBeUndefined();
    expect(serializeLossless([undefined, () => 1, 2])).toBe('[null,null,2]');
    expect(serializeLossless({ a: undefined, b: 1, c: () => 1 })).toBe('{"b":1}');
  });
});

describe('lossless-json — serializeLossless 非 ASCII 转义档（ADR-0022 §2）', () => {
  it('默认档（opts 省略 / {} / escapeUnicode:false）仍与 JSON.stringify 逐字节一致', () => {
    const values: unknown[] = [
      'a"b\\c\n\t/😀',
      '中é\u007f',
      { '中': '文', '😀': ['é', '\u0001'] },
      '\uD800', // 孤立代理项：沿用 JSON.stringify 口径
    ];
    for (const value of values) {
      for (const indent of [undefined, 0, 2, 4] as const) {
        const expected = JSON.stringify(value, null, indent);
        expect(serializeLossless(value, indent)).toBe(expected);
        expect(serializeLossless(value, indent, {})).toBe(expected);
        expect(serializeLossless(value, indent, { escapeUnicode: false })).toBe(expected);
      }
    }
  });

  it('字符串值与对象键的非 ASCII → 小写 4 位 \\uXXXX；ASCII（含 0x7F）原样', () => {
    expect(serializeLossless({ '中': '文', ascii: 'Abc~! ' }, undefined, { escapeUnicode: true })).toBe(
      '{"\\u4e2d":"\\u6587","ascii":"Abc~! "}',
    );
    expect(serializeLossless({ a: '中', b: [1, '文'] }, 0, { escapeUnicode: true })).toBe(
      '{"a":"\\u4e2d","b":[1,"\\u6587"]}',
    );
    expect(serializeLossless('\u007f', undefined, { escapeUnicode: true })).toBe(JSON.stringify('\u007f'));
    expect(serializeLossless('\u0080', undefined, { escapeUnicode: true })).toBe('"\\u0080"');
    expect(serializeLossless({ '中': '文' }, 2, { escapeUnicode: true })).toBe(
      '{\n  "\\u4e2d": "\\u6587"\n}',
    );
  });

  it('非 BMP 按 UTF-16 代理对逐 code unit 转义（😀 U+1F600 → \\ud83d\\ude00）', () => {
    expect(serializeLossless('😀', undefined, { escapeUnicode: true })).toBe('"\\ud83d\\ude00"');
    expect(serializeLossless({ '😀': '𝄞' }, 0, { escapeUnicode: true })).toBe(
      '{"\\ud83d\\ude00":"\\ud834\\udd1e"}',
    );
    // 孤立代理项：在转义档里同样按单个 code unit 转义，且与 JSON.stringify 的输出一致
    expect(serializeLossless('\uD800', undefined, { escapeUnicode: true })).toBe(JSON.stringify('\uD800'));
  });

  it('控制字符 / 引号 / 反斜杠沿用 JSON.stringify 规则（短转义不变成 \\u00XX）', () => {
    const s = 'a"b\\c\n\t\r\b\f\u0001\u001f/';
    expect(serializeLossless(s, undefined, { escapeUnicode: true })).toBe(JSON.stringify(s));
    expect(serializeLossless({ 'k\n': s }, 2, { escapeUnicode: true })).toBe(
      JSON.stringify({ 'k\n': s }, null, 2),
    );
  });

  it('转义档输出仍是合法 JSON、全 ASCII，parseLossless 读回值不变（含 BigInt）', () => {
    const value = {
      '中': '文',
      emoji: '😀',
      ctl: 'a\tb\u0001',
      big: 297532588187238660n,
      arr: ['é', { '键': '值' }],
    };
    for (const indent of [undefined, 0, 2, 4] as const) {
      const text = serializeLossless(value, indent, { escapeUnicode: true }) as string;
      expect(text).toMatch(/^[\x00-\x7F]*$/); // 全 ASCII：非 ASCII 全部成了 \uXXXX
      expect(() => JSON.parse(text)).not.toThrow();
      expect(parseLossless(text)).toEqual(value);
    }
  });

  it('转义只影响文本表示：number / BigInt 不受影响（BigInt 仍裸十进制）', () => {
    expect(serializeLossless({ big: 297532588187238660n, n: 1.5, neg: -2n }, 0, { escapeUnicode: true })).toBe(
      '{"big":297532588187238660,"n":1.5,"neg":-2}',
    );
  });
});

describe('lossless-json — deepEqualJson（编辑 no-op）', () => {
  it('类型严格：number 5 ≠ bigint 5n；键序敏感', () => {
    expect(deepEqualJson(5, 5)).toBe(true);
    expect(deepEqualJson(5n, 5n)).toBe(true);
    expect(deepEqualJson(5, 5n)).toBe(false);
    expect(deepEqualJson({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true);
    expect(deepEqualJson({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(false);
    expect(deepEqualJson([1, 2], [1, 2])).toBe(true);
    expect(deepEqualJson([1, 2], [2, 1])).toBe(false);
    expect(deepEqualJson({ a: [297532588187238660n] }, { a: [297532588187238660n] })).toBe(true);
    expect(deepEqualJson({ a: [297532588187238660n] }, { a: [297532588187238656n] })).toBe(false);
  });

  it('-0 与 0 不同；null / 原始类型', () => {
    expect(deepEqualJson(-0, 0)).toBe(false);
    expect(deepEqualJson(-0, -0)).toBe(true);
    expect(deepEqualJson(null, null)).toBe(true);
    expect(deepEqualJson(null, undefined)).toBe(false);
  });
});

describe('number-literal 与 parser 的一致性（规则单一来源）', () => {
  it('parser 的整数包装与 analyzeNumberLiteral 的判定一致', () => {
    for (const lit of ['1', '-1', '9007199254740991', '9007199254740992', '1e15', '1e16', '1e400']) {
      const info = analyzeNumberLiteral(lit);
      const parsed = parseLossless(lit);
      if (info.value === null) expect(parsed).toBe(Infinity);
      else expect(parsed).toBe(info.value);
    }
  });
});
