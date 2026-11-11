import { describe, expect, it } from 'vitest';
import { SourcePathIndex } from '../../../src/core/path-index';
import { buildRawIndex } from '../../../src/core/raw-text';
import { appendKey } from '../../../src/shared/path';

/* ------------------------------ fixtures ------------------------------ */

const DOC = {
  a: 1,
  b: [true, null, 'x'],
  c: { d: 2 },
  'e.f': 'v',
  'q"k': 3,
  arr: [{ k: 1 }, [2, 3]],
  empty: {},
  emptyArr: [],
};
const SOURCE = JSON.stringify(DOC, null, 2);
const MINIFIED = JSON.stringify(DOC);

/** 第 n 次出现的位置（-1 = 没有） */
function nthIndex(text: string, needle: string, nth = 1): number {
  let from = -1;
  for (let i = 0; i < nth; i++) {
    from = text.indexOf(needle, from + 1);
    if (from < 0) return -1;
  }
  return from;
}

function pathAt(text: string, offset: number, cpEvery?: number): { path: string | null; exact: boolean } {
  const index = new SourcePathIndex(text, cpEvery === undefined ? {} : { cpEvery });
  const hit = index.pathAtOffset(offset);
  return hit ? { path: hit.path, exact: hit.exact } : { path: null, exact: false };
}

/* ------------------------------ pathAtOffset ------------------------------ */

describe('SourcePathIndex.pathAtOffset — 源偏移 → 树路径（#30 / ADR-0019）', () => {
  it('根节点起点 → `$`（exact）', () => {
    expect(pathAt(SOURCE, 0)).toEqual({ path: '$', exact: true });
    expect(pathAt('{"x":[1,2,3]}', 0)).toEqual({ path: '$', exact: true });
  });

  it('对象成员的键起点 → 该成员路径（exact）', () => {
    const keyA = SOURCE.indexOf('"a"');
    const keyD = SOURCE.indexOf('"d"');
    expect(pathAt(SOURCE, keyA)).toEqual({ path: '$.a', exact: true });
    expect(pathAt(SOURCE, keyD)).toEqual({ path: '$.c.d', exact: true });
  });

  it('数组元素的值起点 → 该元素路径（exact）', () => {
    const trueAt = SOURCE.indexOf('true');
    const xAt = SOURCE.indexOf('"x"');
    expect(pathAt(SOURCE, trueAt)).toEqual({ path: '$.b[0]', exact: true });
    expect(pathAt(SOURCE, xAt)).toEqual({ path: '$.b[2]', exact: true });
  });

  it('数组元素容器的开括号 → 该元素路径（exact；数组元素锚点就是值起点）', () => {
    const objAt = SOURCE.indexOf('{', SOURCE.indexOf('"arr"'));
    expect(pathAt(SOURCE, objAt)).toEqual({ path: '$.arr[0]', exact: true });
  });

  it('对象成员的值起点（键在上一行）→ 该成员路径（exact=false）', () => {
    const text = '{\n  "a":\n    123\n}';
    const valueAt = text.indexOf('123');
    expect(pathAt(text, valueAt)).toEqual({ path: '$.a', exact: false });
  });

  it('容器开括号命中该容器（对象成员键在上一行时 exact=false）', () => {
    const text = '{\n  "c":\n    {\n      "d": 2\n    }\n}';
    const braceAt = text.indexOf('{', text.indexOf('"c"'));
    expect(pathAt(text, braceAt)).toEqual({ path: '$.c', exact: false });
  });

  it('结构位置（逗号/闭括号/空白）→ null', () => {
    const commaAt = SOURCE.indexOf(',');
    const closeAt = SOURCE.lastIndexOf('}');
    const spaceAt = SOURCE.indexOf(' ');
    expect(pathAt(SOURCE, commaAt).path).toBeNull();
    expect(pathAt(SOURCE, closeAt).path).toBeNull();
    expect(pathAt(SOURCE, spaceAt).path).toBeNull();
  });

  it('越界 / 非有限偏移 → null', () => {
    expect(pathAt(SOURCE, -1).path).toBeNull();
    expect(pathAt(SOURCE, SOURCE.length).path).toBeNull();
    expect(pathAt(SOURCE, Number.NaN).path).toBeNull();
  });

  it('空文档 / 纯空白 → null', () => {
    expect(pathAt('', 0).path).toBeNull();
    expect(pathAt('   ', 1).path).toBeNull();
  });

  it('根是标量：根起点 → `$`，其余 → null', () => {
    expect(pathAt('123', 0)).toEqual({ path: '$', exact: true });
    expect(pathAt('123', 1).path).toBeNull();
  });

  it('检查点间隔不影响结果（cpEvery 1/2/3/64/2048 与不设一致）', () => {
    const ref = new SourcePathIndex(SOURCE);
    const raw = buildRawIndex(SOURCE);
    const probes: number[] = [];
    for (let line = 1; line <= raw.totalLines; line++) {
      const offset = raw.tokenStartAt(line);
      if (offset !== null) probes.push(offset);
    }
    // 再补键/值起点
    for (const needle of ['"a"', '"d"', 'true', '"x"', '{}', '[]']) {
      const at = SOURCE.indexOf(needle);
      if (at >= 0) probes.push(at);
    }
    const expected = probes.map((offset) => ref.pathAtOffset(offset));
    for (const every of [1, 2, 3, 64, 2048]) {
      const index = new SourcePathIndex(SOURCE, { cpEvery: every });
      // 先让检查点建好（pathAtOffset 首调内部构建）
      expect(index.pathAtOffset(probes[0] as number)).toEqual(expected[0]);
      for (let i = 0; i < probes.length; i++) {
        expect(index.pathAtOffset(probes[i] as number)).toEqual(expected[i]);
      }
    }
  });

  it('深嵌套（300 层）迭代行走，无递归栈限制', () => {
    let path = '$';
    let text = '1';
    for (let i = 0; i < 300; i++) {
      path = appendKey(path, 'a');
      text = '{"a":' + text + '}';
    }
    const index = new SourcePathIndex(text);
    const leafKey = text.indexOf('"a"', text.length - text.length); // 第一层键
    expect(index.pathAtOffset(leafKey)?.path).toBe('$.a');
    expect(index.offsetOfPath(path)).toBe(text.lastIndexOf('"a"'));
  });

  it('检查点索引只占小内存（50MB 量级口径的单元级 sanity）', () => {
    const big = JSON.stringify(Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`k${i}`, i])));
    const index = new SourcePathIndex(big, { cpEvery: 256 });
    index.pathAtOffset(big.length - 3);
    expect(index.checkpointCount).toBeGreaterThan(0);
    expect(index.memoryBytes).toBeLessThan(200 * 1024);
  });
});

