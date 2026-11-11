import { describe, expect, it } from 'vitest';
import { countDocumentNodes, evaluateExpression } from '../../../src/core/expression/engine';
import type { EvalBudget, EvalOutcome, EvaluateOptions } from '../../../src/core/expression/types';
import type { ExprError } from '../../../src/protocol/types';

/* --------------------------------- 测试夹具 --------------------------------- */

/** 异构 fake 文档：对象 / 数组 / 嵌套 / 字符串 / 数字 / 非标识符键 / null / 空容器。 */
function makeDoc() {
  return {
    data: {
      hotel_list: [
        { tag_name: 'x', price: 120 },
        { tag_name: 'y', price: 80 },
        { tag_name: 'z', price: 200 },
      ],
      name: 'hotel data',
      count: 3,
    },
    items: [
      { id: 1, name: 'a', tags: ['t1', 't2'], meta: { ok: true } },
      { id: 2, name: 'b', tags: [], meta: { ok: false } },
      { id: 3, name: 'c', tags: ['t3'], meta: { ok: true } },
    ],
    'a b': { deep: 42 },
    num: 3.5,
    int: 7,
    flag: true,
    nothing: null,
    empty: {},
    emptyArr: [],
    str: 'Hello World',
    padded: '  pad  ',
    nested: { arr: [{ x: 1 }, { x: 2 }] },
    nums: [10, 20, 30],
    dup: [1, 2, 1],
  };
}

const DOC = makeDoc();
type Doc = ReturnType<typeof makeDoc>;

function makeBudget(over: Partial<EvalBudget> = {}): EvalBudget {
  return { level: 'standard', maxTimeMs: 500, maxSteps: 5_000_000, maxResult: 200_000, ...over };
}

interface RunOptions {
  doc?: unknown;
  strict?: boolean;
  budget?: Partial<EvalBudget>;
  now?: () => number;
}

function run(text: string, options: RunOptions = {}): EvalOutcome {
  const evaluateOptions: EvaluateOptions = {
    strict: options.strict ?? false,
    budget: makeBudget(options.budget),
    now: options.now,
  };
  return evaluateExpression(text, options.doc === undefined ? DOC : options.doc, evaluateOptions);
}

function ok(text: string, options: RunOptions = {}) {
  const outcome = run(text, options);
  if (!outcome.ok) throw new Error(`expected ok, got ${JSON.stringify(outcome.error)} for: ${text}`);
  return outcome;
}

function valueOf(text: string, options: RunOptions = {}): unknown {
  return ok(text, options).value;
}

function errorOf(text: string, options: RunOptions = {}): ExprError {
  const outcome = run(text, options);
  expect(outcome.ok, `expected error for: ${text}`).toBe(false);
  return (outcome as { ok: false; error: ExprError }).error;
}

/* -------------------------------- 语义矩阵 -------------------------------- */

describe('core/expression — 字段读 / 下标 / 可选链', () => {
  it('根字段读：$.data.name', () => {
    expect(valueOf('$.data.name')).toBe('hotel data');
    expect(valueOf('$.int')).toBe(7);
  });

  it('裸顶层字段 ≡ $.字段；嵌套裸字段也可', () => {
    expect(valueOf('data.name')).toBe('hotel data');
    expect(valueOf('items.length')).toBe(3);
    expect(valueOf('data.hotel_list[1].price')).toBe(80);
  });

  it('非标识符键：$["a b"] 与括号下标', () => {
    expect(valueOf("$['a b'].deep")).toBe(42);
    expect(valueOf('$["a b"]["deep"]')).toBe(42);
  });

  it('数组下标 / 字符串下标 / length 属性', () => {
    expect(valueOf('$.nums[1]')).toBe(20);
    expect(valueOf("$.nums['2']")).toBe(30);
    expect(valueOf('$.items[2].tags[0]')).toBe('t3');
    expect(valueOf('$.str.length')).toBe(11);
    expect(valueOf("$.str[1]")).toBe('e');
  });

  it('可选链：?. / ?.[] / 短路后 ?? 兜底', () => {
    expect(valueOf('$.data?.name')).toBe('hotel data');
    expect(valueOf('$.nothing?.x')).toBe(null);
    expect(valueOf('$.items[9]?.id')).toBe(null);
    expect(valueOf("$.nothing?.x ?? 'fallback'")).toBe('fallback');
    expect(valueOf('$.nested?.arr?.[0]?.x')).toBe(1);
    expect(valueOf('$.data?.hotel_list[0]?.tag_name')).toBe('x');
  });

  it('数组越界读 = undefined（最终按 JSON 语义 → null）', () => {
    expect(run('$.nums[99]')).toMatchObject({ ok: true, value: null, kind: 'null', count: 0 });
  });
});

