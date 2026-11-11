/**
 * search-parity — `core/search.ts` × 独立参考实现（`./search-reference.ts`）的语义对拍。
 *
 * 目的（ADR-0014 修订 2026-11-10 / 架构走查候选 5）：ADR-0014 的 `caseSensitive` / `regex` /
 * `keysOnly` / `limit` 语义此前没有对照物——两份冒烟脚本各自手抄一份 reference walk，
 * 于是「期望值」与「被测实现」互相背书。本测试是搜索语义的**单一 oracle**：
 *   - 参考实现与 core 刻意用不同结构（先展平再匹配 vs 单趟 DFS 边走边判）；
 *   - 矩阵覆盖 4 格语义组合 × keysOnly × limit × 空 query × 无命中 × 根形态 × Unicode 等；
 *   - 失败 message 带 case / query / opts，能直接定位到「哪条语义不同」。
 *
 * 显式边界：不覆盖灾难性回溯静态筛查（参考实现不复制该启发式，避免重复实现/自证）；
 * `(a+)+` 等拒绝用例仍由 `search.test.ts` 兜底。`shouldCancel` / `CANCELLED` 不属于命中语义。
 */
import { describe, expect, it } from 'vitest';
import { searchDocument } from '../../../src/core/search';
import { CoreError } from '../../../src/protocol/errors';
import { SEARCH_LIMIT, SEARCH_PATTERN_MAX } from '../../../src/protocol/versions';
import {
  bigHitDoc,
  deepDoc,
  FIELD_DOC,
  MIXED_DOC,
  OPTIONS_DOC,
  ROOT_ARRAY,
  ROOT_EMPTY_OBJECT,
  ROOT_SCALAR,
  TRUNC_DOC,
  UNICODE_DOC,
} from './search-fixtures';
import {
  flattenDocument,
  referenceSearch,
  ReferencePatternError,
  type ReferenceOpts,
} from './search-reference';

interface ParityCase {
  name: string;
  doc: unknown;
  query: string;
  opts?: ReferenceOpts;
}

