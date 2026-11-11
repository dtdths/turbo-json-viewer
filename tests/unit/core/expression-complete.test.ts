import { describe, expect, it } from 'vitest';
import { getCompletions } from '../../../src/core/expression/complete';
import type { CompletionContext } from '../../../src/core/expression/types';
import {
  ARRAY_METHODS,
  GLOBAL_NAMES,
  MATH_MEMBERS,
  STRING_METHODS,
} from '../../../src/core/expression/whitelist';
import type { ExprCompletion, JsonKind } from '../../../src/protocol/types';

/* --------------------------------- 测试夹具 --------------------------------- */

const ROOT_KINDS: Record<string, JsonKind> = {
  data: 'object',
  items: 'array',
  num: 'number',
  flag: 'boolean',
  str: 'string',
};

const CTX: CompletionContext = {
  rootKeys: ['data', 'items', 'num', 'flag', 'str', 'a b'],
  rootKinds: ROOT_KINDS,
};

function labels(items: ExprCompletion[]): string[] {
  return items.map((item) => item.label);
}

function find(items: ExprCompletion[], label: string): ExprCompletion | undefined {
  return items.find((item) => item.label === label);
}

describe('core/expression/complete — 白名单单一来源口径', () => {
  it('数组 15 / 字符串 12 方法 + Math 11 + 全局 7（含 length 属性另列）', () => {
    expect(ARRAY_METHODS).toHaveLength(15);
    expect(STRING_METHODS).toHaveLength(12);
    expect(MATH_MEMBERS).toHaveLength(11);
    expect(GLOBAL_NAMES).toHaveLength(7);
    expect(ARRAY_METHODS).not.toContain('length');
    expect(STRING_METHODS).not.toContain('length');
    expect(ARRAY_METHODS).not.toContain('forEach');
    expect(ARRAY_METHODS).not.toContain('push');
    expect(STRING_METHODS).not.toContain('match');
  });
});

/* -------------------------------- 根级补全 -------------------------------- */

describe('core/expression/complete — 根级 / 全局', () => {
  it('空文本 → 根字段在前、全局在后', () => {
    const items = getCompletions('', 0, CTX);
    expect(labels(items).slice(0, 6)).toEqual(['data', 'items', 'num', 'flag', 'str', 'a b']);
    const globals = labels(items).slice(6);
    expect(globals).toEqual([...GLOBAL_NAMES]);
  });

  it('根字段 kind=field + detail「根字段 · <kind>」；未知类型回退「根字段」', () => {
    const items = getCompletions('', 0, CTX);
    expect(find(items, 'data')).toMatchObject({ kind: 'field', detail: '根字段 · object' });
    expect(find(items, 'items')).toMatchObject({ kind: 'field', detail: '根字段 · array' });
    expect(find(items, 'num')).toMatchObject({ kind: 'field', detail: '根字段 · number' });
    expect(find(items, 'a b')).toMatchObject({ kind: 'field', detail: '根字段' });
  });

  it('全局名 kind=global + detail「全局」（含 undefined）', () => {
    const items = getCompletions('', 0, CTX);
    for (const name of GLOBAL_NAMES) {
      expect(find(items, name)).toMatchObject({ kind: 'global', detail: '全局' });
    }
    expect(find(items, 'undefined')).toBeDefined();
  });

  it('标识符前缀：不做过滤（CM6 filter），候选与空文本一致', () => {
    const items = getCompletions('it', 2, CTX);
    expect(labels(items)).toEqual(labels(getCompletions('', 0, CTX)));
    expect(find(items, 'items')).toBeDefined();
  });

  it('前缀完全相同优先（稳定排序）', () => {
    expect(labels(getCompletions('items', 5, CTX))[0]).toBe('items');
    expect(labels(getCompletions('num', 3, CTX))[0]).toBe('num');
  });

  it('pos 越界夹取（>len / 负数）', () => {
    expect(labels(getCompletions('Math.', 999, CTX))).toEqual(MATH_MEMBERS);
    expect(labels(getCompletions('Math.', -3, CTX))).toEqual(labels(getCompletions('', 0, CTX)));
  });

  it('无根键（标量根）→ 只有全局名', () => {
    const items = getCompletions('', 0, { rootKeys: [] });
    expect(labels(items)).toEqual([...GLOBAL_NAMES]);
  });

  it('根字段与全局重名时去重（根字段在前）', () => {
    const items = getCompletions('', 0, { rootKeys: ['Math', 'x'], rootKinds: { Math: 'object' } });
    expect(labels(items)[0]).toBe('Math');
    expect(find(items, 'Math')).toMatchObject({ kind: 'field', detail: '根字段 · object' });
    expect(labels(items).filter((label) => label === 'Math')).toHaveLength(1);
    expect(labels(items)).toContain('Array');
    expect(labels(items)).toContain('x');
  });

  it('非补全上下文（括号 / 空白）→ 根字段 + 全局', () => {
    expect(labels(getCompletions('(', 1, CTX))).toEqual(labels(getCompletions('', 0, CTX)));
    expect(labels(getCompletions('   ', 3, CTX))).toEqual(labels(getCompletions('', 0, CTX)));
  });
});