describe('core/expression — 字面量 / 模板串 / 运算符', () => {
  it('模板串插值（值转字符串）', () => {
    expect(valueOf('`count=${$.items.length}`')).toBe('count=3');
    expect(valueOf('`x=${$.int + 1}, y=${$.data.name}`')).toBe('x=8, y=hotel data');
    expect(valueOf('`n=${$.nothing}`')).toBe('n=null');
  });

  it('三元与一元运算', () => {
    expect(valueOf("$.int > 5 ? 'big' : 'small'")).toBe('big');
    expect(valueOf('-$.int')).toBe(-7);
    expect(valueOf('!$.flag')).toBe(false);
    expect(valueOf("+'42'")).toBe(42);
  });

  it('typeof：JSON 值域 + null', () => {
    expect(valueOf('typeof $.data')).toBe('object');
    expect(valueOf('typeof $.nothing')).toBe('object');
    expect(valueOf('typeof $.num')).toBe('number');
    expect(valueOf('typeof $.flag')).toBe('boolean');
    expect(valueOf('typeof $.data.name')).toBe('string');
    expect(valueOf('typeof undefined')).toBe('undefined');
  });

  it('算术 / 比较 / 逻辑 / ??', () => {
    expect(valueOf('$.int + 1')).toBe(8);
    expect(valueOf('$.int * 2 - 1')).toBe(13);
    expect(valueOf('10 % 3')).toBe(1);
    expect(valueOf("$.str + '!'")).toBe('Hello World!');
    expect(valueOf('$.int === 7')).toBe(true);
    expect(valueOf('$.int !== 7')).toBe(false);
    expect(valueOf('$.int >= 7')).toBe(true);
    expect(valueOf("$.flag && 'yes'")).toBe('yes');
    expect(valueOf("$.nothing || 'n'")).toBe('n');
    expect(valueOf("$.nothing ?? 'd'")).toBe('d');
    expect(valueOf('0 ?? 1')).toBe(0);
  });
});

describe('core/expression — 数组 / 对象字面量与展开', () => {
  it('数组字面量 + 展开符（按自身元素展开）', () => {
    expect(valueOf('[...$.nums]')).toEqual([10, 20, 30]);
    expect(valueOf('[1, ...$.nums, 2]')).toEqual([1, 10, 20, 30, 2]);
  });

  it('对象字面量 + 展开符（按 own 键展开）', () => {
    expect(valueOf('({n: $.int, ...$.nested})')).toEqual({ n: 7, arr: [{ x: 1 }, { x: 2 }] });
    expect(valueOf('({...$.nothing})')).toEqual({});
    expect(valueOf("({'a b': 1, m: 2})")).toEqual({ 'a b': 1, m: 2 });
  });

  it('对象简写属性与计算键', () => {
    expect(valueOf('(x => ({x, y: x + 1}))(5)')).toEqual({ x: 5, y: 6 });
    expect(valueOf("({['k' + 1]: 2})")).toEqual({ k1: 2 });
  });
});

describe('core/expression — 作用域优先级与安全边界', () => {
  it('全局白名单优先于文档根同名字段（Math 永远是 Math）', () => {
    const shadowDoc = { Math: { max: 999 }, Number: 'n', String: 's', Boolean: 'b', undefined: 'u' };
    expect(valueOf('Math.max(1, 2)', { doc: shadowDoc })).toBe(2);
    expect(valueOf("Number('3')", { doc: shadowDoc })).toBe(3);
    expect(valueOf("String(1)", { doc: shadowDoc })).toBe('1');
    expect(valueOf('Boolean(1)', { doc: shadowDoc })).toBe(true);
    expect(valueOf('Array.isArray([])', { doc: shadowDoc })).toBe(true);
    expect(valueOf("JSON.stringify(1)", { doc: shadowDoc })).toBe('1');
    expect(valueOf('undefined', { doc: shadowDoc })).toBe(null);
  });

  it('不跟随原型链：constructor / __proto__ / toString 只认 own property', () => {
    expect(errorOf('$.constructor')).toMatchObject({ code: 'EVAL_UNKNOWN_FIELD', params: ['constructor'] });
    expect(errorOf('$.data.constructor')).toMatchObject({
      code: 'EVAL_UNKNOWN_FIELD',
      params: ['constructor'],
    });
    expect(errorOf('$.data.__proto__')).toMatchObject({ code: 'EVAL_UNKNOWN_FIELD', params: ['__proto__'] });
    expect(errorOf('({}).constructor')).toMatchObject({ code: 'EVAL_UNKNOWN_FIELD', params: ['constructor'] });
    // 元素内部：非严格 → MISSING → map 丢弃 + skipped
    const outcome = ok('$.items.map(x => x.constructor)');
    expect(outcome.value).toEqual([]);
    expect(outcome.skipped).toBe(3);
  });

  it('根级静态链写在箭头函数体内也恒报错（Lead 口径修订）', () => {
    // 非严格也不是 skipped：基值来自文档根 → 根级静态链。
    expect(errorOf('$.items.map(x => $.zzz)', { strict: false })).toMatchObject({
      code: 'EVAL_UNKNOWN_FIELD',
      params: ['zzz'],
    });
    expect(errorOf('$.items.map(x => $.zzz)', { strict: true })).toMatchObject({
      code: 'EVAL_UNKNOWN_FIELD',
      params: ['zzz'],
    });
    // 从根起算的更深链（$.items[0].zzz）同样算根级静态链。
    expect(errorOf('$.items.map(x => $.items[0].zzz)')).toMatchObject({
      code: 'EVAL_UNKNOWN_FIELD',
      params: ['zzz'],
    });
  });

  it('基值来自元素 / 回调参数才走 strict/MISSING（非严格 skipped）', () => {
    const outcome = ok('$.items.map(x => x.nope)');
    expect(outcome.value).toEqual([]);
    expect(outcome.skipped).toBe(3);
    expect(errorOf('$.items.map(x => x.nope)', { strict: true })).toMatchObject({
      code: 'EVAL_UNKNOWN_FIELD',
      params: ['nope'],
    });
  });

  it('模板串里的 MISSING → 空串（不污染文案、不计 skipped）', () => {
    const outcome = ok('$.items.map(x => `v=${x.zzz}`)');
    expect(outcome.value).toEqual(['v=', 'v=', 'v=']);
    expect(outcome.skipped).toBe(0);
  });

  it('MISSING 作为方法实参继续传播（不会静默变成 NaN）', () => {
    const outcome = ok('$.items.map(x => Math.abs(x.zzz))');
    expect(outcome.value).toEqual([]);
    expect(outcome.skipped).toBe(3);
    expect(valueOf('$.items.filter(x => $.str.includes(x.zzz))')).toEqual([]);
  });

  it('箭头参数遮蔽根同名字段（词法作用域优先）', () => {
    expect(valueOf('$.items.map(items => items.id)')).toEqual([1, 2, 3]);
    expect(valueOf('(data => data.name)($.data)')).toBe('hotel data');
  });

  it('方法调用结果上的可选链', () => {
    expect(valueOf('$.items.find(x => x.id === 2)?.name')).toBe('b');
    expect(valueOf('$.items.find(x => x.id === 99)?.name')).toBe(null);
  });

  it('可选链上的方法调用：空值短路，不抛 EVAL_SHAPE_ERROR', () => {
    expect(valueOf('$.items?.map(x => x.id)')).toEqual([1, 2, 3]);
    expect(valueOf('$.nothing?.map(x => x)')).toBe(null);
  });
});

