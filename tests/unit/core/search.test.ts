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

  it('数组下标不参与键名匹配；[0] 仅作为路径后缀命中（ADR-0023）', () => {
    // 键名搜索：数组下标不是键名
    expect(searchDocument({ arr: ['x'] }, '[0]', { keysOnly: true }).total).toBe(0);
    // 路径模式：`[0]` 命中 $.arr[0]
    expect(searchDocument({ arr: ['x'] }, '[0]').hits.map((h) => [h.path, h.field])).toEqual([
      ['$.arr[0]', 'path'],
    ]);
  });

  it('数字按显示文本参与值匹配；布尔/null 也按显示文本参与（ADR-0014 修订 / ADR-0023）', () => {
    expect(searchDocument({ n: 123, b: true, z: null }, '123')).toMatchObject({ total: 1 });
    expect(searchDocument({ n: 123, b: true, z: null }, '123').hits[0]).toMatchObject({
      path: '$.n',
      field: 'value',
      kind: 'number',
      preview: '123',
    });
    expect(searchDocument({ n: 123, b: true, z: null }, 'true')).toMatchObject({ total: 1 });
    expect(searchDocument({ n: 123, b: true, z: null }, 'true').hits[0]).toMatchObject({
      path: '$.b',
      field: 'value',
      kind: 'boolean',
      preview: 'true',
    });
    expect(searchDocument({ n: 123, b: true, z: null }, 'null')).toMatchObject({ total: 1 });
    expect(searchDocument({ n: 123, b: true, z: null }, 'null').hits[0]).toMatchObject({
      path: '$.z',
      field: 'value',
      kind: 'null',
      preview: 'null',
    });
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

  it('数字仍参与值匹配（按显示文本）；布尔/null 也参与（ADR-0023）', () => {
    expect(searchDocument({ n: 123, b: true, z: null }, '^123$', { regex: true }).total).toBe(1);
    expect(searchDocument({ n: 123, b: true, z: null }, '^true$', { regex: true }).hits).toHaveLength(1);
    expect(searchDocument({ n: 123, b: true, z: null }, '^true$', { regex: true }).hits[0]).toMatchObject({
      path: '$.b',
      field: 'value',
      kind: 'boolean',
    });
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

/* ---------------------------------------------------------------- 布尔/null 值命中（ADR-0023 §1） */

describe('searchDocument — 布尔/null 值命中（ADR-0023 §1）', () => {
  const doc = { t: true, f: false, z: null, n: 123 };

  it('true / false / null 按显示文本参与值命中（搜到的 == 看到的）', () => {
    expect(searchDocument(doc, 'true').hits.map((h) => [h.path, h.field, h.kind, h.preview])).toEqual([
      ['$.t', 'value', 'boolean', 'true'],
    ]);
    expect(searchDocument(doc, 'false').hits.map((h) => [h.path, h.field, h.preview])).toEqual([
      ['$.f', 'value', 'false'],
    ]);
    expect(searchDocument(doc, 'null').hits.map((h) => [h.path, h.field, h.kind, h.preview])).toEqual([
      ['$.z', 'value', 'null', 'null'],
    ]);
  });

  it('值匹配规则与字符串/数字一致：子串 + 大小写按 Aa', () => {
    expect(searchDocument(doc, 'ul').hits.map((h) => h.path)).toEqual(['$.z']); // 'null' 的子串
    expect(searchDocument(doc, 'TRUE').hits.map((h) => h.path)).toEqual(['$.t']);
    expect(searchDocument(doc, 'TRUE', { caseSensitive: true }).total).toBe(0);
    expect(searchDocument(doc, 'True', { caseSensitive: true }).total).toBe(0);
  });

  it('正则模式同规则（^true$ / ^(?:true|false)$）', () => {
    expect(searchDocument(doc, '^true$', { regex: true }).hits.map((h) => h.path)).toEqual(['$.t']);
    expect(searchDocument(doc, '^(?:true|false)$', { regex: true }).hits.map((h) => h.path)).toEqual([
      '$.t',
      '$.f',
    ]);
  });

  it('keysOnly 仍只搜键名（布尔/null 值不命中）', () => {
    expect(searchDocument(doc, 'true', { keysOnly: true }).total).toBe(0);
    expect(searchDocument(doc, 'null', { keysOnly: true }).total).toBe(0);
  });
});

/* ---------------------------------------------------------------- 路径命中（ADR-0023 §2–§3） */

/** 路径例表专用文档：键/值都不含 `.` / `[` / `$`，排除键值命中干扰。 */
const PATH_DOC = {
  data: { hotel_list: ['a', 'b', 'c', 'd'], other_list: ['w', 'x', 'y', 'z'] },
  meta: { data: 1 },
};

describe('searchDocument — 路径模式触发（ADR-0023 §2）', () => {
  it('查询含 `.` / `[` / `$` 才启用路径命中', () => {
    // `.` 触发：'x.a' 只可能是路径后缀，键/值都不含它
    expect(searchDocument({ x: { a: 1 } }, 'x.a').hits.map((h) => [h.path, h.field])).toEqual([
      ['$.x.a', 'path'],
    ]);
    // `[` 触发
    expect(searchDocument({ x: ['a'] }, '[0]').hits.map((h) => [h.path, h.field])).toEqual([
      ['$.x[0]', 'path'],
    ]);
    // `$` 触发
    expect(searchDocument({ x: { a: 1 } }, '$').hits.map((h) => [h.path, h.field])).toEqual([
      ['$', 'path'],
    ]);
    // 无触发字符：即使路径以该串结尾也不收（非标识符键路径末尾的 `']`）
    expect(searchDocument({ 'a b': 1 }, "']").total).toBe(0);
  });

  it('普通词查询完全不碰路径（`data` 只由键/值命中）', () => {
    const result = searchDocument(PATH_DOC, 'data');
    expect(result.hits.map((h) => [h.path, h.field])).toEqual([
      ['$.data', 'key'],
      ['$.meta.data', 'key'],
    ]);
  });
});

describe('searchDocument — 路径后缀匹配例表（ADR-0023 §2）', () => {
  it('$.data → 只命中该节点（不命中子树）', () => {
    const result = searchDocument(PATH_DOC, '$.data');
    expect(result.hits.map((h) => [h.path, h.field, h.kind])).toEqual([['$.data', 'path', 'object']]);
  });

  it('hotel_list[3] → 命中该数组元素节点', () => {
    expect(searchDocument(PATH_DOC, 'hotel_list[3]').hits.map((h) => [h.path, h.field])).toEqual([
      ['$.data.hotel_list[3]', 'path'],
    ]);
  });

  it('[3] → 命中所有以 [3] 结尾的节点', () => {
    expect(searchDocument(PATH_DOC, '[3]').hits.map((h) => h.path)).toEqual([
      '$.data.hotel_list[3]',
      '$.data.other_list[3]',
    ]);
  });

  it('$ → 只命中根', () => {
    const result = searchDocument(PATH_DOC, '$');
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toMatchObject({ path: '$', key: 'root', field: 'path', kind: 'object' });
  });

  it('data. / . / 前缀 → 0 条（不做中段/子树匹配）', () => {
    expect(searchDocument(PATH_DOC, 'data.').total).toBe(0);
    expect(searchDocument(PATH_DOC, '.').total).toBe(0);
    expect(searchDocument(PATH_DOC, '$.da').total).toBe(0); // 路径前缀不命中
  });

  it('路径后缀大小写按 Aa', () => {
    expect(searchDocument({ Hotel: 1 }, '$.hotel').hits.map((h) => [h.path, h.field])).toEqual([
      ['$.Hotel', 'path'],
    ]);
    expect(searchDocument({ Hotel: 1 }, '$.hotel', { caseSensitive: true }).total).toBe(0);
  });

  it('正则模式：对整条路径 test()（用户可自行 $ 锚定）', () => {
    // 后缀正则：$.data / $.meta.data
    expect(searchDocument(PATH_DOC, '\\.data$', { regex: true }).hits.map((h) => h.path)).toEqual([
      '$.data',
      '$.meta.data',
    ]);
    // 用户自行锚定：只命中数组下标 3 的 hotel_list 元素
    expect(searchDocument(PATH_DOC, 'hotel_list\\[3\\]$', { regex: true }).hits.map((h) => h.path)).toEqual([
      '$.data.hotel_list[3]',
    ]);
    // 整条路径完全匹配
    expect(searchDocument(PATH_DOC, '^\\$\\.data$', { regex: true }).hits.map((h) => h.path)).toEqual([
      '$.data',
    ]);
  });
});

describe('searchDocument — 一节点一条 + key > value > path（ADR-0023 §3）', () => {
  it('key > path：键名与路径后缀同时命中只记 key', () => {
    const result = searchDocument({ $foo: 1 }, '$foo');
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toMatchObject({ path: '$.$foo', key: '$foo', field: 'key' });
  });

  it('value > path：值等于路径后缀只记 value', () => {
    const result = searchDocument({ data: '$.data' }, '$.data');
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toMatchObject({ path: '$.data', key: 'data', field: 'value', kind: 'string' });
  });

  it('keysOnly 不收 path', () => {
    expect(searchDocument(PATH_DOC, '$.data', { keysOnly: true }).total).toBe(0);
    expect(searchDocument(PATH_DOC, 'hotel_list[0]', { keysOnly: true }).total).toBe(0);
  });
});

describe('searchDocument — 路径命中的 limit / 截断（ADR-0023 §5）', () => {
  const doc = { a: [1], b: [1], c: [1] };

  it('路径命中同样受 limit 约束并置 truncated', () => {
    const result = searchDocument(doc, '[0]', { limit: 2 });
    expect(result.hits.map((h) => h.path)).toEqual(['$.a[0]', '$.b[0]']);
    expect(result.total).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it('未截断时 total = 路径命中数，field 全为 path', () => {
    const result = searchDocument(doc, '[0]');
    expect(result.total).toBe(3);
    expect(result.hits.every((h) => h.field === 'path')).toBe(true);
    expect(result.truncated).toBe(false);
  });
});