/** 对拍矩阵：一行 = 一条语义。命名带语义族前缀，失败时 `it` 名 + message 双定位。 */
const PARITY_CASES: ParityCase[] = [
  // ---- 默认：大小写不敏感子串 ----
  { name: 'default: 大小写不敏感子串', doc: MIXED_DOC, query: 'alice' },
  { name: 'default: 大写查询也命中', doc: MIXED_DOC, query: 'ALICE' },
  { name: 'default: 非标识符键（含空格）', doc: MIXED_DOC, query: 'a b' },
  { name: 'default: 空键名', doc: MIXED_DOC, query: 'empty' },
  { name: 'default: 引号键名', doc: MIXED_DOC, query: "quote'" },
  { name: 'default: 反斜杠键名', doc: MIXED_DOC, query: 'slash' },
  { name: 'default: 深层路径', doc: deepDoc(), query: 'bottom' },
  { name: 'default: 长字符串值', doc: MIXED_DOC, query: 'yyy' },
  { name: 'default: 无命中', doc: MIXED_DOC, query: 'zz-no-such-term' },
  { name: 'default: 空查询', doc: MIXED_DOC, query: '' },
  { name: 'default: 根标量', doc: ROOT_SCALAR, query: 'hotel' },
  { name: 'default: 根数组', doc: ROOT_ARRAY, query: 'hotel' },
  { name: 'default: 根空对象', doc: ROOT_EMPTY_OBJECT, query: 'hotel' },
  { name: 'default: 数组下标不参与键名', doc: FIELD_DOC, query: '[0]' },
  { name: 'default: 键名优先于值', doc: FIELD_DOC, query: 'abc' },
  { name: 'default: unicode 中文', doc: UNICODE_DOC, query: '中文' },
  { name: 'default: unicode emoji', doc: UNICODE_DOC, query: '🏨' },
  { name: 'default: unicode ß / ẞ', doc: UNICODE_DOC, query: 'ß' },
  { name: 'default: unicode İ', doc: UNICODE_DOC, query: 'İ' },
  // ---- Aa：大小写敏感子串 ----
  { name: 'caseSensitive: 只命中大小写一致', doc: MIXED_DOC, query: 'ALICE', opts: { caseSensitive: true } },
  { name: 'caseSensitive: unicode ß / ẞ', doc: UNICODE_DOC, query: 'ß', opts: { caseSensitive: true } },
  // ---- 正则（`.` 通配 / 锚点 / 交替 / 转义） ----
  { name: 'regex: 点号通配', doc: MIXED_DOC, query: 'h.tel', opts: { regex: true } },
  { name: 'regex: 锚点', doc: OPTIONS_DOC, query: '^hotel$', opts: { regex: true } },
  { name: 'regex: 交替', doc: MIXED_DOC, query: 'Alice|bob', opts: { regex: true } },
  { name: 'regex: 转义数字', doc: MIXED_DOC, query: '^\\d+$', opts: { regex: true } },
  { name: 'regex: 空字符串匹配（^$）', doc: MIXED_DOC, query: '^$', opts: { regex: true } },
  { name: 'regex: 空查询不编译', doc: MIXED_DOC, query: '', opts: { regex: true } },
  { name: 'regex: 语法错但 limit=0（先判 limit，不编译）', doc: MIXED_DOC, query: '(', opts: { regex: true, limit: 0 } },
  { name: 'regex + caseSensitive: 锚点', doc: OPTIONS_DOC, query: '^hotel$', opts: { regex: true, caseSensitive: true } },
  // ---- 数字值按显示文本匹配（ADR-0014 修订 2026-11-12） ----
  { name: 'number: 大整数十进制串', doc: { big: 297532588187238660n }, query: '297532588187238660' },
  { name: 'number: 普通数字', doc: { n: 100, s: 'x100x' }, query: '100' },
  { name: 'number: 指数显示文本', doc: { n: 1e21 }, query: '1e+21' },
  { name: 'number: 小数显示文本', doc: { n: 1.5 }, query: '1.5' },
  { name: 'number: -0 显示为 0', doc: { n: -0 }, query: '0' },
  { name: 'number + regex', doc: { big: 297532588187238660n, n: 42 }, query: '^\\d+$', opts: { regex: true } },
  { name: 'number + keysOnly 不命中值', doc: { n: 100 }, query: '100', opts: { keysOnly: true } },

  // ---- keysOnly ----
  { name: 'keysOnly: 只命中键名', doc: MIXED_DOC, query: 'alice', opts: { keysOnly: true } },
  { name: 'keysOnly + regex', doc: OPTIONS_DOC, query: '^hotel$', opts: { keysOnly: true, regex: true } },
  { name: 'keysOnly + caseSensitive', doc: OPTIONS_DOC, query: 'hotel', opts: { keysOnly: true, caseSensitive: true } },
  // ---- limit / 截断 ----
  { name: 'limit=1', doc: TRUNC_DOC, query: 'x', opts: { limit: 1 } },
  { name: 'limit=2', doc: TRUNC_DOC, query: 'x', opts: { limit: 2 } },
  { name: 'limit=5（恰好等于命中数）', doc: TRUNC_DOC, query: 'x', opts: { limit: 5 } },
  { name: 'limit=6（大于命中数）', doc: TRUNC_DOC, query: 'x', opts: { limit: 6 } },
  { name: 'limit=2.5（小数 limit：core 命中 3 条时截断）', doc: TRUNC_DOC, query: 'x', opts: { limit: 2.5 } },
  { name: 'limit=0.5（小数 limit：首条即截断）', doc: TRUNC_DOC, query: 'x', opts: { limit: 0.5 } },
  { name: 'limit=0', doc: TRUNC_DOC, query: 'x', opts: { limit: 0 } },
  { name: 'limit=-1', doc: TRUNC_DOC, query: 'x', opts: { limit: -1 } },
  { name: 'limit=Infinity（core 口径：非法 limit → 空）', doc: TRUNC_DOC, query: 'x', opts: { limit: Infinity } },
  // ---- 冒烟 options fixture 四格（与 `smoke-search` 手算常量一致） ----
  { name: 'options: 默认 6', doc: OPTIONS_DOC, query: 'hotel' },
  { name: 'options: Aa 2', doc: OPTIONS_DOC, query: 'hotel', opts: { caseSensitive: true } },
  { name: 'options: 正则 5', doc: OPTIONS_DOC, query: '^hotel$', opts: { regex: true } },
  { name: 'options: 正则+Aa 1', doc: OPTIONS_DOC, query: '^hotel$', opts: { regex: true, caseSensitive: true } },
];

interface ProjectedHit {
  path: string;
  key: string;
  kind: string;
  field: 'key' | 'value';
}

function project(hits: readonly { path: string; key: string; kind: string; field: 'key' | 'value' }[]): ProjectedHit[] {
  return hits.map((hit) => ({ path: hit.path, key: hit.key, kind: hit.kind, field: hit.field }));
}

/** 对拍一条语义：hits 有序列表（path/key/kind/field）+ total + truncated 必须完全一致。 */
function expectParity(label: string, doc: unknown, query: string, opts?: ReferenceOpts): void {
  const core = searchDocument(doc, query, opts);
  const reference = referenceSearch(doc, query, opts);
  const message = `${label} — query=${JSON.stringify(query)} opts=${JSON.stringify(opts ?? {})}`;
  expect(project(core.hits), `${message} — hits`).toEqual(project(reference.hits));
  expect(core.total, `${message} — total`).toBe(reference.total);
  expect(core.truncated, `${message} — truncated`).toBe(reference.truncated);
}