describe('core/expression — 箭头函数与数组方法', () => {
  it('箭头函数立即调用', () => {
    expect(valueOf('(x => x + 1)(41)')).toBe(42);
    expect(valueOf('((a, b) => a * b)(6, 7)')).toBe(42);
  });

  it('map（含 index 参数）', () => {
    expect(valueOf('$.items.map(x => x.name)')).toEqual(['a', 'b', 'c']);
    expect(valueOf('$.items.map((x, i) => i)')).toEqual([0, 1, 2]);
  });

  it('filter / find / findIndex', () => {
    expect(valueOf('$.items.filter(x => x.meta.ok).map(x => x.id)')).toEqual([1, 3]);
    expect(valueOf('$.items.find(x => x.id === 2).name')).toBe('b');
    expect(valueOf('$.items.findIndex(x => x.id === 2)')).toBe(1);
    expect(valueOf('$.items.find(x => x.id === 99)')).toBe(null);
    expect(valueOf('$.items.findIndex(x => x.id === 99)')).toBe(-1);
  });

  it('some / every', () => {
    expect(valueOf('$.items.some(x => x.id > 2)')).toBe(true);
    expect(valueOf('$.items.some(x => x.id > 9)')).toBe(false);
    expect(valueOf('$.items.every(x => x.id > 0)')).toBe(true);
    expect(valueOf('$.items.every(x => x.id > 1)')).toBe(false);
  });

  it('includes / indexOf / lastIndexOf', () => {
    expect(valueOf('$.nums.includes(20)')).toBe(true);
    expect(valueOf('$.nums.includes(99)')).toBe(false);
    expect(valueOf('$.nums.indexOf(30)')).toBe(2);
    expect(valueOf('$.dup.lastIndexOf(1)')).toBe(2);
  });

  it('slice（负数边界按 JS 语义）', () => {
    expect(valueOf('$.nums.slice(1)')).toEqual([20, 30]);
    expect(valueOf('$.nums.slice(-2)')).toEqual([20, 30]);
    expect(valueOf('$.nums.slice(0, -1)')).toEqual([10, 20]);
    expect(valueOf('$.nums.slice(9)')).toEqual([]);
  });

  it('concat / join', () => {
    expect(valueOf('$.nums.concat([40], 50)')).toEqual([10, 20, 30, 40, 50]);
    expect(valueOf("$.nums.join('-')")).toBe('10-20-30');
    expect(valueOf("$.items.map(x => x.name).join('')")).toBe('abc');
  });

  it('flat（深度参数可选）', () => {
    expect(valueOf('[[1], [2, [3]]].flat()')).toEqual([1, 2, [3]]);
    expect(valueOf('[[1], [2, [3]]].flat(2)')).toEqual([1, 2, 3]);
    expect(valueOf('$.nums.flat()')).toEqual([10, 20, 30]);
  });

  it('at（正负下标 / 越界）', () => {
    expect(valueOf('$.nums.at(0)')).toBe(10);
    expect(valueOf('$.nums.at(-1)')).toBe(30);
    expect(valueOf('$.nums.at(99)')).toBe(null);
  });

  it('reduce：初始值 / 无初始值 / 空数组抛 EVAL_ILLEGAL_CALL', () => {
    expect(valueOf('$.nums.reduce((a, b) => a + b, 0)')).toBe(60);
    expect(valueOf('$.nums.reduce((a, b) => a + b)')).toBe(60);
    expect(valueOf('$.items.reduce((a, x) => a + x.id, 0)')).toBe(6);
    expect(errorOf('[].reduce((a, b) => a + b)')).toMatchObject({
      code: 'EVAL_ILLEGAL_CALL',
      params: ['reduce'],
    });
  });
});

