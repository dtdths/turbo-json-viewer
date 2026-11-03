/**
 * core/repair 单测 — 截断 JSON 的保守修复（#8 / ADR-0004 修订 2026-11-03）。
 *
 * 契约（docs/design/reassess-fidelity.md §6.1 fixture 表 + §6.2 规则表）：
 *   1. 原文本 JSON.parse 通过 → { status: 'none' }（不返回文本）；
 *   2. EOF 形态 → 只做语法闭合（补闭合符/补结束引号/删尾逗号/删悬空成员/删半个字面量），
 *      输出必须 JSON.parse 通过 → status='repaired'；
 *   3. 非 EOF 形态（完整值后面还有内容 / 中途语法错 / 空文档）→ status='unrepairable'、
 *      reason='not-eof'，**不产生文本**；尝试修复后仍不可解析 → reason='still-invalid'；
 *   4. ops[].at 一律指向**原文本**偏移：delete 的 text 等于原文本切片，
 *      insert 的 at = 原文本长度（source.length）。
 */
import { describe, expect, it } from 'vitest';
import { repairTruncatedJson } from '../../../src/core/repair';
import type { RepairCounts } from '../../../src/protocol/types';

/** §6.1 的 16 个截断 fixture：源文本 → 修复后应逐字等于的文本 */
const TRUNCATED: [string, string][] = [
  ['{"a":1,"b":"hello wor', '{"a":1,"b":"hello wor"}'],
  // 末尾是**真实反斜杠**（半个转义）
  ['{"s":"ab\\', '{"s":"ab"}'],
  // 末尾是字面量 \u00（半个 \uXXXX）
  ['{"s":"ab\\u00', '{"s":"ab"}'],
  ['{"a":1,"b":{"c":2', '{"a":1,"b":{"c":2}}'],
  ['{"items":[1,2,3', '{"items":[1,2,3]}'],
  ['{"items":[', '{"items":[]}'],
  ['{"a":1,', '{"a":1}'],
  ['{"a":[1,2,', '{"a":[1,2]}'],
  ['{"a":', '{}'],
  ['{"n":1234567', '{"n":1234567}'],
  ['{"n":1.2e', '{"n":1.2}'],
  ['{"t":tru', '{}'],
  ['{"t":nul', '{}'],
  ['{"a":1,"bb', '{"a":1}'],
  ['{"a":{"b":[{"c":[1,{"d":"x', '{"a":{"b":[{"c":[1,{"d":"x"}]}]}}'],
  ['[{"id":1,"x":2},{"id":3,"na', '[{"id":1,"x":2},{"id":3}]'],
];

/** 两个「本来就合法」的 fixture（只有尾随空白 / 完全合法） */
const NOT_TRUNCATED: string[] = ['{"a":1}   \n  ', '{"a":1,"b":2}'];

/** 非 EOF 形态：不修复、不猜内容 */
const UNREPAIRABLE: string[] = [
  '{"a":1}XYZ', // 完整值后面有垃圾
  '[1,2]garbage',
  '{a:1}', // 键没加引号
  '{"a" 1}', // 缺冒号
  '{"a":1}{"b":2}', // 两个顶层值
  '', // 空文档：没有可闭合的东西
  '   ', // 只有空白
];

const isParsable = (text: string): boolean => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

describe('repairTruncatedJson — 本来就合法（§6.1 后 2 个 fixture）', () => {
  for (const source of NOT_TRUNCATED) {
    it(`${JSON.stringify(source)} → status none，不返回文本`, () => {
      const r = repairTruncatedJson(source);
      // 「JSON.parse 通过 → { status: 'none' }」：非截断输入不产生任何编辑信息
      expect(r).toEqual({ status: 'none' });
      expect(r.text).toBeUndefined();
      expect(r.ops).toBeUndefined();
      expect(r.counts).toBeUndefined();
      expect(r.truncatedAt).toBeUndefined();
      expect(r.unrepairableReason).toBeUndefined();
    });
  }
});