describe('search parity — core vs 独立参考实现（矩阵）', () => {
  it.each(PARITY_CASES)('$name', (testCase) => {
    expectParity(testCase.name, testCase.doc, testCase.query, testCase.opts);
  });
});

describe('search parity — 参考实现自身口径（oracle 的可信度）', () => {
  it('flattenDocument：前序 + 规范路径（根 / 非标识符键 / 数组下标）', () => {
    const entries = flattenDocument({ 'a b': ['x'], c: 1 });
    expect(entries.map((entry) => [entry.path, entry.key, entry.isIndex, entry.isRoot])).toEqual([
      ['$', 'root', false, true],
      ["$['a b']", 'a b', false, false],
      ["$['a b'][0]", '[0]', true, false],
      ['$.c', 'c', false, false],
    ]);
  });

  it('冒烟 options fixture：6 / 2 / 5 / 1 由参考实现背书（core 同步）', () => {
    const matrix: Array<[string, string, ReferenceOpts, number]> = [
      ['默认（大小写不敏感子串）', 'hotel', {}, 6],
      ['Aa（大小写敏感子串）', 'hotel', { caseSensitive: true }, 2],
      ['正则（i）', '^hotel$', { regex: true }, 5],
      ['正则 + Aa', '^hotel$', { regex: true, caseSensitive: true }, 1],
    ];
    for (const [label, query, opts, expected] of matrix) {
      expect(referenceSearch(OPTIONS_DOC, query, opts).total, `参考实现 — ${label}`).toBe(expected);
      expect(searchDocument(OPTIONS_DOC, query, opts).total, `core — ${label}`).toBe(expected);
    }
  });

  it('默认 SEARCH_LIMIT：core 与参考实现都截断到 50,000', () => {
    const doc = bigHitDoc();
    const core = searchDocument(doc, 'x');
    const reference = referenceSearch(doc, 'x');
    expect(core.total).toBe(SEARCH_LIMIT);
    expect(core.truncated).toBe(true);
    expect(core.hits).toHaveLength(SEARCH_LIMIT);
    expect(reference.total).toBe(core.total);
    expect(reference.truncated).toBe(core.truncated);
    // 5 万条不做整表深比较（失败 diff 无意义）：抽查首尾，其余由小 fixture 矩阵覆盖。
    expect(project(core.hits.slice(0, 3))).toEqual(project(reference.hits.slice(0, 3)));
    expect(project(core.hits.slice(-3))).toEqual(project(reference.hits.slice(-3)));
  });

  it('恰好 limit 命中：truncated=true（core 现状口径，参考实现照抄）', () => {
    const doc = { a: 'x', b: 'x' };
    const core = searchDocument(doc, 'x', { limit: 2 });
    const reference = referenceSearch(doc, 'x', { limit: 2 });
    expect(core.total).toBe(2);
    expect(core.truncated).toBe(true);
    expect(reference.total).toBe(core.total);
    expect(reference.truncated).toBe(core.truncated);
  });
});

describe('search parity — BAD_PATTERN（语法 / 超长；不覆盖 ReDoS 筛查）', () => {
  function bothReject(query: string): void {
    let coreRejected = false;
    try {
      searchDocument({ s: 'aaa' }, query, { regex: true });
    } catch (error) {
      expect(error).toBeInstanceOf(CoreError);
      expect((error as CoreError).code).toBe('BAD_PATTERN');
      coreRejected = true;
    }
    expect(coreRejected, `core 未拒绝：${query}`).toBe(true);

    let referenceRejected = false;
    try {
      referenceSearch({ s: 'aaa' }, query, { regex: true });
    } catch (error) {
      expect(error).toBeInstanceOf(ReferencePatternError);
      referenceRejected = true;
    }
    expect(referenceRejected, `参考实现未拒绝：${query}`).toBe(true);
  }

  it('语法错误：两边都拒绝', () => {
    bothReject('(');
    bothReject('[');
  });

  it('超过 SEARCH_PATTERN_MAX：两边都拒绝', () => {
    bothReject('a'.repeat(SEARCH_PATTERN_MAX + 1));
  });

  it('恰好 SEARCH_PATTERN_MAX：两边都放行', () => {
    const atLimit = 'a'.repeat(SEARCH_PATTERN_MAX);
    expect(() => searchDocument({ s: 'aaa' }, atLimit, { regex: true })).not.toThrow();
    expect(() => referenceSearch({ s: 'aaa' }, atLimit, { regex: true })).not.toThrow();
  });
});