describe('core/expression — 字符串方法 / Math / 全局', () => {
  it('字符串方法矩阵', () => {
    expect(valueOf("$.str.includes('World')")).toBe(true);
    expect(valueOf("$.str.startsWith('Hello')")).toBe(true);
    expect(valueOf("$.str.endsWith('World')")).toBe(true);
    expect(valueOf("$.str.indexOf('o')")).toBe(4);
    expect(valueOf('$.str.slice(0, 5)')).toBe('Hello');
    expect(valueOf('$.str.toUpperCase()')).toBe('HELLO WORLD');
    expect(valueOf('$.str.toLowerCase()')).toBe('hello world');
    expect(valueOf('$.padded.trim()')).toBe('pad');
    expect(valueOf("$.str.split(' ')")).toEqual(['Hello', 'World']);
    expect(valueOf("$.str.replace('World', 'TJ')")).toBe('Hello TJ');
    expect(valueOf('$.str.charAt(1)')).toBe('e');
    expect(valueOf('$.str.substring(0, 5)')).toBe('Hello');
  });

  it('Math 白名单（含 Math.max 回归）', () => {
    expect(valueOf('Math.max(1, 5, 3)')).toBe(5);
    expect(valueOf('Math.max(...$.nums)')).toBe(30);
    expect(valueOf('Math.min(...$.nums)')).toBe(10);
    expect(valueOf('Math.abs(-3)')).toBe(3);
    expect(valueOf('Math.floor(3.9)')).toBe(3);
    expect(valueOf('Math.ceil(3.1)')).toBe(4);
    expect(valueOf('Math.round(2.5)')).toBe(3);
    expect(valueOf('Math.trunc(-2.7)')).toBe(-2);
    expect(valueOf('Math.pow(2, 10)')).toBe(1024);
    expect(valueOf('Math.sqrt(81)')).toBe(9);
    expect(valueOf('Math.sign(-5)')).toBe(-1);
    expect(valueOf('Math.log(1)')).toBe(0);
  });

  it('Number / String / Boolean 转换', () => {
    expect(valueOf("Number('42')")).toBe(42);
    expect(valueOf('Number($.nothing)')).toBe(0);
    expect(valueOf('Number($.str)')).toBe(null); // NaN → JSON null
    expect(valueOf('String($.int)')).toBe('7');
    expect(valueOf('String($.data)')).toBe('[object Object]');
    expect(valueOf('String($.nums)')).toBe('10,20,30');
    expect(valueOf('Boolean($.nothing)')).toBe(false);
    expect(valueOf('Boolean($.items)')).toBe(true);
  });

  it('Array.isArray', () => {
    expect(valueOf('Array.isArray($.nums)')).toBe(true);
    expect(valueOf('Array.isArray($.data)')).toBe(false);
    expect(valueOf("Array.isArray('abc')")).toBe(false);
  });

  it('JSON.parse / JSON.stringify', () => {
    expect(valueOf("JSON.parse('{\"a\":1}').a")).toBe(1);
    expect(valueOf("JSON.parse('[1,2]')[1]")).toBe(2);
    expect(valueOf('JSON.stringify({a: 1})')).toBe('{"a":1}');
    expect(valueOf('JSON.stringify($.nums)')).toBe('[10,20,30]');
    expect(valueOf('JSON.stringify(undefined)')).toBe(null);
    expect(errorOf('JSON.parse(1)')).toMatchObject({ code: 'EVAL_ILLEGAL_CALL', params: ['JSON.parse'] });
    expect(errorOf("JSON.parse('{bad')")).toMatchObject({ code: 'EVAL_ILLEGAL_CALL', params: ['JSON.parse'] });
  });
});

describe('core/expression — 结果归一化与引用语义', () => {
  it('最终 undefined → null / count 0 / kind null', () => {
    const outcome = ok('undefined');
    expect(outcome).toMatchObject({ value: null, kind: 'null', count: 0 });
    expect(outcome.origins.top).toEqual([]);
  });

  it('数组 / 对象里的 undefined 省略', () => {
    expect(valueOf('[undefined, 1]')).toEqual([1]);
    expect(valueOf('({a: undefined, b: 2})')).toEqual({ b: 2 });
    expect(valueOf('[$.nums[99], 1]')).toEqual([1]);
  });

  it('元素引用不复制：结果里的文档容器 identity 不变', () => {
    const outcome = ok('$.items');
    expect(outcome.value).toBe(DOC.items);
    expect(outcome.count).toBe(3);
    expect(outcome.kind).toBe('array');

    const objectOutcome = ok('$.data');
    expect(objectOutcome.value).toBe(DOC.data);
    expect(objectOutcome.count).toBe(3);
    expect(objectOutcome.kind).toBe('object');

    const filterOutcome = ok('$.items.filter(x => x.meta.ok)');
    const filtered = filterOutcome.value as Doc['items'];
    expect(filtered[0]).toBe(DOC.items[0]);
    expect(filtered[1]).toBe(DOC.items[2]);
  });

  it('非有限数字按 JSON 语义 → null', () => {
    expect(valueOf('1 / 0')).toBe(null);
    expect(valueOf('Number($.str)')).toBe(null);
    expect(valueOf('Math.sqrt(-1)')).toBe(null);
  });
});

/* ----------------------------- 缺失字段分级 ----------------------------- */