describe('repairTruncatedJson — 16 个截断 fixture 逐字修复（§6.1）', () => {
  for (const [source, expected] of TRUNCATED) {
    it(`${JSON.stringify(source)} → ${JSON.stringify(expected)}`, () => {
      const r = repairTruncatedJson(source);

      expect(r.status).toBe('repaired');
      expect(r.text).toBe(expected);
      // 自校验：修复结果必须真的可解析
      expect(isParsable(r.text as string)).toBe(true);
      expect(r.truncatedAt).toBe(source.length);
      expect(r.unrepairableReason).toBeUndefined();
      expect(r.counts).toBeDefined();
      expect(r.summaryText).toBeDefined();
      // 修完即合法 → 再修一次应判定 none（幂等）
      expect(repairTruncatedJson(r.text as string)).toEqual({ status: 'none' });
    });
  }
});

describe('repairTruncatedJson — 非 EOF 形态拒绝修复', () => {
  for (const source of UNREPAIRABLE) {
    it(`${JSON.stringify(source)} → unrepairable/not-eof，不产出文本`, () => {
      const r = repairTruncatedJson(source);

      expect(r.status).toBe('unrepairable');
      expect(r.unrepairableReason).toBe('not-eof');
      // 不猜内容：没有「修好的文本」、没有编辑列表
      expect(r.text).toBeUndefined();
      expect(r.ops).toBeUndefined();
      expect(r.counts).toBeUndefined();
      expect(r.summaryText).toBeUndefined();
      expect(r.truncatedAt).toBeUndefined();
    });
  }
});

describe('repairTruncatedJson — counts（§6.3 形状）', () => {
  const CASES: [string, RepairCounts][] = [
    // 只补：1 个 `}` + 1 个 `"`
    ['{"a":1,"b":"hello wor', { brackets: 1, quotes: 1, commas: 0, deletedChars: 0 }],
    // 删半个转义（1 字符）+ 补引号 + 补 `}`
    ['{"s":"ab\\', { brackets: 1, quotes: 1, commas: 0, deletedChars: 1 }],
    // 删 `\u00`（4 字符）
    ['{"s":"ab\\u00', { brackets: 1, quotes: 1, commas: 0, deletedChars: 4 }],
    // 删尾逗号 + 补 `}`
    ['{"a":1,', { brackets: 1, quotes: 0, commas: 1, deletedChars: 1 }],
    // 删尾逗号 + 补 `]}`（一次插入两个闭合符）
    ['{"a":[1,2,', { brackets: 2, quotes: 0, commas: 1, deletedChars: 1 }],
    // 删悬空成员 `"a":`（4 字符）+ 补 `}`
    ['{"a":', { brackets: 1, quotes: 0, commas: 0, deletedChars: 4 }],
    // 数字只保留合法前缀 `1.2` → 删 1 字符
    ['{"n":1.2e', { brackets: 1, quotes: 0, commas: 0, deletedChars: 1 }],
    // 删半个字面量 `tru` + 悬空键 `"t":`
    ['{"t":tru', { brackets: 1, quotes: 0, commas: 0, deletedChars: 7 }],
    // 删半个键 `"bb` + 前导逗号
    ['{"a":1,"bb', { brackets: 1, quotes: 0, commas: 1, deletedChars: 4 }],
    // 6 个闭合符（嵌套三层）+ 1 个结束引号
    ['{"a":{"b":[{"c":[1,{"d":"x', { brackets: 6, quotes: 1, commas: 0, deletedChars: 0 }],
    // 删半个键 + 前导逗号 + 补 `}]`
    ['[{"id":1,"x":2},{"id":3,"na', { brackets: 2, quotes: 0, commas: 1, deletedChars: 4 }],
  ];

  for (const [source, counts] of CASES) {
    it(`${JSON.stringify(source)} → ${JSON.stringify(counts)}`, () => {
      expect(repairTruncatedJson(source).counts).toEqual(counts);
    });
  }

  it('deletedChars = 所有 delete op 的字符数之和（含被删的逗号）', () => {
    for (const [source] of TRUNCATED) {
      const r = repairTruncatedJson(source);
      const deleted = (r.ops ?? [])
        .filter((op) => op.op === 'delete')
        .reduce((sum, op) => sum + op.text.length, 0);
      expect(r.counts?.deletedChars).toBe(deleted);
      expect(r.counts?.commas).toBe((r.ops ?? []).filter((op) => op.op === 'delete' && op.scope === 'comma').length);
    }
  });

  it('brackets = 插入的 `}`/`]` 个数，quotes = 插入的结束引号个数', () => {
    for (const [source] of TRUNCATED) {
      const r = repairTruncatedJson(source);
      const ops = r.ops ?? [];
      const closerChars = ops
        .filter((op) => op.op === 'insert' && op.scope === 'container')
        .reduce((sum, op) => sum + op.text.length, 0);
      const quoteInserts = ops.filter((op) => op.op === 'insert' && op.scope === 'string').length;
      expect(r.counts?.brackets).toBe(closerChars);
      expect(r.counts?.quotes).toBe(quoteInserts);
      // 所有闭合符只会是 `}` / `]`
      for (const op of ops) {
        if (op.op === 'insert' && op.scope === 'container') expect(op.text).toMatch(/^[}\]]+$/);
      }
    }
  });
});

