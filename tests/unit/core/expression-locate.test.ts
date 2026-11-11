import { describe, expect, it } from 'vitest';
import { evaluateExpression } from '../../../src/core/expression/engine';
import { locateOriginalPath } from '../../../src/core/expression/locate';
import type { EvalBudget, EvalOk, EvalOrigins, EvaluateOptions } from '../../../src/core/expression/types';

/* --------------------------------- 测试夹具 --------------------------------- */

function makeDoc() {
  return {
    data: {
      hotel_list: [
        { tag_name: 'x', price: 120 },
        { tag_name: 'y', price: 80 },
      ],
      name: 'hotel data',
    },
    items: [
      { id: 1, name: 'a', meta: { ok: true } },
      { id: 2, name: 'b', meta: { ok: false } },
      { id: 3, name: 'c', meta: { ok: true } },
    ],
    'a b': { deep: 42 },
  };
}

const DOC = makeDoc();
type Doc = ReturnType<typeof makeDoc>;

function makeBudget(over: Partial<EvalBudget> = {}): EvalBudget {
  return { level: 'standard', maxTimeMs: 500, maxSteps: 5_000_000, maxResult: 200_000, ...over };
}

function evaluate(text: string, doc: unknown = DOC, budgetOver: Partial<EvalBudget> = {}): EvalOk {
  const options: EvaluateOptions = { strict: false, budget: makeBudget(budgetOver), now: () => 0 };
  const outcome = evaluateExpression(text, doc, options);
  if (!outcome.ok) throw new Error(`expected ok, got ${JSON.stringify(outcome.error)} for: ${text}`);
  return outcome;
}

/** 手工构造 origins（locate 纯函数的白盒用例）。 */
function makeOrigins(
  top: EvalOrigins['top'],
  entries: [object, string][],
): EvalOrigins {
  const objects = new WeakMap<object, string>();
  for (const [key, value] of entries) objects.set(key, value);
  return { top, objects };
}

/* ---------------------------- 从真实求值到 locate ---------------------------- */

