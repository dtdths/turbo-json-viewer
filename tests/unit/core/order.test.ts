/**
 * core/order — 显示排序规则（#40 / ADR-0024 §3 / §6）。
 *
 * 比较器约束（ADR 定稿）：
 *   - 数字段按数值（`item2 < item10`，前导零由数值比较吸收）；
 *   - 非数字段忽略大小写；
 *   - 全平局用原码元序兜底 → **全序**（与平台/ICU 版本无关，不用 Intl.Collator）；
 *   - 中文 / 非 ASCII 按码元序（不做拼音、不做 locale 排序）。
 */
import { describe, expect, it } from 'vitest';
import { compareNaturalKeys, normalizeSortOrder, orderedKeys } from '../../../src/core/order';
import type { SortOrder } from '../../../src/protocol/types';

function asc(keys: string[]): string[] {
  return [...keys].sort(compareNaturalKeys);
}

function desc(keys: string[]): string[] {
  return [...keys].sort((a, b) => compareNaturalKeys(b, a));
}

/** 确定性伪随机（mulberry32）：全序性质测试必须可复现。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KEY_CHARS = ['0', '1', '2', '9', 'a', 'b', 'A', 'B', '中', '文', '-', '_', '.', ' ', 'é', '😀'];

function randomKeys(seed: number, count: number): string[] {
  const rand = mulberry32(seed);
  const out = new Set<string>();
  while (out.size < count) {
    const length = 1 + Math.floor(rand() * 6);
    let key = '';
    for (let i = 0; i < length; i++) key += KEY_CHARS[Math.floor(rand() * KEY_CHARS.length)] as string;
    out.add(key);
  }
  return [...out];
}

function sign(n: number): number {
  return n < 0 ? -1 : n > 0 ? 1 : 0;
}

describe('core/order — normalizeSortOrder（白名单归一化）', () => {
  it('三档协议值原样通过', () => {
    expect(normalizeSortOrder('raw')).toBe('raw');
    expect(normalizeSortOrder('key-asc')).toBe('key-asc');
    expect(normalizeSortOrder('key-desc')).toBe('key-desc');
  });

  it('非法值（拼错 / 空串 / 非字符串 / undefined）一律回落 raw', () => {
    const invalid: unknown[] = ['asc', 'key_asc', 'KEY-ASC', '', null, undefined, 0, 1, true, {}, [], 'RAW'];
    for (const value of invalid) expect(normalizeSortOrder(value)).toBe('raw');
  });
});

describe('core/order — compareNaturalKeys（自然序）', () => {
  it('数字段按数值：item2 < item10（不是字典序）', () => {
    expect(asc(['item10', 'item1', 'item2'])).toEqual(['item1', 'item2', 'item10']);
    expect(asc(['k10', 'k9', 'k100'])).toEqual(['k9', 'k10', 'k100']);
    expect(asc(['2', '10', '1'])).toEqual(['1', '2', '10']);
  });

  it('前导零由数值比较吸收（数值相等时用原码元序兜底）', () => {
    // 数值都是 1 → 平局 → 原码元序：k001 < k01 < k1
    expect(asc(['k1', 'k01', 'k001'])).toEqual(['k001', 'k01', 'k1']);
    // 值仍按数值：k007 < k8
    expect(asc(['k8', 'k007'])).toEqual(['k007', 'k8']);
  });

  it('超长数字段按长度+字典序比较（不经过 Number，不丢精度）', () => {
    const big1 = '9'.repeat(40) + '1';
    const big2 = '9'.repeat(40) + '2';
    expect(compareNaturalKeys(big1, big2)).toBeLessThan(0);
    // 40 位与 41 位：后者更大（长度优先）
    expect(compareNaturalKeys('9'.repeat(40), '1' + '0'.repeat(40))).toBeLessThan(0);
  });

  it('非数字段忽略大小写（平局回落到原码元序）', () => {
    // 折同后 a == A → 原码元序 'A'(65) < 'a'(97)
    expect(sign(compareNaturalKeys('A', 'a'))).toBe(-1);
    expect(sign(compareNaturalKeys('a', 'A'))).toBe(1);
    expect(asc(['b', 'A', 'a', 'B'])).toEqual(['A', 'a', 'B', 'b']);
    expect(asc(['Item10', 'item2'])).toEqual(['item2', 'Item10']);
  });

  it('同一位置数字段 vs 非数字段：数字段在前（固定规则，保证全序）', () => {
    expect(asc(['ab', 'a2', 'a10', 'a1b'])).toEqual(['a1b', 'a2', 'a10', 'ab']);
    expect(asc(['a', '1'])).toEqual(['1', 'a']);
  });

  it('中文 / 非 ASCII 按码元序（不做拼音、不做 locale 排序）', () => {
    // '1' 数字段在前；其余按折小写后的码元序：a(0x61=97) < z(0x7A=122) < 中(U+4E2D=20013) < 文(U+6587=25991)
    expect(asc(['文', 'a', '中', 'Z', '1'])).toEqual(['1', 'a', 'Z', '中', '文']);
    // 中文键之间：码元序而非拼音（"阿" U+963F < "中" U+4E2D? 963F=38463 > 20013 → 中 先）
    expect(asc(['阿', '中'])).toEqual(['中', '阿']);
  });

  it('空串排最前（前缀更短者在前）', () => {
    expect(asc(['a', '', 'ab', 'A'])).toEqual(['', 'A', 'a', 'ab']);
  });

  it('降序 = 升序的严格反序（复用同一比较器反向调用）', () => {
    const keys = ['item10', 'item2', 'Item1', '文', 'a', 'A', ''];
    expect(desc(keys)).toEqual(asc(keys).reverse());
  });

  it('比较器是自反 / 反对称 / 严格全序（不同键永不为 0）', () => {
    const keys = [...randomKeys(2026, 60), '', 'a', 'A', '1', '01'];
    for (const a of keys) {
      expect(compareNaturalKeys(a, a)).toBe(0);
      for (const b of keys) {
        // 0 === -0 为 true：用 === 而不是 toBe（Object.is 会区分 ±0）
        expect(sign(compareNaturalKeys(a, b)) === -sign(compareNaturalKeys(b, a))).toBe(true);
        if (a !== b) expect(compareNaturalKeys(a, b)).not.toBe(0);
      }
    }
  });

  it('传递性 + 排序结果与输入排列无关（任意打乱都得到同一序列）', () => {
    const keys = randomKeys(40, 80);
    const ordered = asc(keys);
    // 无平局 → 严格递增
    for (let i = 1; i < ordered.length; i++) {
      expect(compareNaturalKeys(ordered[i - 1] as string, ordered[i] as string)).toBeLessThan(0);
    }
    // 随机抽三元组验证传递性
    const rand = mulberry32(7);
    for (let t = 0; t < 3000; t++) {
      const [x, y, z] = [
        keys[Math.floor(rand() * keys.length)] as string,
        keys[Math.floor(rand() * keys.length)] as string,
        keys[Math.floor(rand() * keys.length)] as string,
      ];
      if (compareNaturalKeys(x, y) < 0 && compareNaturalKeys(y, z) < 0) {
        expect(compareNaturalKeys(x, z)).toBeLessThan(0);
      }
    }
    // 不同排列排序结果一致（总序 → 唯一序）
    const shuffled = [...keys].sort(() => 0); // 保持原序
    for (let round = 0; round < 5; round++) {
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j] as string, shuffled[i] as string];
      }
      expect(asc(shuffled)).toEqual(ordered);
    }
  });
});

describe('core/order — orderedKeys（容器 → 显示键序）', () => {
  it('raw = Object.keys 顺序（缺省也是 raw）', () => {
    const node: Record<string, unknown> = JSON.parse('{"b":1,"a":2,"10":3,"2":4}');
    expect(orderedKeys(node)).toEqual(['2', '10', 'b', 'a']);
    expect(orderedKeys(node, 'raw')).toEqual(Object.keys(node));
  });

  it('key-asc：数字段按数值 + 自然序', () => {
    const node: Record<string, unknown> = JSON.parse('{"b":1,"a":2,"10":3,"2":4}');
    // 数字段在前：2 < 10；非数字段 a < b
    expect(orderedKeys(node, 'key-asc')).toEqual(['2', '10', 'a', 'b']);
  });

  it('key-desc：严格反序', () => {
    const node: Record<string, unknown> = JSON.parse('{"b":1,"a":2,"10":3,"2":4}');
    expect(orderedKeys(node, 'key-desc')).toEqual(['b', 'a', '10', '2']);
  });

  it('每次返回新数组（调用方可以随意修改/缓存）', () => {
    const node = { b: 1, a: 2 };
    const first = orderedKeys(node, 'key-asc');
    const second = orderedKeys(node, 'key-asc');
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    // 不污染 Object.keys 真相（值图键序不变）
    expect(Object.keys(node)).toEqual(['b', 'a']);
  });

  it('空对象 → 空数组；非法档位 → raw 顺序', () => {
    expect(orderedKeys({}, 'key-asc')).toEqual([]);
    expect(orderedKeys({ b: 1, a: 2 }, 'nope' as unknown as SortOrder)).toEqual(['b', 'a']);
  });
});
