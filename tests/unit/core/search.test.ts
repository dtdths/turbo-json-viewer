import { describe, expect, it } from 'vitest';
import { CoreError } from '../../../src/protocol/errors';
import { searchDocument } from '../../../src/core/search';

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

  it('数字/布尔/null 不参与值匹配（只匹配字符串值）', () => {
    const result = searchDocument({ n: 123, b: true, z: null }, '123');
    expect(result.total).toBe(0);
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