describe('repairTruncatedJson — summaryText（中文一行、零计数省略）', () => {
  it('只补闭合符 + 结束引号', () => {
    const r = repairTruncatedJson('{"a":{"b":[{"c":[1,{"d":"x');
    expect(r.summaryText).toBe('已修复：补 6 个闭合符、1 个结束引号（仅语法闭合，未修改任何已有值）');
  });

  it('有删除时「删除 N 个字符」在前', () => {
    const r = repairTruncatedJson('{"a":1,"bb');
    expect(r.summaryText).toBe('已修复：删除 4 个字符、补 1 个闭合符（仅语法闭合，未修改任何已有值）');
  });

  it('只有闭合符（无结束引号）时不出现「结束引号」', () => {
    const r = repairTruncatedJson('{"items":[1,2,3');
    expect(r.summaryText).toBe('已修复：补 2 个闭合符（仅语法闭合，未修改任何已有值）');
  });

  it('所有已修复 fixture 的摘要都以固定后缀收尾且不含零计数项', () => {
    for (const [source] of TRUNCATED) {
      const r = repairTruncatedJson(source);
      const summary = r.summaryText as string;
      expect(summary.startsWith('已修复：')).toBe(true);
      expect(summary.endsWith('（仅语法闭合，未修改任何已有值）')).toBe(true);
      expect(summary).toContain('仅语法闭合');
      const counts = r.counts as RepairCounts;
      if (counts.deletedChars === 0) expect(summary).not.toContain('删除');
      if (counts.quotes === 0) expect(summary).not.toContain('结束引号');
      if (counts.brackets === 0) expect(summary).not.toContain('闭合符');
    }
  });
});

