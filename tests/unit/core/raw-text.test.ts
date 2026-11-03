import { describe, expect, it } from 'vitest';
import { buildRawIndex, probeText, RawTextIndex } from '../../../src/core/raw-text';
import {
  RAW_CP_EVERY,
  RAW_LINE_DISPLAY_MAX,
  RAW_MAX_LINE_LENGTH,
} from '../../../src/protocol/versions';

/* ------------------------------ fixtures ------------------------------ */

const SOURCE_DOC = { a: 1, b: [true, null, 'x'], c: { d: 2 } };
const SOURCE_TEXT = JSON.stringify(SOURCE_DOC, null, 2);
const SOURCE_LINES = SOURCE_TEXT.split('\n');

/** > RAW_MAX_LINE_LENGTH 的单行 minified 文档：数字用规范形态，行文本应与 JSON.stringify(...,null,2) 逐字一致 */
function bigMinifiedText(keyCount = 400): string {
  const value: Record<string, unknown> = {};
  for (let i = 0; i < keyCount; i++) value[`key${i}`] = i % 7 === 0 ? true : i;
  return JSON.stringify(value);
}

const PRETTY_TEXT = bigMinifiedText();
const PRETTY_LINES = JSON.stringify(JSON.parse(PRETTY_TEXT), null, 2).split('\n');

/** 反引号/转义/大整数：验证 pretty 行文本取源切片（不是 String(value)） */
function escapedMinifiedText(): string {
  const parts: string[] = ['{'];
  for (let i = 0; i < 500; i++) parts.push(`"p${i}":${i},`);
  parts.push('"esc":"caf\\u00e9",');
  parts.push('"num":1.0,');
  parts.push('"big":1234567890123456789}');
  return parts.join('');
}

function allLines(index: RawTextIndex, count?: number): { lines: string[]; truncated?: number[] } {
  const total = index.meta().totalLines;
  return index.windowText(0, count ?? total);
}

function lineOf(index: RawTextIndex, start: number, count = 1): string[] {
  return index.windowText(start, count).lines;
}

/* ------------------------------- probe -------------------------------- */

describe('probeText — 形状探测（一次 indexOf 扫描）', () => {
  it('空文本：1 行、最长行 0', () => {
    expect(probeText('')).toEqual({ lines: 1, maxLine: 0 });
  });

  it('多行：行数 = \\n 数量 + 1，最长行取最大行字符数', () => {
    expect(probeText('a\nbb\nccc')).toEqual({ lines: 3, maxLine: 3 });
    expect(probeText('aaaa\nb')).toEqual({ lines: 2, maxLine: 4 });
  });

  it('尾换行产生一个空行（非空行不计入最长行）', () => {
    expect(probeText('a\n')).toEqual({ lines: 2, maxLine: 1 });
    expect(probeText('ab\n\nc\n')).toEqual({ lines: 4, maxLine: 2 });
  });

  it('CRLF：行数按 \\n 计，行文本含 \\r', () => {
    expect(probeText('a\r\nbb\r\n')).toEqual({ lines: 3, maxLine: 3 });
  });
});

/* ---------------------------- source 模式 ----------------------------- */

