import { describe, expect, it } from 'vitest';
import { CoreError } from '../../../src/protocol/errors';
import { SEARCH_PATTERN_MAX } from '../../../src/protocol/versions';
import { regexSafetyError, searchDocument } from '../../../src/core/search';

const DOC = {
  name: 'Alice',
  tags: ['alice', 'bob'],
  nested: { note: 'ALICE in wonderland', count: 2 },
  'a b': true,
};

describe('searchDocument — 命中规则', () => {
  it('命中键名与字符串值（默认大小写不敏感）', () => {
    const result = searchDocument(DOC, 'alice');
    expect(result.total).toBe(3);
    expect(result.truncated).toBe(false);
    expect(result.hits.map((h) => [h.path, h.field])).toEqual([
      ['$.name', 'value'],
      ['$.tags[0]', 'value'],
      ['$.nested.note', 'value'],
    ]);
  });

  it('大小写敏感时只命中完全一致的文本', () => {
    const result = searchDocument(DOC, 'alice', { caseSensitive: true });
    expect(result.hits.map((h) => h.path)).toEqual(['$.tags[0]']);
  });

  it('键名命中：field=key、path 指向该键、容器预览是省略号形态', () => {
    const result = searchDocument(DOC, 'tag');
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toMatchObject({
      path: '$.tags',
      key: 'tags',
      kind: 'array',
      field: 'key',
      preview: '[…]',
    });
  });

  it('keysOnly 只命中键名', () => {
    expect(searchDocument(DOC, 'alice', { keysOnly: true }).total).toBe(0);
    expect(searchDocument(DOC, 'tag', { keysOnly: true }).total).toBe(1);
  });

  it('非标识符键用括号路径，命中键名', () => {
    const result = searchDocument(DOC, 'a b');
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toMatchObject({ path: "$['a b']", key: 'a b', field: 'key', kind: 'boolean' });
  });

  it('数组下标不参与键名匹配', () => {
    expect(searchDocument({ arr: ['x'] }, '[0]').total).toBe(0);
  });

  it('数字按显示文本参与值匹配；布尔/null 不参与（ADR-0014 修订 2026-11-12）', () => {
    expect(searchDocument({ n: 123, b: true, z: null }, '123')).toMatchObject({ total: 1 });
    expect(searchDocument({ n: 123, b: true, z: null }, '123').hits[0]).toMatchObject({
      path: '$.n',
      field: 'value',
      kind: 'number',
      preview: '123',
    });
    expect(searchDocument({ n: 123, b: true, z: null }, 'true').total).toBe(0);
    expect(searchDocument({ n: 123, b: true, z: null }, 'null').total).toBe(0);
  });

  it('字符串根文档按值命中（path=$、key=root）', () => {
    const result = searchDocument('hello world', 'ell');
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toMatchObject({ path: '$', key: 'root', field: 'value', kind: 'string' });
  });

  it('空查询返回空结果', () => {
    expect(searchDocument(DOC, '')).toEqual({ hits: [], total: 0, truncated: false });
  });

  it('命中预览截断到 80 字符', () => {
    const long = { s: 'y'.repeat(200) };
    const hit = searchDocument(long, 'yyy').hits[0];
    expect(hit?.preview.length).toBe(80);
    expect(hit?.preview.endsWith('…')).toBe(true);
  });
});