describe('core/expression — 缺失字段分级（根级静态链 vs 元素内部）', () => {
  it('根级静态链缺字段：严格与否都报错（非严格也是）', () => {
    for (const strict of [false, true]) {
      expect(errorOf('$.itmes', { strict })).toMatchObject({
        code: 'EVAL_UNKNOWN_FIELD',
        params: ['itmes'],
      });
      expect(errorOf('$.data.nmae', { strict })).toMatchObject({
        code: 'EVAL_UNKNOWN_FIELD',
        params: ['nmae'],
      });
    }
  });

  it('根级静态链缺字段带拼写候选（≤3，稳定）', () => {
    const error = errorOf('$.itmes');
    expect(error.candidates).toBeDefined();
    expect(error.candidates).toContain('items');
    expect((error.candidates as string[]).length).toBeLessThanOrEqual(3);

    const bare = errorOf('itmes');
    expect(bare.code).toBe('EVAL_UNKNOWN_FIELD');
    expect(bare.params).toEqual(['itmes']);
    expect(bare.candidates).toContain('items');
  });

  it('箭头函数体内缺字段：非严格 → MISSING（map 丢弃并 skipped++）', () => {
    const outcome = ok('$.items.map(x => x.zzz)');
    expect(outcome.value).toEqual([]);
    expect(outcome.skipped).toBe(3);
  });

  it('箭头函数体内缺字段：严格 → EVAL_UNKNOWN_FIELD', () => {
    expect(errorOf('$.items.map(x => x.zzz)', { strict: true })).toMatchObject({
      code: 'EVAL_UNKNOWN_FIELD',
      params: ['zzz'],
    });
    expect(errorOf('$.items.filter(x => x.zzz)', { strict: true })).toMatchObject({
      code: 'EVAL_UNKNOWN_FIELD',
      params: ['zzz'],
    });
  });

  it('filter / find / findIndex / some / every 把 MISSING 当 falsy', () => {
    expect(valueOf('$.items.filter(x => x.zzz)')).toEqual([]);
    expect(valueOf('$.items.find(x => x.zzz)')).toBe(null);
    expect(valueOf('$.items.findIndex(x => x.zzz)')).toBe(-1);
    expect(valueOf('$.items.some(x => x.zzz)')).toBe(false);
    expect(valueOf('$.items.every(x => x.zzz)')).toBe(false);
  });

  it('skipped 只统计 MISSING，不统计用户显式 undefined', () => {
    const missingOutcome = ok('$.items.map(x => x.id === 1 ? x.zzz : x.id)');
    expect(missingOutcome.value).toEqual([2, 3]);
    expect(missingOutcome.skipped).toBe(1);

    const undefinedOutcome = ok('$.items.map(x => x.id === 1 ? undefined : x.id)');
    expect(undefinedOutcome.value).toEqual([2, 3]);
    expect(undefinedOutcome.skipped).toBe(0);
  });

  it('MISSING 作为运算 / 成员基值继续传播（最终仍被省略）', () => {
    const outcome = ok('$.items.filter(x => (x.zzz + 1) > 0)');
    expect(outcome.value).toEqual([]);
    const member = ok('$.items.filter(x => x.zzz.deeper)');
    expect(member.value).toEqual([]);
  });

  it('严格模式下根级链 / 元素内部都带行列定位', () => {
    const rootError = errorOf('$.itmes');
    expect(rootError.line).toBe(1);
    expect(typeof rootError.column).toBe('number');
    const elementError = errorOf('$.items.map(x => x.zzz)', { strict: true });
    expect(elementError.line).toBe(1);
    expect(elementError.column).toBeGreaterThan(1);
  });
});

/* ------------------------------ 白名单拒绝 ------------------------------ */