/* ------------------------------ offsetOfPath ------------------------------ */

describe('SourcePathIndex.offsetOfPath — 树路径 → 源偏移（重复键取最后一个）', () => {
  it('根 → 0；普通成员/数组元素/嵌套容器', () => {
    const index = new SourcePathIndex(SOURCE);
    expect(index.offsetOfPath('$')).toBe(0);
    expect(index.offsetOfPath('$.a')).toBe(SOURCE.indexOf('"a"'));
    expect(index.offsetOfPath('$.b[1]')).toBe(SOURCE.indexOf('null'));
    expect(index.offsetOfPath('$.c.d')).toBe(SOURCE.indexOf('"d"'));
    const arrAt = SOURCE.indexOf('"arr"');
    expect(index.offsetOfPath('$.arr[0].k')).toBe(SOURCE.indexOf('"k"', arrAt));
    expect(index.offsetOfPath('$.arr[1][1]')).toBe(SOURCE.indexOf('3', arrAt));
  });

  it('空容器 / 对象成员的空容器路径', () => {
    const index = new SourcePathIndex(SOURCE);
    // 对象成员的锚点 = 键起点（容器也一样）
    expect(index.offsetOfPath('$.empty')).toBe(SOURCE.indexOf('"empty"'));
    expect(index.offsetOfPath('$.emptyArr')).toBe(SOURCE.indexOf('"emptyArr"'));
  });

  it('不存在的路径 / 非法路径 → null', () => {
    const index = new SourcePathIndex(SOURCE);
    expect(index.offsetOfPath('$.zz')).toBeNull();
    expect(index.offsetOfPath('$.b[9]')).toBeNull();
    expect(index.offsetOfPath('not-a-path')).toBeNull();
  });

  it('重复键：取最后一个源位置（与 JSON.parse 生效值一致）', () => {
    const text = '{"k":1,"x":0,"k":2}';
    const index = new SourcePathIndex(text);
    expect(index.offsetOfPath('$.k')).toBe(text.lastIndexOf('"k"'));
    // 两个键起点都映射到同一路径
    expect(index.pathAtOffset(text.indexOf('"k"'))?.path).toBe('$.k');
    expect(index.pathAtOffset(text.lastIndexOf('"k"'))?.path).toBe('$.k');
  });

  it('转义键：pathAt ↔ offsetOfPath 往返一致', () => {
    const text = '{"a\\"b":1,"c\\\\d":2,"caf\\u00e9":3}';
    const index = new SourcePathIndex(text);
    const quoteKey = appendKey('$', 'a"b');
    const slashKey = appendKey('$', 'c\\d');
    const accentKey = appendKey('$', 'café');
    expect(index.offsetOfPath(quoteKey)).toBe(text.indexOf('"a'));
    expect(index.offsetOfPath(slashKey)).toBe(text.indexOf('"c'));
    expect(index.offsetOfPath(accentKey)).toBe(text.indexOf('"caf'));
    expect(index.pathAtOffset(text.indexOf('"a'))?.path).toBe(quoteKey);
    expect(index.pathAtOffset(text.indexOf('"caf'))?.path).toBe(accentKey);
    expect(index.pathAtOffset(text.indexOf('"c\\\\'))?.path).toBe(slashKey);
  });

  it('数组根：$[i] 路径与元素偏移', () => {
    const text = '[\n  10,\n  {"k": 20}\n]';
    const index = new SourcePathIndex(text);
    expect(index.offsetOfPath('$[0]')).toBe(text.indexOf('10'));
    expect(index.offsetOfPath('$[1]')).toBe(text.indexOf('{'));
    expect(index.offsetOfPath('$[1].k')).toBe(text.indexOf('"k"'));
    expect(index.pathAtOffset(text.indexOf('10'))?.path).toBe('$[0]');
  });

  it('深嵌套 300 层：完整路径命中（大 depth 不栈溢出）', () => {
    let path = '$';
    let text = '1';
    for (let i = 0; i < 300; i++) {
      path = appendKey(path, 'a');
      text = '{"a":' + text + '}';
    }
    const index = new SourcePathIndex(text);
    expect(index.offsetOfPath(path)).toBe(text.lastIndexOf('"a"'));
  });
});

