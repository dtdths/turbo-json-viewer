import { describe, expect, it } from 'vitest';
import { getCompletions } from '../../../src/core/expression/complete';
import type { CompletionContext } from '../../../src/core/expression/types';
import {
  ARRAY_METHODS,
  GLOBAL_NAMES,
  MATH_MEMBERS,
  STRING_METHODS,
} from '../../../src/core/expression/whitelist';
import type { ExprCompletion, JsonKind, PathSample } from '../../../src/protocol/types';

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

/* --------------------- 类型感知补全（#43 / ADR-0025 §6） --------------------- */

/** 缓存 profile 的路径样本（根 + 各层容器；members 已按 freq 降序、同频首次出现序）。 */
const PROFILE_PATHS: PathSample[] = [
  {
    segments: [],
    kind: 'object',
    samples: 1,
    members: [
      { name: 'data', freq: 1, kind: 'object' },
      { name: 'items', freq: 1, kind: 'array' },
      { name: 'tags', freq: 1, kind: 'array' },
      { name: 'num', freq: 1, kind: 'number' },
    ],
  },
  {
    segments: ['data'],
    kind: 'object',
    samples: 1,
    members: [
      { name: 'items', freq: 1, kind: 'array' },
      { name: 'flag', freq: 1, kind: 'boolean' },
    ],
  },
  {
    segments: ['data', 'items'],
    kind: 'array',
    samples: 2,
    members: [
      { name: 'name', freq: 2, kind: 'string' },
      { name: 'price', freq: 1, kind: 'number' },
    ],
  },
  {
    segments: ['items'],
    kind: 'array',
    samples: 2,
    members: [
      { name: 'name', freq: 2, kind: 'string' },
      { name: 'price', freq: 1, kind: 'number' },
    ],
  },
  {
    segments: ['tags'],
    kind: 'array',
    samples: 3,
    members: [
      { name: 'mixedField', freq: 2, kind: 'mixed' },
      { name: 'label', freq: 1, kind: 'string' },
    ],
  },
  {
    // 标量数组：命中路径但 members 为空（元素不是对象）→ 补全应退化回方法并集
    segments: ['nums'],
    kind: 'array',
    samples: 3,
    members: [],
  },
  {
    segments: ['a', 'b'],
    kind: 'object',
    samples: 1,
    members: [{ name: 'c', freq: 1, kind: 'number' }],
  },
];

const PROFILE_CTX: CompletionContext = {
  rootKeys: ['data', 'items', 'tags', 'num'],
  rootKinds: { data: 'object', items: 'array', tags: 'array', num: 'number' },
  paths: PROFILE_PATHS,
};

/** 根为数组的 profile：`$.` 给元素字段样本（ADR-0025 §6）。 */
const ARRAY_ROOT_CTX: CompletionContext = {
  rootKeys: [],
  paths: [
    {
      segments: [],
      kind: 'array',
      samples: 3,
      members: [
        { name: 'name', freq: 3, kind: 'string' },
        { name: 'price', freq: 2, kind: 'number' },
      ],
    },
  ],
};

const FALLBACK_LABELS = [
  ...ARRAY_METHODS,
  ...STRING_METHODS.filter((name) => !ARRAY_METHODS.includes(name)),
  'length',
];

