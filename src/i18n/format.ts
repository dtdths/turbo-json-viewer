/**
 * i18n/format — worker 诊断**结构化数据 → 本地化文案**的唯一格式化入口（ADR-0026 §4）。
 *
 * worker 只产出 `RepairNote` / `CompletionDetail` / `PatternIssue`；本模块把 domain code 映射到
 * `core.*` 词条。页面所有展示点都走这里（修复条、摘要列表、搜索面板错误、补全 detail），
 * 因此**切语言后旧回包重渲染也正确**——worker 没有语言状态。
 */
import type { CoreError } from '../protocol/errors';
import type { PatternIssue } from '../protocol/errors';
import type { CompletionDetail, JsonKind, RepairCounts, RepairNote } from '../protocol/types';
import { t } from './index';

/** 一条修复操作的说明文案（`RepairOp.note`）。 */
export function repairNoteText(note: RepairNote): string {
  switch (note.code) {
    case 'trailing-comma':
      return t('core.repair.note.trailingComma');
    case 'member-no-value':
      return t('core.repair.note.memberNoValue');
    case 'escape-half':
      return t('core.repair.note.escapeHalf');
    case 'string-unclosed':
      return t('core.repair.note.stringUnclosed');
    case 'literal-partial':
      return t('core.repair.note.literalPartial', { literal: note.literal });
    case 'number-dropped':
      return t('core.repair.note.numberDropped', { literal: note.literal });
    case 'number-prefix':
      return t('core.repair.note.numberPrefix', { literal: note.literal, keep: note.keep });
    case 'key-no-value':
      return t('core.repair.note.keyNoValue');
    case 'dangling-key':
      return t('core.repair.note.danglingKey');
    case 'closers':
      return t('core.repair.note.closers', {
        n: note.count,
        closers: note.closers,
        where: note.where,
      });
  }
}

/**
 * 一行修复摘要（由 counts 拼出；与旧 `summaryText` 逐字等价，见 ADR-0026 §4）。
 * 零计数项省略；零项时给「已修复（仅语法闭合…）」。
 */
export function repairSummaryText(counts: RepairCounts | undefined): string {
  const bits: string[] = [];
  const deleted = counts?.deletedChars ?? 0;
  const brackets = counts?.brackets ?? 0;
  const quotes = counts?.quotes ?? 0;
  // 计数按旧口径裸数字（不加千分位）：与 i18n 化之前的摘要逐字一致
  const raw = (value: number) => String(value);
  if (deleted > 0) {
    bits.push(t('core.repair.summary.deletedChars', { n: deleted, count: raw(deleted) }));
  }
  const closes: string[] = [];
  if (brackets > 0) {
    closes.push(t('core.repair.summary.bracket', { n: brackets, count: raw(brackets) }));
  }
  if (quotes > 0) {
    closes.push(t('core.repair.summary.quote', { n: quotes, count: raw(quotes) }));
  }
  if (closes.length > 0) {
    bits.push(t('core.repair.summary.closes', { list: closes.join(t('core.listSeparator')) }));
  }
  if (bits.length === 0) return t('core.repair.summary.repairedNone');
  return t('core.repair.summary.repaired', { bits: bits.join(t('core.listSeparator')) });
}

/**
 * 正则不可用文案（`BAD_PATTERN`）。
 * `syntax` 把引擎原文（英文 reason）附在本地化前缀后；`too-long` 用 `patternLimit`；
 * 无 `patternIssue` 的旧包 / 未知错误退回原始 `message`（不吞信息）。
 */
export function patternErrorText(error: CoreError): string {
  const issue: PatternIssue | undefined = error.patternIssue;
  if (issue === 'syntax') return t('core.pattern.syntax', { reason: error.message });
  if (issue === 'too-long') {
    return t('core.pattern.tooLong', { n: error.patternLimit ?? 0 });
  }
  if (issue === 'backtracking') return t('core.pattern.backtracking');
  return error.message;
}

/** 补全项右侧说明（CM6 `detail`）。 */
export function completionDetailText(detail: CompletionDetail): string {
  switch (detail.scope) {
    case 'root-field':
      return t('core.complete.detail.rootField', { kind: kindText(detail.kind) });
    case 'root-field-plain':
      return t('core.complete.detail.rootFieldPlain');
    case 'sampled-field':
      return t('core.complete.detail.sampled', {
        kind: kindText(detail.kind),
        freq: detail.freq,
        samples: detail.samples,
      });
    case 'global':
      return t('core.complete.detail.global');
    case 'math-method':
      return t('core.complete.detail.mathMethod');
    case 'array-method':
      return t('core.complete.detail.arrayMethod');
    case 'string-method':
      return t('core.complete.detail.stringMethod');
    case 'json-method':
      return t('core.complete.detail.jsonMethod');
    case 'property':
      return t('core.complete.detail.property');
  }
}

/** 类型名（`mixed` 走词条；其余 JsonKind 是英文标识符，与现状一致）。 */
function kindText(kind: JsonKind | 'mixed'): string {
  return kind === 'mixed' ? t('core.complete.kind.mixed') : kind;
}