/* ------------------------------ raw-text.tokenStartAt ------------------------------ */

describe('RawTextIndex.tokenStartAt — 显示行行首 token 偏移（双向定位入参）', () => {
  it('源码行模式：返回本行第一个非空白字符偏移；空行 → null', () => {
    const text = '{\n\n  "a": 1,\n  "b": 2\n}';
    const index = buildRawIndex(text);
    expect(index.mode).toBe('source');
    expect(index.tokenStartAt(1)).toBe(0); // {
    expect(index.tokenStartAt(2)).toBeNull(); // 空行
    expect(index.tokenStartAt(3)).toBe(text.indexOf('"a"'));
    expect(index.tokenStartAt(5)).toBe(text.lastIndexOf('}'));
  });

  it('pretty 模式：返回 LineRec.start（键/值/开括号起点）；闭括号行也返回偏移', () => {
    // > RAW_MAX_LINE_LENGTH 的单行源 → pretty 布局
    const big = JSON.stringify(Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`key${i}`, i])));
    const index = buildRawIndex(big);
    expect(index.mode).toBe('pretty');
    expect(index.tokenStartAt(1)).toBe(0); // 根 `{`
    const firstKey = big.indexOf('"key0"');
    expect(index.tokenStartAt(2)).toBe(firstKey);
    expect(index.tokenStartAt(index.totalLines)).toBe(big.lastIndexOf('}'));
    // 行首 token 起点 → 树路径（与 SourcePathIndex 联通）
    expect(new SourcePathIndex(big).pathAtOffset(firstKey)?.path).toBe('$.key0');
  });

  it('pretty 行号越界夹取', () => {
    const index = buildRawIndex(MINIFIED);
    expect(index.tokenStartAt(0)).toBe(index.tokenStartAt(1));
    expect(index.tokenStartAt(1e9)).toBe(index.tokenStartAt(index.totalLines));
  });

  it('plain（截断修复文档）→ null', () => {
    const index = buildRawIndex('{"a":1,"b":"hel', { damaged: true });
    expect(index.mode).toBe('plain');
    expect(index.tokenStartAt(1)).toBeNull();
  });
});