describe('core/expression — 白名单拒绝（code + params）', () => {
  it('赋值 / 自增 / new', () => {
    expect(errorOf('x = 1')).toMatchObject({ code: 'STATIC_ERR_NODE', params: ['AssignmentExpression'] });
    expect(errorOf('x++')).toMatchObject({ code: 'STATIC_ERR_NODE', params: ['UpdateExpression'] });
    expect(errorOf('new Date()')).toMatchObject({ code: 'STATIC_ERR_NODE', params: ['NewExpression'] });
  });

  it('function / class / 多语句 / 空表达式 → PARSE_ERR_ROOT_SHAPE', () => {
    for (const text of ['function f() { return 1 }', 'class A {}', 'while (true) {}', '$.a; $.b', '']) {
      expect(errorOf(text)).toMatchObject({ code: 'PARSE_ERR_ROOT_SHAPE', params: ['root-shape'] });
    }
  });

  it('正则仍拒绝；BigIntLiteral 自 ADR-0020 起允许', () => {
    expect(errorOf('/abc/')).toMatchObject({ code: 'STATIC_ERR_NODE', params: ['RegExpLiteral'] });
    expect(valueOf('1n')).toBe(1n);
  });

  it('块体箭头 / 解构参数 / 默认参数 / async 箭头', () => {
    expect(errorOf('x => { return 1 }')).toMatchObject({ code: 'STATIC_ERR_NODE', params: ['BlockStatement'] });
    expect(errorOf('({a}) => a')).toMatchObject({ code: 'STATIC_ERR_NODE', params: ['ObjectPattern'] });
    expect(errorOf('(x = 1) => x')).toMatchObject({ code: 'STATIC_ERR_NODE', params: ['AssignmentPattern'] });
    expect(errorOf('(async () => 1)')).toMatchObject({
      code: 'STATIC_ERR_NODE',
      params: ['ArrowFunctionExpression'],
    });
  });

  it('禁用运算符：==/!=/位运算/**/in/instanceof/delete/void', () => {
    expect(errorOf('$.int == 1')).toMatchObject({ code: 'STATIC_ERR_NODE', params: ['=='] });
    expect(errorOf('$.int != 1')).toMatchObject({ code: 'STATIC_ERR_NODE', params: ['!='] });
    expect(errorOf('1 & 2')).toMatchObject({ code: 'STATIC_ERR_NODE', params: ['&'] });
    expect(errorOf('1 ** 2')).toMatchObject({ code: 'STATIC_ERR_NODE', params: ['**'] });
    expect(errorOf("'a' in $.data")).toMatchObject({ code: 'STATIC_ERR_NODE', params: ['in'] });
    expect(errorOf('$.data instanceof Array')).toMatchObject({ code: 'STATIC_ERR_NODE', params: ['instanceof'] });
    expect(errorOf('delete $.a')).toMatchObject({ code: 'STATIC_ERR_NODE', params: ['delete'] });
    expect(errorOf('void 0')).toMatchObject({ code: 'STATIC_ERR_NODE', params: ['void'] });
  });

  it('调用点非法：非白名单方法 / 变异方法 / 非可调用', () => {
    expect(errorOf('$.items.push(1)')).toMatchObject({ code: 'STATIC_ERR_CALL', params: ['push'] });
    expect(errorOf('$.items.forEach(x => x)')).toMatchObject({ code: 'STATIC_ERR_CALL', params: ['forEach'] });
    expect(errorOf('$.items[0].id()')).toMatchObject({ code: 'STATIC_ERR_CALL', params: ['id'] });
    expect(errorOf('$.data.name()')).toMatchObject({ code: 'STATIC_ERR_CALL', params: ['name'] });
    expect(errorOf('(x => x)()()')).toMatchObject({ code: 'STATIC_ERR_CALL', params: ['<expr>'] });
  });

  it('其它表达位置的危险节点：import()/函数表达式/class 表达式/this/序列', () => {
    expect(errorOf("import('x')")).toMatchObject({ code: 'STATIC_ERR_NODE', params: ['ImportExpression'] });
    expect(errorOf('(function () { return 1 })')).toMatchObject({
      code: 'STATIC_ERR_NODE',
      params: ['FunctionExpression'],
    });
    expect(errorOf('(class A {})')).toMatchObject({ code: 'STATIC_ERR_NODE', params: ['ClassExpression'] });
    expect(errorOf('this.x')).toMatchObject({ code: 'STATIC_ERR_NODE', params: ['ThisExpression'] });
    expect(errorOf('(1, 2)')).toMatchObject({ code: 'STATIC_ERR_NODE', params: ['SequenceExpression'] });
    expect(errorOf('String.raw`x`')).toMatchObject({ code: 'STATIC_ERR_NODE', params: ['TaggedTemplateExpression'] });
    expect(errorOf('(async () => await $.int)')).toMatchObject({
      code: 'STATIC_ERR_NODE',
      params: ['ArrowFunctionExpression'],
    });
  });

  it('接收者类型错误：字符串/数字上调用数组/字符串方法', () => {
    expect(errorOf("'abc'.map(x => x)")).toMatchObject({ code: 'EVAL_SHAPE_ERROR', params: ['base-kind'] });
    expect(errorOf('$.int.toUpperCase()')).toMatchObject({ code: 'EVAL_SHAPE_ERROR', params: ['base-kind'] });
    expect(errorOf('$.nothing.toUpperCase()')).toMatchObject({ code: 'EVAL_SHAPE_ERROR', params: ['base-kind'] });
  });

  it('语义上非法的白名单调用：replace/split 参数、回调不是函数', () => {
    expect(errorOf("$.str.replace(1, 'x')")).toMatchObject({ code: 'EVAL_ILLEGAL_CALL', params: ['replace'] });
    expect(errorOf('$.str.split(1)')).toMatchObject({ code: 'EVAL_ILLEGAL_CALL', params: ['split'] });
    expect(errorOf('$.items.map(1)')).toMatchObject({ code: 'EVAL_ILLEGAL_CALL', params: ['map'] });
    expect(errorOf('$.items.map()')).toMatchObject({ code: 'EVAL_ILLEGAL_CALL', params: ['map'] });
    expect(errorOf('$.items.filter()')).toMatchObject({ code: 'EVAL_ILLEGAL_CALL', params: ['filter'] });
  });

  it('在错误类型上取属性 / 非整数下标 → EVAL_SHAPE_ERROR', () => {
    expect(errorOf('$.nothing.x')).toMatchObject({ code: 'EVAL_SHAPE_ERROR', params: ['base-kind'] });
    expect(errorOf('$.num.x')).toMatchObject({ code: 'EVAL_SHAPE_ERROR', params: ['base-kind'] });
    expect(errorOf('$.str.nope')).toMatchObject({ code: 'EVAL_SHAPE_ERROR', params: ['base-kind'] });
    expect(errorOf('$.nums[1.5]')).toMatchObject({ code: 'EVAL_SHAPE_ERROR', params: ['index'] });
  });

  it('语法错误 → PARSE_ERR_SYNTAX（acorn line/column，1-based）', () => {
    const error = errorOf('$.data.');
    expect(error.code).toBe('PARSE_ERR_SYNTAX');
    expect(error.line).toBe(1);
    expect(typeof error.column).toBe('number');
    expect((error.params?.[0] as string).length).toBeGreaterThan(0);
  });
});

/* --------------------------------- 预算 --------------------------------- */