describe('core/expression/locate — 真实求值结果 → 原文档路径', () => {
  it('filter 结果：原对象引用 + 顶层/嵌套都跳回原文档', () => {
    const outcome = evaluate('$.items.filter(x => x.meta.ok)');
    const result = outcome.value as Doc['items'];
    expect(result[0]).toBe(DOC.items[0]);
    expect(result[1]).toBe(DOC.items[2]);
    expect(outcome.origins.objects.get(DOC.items[0] as object)).toBe('$.items[0]');
    expect(outcome.origins.objects.get(DOC.items[2] as object)).toBe('$.items[2]');
    expect(outcome.origins.top).toEqual(['$.items[0]', '$.items[2]']);

    expect(locateOriginalPath(outcome.value, outcome.origins, '$[0]')).toBe('$.items[0]');
    expect(locateOriginalPath(outcome.value, outcome.origins, '$[1]')).toBe('$.items[2]');
    expect(locateOriginalPath(outcome.value, outcome.origins, '$[1].name')).toBe('$.items[2].name');
    expect(locateOriginalPath(outcome.value, outcome.origins, '$[1].meta.ok')).toBe('$.items[2].meta.ok');
  });

  it('map(x => x.name)：标量元素靠 origins.top 定位', () => {
    const outcome = evaluate('$.items.map(x => x.name)');
    expect(outcome.value).toEqual(['a', 'b', 'c']);
    expect(outcome.origins.top).toEqual(['$.items[0].name', '$.items[1].name', '$.items[2].name']);

    expect(locateOriginalPath(outcome.value, outcome.origins, '$[0]')).toBe('$.items[0].name');
    expect(locateOriginalPath(outcome.value, outcome.origins, '$[2]')).toBe('$.items[2].name');
    // 越界 / 不存在的路径 → null
    expect(locateOriginalPath(outcome.value, outcome.origins, '$[9]')).toBe(null);
    expect(locateOriginalPath(outcome.value, outcome.origins, '$[0].x')).toBe(null);
  });

  it('map(x => ({n: x.name}))：计算对象无来源 → null', () => {
    const outcome = evaluate('$.items.map(x => ({n: x.name}))');
    expect(outcome.value).toEqual([{ n: 'a' }, { n: 'b' }, { n: 'c' }]);
    expect(outcome.origins.top).toEqual([null, null, null]);
    expect(locateOriginalPath(outcome.value, outcome.origins, '$[1]')).toBe(null);
    expect(locateOriginalPath(outcome.value, outcome.origins, '$[1].n')).toBe(null);
  });

  it('map(x => x)：元素原样引用（identity 不变）+ 嵌套定位', () => {
    const outcome = evaluate('$.items.map(x => x)');
    const result = outcome.value as Doc['items'];
    expect(result[2]).toBe(DOC.items[2]);
    expect(locateOriginalPath(outcome.value, outcome.origins, '$[2].meta.ok')).toBe('$.items[2].meta.ok');
    expect(locateOriginalPath(outcome.value, outcome.origins, '$[2]')).toBe('$.items[2]');
  });

  it('slice：元素路径按下标平移', () => {
    const outcome = evaluate('$.items.slice(1, 3)');
    expect(locateOriginalPath(outcome.value, outcome.origins, '$[0].name')).toBe('$.items[1].name');
    expect(locateOriginalPath(outcome.value, outcome.origins, '$[1].id')).toBe('$.items[2].id');
  });

  it('$ 整个根：根容器登记为 $，任意路径精确还原', () => {
    const outcome = evaluate('$');
    expect(outcome.value).toBe(DOC);
    expect(outcome.origins.objects.get(DOC)).toBe('$');
    expect(locateOriginalPath(outcome.value, outcome.origins, '$')).toBe('$');
    expect(locateOriginalPath(outcome.value, outcome.origins, '$.items[0].name')).toBe('$.items[0].name');
    expect(locateOriginalPath(outcome.value, outcome.origins, "$['a b'].deep")).toBe("$['a b'].deep");
    expect(locateOriginalPath(outcome.value, outcome.origins, '$.data.hotel_list[1].price')).toBe(
      '$.data.hotel_list[1].price',
    );
  });

  it('$.data 结果根：根容器来源是 $.data', () => {
    const outcome = evaluate('$.data');
    expect(outcome.value).toBe(DOC.data);
    expect(locateOriginalPath(outcome.value, outcome.origins, '$')).toBe('$.data');
    expect(locateOriginalPath(outcome.value, outcome.origins, '$.name')).toBe('$.data.name');
    expect(locateOriginalPath(outcome.value, outcome.origins, '$.hotel_list[1].tag_name')).toBe(
      '$.data.hotel_list[1].tag_name',
    );
  });

  it('计算对象里引用文档数组：最深已知容器 + 相对后缀', () => {
    const outcome = evaluate('({a: $.items})');
    expect(locateOriginalPath(outcome.value, outcome.origins, "$['a']")).toBe('$.items');
    expect(locateOriginalPath(outcome.value, outcome.origins, "$['a'][0].name")).toBe('$.items[0].name');
    expect(locateOriginalPath(outcome.value, outcome.origins, "$['a'][2].meta.ok")).toBe('$.items[2].meta.ok');
  });

  it('计算标量：origins.top 为空 → 全部 null', () => {
    const outcome = evaluate('1 + 2');
    expect(outcome.origins.top).toEqual([]);
    expect(locateOriginalPath(outcome.value, outcome.origins, '$')).toBe(null);
    expect(locateOriginalPath(outcome.value, outcome.origins, '$.x')).toBe(null);
  });

  it('不存在的键 / 非法路径 → null', () => {
    const outcome = evaluate('$');
    expect(locateOriginalPath(outcome.value, outcome.origins, '$.nope')).toBe(null);
    expect(locateOriginalPath(outcome.value, outcome.origins, '$.items[9]')).toBe(null);
    expect(locateOriginalPath(outcome.value, outcome.origins, 'items[0]')).toBe(null);
    expect(locateOriginalPath(outcome.value, outcome.origins, '')).toBe(null);
  });
});

