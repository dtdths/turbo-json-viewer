/**
 * tests/unit/i18n/format — worker 诊断结构化 → 本地化文案（ADR-0026 §4）。
 *
 * 断言中文输出与 i18n 化之前的旧字符串**逐字一致**（16 套冒烟按这些文案断言）。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  completionDetailText,
  patternErrorText,
  repairNoteText,
  repairSummaryText,
} from '../../../src/i18n/format';
import { initI18n } from '../../../src/i18n/index';
import { CoreError } from '../../../src/protocol/errors';
import type { RepairCounts } from '../../../src/protocol/types';

beforeAll(async () => {
  await initI18n('zh-CN');
});

describe('repairSummaryText（由 counts 拼出，旧 summaryText 的逐字等价）', () => {
  it('零计数 → 「已修复（仅语法闭合…）」', () => {
    expect(repairSummaryText(undefined)).toBe('已修复（仅语法闭合，未修改任何已有值）');
    expect(repairSummaryText({ brackets: 0, quotes: 0, commas: 0, deletedChars: 0 })).toBe(
      '已修复（仅语法闭合，未修改任何已有值）',
    );
  });

  it('零计数项省略、顿号连接', () => {
    const counts: RepairCounts = { brackets: 1, quotes: 2, commas: 3, deletedChars: 4 };
    expect(repairSummaryText(counts)).toBe(
      '已修复：删除 4 个字符、补 1 个闭合符、2 个结束引号（仅语法闭合，未修改任何已有值）',
    );
    expect(repairSummaryText({ brackets: 0, quotes: 1, commas: 0, deletedChars: 0 })).toBe(
      '已修复：补 1 个结束引号（仅语法闭合，未修改任何已有值）',
    );
  });

  it('计数保持裸数字（与 i18n 化之前的摘要逐字一致，不加千分位）', () => {
    expect(repairSummaryText({ brackets: 0, quotes: 0, commas: 0, deletedChars: 1234 })).toBe(
      '已修复：删除 1234 个字符（仅语法闭合，未修改任何已有值）',
    );
    expect(repairSummaryText({ brackets: 6, quotes: 1, commas: 0, deletedChars: 0 })).toBe(
      '已修复：补 6 个闭合符、1 个结束引号（仅语法闭合，未修改任何已有值）',
    );
  });
});

describe('repairNoteText（每个 RepairNote code 的中文）', () => {
  it('无参 code', () => {
    expect(repairNoteText({ code: 'trailing-comma' })).toBe('尾随逗号 → 删除');
    expect(repairNoteText({ code: 'member-no-value' })).toBe(
      '键名未写完且没有值可保留 → 丢弃整个成员（不补引号）',
    );
    expect(repairNoteText({ code: 'escape-half' })).toBe('末尾是不完整转义 → 丢弃（不猜测字符）');
    expect(repairNoteText({ code: 'string-unclosed' })).toBe('字符串未闭合 → 补结束引号');
    expect(repairNoteText({ code: 'key-no-value' })).toBe(
      '键已闭合但后面没有值 → 删除该键（不补值、不猜冒号）',
    );
    expect(repairNoteText({ code: 'dangling-key' })).toBe('悬空的键（后面没有值）→ 连同冒号删除');
  });

  it('带参 code 插值', () => {
    expect(repairNoteText({ code: 'literal-partial', literal: 'tru' })).toBe(
      '不完整字面量 `tru` → 丢弃（不猜测 true/false/null）',
    );
    expect(repairNoteText({ code: 'number-dropped', literal: '1.2e' })).toBe(
      '不完整数字 `1.2e` → 整段丢弃（没有合法前缀可保留）',
    );
    expect(repairNoteText({ code: 'number-prefix', literal: '1.2e', keep: '1.2' })).toBe(
      '不完整数字 `1.2e` → 只保留合法前缀 `1.2`（不补数字）',
    );
    expect(
      repairNoteText({ code: 'closers', count: 2, closers: '}]', where: '{@3, [@9' }),
    ).toBe('补 2 个闭合符 `}]`（对应未闭合的 {@3, [@9）');
  });
});

describe('patternErrorText', () => {
  it('syntax：本地化前缀 + 引擎原文 reason', () => {
    const error = new CoreError({
      code: 'BAD_PATTERN',
      message: 'Invalid regular expression: /(/: Unterminated group',
      patternIssue: 'syntax',
    });
    expect(patternErrorText(error)).toBe(
      '正则语法错误：Invalid regular expression: /(/: Unterminated group',
    );
  });

  it('too-long：使用 patternLimit', () => {
    const error = new CoreError({
      code: 'BAD_PATTERN',
      message: 'pattern too long',
      patternIssue: 'too-long',
      patternLimit: 512,
    });
    expect(patternErrorText(error)).toBe('正则过长（上限 512 字符）');
  });

  it('backtracking', () => {
    const error = new CoreError({
      code: 'BAD_PATTERN',
      message: 'catastrophic backtracking',
      patternIssue: 'backtracking',
    });
    expect(patternErrorText(error)).toBe('该正则可能触发灾难性回溯');
  });

  it('无 patternIssue 的旧包 → 退回原始 message（不吞信息）', () => {
    const error = new CoreError({ code: 'BAD_PATTERN', message: 'legacy message' });
    expect(patternErrorText(error)).toBe('legacy message');
  });
});

describe('completionDetailText（旧 detail 字符串的逐字等价）', () => {
  it('根字段 / 路径样本 / 方法 / 属性 / 全局', () => {
    expect(completionDetailText({ scope: 'root-field', kind: 'object' })).toBe('根字段 · object');
    expect(completionDetailText({ scope: 'root-field-plain' })).toBe('根字段');
    expect(
      completionDetailText({ scope: 'sampled-field', kind: 'string', freq: 3, samples: 10 }),
    ).toBe('string · 采样 3/10');
    expect(
      completionDetailText({ scope: 'sampled-field', kind: 'mixed', freq: 1, samples: 2 }),
    ).toBe('混合 · 采样 1/2');
    expect(completionDetailText({ scope: 'global' })).toBe('全局');
    expect(completionDetailText({ scope: 'math-method' })).toBe('Math 方法');
    expect(completionDetailText({ scope: 'array-method' })).toBe('array 方法');
    expect(completionDetailText({ scope: 'string-method' })).toBe('string 方法');
    expect(completionDetailText({ scope: 'json-method' })).toBe('JSON 方法');
    expect(completionDetailText({ scope: 'property' })).toBe('属性');
  });
});