describe('searchDocument — limit 与取消', () => {
  it('超过 limit 时截断并置 truncated', () => {
    const doc = { k1: 'x', k2: 'x', k3: 'x', k4: 'x' };
    const result = searchDocument(doc, 'x', { limit: 2 });
    expect(result.hits).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it('默认 limit 是 SEARCH_LIMIT（5 万）', () => {
    const items = Array.from({ length: 60_000 }, () => 'x');
    const result = searchDocument({ items }, 'x');
    expect(result.hits.length).toBe(50_000);
    expect(result.truncated).toBe(true);
  });

  it('shouldCancel 在遍历中被调用并抛 CANCELLED', () => {
    const items = Array.from({ length: 5000 }, (_, i) => i);
    expect(() => searchDocument({ items }, 'zz', { shouldCancel: () => true })).toThrowError(CoreError);
    try {
      searchDocument({ items }, 'zz', { shouldCancel: () => true });
    } catch (err) {
      expect((err as CoreError).code).toBe('CANCELLED');
    }
  });

  it('limit <= 0 时返回空结果', () => {
    expect(searchDocument(DOC, 'alice', { limit: 0 })).toEqual({ hits: [], total: 0, truncated: false });
  });
});

/* ---------------------------------------------------------------- 正则模式（ADR-0014） */

/** 四格语义矩阵专用文档：`HOTEL` 只在小写 key/值里出现，`Hotel` 只有大小写差异。 */
const MATRIX_DOC = {
  Hotel: 'Hotel California',
  hotel: 'small hotel',
  'h.tel': 'dot is literal in substring',
};

/** 断言抛 BAD_PATTERN 并返回 message（避开 try/catch 重复）。 */
function badPatternMessage(query: string, opts: { caseSensitive?: boolean; regex?: boolean } = {}): string {
  try {
    searchDocument({ s: 'aaa' }, query, opts);
  } catch (error) {
    expect(error).toBeInstanceOf(CoreError);
    const coreError = error as CoreError;
    expect(coreError.code).toBe('BAD_PATTERN');
    return coreError.message;
  }
  throw new Error(`expected BAD_PATTERN for ${query}`);
}

describe('searchDocument — 正则模式：四格语义矩阵（ADR-0014 §2.2）', () => {
  it('子串 + 不区分大小写：`.` 是字面量（h.tel → 1 命中；按正则解释会是 4）', () => {
    const result = searchDocument(MATRIX_DOC, 'h.tel');
    expect(result.hits.map((h) => [h.path, h.field])).toEqual([["$['h.tel']", 'key']]);
  });

  it('子串 + Aa：大小写敏感（HOTEL → 0 命中；不区分大小写会是 2）', () => {
    expect(searchDocument(MATRIX_DOC, 'HOTEL', { caseSensitive: true }).total).toBe(0);
    expect(searchDocument(MATRIX_DOC, 'hotel').hits.map((h) => h.path)).toEqual([
      '$.Hotel',
      '$.hotel',
    ]);
  });

  it('正则（不区分大小写）：`.` 是通配 + i flag（h.tel → 3 命中；按子串解释会是 1）', () => {
    const result = searchDocument(MATRIX_DOC, 'h.tel', { regex: true });
    expect(result.hits.map((h) => [h.path, h.field])).toEqual([
      ['$.Hotel', 'key'],
      ['$.hotel', 'key'],
      ["$['h.tel']", 'key'],
    ]);
  });

  it('正则 + Aa：无 i flag（^Hotel$ → 1 命中；不区分大小写会是 2）', () => {
    expect(
      searchDocument(MATRIX_DOC, '^Hotel$', { regex: true, caseSensitive: true }).hits.map((h) => h.path),
    ).toEqual(['$.Hotel']);
    expect(searchDocument(MATRIX_DOC, '^Hotel$', { regex: true }).hits.map((h) => h.path)).toEqual([
      '$.Hotel',
      '$.hotel',
    ]);
  });
});

describe('searchDocument — 正则模式：键优先 / 只匹配键名 + 字符串值', () => {
  it('同一条正则同时命中键名与值：field=key 优先（与 slice 4 判定顺序一致）', () => {
    const result = searchDocument({ abc: 'abc' }, '^abc$', { regex: true });
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toMatchObject({ path: '$.abc', key: 'abc', field: 'key' });
  });

  it('数字仍参与值匹配（按显示文本）；布尔/null 不参与', () => {
    expect(searchDocument({ n: 123, b: true, z: null }, '^123$', { regex: true }).total).toBe(1);
    expect(searchDocument({ n: 123, b: true, z: null }, '^true$', { regex: true }).total).toBe(0);
  });

  it('空查询不编译正则、直接返回空结果', () => {
    expect(searchDocument(MATRIX_DOC, '', { regex: true })).toEqual({ hits: [], total: 0, truncated: false });
  });
});

describe('searchDocument — 正则模式：BAD_PATTERN（语法 / 超长 / 安全筛查）', () => {
  it('无效正则 → BAD_PATTERN，message 带原生原因', () => {
    const message = badPatternMessage('(', { regex: true });
    expect(message.startsWith('正则语法错误：')).toBe(true);
    expect(message.length).toBeGreaterThan('正则语法错误：'.length);
    expect(() => searchDocument(DOC, '[', { regex: true })).toThrowError(CoreError);
  });

  it(`超过 SEARCH_PATTERN_MAX（${SEARCH_PATTERN_MAX}）→ BAD_PATTERN「正则过长」`, () => {
    const tooLong = 'a'.repeat(SEARCH_PATTERN_MAX + 1);
    const message = badPatternMessage(tooLong, { regex: true });
    expect(message).toBe(`正则过长（上限 ${SEARCH_PATTERN_MAX} 字符）`);
  });

  it('恰好 SEARCH_PATTERN_MAX 字符仍可编译（边界不误杀）', () => {
    const atLimit = 'a'.repeat(SEARCH_PATTERN_MAX);
    expect(() => searchDocument(DOC, atLimit, { regex: true })).not.toThrow();
    expect(searchDocument(DOC, atLimit, { regex: true }).total).toBe(0);
  });

  it('量词作用于含量词的分组 → 拒绝（(a+)+ / (a*)+ / (a+)* / (?:a{1,})+ / ((a+))+）', () => {
    for (const unsafe of ['(a+)+', '(a*)+', '(a+)*', '(?:a{1,})+', '((a+))+']) {
      expect(badPatternMessage(unsafe, { regex: true })).toBe('该正则可能触发灾难性回溯');
    }
  });

  it('交替分支的重复不误杀：(foo|bar)+ 通过', () => {
    expect(regexSafetyError('(foo|bar)+')).toBeNull();
    expect(() => searchDocument(DOC, '(foo|bar)+', { regex: true })).not.toThrow();
    expect(searchDocument({ s: 'foobar' }, '(foo|bar)+', { regex: true }).total).toBe(1);
  });

  it('子串模式不受安全筛查影响（(a+)+ 只是普通子串）', () => {
    expect(searchDocument({ s: '(a+)+' }, '(a+)+').total).toBe(1);
  });
});

describe('regexSafetyError — 静态筛查纯函数', () => {
  it('安全模式返回 null：无嵌套量词 / 交替 / 字符类 / 转义 / 单层量词', () => {
    for (const safe of [
      'foo',
      '(foo|bar)+',
      '(?:ab)+',
      '(a+)',
      '(ab)?',
      '(a+)?', // 外层 ? 最多应用一次 → 线性回溯，放行
      '(a+){1}',
      '[a+]+',
      '\\(a\\+\\)+',
      '\\d+(\\.\\d+)?', // 常见分组 + 内层量词 + 外层 ?，不能误杀
    ]) {
      expect(regexSafetyError(safe)).toBeNull();
    }
  });

  it('嵌套量词返回拒绝原因', () => {
    for (const unsafe of ['(a+)+', '(a?)+', '((a+))+', '(a+){2}', '(a+){2,}', '(?:a{1,})+']) {
      expect(regexSafetyError(unsafe)).toBe('该正则可能触发灾难性回溯');
    }
  });

  it('字符类 / 转义里的量词不算分组量词', () => {
    expect(regexSafetyError('[(a+)]+')).toBeNull();
    expect(regexSafetyError('\\(a\\+\\)+')).toBeNull();
  });
});

describe('searchDocument — 正则模式：取消与 limit 不回归', () => {
  it('shouldCancel 在正则模式下仍每 4096 节点生效', () => {
    const items = Array.from({ length: 5000 }, (_, i) => i);
    expect(() =>
      searchDocument({ items }, 'zzz', { regex: true, shouldCancel: () => true }),
    ).toThrowError(CoreError);
    try {
      searchDocument({ items }, 'zzz', { regex: true, shouldCancel: () => true });
    } catch (error) {
      expect((error as CoreError).code).toBe('CANCELLED');
    }
  });

  it('正则 + limit → 截断并置 truncated', () => {
    const doc = { k1: 'x', k2: 'x', k3: 'x' };
    const result = searchDocument(doc, 'x', { regex: true, limit: 2 });
    expect(result.hits).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(result.truncated).toBe(true);
  });
});

describe('search — 无损数字（BigInt，ADR-0020）口径不变', () => {
  it('大整数（用户 2026-11-12 反馈）：按显示文本可搜到；数字 kind 仍是 number', () => {
    const doc = { id: 297532588187238660n, note: '297532588187238660' };
    // BigInt 值与同串字符串值都命中（前序：id 在前）；树里显示什么就能搜到什么
    const byValue = searchDocument(doc, '297532588187238660', {});
    expect(byValue.hits.map((h) => [h.path, h.field, h.kind])).toEqual([
      ['$.id', 'value', 'number'],
      ['$.note', 'value', 'string'],
    ]);
    // 命中预览 = 树里显示的十进制串（不是 null）
    expect(byValue.hits[0]).toMatchObject({ preview: '297532588187238660', kind: 'number' });
    // 键名照常命中
    const byKey = searchDocument(doc, 'id', {});
    expect(byKey.hits.map((h) => [h.path, h.field])).toEqual([['$.id', 'key']]);
  });

  it('普通数字按显示文本匹配（含指数/小数/-0 的显示口径）', () => {
    expect(searchDocument({ a: 100 }, '100').hits[0]).toMatchObject({ path: '$.a', kind: 'number' });
    expect(searchDocument({ a: 1e21 }, '1e+21').total).toBe(1); // 与 JSON.stringify 显示一致
    expect(searchDocument({ a: 1.5 }, '1.5').total).toBe(1);
    expect(searchDocument({ a: -0 }, '0').hits[0]).toMatchObject({ path: '$.a', preview: '0' });
    expect(searchDocument([297532588187238660n], '297532588187238660').hits[0]).toMatchObject({
      path: '$[0]',
      kind: 'number',
    });
  });
});