describe('RawTextIndex — source 模式（行文本 = 源切片）', () => {
  it('meta：mode/source、总行数、字符数、最长行、buildMs', () => {
    const index = new RawTextIndex(SOURCE_TEXT);
    const meta = index.meta();
    expect(meta).toMatchObject({
      mode: 'source',
      totalLines: SOURCE_LINES.length,
      chars: SOURCE_TEXT.length,
      maxLineLength: Math.max(...SOURCE_LINES.map((line) => line.length)),
    });
    expect(meta.damaged).toBeUndefined();
    expect(typeof meta.buildMs).toBe('number');
    expect(meta.buildMs).toBeGreaterThanOrEqual(0);
    expect(index.mode).toBe('source');
    expect(index.totalLines).toBe(SOURCE_LINES.length);
  });

  it('窗口逐字等于源文本逐行 slice（含缩进/逗号/括号原样）', () => {
    const index = new RawTextIndex(SOURCE_TEXT);
    expect(allLines(index).lines).toEqual(SOURCE_LINES);
  });

  it('任意 start/count 窗口逐字（含夹取与空窗口）', () => {
    const index = new RawTextIndex(SOURCE_TEXT);
    expect(lineOf(index, 0, 3)).toEqual(SOURCE_LINES.slice(0, 3));
    expect(lineOf(index, 2, 4)).toEqual(SOURCE_LINES.slice(2, 6));
    expect(lineOf(index, SOURCE_LINES.length - 1)).toEqual([SOURCE_LINES[SOURCE_LINES.length - 1]]);
    expect(lineOf(index, SOURCE_LINES.length, 5)).toEqual([]);
    // start/count 负数或非有限值 → 夹到 0 / 空
    expect(index.windowText(-3, 2).lines).toEqual(SOURCE_LINES.slice(0, 2));
    expect(index.windowText(0, -1).lines).toEqual([]);
    expect(index.windowText(Number.NaN, 1).lines).toEqual([SOURCE_LINES[0]]); // 非有限 start 按 0
  });

  it('空文档：1 行空串，totalLines = 1', () => {
    const index = new RawTextIndex('');
    expect(index.meta()).toMatchObject({ mode: 'source', totalLines: 1, chars: 0, maxLineLength: 0 });
    expect(index.windowText(0, 10).lines).toEqual(['']);
    expect(index.locate(0)).toBe(1);
    expect(index.locate(5)).toBe(1);
  });

  it('尾换行：最后多一个空行；空行原样保留', () => {
    const withBlank = '{\n\n  "a": 1\n}\n';
    const index = new RawTextIndex(withBlank);
    expect(index.meta().totalLines).toBe(5);
    expect(allLines(index).lines).toEqual(['{', '', '  "a": 1', '}', '']);
  });

  it('CRLF 原样处理（不规范化 \\r）', () => {
    const index = new RawTextIndex('{\r\n  "a": 1\r\n}');
    expect(allLines(index).lines).toEqual(['{\r', '  "a": 1\r', '}']);
  });

  it('超长源行按显示上限截断，并记录隐藏字符数（maxLineLength 可注入以便强制 source 模式）', () => {
    const text = '"' + 'x'.repeat(RAW_LINE_DISPLAY_MAX + 500) + '"'; // 合法 JSON 单行、> 显示上限
    const index = new RawTextIndex(text, { maxLineLength: 1_000_000 });
    expect(index.mode).toBe('source');
    const win = lineOf(index, 0);
    expect(win[0]).toHaveLength(RAW_LINE_DISPLAY_MAX);
    expect(win[0]).toBe(text.slice(0, RAW_LINE_DISPLAY_MAX));
    expect(index.windowText(0, 1).truncated).toEqual([text.length - RAW_LINE_DISPLAY_MAX]);
  });

  it('无超长行时 truncated 缺省', () => {
    const index = new RawTextIndex(SOURCE_TEXT);
    expect(index.windowText(0, SOURCE_LINES.length).truncated).toBeUndefined();
  });
});

/* --------------------------- source locate ---------------------------- */