describe('core/expression — 预算三刹车', () => {
  it('步数超限 → EVAL_STEP_LIMIT（params 带预算数值）', () => {
    const error = errorOf('$.nums.map(x => x * 2)', { budget: { maxSteps: 10 } });
    expect(error).toMatchObject({ code: 'EVAL_STEP_LIMIT', params: [10] });
  });

  it('假时钟超时 → EVAL_TIME_LIMIT（不依赖真实时间）', () => {
    const bigDoc = { list: Array.from({ length: 4000 }, (_, i) => ({ v: i })) };
    let clock = 0;
    const now = () => {
      clock += 10;
      return clock;
    };
    const error = errorOf('$.list.map(x => x.v)', {
      doc: bigDoc,
      now,
      budget: { maxTimeMs: 5, maxSteps: 1_000_000 },
    });
    expect(error).toMatchObject({ code: 'EVAL_TIME_LIMIT', params: [5] });
  });

  it('maxResult 截断数组（继续执行但不追加，truncated=true）', () => {
    const outcome = ok('$.items.map(x => x.id)', { budget: { maxResult: 2 } });
    expect(outcome.value).toEqual([1, 2]);
    expect(outcome.count).toBe(2);
    expect(outcome.truncated).toBe(true);
  });

  it('maxResult 截断对象', () => {
    const outcome = ok('({a: 1, b: 2, c: 3})', { budget: { maxResult: 2 } });
    expect(outcome.value).toEqual({ a: 1, b: 2 });
    expect(outcome.count).toBe(2);
    expect(outcome.truncated).toBe(true);
  });

  it('maxResult 截断字符串（最终结果 / 模板串）', () => {
    const direct = ok('$.str', { budget: { maxResult: 4 } });
    expect(direct.value).toBe('Hell');
    expect(direct.truncated).toBe(true);

    const template = ok('`${$.str}!`', { budget: { maxResult: 5 } });
    expect(template.value).toBe('Hello');
    expect(template.truncated).toBe(true);

    const stringify = ok('JSON.stringify($.nums)', { budget: { maxResult: 4 } });
    expect(stringify.value).toBe('[10,');
    expect(stringify.truncated).toBe(true);
  });

  it('JSON.parse 结果容器尺寸超 maxResult → EVAL_ILLEGAL_CALL [JSON.parse]', () => {
    const error = errorOf(`JSON.parse('[[1],[2],[3]]')`, { budget: { maxResult: 2 } });
    expect(error).toMatchObject({ code: 'EVAL_ILLEGAL_CALL', params: ['JSON.parse'] });
  });

  it('截断是「继续执行但不追加」：步数与不截断一致', () => {
    const capped = ok('$.items.map(x => x.id)', { budget: { maxResult: 2 } });
    const full = ok('$.items.map(x => x.id)');
    expect(capped.value).toEqual([1, 2]);
    expect(capped.steps).toBe(full.steps);
    expect(capped.truncated).toBe(true);
    expect(full.truncated).toBe(false);
  });

  it('maxResult 截断原样引用的文档容器（数组结果，结果根收口）', () => {
    const doc = { big: Array.from({ length: 60000 }, (_, i) => i), small: [1, 2, 3] };

    const outcome = ok('$.big', { doc, budget: { maxResult: 50000 } });
    expect(outcome.count).toBe(50000);
    expect((outcome.value as number[]).length).toBe(50000);
    expect((outcome.value as number[])[0]).toBe(0);
    expect(outcome.truncated).toBe(true);

    const small = ok('$.small', { doc });
    expect(small).toMatchObject({ kind: 'array', count: 3, truncated: false });

    // `$` 指向小数组时不截断
    const rootArray = ok('$', { doc: [1, 2, 3] });
    expect(rootArray).toMatchObject({ kind: 'array', count: 3, truncated: false });
  });

  it('maxResult 截断原样引用的文档容器（对象结果，保持原键序、值仍引用原节点）', () => {
    const bigObj = { a: { v: 1 }, b: 2, c: 3, d: 4 };
    const doc = { obj: bigObj };
    const outcome = ok('$.obj', { doc, budget: { maxResult: 2 } });
    expect(outcome.value).toEqual({ a: { v: 1 }, b: 2 });
    expect(Object.keys(outcome.value as object)).toEqual(['a', 'b']);
    expect((outcome.value as Record<string, unknown>).a).toBe(bigObj.a);
    expect(outcome.count).toBe(2);
    expect(outcome.truncated).toBe(true);
  });

  it('文本过长 → PARSE_ERR_ROOT_SHAPE [text-length]', () => {
    expect(errorOf('1'.repeat(5000))).toMatchObject({
      code: 'PARSE_ERR_ROOT_SHAPE',
      params: ['text-length'],
    });
  });

  it('AST 过深 → PARSE_ERR_ROOT_SHAPE [depth]', () => {
    const deep = '['.repeat(200) + '1' + ']'.repeat(200);
    expect(errorOf(deep)).toMatchObject({ code: 'PARSE_ERR_ROOT_SHAPE', params: ['depth'] });
  });

  it('确定性：同输入 + 同预算跑两次 → value/steps/skipped 完全一致', () => {
    const text = '$.items.filter(x => x.meta.ok).map(x => x.id)';
    const first = ok(text, { now: () => 0 });
    const second = ok(text, { now: () => 0 });
    expect(second.value).toEqual(first.value);
    expect(second.steps).toBe(first.steps);
    expect(second.skipped).toBe(first.skipped);
    expect(second.truncated).toBe(first.truncated);
  });

  it('确定性：截断结果也可复现', () => {
    const first = ok('$.nums.map(x => x * 2)', { budget: { maxResult: 2 } });
    const second = ok('$.nums.map(x => x * 2)', { budget: { maxResult: 2 } });
    expect(second.value).toEqual(first.value);
    expect(second.steps).toBe(first.steps);
    expect(second.truncated).toBe(true);
  });
});

/* ---------------------------- countDocumentNodes ---------------------------- */