describe('repairTruncatedJson — ops（偏移指向原文本）', () => {
  it('所有 insert 的 at = 原文本长度；delete 的 text = 原文本切片', () => {
    for (const [source] of TRUNCATED) {
      const r = repairTruncatedJson(source);
      const ops = r.ops as NonNullable<typeof r.ops>;
      // 有变化才报 repaired → ops 不能为空
      expect(ops.length).toBeGreaterThan(0);

      for (const op of ops) {
        expect(Number.isInteger(op.at)).toBe(true);
        expect(op.at).toBeGreaterThanOrEqual(0);
        expect(op.at).toBeLessThanOrEqual(source.length);
        expect(['container', 'string', 'token', 'member', 'comma']).toContain(op.scope);
        expect(typeof op.note).toBe('string');
        expect(op.note.length).toBeGreaterThan(0);
        expect(['insert', 'delete']).toContain(op.op);

        if (op.op === 'insert') {
          expect(op.text.length).toBeGreaterThan(0);
          expect(op.at).toBe(source.length);
        } else {
          expect(source.slice(op.at, op.at + op.text.length)).toBe(op.text);
          expect(op.text.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('闭合符合成**一条** insert op（多个闭合符不拆开）', () => {
    const r = repairTruncatedJson('{"items":[1,2,3');
    const closers = (r.ops ?? []).filter((op) => op.op === 'insert' && op.scope === 'container');
    expect(closers).toHaveLength(1);
    expect(closers[0].text).toBe(']}');
    expect(closers[0].at).toBe('{"items":[1,2,3'.length);
    // note 交代「补几个」与对应未闭合容器的原文偏移
    expect(closers[0].note).toContain('补 2 个闭合符');
    expect(closers[0].note).toContain(']}');
    expect(closers[0].note).toContain('{@0');
    expect(closers[0].note).toContain('[@9');
  });

  it('不完整转义的 note 明说不猜测字符', () => {
    const r = repairTruncatedJson('{"s":"ab\\');
    const del = (r.ops ?? []).find((op) => op.op === 'delete');
    expect(del?.scope).toBe('string');
    expect(del?.text).toBe('\\');
    expect(del?.at).toBe('{"s":"ab'.length);
    expect(del?.note).toContain('不完整转义');
    expect(del?.note).toContain('不猜测');
  });

  it('深层嵌套：闭合符按容器栈逆序补齐并给出全部未闭合容器偏移', () => {
    const r = repairTruncatedJson('{"a":{"b":[{"c":[1,{"d":"x');
    const closer = (r.ops ?? []).find((op) => op.op === 'insert' && op.scope === 'container');
    expect(closer?.text).toBe('}]}]}}');
    expect(closer?.note).toContain('补 6 个闭合符');
    expect(closer?.note).toContain('{@0');
    expect(closer?.note).toContain('{@19');
  });

  it('修复后文本 = 应用 ops 后的结果（右到左不串位）', () => {
    // 字符串尾部：删转义 + 补引号 + 补 `}` 三者偏移相邻，若应用顺序出错会得到 `{"s":"ab"}}`
    const r = repairTruncatedJson('{"s":"ab\\');
    expect(r.text).toBe('{"s":"ab"}');
  });
});

describe('repairTruncatedJson — 不抛错 / 不自造内容', () => {
  it('对任意畸形输入都不抛错', () => {
    const WEIRD = [
      '',
      ' ',
      '\n\t',
      '{',
      '[',
      '"',
      '"abc',
      '\\',
      '{"a"',
      '{"a":-',
      '{"a":1.',
      '{"a":01',
      '{"a":tru}',
      '{"a":1.2.3}',
      '[1,2',
      '[[[[[[',
      '{"a":"\\u12"}',
      'nul',
      'tru',
      '{\u0000}',
      '{"a":1,}',
      '[1,]',
      '{"a":1} ',
      '{"a":"x\\u00zz"}',
    ];
    for (const source of WEIRD) {
      expect(() => repairTruncatedJson(source)).not.toThrow();
      const r = repairTruncatedJson(source);
      expect(['none', 'repaired', 'unrepairable']).toContain(r.status);
      // 只要给了文本，就必须真的可解析
      if (r.text !== undefined) expect(isParsable(r.text)).toBe(true);
      // 不可修复时不给文本（不猜内容）
      if (r.status === 'unrepairable') expect(r.text).toBeUndefined();
    }
  });

  it('数字只保留合法前缀，不补齐尾数（`1.2e` → `1.2`）', () => {
    expect(repairTruncatedJson('{"n":1.2e').text).toBe('{"n":1.2}');
    expect(repairTruncatedJson('{"n":1.2e+').text).toBe('{"n":1.2}');
    // 没有合法前缀可保留时整段丢弃，不写 `0`
    expect(repairTruncatedJson('{"n":-').text).toBe('{}');
  });

  it('尝试修复后仍不可解析 → unrepairable/still-invalid（顶层只剩半个 token，无内容可闭）', () => {
    for (const source of ['-', 'tru']) {
      const r = repairTruncatedJson(source);
      expect(r.status).toBe('unrepairable');
      expect(r.unrepairableReason).toBe('still-invalid');
      // 仍然不猜内容：没有文本、没有 ops
      expect(r.text).toBeUndefined();
      expect(r.ops).toBeUndefined();
    }
  });

  it('半个字面量一律丢弃，不按前缀补成 true/false/null', () => {
    expect(repairTruncatedJson('{"t":tru').text).toBe('{}');
    expect(repairTruncatedJson('{"t":fals').text).toBe('{}');
    expect(repairTruncatedJson('{"t":nul').text).toBe('{}');
    // 数组里的半个元素同样丢弃（连带前一个逗号）
    expect(repairTruncatedJson('[1,tru').text).toBe('[1]');
    // 合法的完整字面量保留
    expect(repairTruncatedJson('{"t":true').text).toBe('{"t":true}');
  });
});