describe('core/expression/locate — 截断结果仍可跳回原文档', () => {
  it('数组结果被 maxResult 截断：top 逐项补来源', () => {
    const doc = { big: Array.from({ length: 60000 }, (_, i) => i) };
    const outcome = evaluate('$.big', doc, { maxResult: 50000 });
    expect(outcome.count).toBe(50000);
    expect(outcome.truncated).toBe(true);
    expect(locateOriginalPath(outcome.value, outcome.origins, '$[0]')).toBe('$.big[0]');
    expect(locateOriginalPath(outcome.value, outcome.origins, '$[49999]')).toBe('$.big[49999]');
    expect(locateOriginalPath(outcome.value, outcome.origins, '$[50000]')).toBe(null);
  });

  it('对象结果被 maxResult 截断：top 逐键补来源（原键序）', () => {
    const doc = { obj: { a: { v: 1 }, b: 2, c: 3 } };
    const outcome = evaluate('$.obj', doc, { maxResult: 2 });
    expect(outcome.value).toEqual({ a: { v: 1 }, b: 2 });
    expect(outcome.truncated).toBe(true);
    expect(locateOriginalPath(outcome.value, outcome.origins, '$.a')).toBe('$.obj.a');
    expect(locateOriginalPath(outcome.value, outcome.origins, '$.a.v')).toBe('$.obj.a.v');
    expect(locateOriginalPath(outcome.value, outcome.origins, '$.b')).toBe('$.obj.b');
  });
});

/* ------------------------------- 白盒 locate ------------------------------- */

describe('core/expression/locate — 纯函数白盒', () => {
  it('手工 origins：对象来源 + 剩余后缀', () => {
    const element = { x: 1, nested: { y: 2 } };
    const origins = makeOrigins(['$.a'], [[element, '$.a']]);
    const result = [element];
    expect(locateOriginalPath(result, origins, '$[0]')).toBe('$.a');
    expect(locateOriginalPath(result, origins, '$[0].x')).toBe('$.a.x');
    expect(locateOriginalPath(result, origins, '$[0].nested.y')).toBe('$.a.nested.y');
    expect(locateOriginalPath(result, origins, '$[1]')).toBe(null);
  });

  it('手工 origins：顶层标量来源', () => {
    const origins = makeOrigins(['$.n'], []);
    expect(locateOriginalPath(['v'], origins, '$[0]')).toBe('$.n');
    expect(locateOriginalPath([1], origins, '$[0]')).toBe('$.n');
  });

  it('手工 origins：对象 top 记录', () => {
    const docChild = { b: 1 };
    const origins = makeOrigins({ a: '$.data.a', computed: null }, [[docChild, '$.data.a']]);
    const result = { a: docChild, computed: { b: 2 } };
    expect(locateOriginalPath(result, origins, '$')).toBe(null);
    expect(locateOriginalPath(result, origins, '$.a')).toBe('$.data.a');
    expect(locateOriginalPath(result, origins, '$.a.b')).toBe('$.data.a.b');
    expect(locateOriginalPath(result, origins, '$.computed')).toBe(null);
    expect(locateOriginalPath(result, origins, '$.computed.b')).toBe(null);
  });

  it('最深候选优先：嵌套容器来源覆盖父容器来源', () => {
    const deep = { id: 1 };
    const container = { deep };
    const origins = makeOrigins([], [
      [container, '$.list'],
      [deep, '$.list[0]'],
    ]);
    expect(locateOriginalPath(container, origins, '$.deep.id')).toBe('$.list[0].id');
  });

  it('数组/对象父路径来源缺失 → null', () => {
    const origins = makeOrigins([], []);
    expect(locateOriginalPath({ a: 1 }, origins, '$.a')).toBe(null);
    expect(locateOriginalPath([1, 2], origins, '$[0]')).toBe(null);
  });
});