describe('core/expression/complete — 类型感知补全（链解析 / detail / 退化）', () => {
  it('单段键链 `items.` 命中 paths → 元素字段 + 方法并集（detail = `<kind> · 采样 <freq>/<samples>`）', () => {
    const items = getCompletions('items.', 6, PROFILE_CTX);
    expect(labels(items)).toEqual(['name', 'price', ...FALLBACK_LABELS]);
    expect(items[0]).toMatchObject({ kind: 'field', detail: 'string · 采样 2/2' });
    expect(items[1]).toMatchObject({ kind: 'field', detail: 'number · 采样 1/2' });
    // 数组路径命中后仍保留方法并集（ADR-0025 §6：既有能力不回归）
    expect(labels(items)).toContain('map');
  });

  it('任意深纯键链：`$.data.items.` / `$?.data?.items?.` / `data.items.` 等价', () => {
    const expected = labels(getCompletions('$.data.items.', 14, PROFILE_CTX));
    expect(expected).toEqual(['name', 'price', ...FALLBACK_LABELS]);
    expect(labels(getCompletions('$?.data?.items?.', 17, PROFILE_CTX))).toEqual(expected);
    expect(labels(getCompletions('data.items.', 11, PROFILE_CTX))).toEqual(expected);
    expect(labels(getCompletions('$.items.', 8, PROFILE_CTX))).toEqual(expected);
  });

  it('深链 `$.a.b.` → 该路径的 members', () => {
    expect(labels(getCompletions('$.a.b.', 7, PROFILE_CTX))).toEqual(['c']);
    expect(find(getCompletions('$.a.b.', 7, PROFILE_CTX), 'c')).toMatchObject({
      kind: 'field',
      detail: 'number · 采样 1/1',
    });
  });

  it('mixed → detail 用「混合」', () => {
    const tags = getCompletions('tags.', 5, PROFILE_CTX);
    expect(tags[0]).toMatchObject({ label: 'mixedField', kind: 'field', detail: '混合 · 采样 2/3' });
    expect(tags[1]).toMatchObject({ label: 'label', detail: 'string · 采样 1/3' });
  });

  it('未命中（`nope.` / `missing.deep.`）→ 退化方法并集', () => {
    expect(labels(getCompletions('nope.', 5, PROFILE_CTX))).toEqual(FALLBACK_LABELS);
    expect(labels(getCompletions('missing.deep.', 13, PROFILE_CTX))).toEqual(FALLBACK_LABELS);
  });

  it('命中的数组路径 members 为空（标量数组）→ 仍给方法并集，不返回空候选', () => {
    expect(labels(getCompletions('nums.', 5, PROFILE_CTX))).toEqual(FALLBACK_LABELS);
  });

  it('不支持下标 / 调用 / 运算：沿用旧行为（`items[0].` → 根字段 + 全局）', () => {
    const roots = labels(getCompletions('', 0, PROFILE_CTX));
    expect(labels(getCompletions('items[0].', 9, PROFILE_CTX))).toEqual(roots);
    expect(labels(getCompletions('$[0].', 5, PROFILE_CTX))).toEqual(roots);
  });

  it('根字段 detail 保持「根字段 · <kind>」（main.ts 动态示例依赖）', () => {
    const items = getCompletions('', 0, PROFILE_CTX);
    expect(find(items, 'data')).toMatchObject({ kind: 'field', detail: '根字段 · object' });
    expect(find(items, 'items')).toMatchObject({ kind: 'field', detail: '根字段 · array' });
    expect(find(items, 'num')).toMatchObject({ kind: 'field', detail: '根字段 · number' });
  });

  it('根为数组：`$.` 给元素字段样本（采样 detail）+ 数组方法并集 + 全局名', () => {
    const items = getCompletions('$.', 2, ARRAY_ROOT_CTX);
    expect(labels(items)).toEqual(['name', 'price', ...FALLBACK_LABELS, ...GLOBAL_NAMES]);
    expect(items[0]).toMatchObject({ kind: 'field', detail: 'string · 采样 3/3' });
    expect(items[1]).toMatchObject({ kind: 'field', detail: 'number · 采样 2/3' });
    expect(find(getCompletions('', 0, ARRAY_ROOT_CTX), 'name')).toMatchObject({
      detail: 'string · 采样 3/3',
    });
  });

  it('标量根数组（members 为空）：`$.` 仍给数组方法并集 + length，不退化到只有全局名', () => {
    const scalarRoot: CompletionContext = {
      rootKeys: [],
      paths: [{ segments: [], kind: 'array', samples: 3, members: [] }],
    };
    const items = getCompletions('$.', 2, scalarRoot);
    expect(labels(items)).toEqual([...FALLBACK_LABELS, ...GLOBAL_NAMES]);
    expect(labels(items)).toContain('map');
    expect(labels(items)).toContain('length');
  });

  it('内建接收者优先于 paths（Math. 仍是 MATH_MEMBERS）', () => {
    expect(labels(getCompletions('Math.', 5, PROFILE_CTX))).toEqual([...MATH_MEMBERS]);
  });

  it('命中路径时前缀完全相同优先（CM6 自己过滤）', () => {
    // tags 的成员序为 mixedField → label；前缀 label 与后者完全相同 → 提到最前
    const tags = getCompletions('tags.label', 10, PROFILE_CTX);
    expect(labels(tags).slice(0, 2)).toEqual(['label', 'mixedField']);
  });

  it('profile 未就绪（ctx 无 paths）→ `items.` 退化方法并集（非回归）', () => {
    expect(labels(getCompletions('items.', 6, CTX))).toEqual(FALLBACK_LABELS);
  });
});

describe('core/expression/complete — 回调参数绑定（ADR-0025 修订 2026-11-13）', () => {
  const at = (text: string) => getCompletions(text, text.length, PROFILE_CTX);

  it('items.map(item => item. → 元素字段（作用域级，不只紧跟 =>）', () => {
    const items = at('items.map(item => item.');
    expect(labels(items)).toEqual(['name', 'price']);
    expect(items[0]).toMatchObject({ kind: 'field', detail: 'string · 采样 2/2' });
    expect(labels(items)).not.toContain('map');
  });

  it('对象字面量体：items.map(item => ({ a: item. → 元素字段', () => {
    expect(labels(at('items.map(item => ({ a: item.'))).toEqual(['name', 'price']);
    expect(labels(at('items.map(item => ({ a: 1, b: item.'))).toEqual(['name', 'price']);
  });

  it('多行 body（=> 后换行）+ 其他单参数回调（filter/find/some/forEach）同样绑定', () => {
    expect(labels(at('items.map(item =>\n  item.'))).toEqual(['name', 'price']);
    expect(labels(at('items.filter(x => x.'))).toEqual(['name', 'price']);
    expect(labels(at('items.find(x => x.'))).toEqual(['name', 'price']);
    expect(labels(at('items.some(x => x.'))).toEqual(['name', 'price']);
    expect(labels(at('items.forEach(x => x.'))).toEqual(['name', 'price']);
  });

  it('任意深路径链 + ?. 变体：$.data.items.map(x => x. / x?..', () => {
    expect(labels(at('$.data.items.map(x => x.'))).toEqual(['name', 'price']);
    expect(labels(at('$?.data?.items?.map(x => x.'))).toEqual(['name', 'price']);
    expect(labels(at('items.map(x => x?.'))).toEqual(['name', 'price']);
  });

  it('嵌套回调链不解析（单层边界）→ 退化方法并集', () => {
    expect(labels(at('items.map(item => item.name.map(t => t.'))).toEqual(FALLBACK_LABELS);
  });

  it('多参数回调（reduce / sort）不绑定 → 方法并集', () => {
    expect(labels(at('items.reduce((a, b) => b.'))).toEqual(FALLBACK_LABELS);
    expect(labels(at('items.sort((a, b) => a.'))).toEqual(FALLBACK_LABELS);
  });

  it('未绑定标识符仍走原行为（不回归）：z. → 方法并集；根前缀 → 根字段', () => {
    expect(labels(at('z.'))).toEqual(FALLBACK_LABELS);
    expect(labels(at('da'))).toEqual(labels(at('')));
  });
});