describe('core/expression — countDocumentNodes（迭代式全量计数）', () => {
  it('标量 / null / 空容器', () => {
    expect(countDocumentNodes(1)).toBe(1);
    expect(countDocumentNodes('x')).toBe(1);
    expect(countDocumentNodes(null)).toBe(1);
    expect(countDocumentNodes({})).toBe(1);
    expect(countDocumentNodes([])).toBe(1);
  });

  it('对象 / 数组：根 + 每个属性值 / 元素', () => {
    expect(countDocumentNodes({ a: 1 })).toBe(2);
    expect(countDocumentNodes({ a: 1, b: 2 })).toBe(3);
    expect(countDocumentNodes([1, 2, 3])).toBe(4);
    expect(countDocumentNodes({ a: { b: 1 }, c: [2, 3] })).toBe(6);
  });

  it('大数组：准确且不爆栈', () => {
    const big = Array.from({ length: 100_000 }, (_, i) => i);
    expect(countDocumentNodes(big)).toBe(100_001);
  });

  it('深嵌套对象（迭代而非递归）', () => {
    let node: unknown = 1;
    for (let i = 0; i < 5000; i++) node = { child: node };
    expect(countDocumentNodes(node)).toBe(5001);
  });
});

/* ---------------------- 无损数字 / BigInt（ADR-0020 §6） ---------------------- */

describe('core/expression — BigInt 语义（ADR-0020 §6）', () => {
  /** 含超大整数的文档（无损解析后值是 BigInt）。 */
  const BIG_DOC = {
    id: 297532588187238660n,
    rows: [{ v: 1n }, { v: 2 }, { v: 3000000000000000000n }],
    name: 'x',
  };

  it('文档里的 BigInt 原样读出、类型仍是 number 类', () => {
    expect(valueOf('id', { doc: BIG_DOC })).toBe(297532588187238660n);
    expect(valueOf('typeof id', { doc: BIG_DOC })).toBe('bigint');
    expect(valueOf('id === 297532588187238660n', { doc: BIG_DOC })).toBe(true);
  });

  it('BigInt 字面量：精确常量（不会被 double 圆整）', () => {
    expect(valueOf('297532588187238660n')).toBe(297532588187238660n);
    expect(valueOf('1234567890123456789n')).toBe(1234567890123456789n);
    // 十进制数字字面量（无 n）也走无损判定：超过安全范围 → BigInt
    expect(valueOf('1234567890123456789')).toBe(1234567890123456789n);
    expect(valueOf('1.5')).toBe(1.5);
  });

  it('BigInt 之间算术按原生；关系比较允许 BigInt 与 Number 混合', () => {
    expect(valueOf('1n + 2n')).toBe(3n);
    expect(valueOf('5n - 2n')).toBe(3n);
    expect(valueOf('3n * 3n')).toBe(9n);
    expect(valueOf('7n / 2n')).toBe(3n); // 整除截断
    expect(valueOf('7n % 2n')).toBe(1n);
    expect(valueOf('-1n')).toBe(-1n);
    expect(valueOf('id > 1', { doc: BIG_DOC })).toBe(true);
    expect(valueOf('id < 1', { doc: BIG_DOC })).toBe(false);
    expect(valueOf('id >= 297532588187238660n', { doc: BIG_DOC })).toBe(true);
  });

  it('混算（BigInt 与 Number）报确定错误 EVAL_MIXED_NUMBER（对齐原生 TypeError）', () => {
    expect(errorOf('id + 1', { doc: BIG_DOC })).toMatchObject({
      code: 'EVAL_MIXED_NUMBER',
      params: ['+'],
    });
    expect(errorOf('id * 2', { doc: BIG_DOC })).toMatchObject({ code: 'EVAL_MIXED_NUMBER', params: ['*'] });
    expect(errorOf('+1n')).toMatchObject({ code: 'EVAL_MIXED_NUMBER', params: ['+'] });
    expect(errorOf('Math.abs(id)', { doc: BIG_DOC })).toMatchObject({
      code: 'EVAL_MIXED_NUMBER',
      params: ['Math.abs'],
    });
  });

  it('显式转换允许：Number()/String()/模板串/JSON.stringify/JSON.parse', () => {
    expect(valueOf('Number(id)', { doc: BIG_DOC })).toBe(297532588187238660);
    expect(valueOf('String(id)', { doc: BIG_DOC })).toBe('297532588187238660');
    expect(valueOf('`${id}`', { doc: BIG_DOC })).toBe('297532588187238660');
    expect(valueOf("'id=' + id", { doc: BIG_DOC })).toBe('id=297532588187238660');
    // 表达式内 JSON.stringify 输出裸数字（与主链路同口径）
    expect(valueOf('JSON.stringify(id)', { doc: BIG_DOC })).toBe('297532588187238660');
    // 表达式内 JSON.parse 也走无损 parser
    expect(valueOf('JSON.parse("[297532588187238660]")[0]')).toBe(297532588187238660n);
  });

  it('数组方法可处理 BigInt（filter/比较），结果保留精确值', () => {
    expect(valueOf('rows.filter(x => x.v > 1)', { doc: BIG_DOC })).toEqual([
      { v: 2 },
      { v: 3000000000000000000n },
    ]);
    expect(valueOf('[1n,2n,3].includes(2n)')).toBe(true);
    expect(valueOf('[1n,2,3n].join("-")')).toBe('1-2-3');
  });

  it('结果归一化保留 BigInt（不被 sanitize 变 null）', () => {
    const outcome = ok('id', { doc: BIG_DOC });
    expect(outcome.value).toBe(297532588187238660n);
    expect(ok('rows', { doc: BIG_DOC }).value).toEqual(BIG_DOC.rows);
  });
});