describe('RawTextIndex — locate（source/plain 精确）', () => {
  // 行：1 'ab' / 2 'cd' / 3 'ef' / 4 ''
  const text = 'ab\ncd\nef\n';
  const index = new RawTextIndex(text);

  it('偏移 → 1-based 行号；\\n 属于它终止的那行', () => {
    expect(index.locate(0)).toBe(1); // 'a'
    expect(index.locate(1)).toBe(1); // 'b'
    expect(index.locate(2)).toBe(1); // '\n' 终止第 1 行
    expect(index.locate(3)).toBe(2); // 'c'
    expect(index.locate(5)).toBe(2); // '\n' 终止第 2 行
    expect(index.locate(6)).toBe(3); // 'e'
    expect(index.locate(8)).toBe(3); // '\n' 终止第 3 行
    expect(index.locate(9)).toBe(4); // 末尾空行
  });

  it('偏移夹取到 [0, chars]', () => {
    expect(index.locate(-10)).toBe(1);
    expect(index.locate(1e9)).toBe(index.meta().totalLines);
    expect(new RawTextIndex(SOURCE_TEXT).locate(SOURCE_TEXT.length)).toBe(SOURCE_LINES.length);
  });

  it('cpEvery 注入：检查点边界可从最近检查点重放（窗口 + locate 与无检查点参照一致）', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line-${i}`);
    const many = lines.join('\n');
    const lean = new RawTextIndex(many, { cpEvery: 3 }).build();
    const reference = new RawTextIndex(many, { cpEvery: 100_000 }).build();
    expect(lean.totalLines).toBe(reference.totalLines);
    for (let start = 0; start < lines.length; start++) {
      expect(lineOf(lean, start, 2)).toEqual(lineOf(reference, start, 2));
      expect(lean.locate(start * 8)).toBe(reference.locate(start * 8));
    }
  });
});

/* ---------------------------- pretty 模式 ----------------------------- */

describe('RawTextIndex — pretty 模式（检查点 pretty 行走器）', () => {
  it('模式选择：最长行 > 阈值才走 pretty（阈值可注入）', () => {
    expect(new RawTextIndex(SOURCE_TEXT).mode).toBe('source');
    expect(new RawTextIndex(SOURCE_TEXT, { maxLineLength: 3 }).mode).toBe('pretty');
    const minified = bigMinifiedText();
    expect(minified.length).toBeGreaterThan(RAW_MAX_LINE_LENGTH);
    expect(new RawTextIndex(minified).mode).toBe('pretty');
    expect(new RawTextIndex(minified, { maxLineLength: minified.length }).mode).toBe('source');
  });

  it('meta 与总行数：行布局 = JSON.stringify(value,null,2)', () => {
    const index = new RawTextIndex(PRETTY_TEXT);
    const meta = index.meta();
    expect(meta.mode).toBe('pretty');
    expect(meta.totalLines).toBe(PRETTY_LINES.length);
    expect(meta.chars).toBe(PRETTY_TEXT.length);
    expect(meta.maxLineLength).toBe(PRETTY_TEXT.length); // 单行 minified
  });

  it('窗口逐字：整窗与任意起始窗都等于规范 pretty 行', () => {
    const index = new RawTextIndex(PRETTY_TEXT);
    expect(allLines(index).lines).toEqual(PRETTY_LINES);
    // 4096 边界：最长行恰好 = 阈值仍走 source；多 1 字符才 pretty
    const exactly = '"' + 'x'.repeat(RAW_MAX_LINE_LENGTH - 2) + '"';
    expect(exactly.length).toBe(RAW_MAX_LINE_LENGTH);
    expect(new RawTextIndex(exactly).mode).toBe('source');
    expect(new RawTextIndex(exactly + '\n').mode).toBe('source'); // 尾换行：最长行不变
    expect(new RawTextIndex('"' + 'x'.repeat(RAW_MAX_LINE_LENGTH - 1) + '"').mode).toBe('pretty');

    for (const start of [0, 1, 7, 16, 190, PRETTY_LINES.length - 3]) {
      expect(lineOf(index, start, 3)).toEqual(PRETTY_LINES.slice(start, start + 3));
    }
  });

  it('正确性锁：全部行 join(\'\\n\') 后 JSON.parse 与 JSON.parse(源文本) 深度相等且键序 = 源序', () => {
    const index = new RawTextIndex(PRETTY_TEXT);
    const joined = allLines(index).lines.join('\n');
    expect(JSON.parse(joined)).toEqual(JSON.parse(PRETTY_TEXT));
    expect(Object.keys(JSON.parse(joined))).toEqual(Object.keys(JSON.parse(PRETTY_TEXT)));
  });

  it('正确性锁（嵌套结构 / 空容器 / 转义 / 重复键 / 原始空白）：join 后 parse 与源值深度相等且键序 = 源序', () => {
    const fixtures = [
      '{}',
      '[]',
      '{"a":{},"b":[],"c":[{}],"d":{"e":[]}}',
      '[1,2,3]',
      '{"k":"v","n":[true,false,null],"o":{"p":{"q":1}}}',
      '[[[[[1]]]]]',
      '{"s":"a\\"b\\\\c","u":"\\u00e9\\ud83d\\ude00"}',
      '{"dup":1,"dup":2}',
      '  {\n "a" : 1 }  ',
      '-0',
      '1.5e10',
    ];
    for (const text of fixtures) {
      // maxLineLength=1 强制 pretty（小文档也走行走器，覆盖全部行形态）
      const index = new RawTextIndex(text, { maxLineLength: 1 });
      expect(index.mode).toBe('pretty');
      const joined = allLines(index).lines.join('\n');
      expect(JSON.parse(joined)).toEqual(JSON.parse(text));
      // JSON.stringify 对键序敏感：相等即「键序 = 源序」
      expect(JSON.stringify(JSON.parse(joined))).toBe(JSON.stringify(JSON.parse(text)));
    }
  });

  it('行文本取源切片：\\uXXXX 转义 / 1.0 / 大整数原样保留（不像 JSON.stringify 那样规范化）', () => {
    const text = escapedMinifiedText();
    expect(text.length).toBeGreaterThan(RAW_MAX_LINE_LENGTH);
    const index = new RawTextIndex(text);
    expect(index.mode).toBe('pretty');
    expect(allLines(index).lines).toContain('  "esc": "caf\\u00e9",');
    expect(allLines(index).lines).toContain('  "num": 1.0,');
    expect(allLines(index).lines).toContain('  "big": 1234567890123456789');
    expect(JSON.parse(allLines(index).lines.join('\n'))).toEqual(JSON.parse(text));
  });

  it('cpEvery 注入：检查点边界重放（cpEvery=4 与无检查点参照逐窗一致）', () => {
    const lean = new RawTextIndex(PRETTY_TEXT, { cpEvery: 4 }).build();
    const reference = new RawTextIndex(PRETTY_TEXT, { cpEvery: 100_000 }).build();
    expect(lean.totalLines).toBe(reference.totalLines);
    for (let start = 0; start < PRETTY_LINES.length; start++) {
      expect(lineOf(lean, start, 1)).toEqual([PRETTY_LINES[start]]);
    }
    for (let start = 0; start < PRETTY_LINES.length; start += 7) {
      expect(lineOf(lean, start, 5)).toEqual(PRETTY_LINES.slice(start, start + 5));
    }
  });

  it('超长标量行截断显示，并给出与 lines 对齐的 truncated', () => {
    const longString = 'x'.repeat(RAW_LINE_DISPLAY_MAX + 300);
    const text = '{"a":' + JSON.stringify(longString) + ',"b":1}';
    expect(text.length).toBeGreaterThan(RAW_MAX_LINE_LENGTH);
    const index = new RawTextIndex(text);
    expect(index.mode).toBe('pretty');
    const expected = JSON.stringify(JSON.parse(text), null, 2).split('\n');
    const longLineIndex = 1; // `  "a": "xxx..."`

    const one = index.windowText(longLineIndex, 1);
    expect(one.lines[0]).toHaveLength(RAW_LINE_DISPLAY_MAX);
    expect(one.lines[0]).toBe(expected[longLineIndex].slice(0, RAW_LINE_DISPLAY_MAX));
    expect(one.truncated).toEqual([expected[longLineIndex].length - RAW_LINE_DISPLAY_MAX]);

    const three = index.windowText(0, 3);
    expect(three.lines).toEqual(expected.slice(0, 3).map((line) => line.slice(0, RAW_LINE_DISPLAY_MAX)));
    expect(three.truncated).toEqual([0, expected[longLineIndex].length - RAW_LINE_DISPLAY_MAX, 0]);
  });

  it('pretty locate：偏移 → 行号（检查点二分 + 局部重走）', () => {
    const index = new RawTextIndex(PRETTY_TEXT);
    expect(index.locate(0)).toBe(1); // '{'
    expect(index.locate(1)).toBe(2); // 首个 key 行
    const keyAt = PRETTY_TEXT.indexOf('"key123"');
    const expectedLine = PRETTY_LINES.indexOf('  "key123": 123,') + 1;
    expect(expectedLine).toBeGreaterThan(1);
    expect(index.locate(keyAt)).toBe(expectedLine);
    expect(index.locate(keyAt + 2)).toBe(expectedLine);
    expect(index.locate(PRETTY_TEXT.length)).toBe(PRETTY_LINES.length);
    expect(index.locate(PRETTY_TEXT.length + 99)).toBe(PRETTY_LINES.length);
    expect(index.locate(-1)).toBe(1);
  });

  it('pretty locate 与 cpEvery 无关', () => {
    const lean = new RawTextIndex(PRETTY_TEXT, { cpEvery: 4 });
    const reference = new RawTextIndex(PRETTY_TEXT);
    for (const offset of [0, 1, 2, 17, 100, 400, 2000, PRETTY_TEXT.length]) {
      expect(lean.locate(offset)).toBe(reference.locate(offset));
    }
  });
});

/* ----------------------------- plain 模式 ----------------------------- */

describe('RawTextIndex — plain 模式（damaged：按 \\n 分行 + 每行硬切）', () => {
  it('damaged → plain，优先于形状探测', () => {
    const index = new RawTextIndex('{"a":1}', { damaged: true });
    expect(index.meta()).toMatchObject({ mode: 'plain', damaged: true, totalLines: 1, chars: 7 });
    expect(index.windowText(0, 1).lines).toEqual(['{"a":1}']);
    expect(index.windowText(0, 1).truncated).toBeUndefined();
  });

  it('超长行按 RAW_LINE_DISPLAY_MAX 硬切为多个显示行（内容不丢、不算 truncated）', () => {
    const long = 'x'.repeat(RAW_LINE_DISPLAY_MAX * 2 + 5);
    const text = `${long}\ny`;
    const index = new RawTextIndex(text, { damaged: true });
    expect(index.meta().totalLines).toBe(4); // 4096 + 4096 + 5 + 'y'
    const win = allLines(index);
    expect(win.lines.map((line) => line.length)).toEqual([RAW_LINE_DISPLAY_MAX, RAW_LINE_DISPLAY_MAX, 5, 1]);
    expect(win.lines.slice(0, 3).join('')).toBe(long);
    expect(win.lines[3]).toBe('y');
    expect(win.truncated).toBeUndefined();
  });

  it('locate：偏移 → 硬切后的显示行号；\\n 属于它终止的那行', () => {
    const lineLength = RAW_LINE_DISPLAY_MAX * 2;
    const text = 'a'.repeat(lineLength) + '\n' + 'bcd';
    const index = new RawTextIndex(text, { damaged: true });
    expect(index.meta().totalLines).toBe(3); // 两个显示块 + 'bcd'
    expect(index.locate(0)).toBe(1);
    expect(index.locate(RAW_LINE_DISPLAY_MAX - 1)).toBe(1);
    expect(index.locate(RAW_LINE_DISPLAY_MAX)).toBe(2);
    expect(index.locate(lineLength - 1)).toBe(2);
    expect(index.locate(lineLength)).toBe(2); // '\n' 终止第一行（最后一个显示块）
    expect(index.locate(lineLength + 1)).toBe(3); // 'b'
    expect(index.locate(text.length)).toBe(3);
    expect(index.locate(text.length + 50)).toBe(3);
  });

  it('damaged 文档的空行 / 尾换行同样按源行处理', () => {
    const index = new RawTextIndex('a\n\n', { damaged: true });
    expect(index.meta().totalLines).toBe(3);
    expect(allLines(index).lines).toEqual(['a', '', '']);
    expect(index.locate(1)).toBe(1); // '\n'
    expect(index.locate(2)).toBe(2); // 第二个 '\n'
    expect(index.locate(3)).toBe(3); // 末尾空行
  });

  it('cpEvery 注入：plain 检查点边界重放（硬切行跨检查点时窗口仍逐字）', () => {
    const long = 'z'.repeat(RAW_LINE_DISPLAY_MAX * 3);
    const text = `${long}\ntail`;
    const lean = new RawTextIndex(text, { damaged: true, cpEvery: 2 }).build();
    const reference = new RawTextIndex(text, { damaged: true, cpEvery: 100_000 }).build();
    expect(lean.totalLines).toBe(reference.totalLines);
    for (let start = 0; start < lean.totalLines; start++) {
      expect(lineOf(lean, start, 2)).toEqual(lineOf(reference, start, 2));
      expect(lean.locate(start * RAW_LINE_DISPLAY_MAX)).toBe(reference.locate(start * RAW_LINE_DISPLAY_MAX));
    }
  });
});

/* ------------------------------ 工厂 / 构建 ----------------------------- */

describe('buildRawIndex — 工厂与惰性构建', () => {
  it('工厂返回已构建索引（meta 含 buildMs）', () => {
    const index = buildRawIndex(SOURCE_TEXT);
    expect(index).toBeInstanceOf(RawTextIndex);
    const meta = index.meta();
    expect(meta.totalLines).toBe(SOURCE_LINES.length);
    expect(typeof meta.buildMs).toBe('number');
  });

  it('build() 幂等、返回自身；windowText 未显式 build 也能用（惰性）', () => {
    const index = new RawTextIndex(SOURCE_TEXT);
    expect(index.build()).toBe(index);
    const first = index.meta();
    expect(index.build()).toBe(index);
    expect(index.meta()).toEqual(first);

    const lazy = new RawTextIndex(SOURCE_TEXT);
    expect(lazy.windowText(0, 1).lines).toEqual([SOURCE_LINES[0]]);
  });

  it('cpEvery 缺省 = RAW_CP_EVERY；非法值夹到 1 行', () => {
    expect(RAW_CP_EVERY).toBe(2048);
    const text = Array.from({ length: 5 }, (_, i) => `l${i}`).join('\n');
    const defaulted = new RawTextIndex(text);
    const injected = new RawTextIndex(text, { cpEvery: 0 });
    expect(allLines(defaulted).lines).toEqual(allLines(injected).lines);
  });
});

/* --------------------- pretty 模式：空容器规范化 --------------------- */

describe('RawTextIndex — pretty 空容器（等价 JSON.stringify，不保留源内部空白）', () => {
  it('对象/数组里的空容器写成 {} / []，内部空白丢弃', () => {
    const text = '{"empty"  :  {   }, "arr":[  ]  , "nested":{"a":{ }}}';
    // 注入 maxLineLength=0 强制 pretty 模式（小文本默认会走 source 模式）
    const index = buildRawIndex(text, { maxLineLength: 0 });
    expect(index.mode).toBe('pretty');
    const lines = allLines(index).lines;
    expect(lines).toEqual([
      '{',
      '  "empty": {},',
      '  "arr": [],',
      '  "nested": {',
      '    "a": {}',
      '  }',
      '}',
    ]);
    // 行布局仍可重建：join → JSON.parse 与源值深度相等
    expect(JSON.parse(lines.join('\n'))).toEqual(JSON.parse(text));
  });

  it('值本身是空容器（数组元素 / 根）也规范化', () => {
    const text = '[{ }, [  ]]';
    const index = buildRawIndex(text, { maxLineLength: 0 });
    expect(allLines(index).lines).toEqual(['[', '  {},', '  []', ']']);
  });
});