/* ------------------------------- 成员补全 ------------------------------- */

describe('core/expression/complete — 成员访问（X. / X?.）', () => {
  it('Math. → MATH_MEMBERS（顺序 = 白名单顺序）', () => {
    const items = getCompletions('Math.', 5, CTX);
    expect(labels(items)).toEqual([...MATH_MEMBERS]);
    expect(items.every((item) => item.detail === 'Math 方法')).toBe(true);
  });

  it('Math. 带前缀：不过滤；前缀完全相同优先', () => {
    const items = getCompletions('Math.max', 8, CTX);
    expect(new Set(labels(items))).toEqual(new Set(MATH_MEMBERS));
    expect(labels(items)).toHaveLength(MATH_MEMBERS.length);
    expect(labels(items)[0]).toBe('max');
  });

  it('Array. → isArray', () => {
    const items = getCompletions('Array.', 6, CTX);
    expect(labels(items)).toEqual(['isArray']);
    expect(items[0]).toMatchObject({ kind: 'method', detail: 'array 方法' });
  });

  it('JSON. → parse / stringify', () => {
    expect(labels(getCompletions('JSON.', 5, CTX))).toEqual(['parse', 'stringify']);
  });

  it('Number / String / Boolean. → 无成员', () => {
    expect(getCompletions('Number.', 7, CTX)).toEqual([]);
    expect(getCompletions('String.', 7, CTX)).toEqual([]);
    expect(getCompletions('Boolean.', 8, CTX)).toEqual([]);
  });

  it('其它接收者 → ARRAY_METHODS ∪ STRING_METHODS ∪ length（dedupe）', () => {
    const items = getCompletions('a.', 2, CTX);
    const expected = [...ARRAY_METHODS, ...STRING_METHODS.filter((name) => !ARRAY_METHODS.includes(name)), 'length'];
    expect(labels(items)).toEqual(expected);
    expect(new Set(labels(items)).size).toBe(labels(items).length);
    expect(find(items, 'map')).toMatchObject({ kind: 'method', detail: 'array 方法' });
    expect(find(items, 'trim')).toMatchObject({ kind: 'method', detail: 'string 方法' });
    expect(find(items, 'includes')).toMatchObject({ kind: 'method', detail: 'array 方法' });
    expect(find(items, 'length')).toMatchObject({ kind: 'field', detail: '属性' });
  });

  it('可选链 a?. 与 a. 同类（其它接收者）', () => {
    expect(labels(getCompletions('a?.', 3, CTX))).toEqual(labels(getCompletions('a.', 2, CTX)));
  });

  it('$. / $?. → 根字段 + 全局（不是方法并集）', () => {
    const root = labels(getCompletions('', 0, CTX));
    expect(labels(getCompletions('$.', 2, CTX))).toEqual(root);
    expect(labels(getCompletions('$?.', 3, CTX))).toEqual(root);
    // 更深一层才是方法并集
    expect(labels(getCompletions('$.items.', 8, CTX))).toEqual(labels(getCompletions('a.', 2, CTX)));
  });

  it('items.map：前缀不过滤，exact 优先', () => {
    const items = getCompletions('items.map', 9, CTX);
    expect(labels(items)).toEqual(labels(getCompletions('a.', 2, CTX)));
    expect(labels(items)[0]).toBe('map');
  });

  it('未知接收者名（foo.）→ 方法并集', () => {
    expect(labels(getCompletions('foo.', 4, CTX))).toEqual(labels(getCompletions('a.', 2, CTX)));
  });
});
