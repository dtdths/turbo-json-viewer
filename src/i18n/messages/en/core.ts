/**
 * en/core — worker 诊断文案（页面侧格式化，`src/i18n/format.ts`）。
 *
 * worker 只产出结构化 code/params（`RepairNote` / `CompletionDetail` / `PatternIssue`），
 * 不感知语言；本文件是这些 code 的英文词条。
 */
export const core = {
  /** 列表连接符（修复摘要等；zh 用顿号） */
  'core.listSeparator': ', ',

  /* ---------------- 修复：逐条 note ---------------- */
  'core.repair.note.trailingComma': 'Trailing comma → removed',
  'core.repair.note.memberNoValue':
    'Key name incomplete with no value to keep → dropped the whole member (no quotes added)',
  'core.repair.note.escapeHalf': 'Incomplete escape at the end → dropped (no character guessed)',
  'core.repair.note.stringUnclosed': 'Unclosed string → added the closing quote',
  'core.repair.note.literalPartial':
    'Incomplete literal `{literal}` → dropped (true/false/null not guessed)',
  'core.repair.note.numberDropped':
    'Incomplete number `{literal}` → dropped entirely (no valid prefix to keep)',
  'core.repair.note.numberPrefix':
    'Incomplete number `{literal}` → kept only the valid prefix `{keep}` (no digits added)',
  'core.repair.note.keyNoValue':
    'Key closed but no value followed → removed the key (no value added, no colon guessed)',
  'core.repair.note.danglingKey': 'Dangling key (no value) → removed together with the colon',
  'core.repair.note.closers': {
    one: 'Added {n} closing bracket `{closers}` (for unclosed {where})',
    other: 'Added {n} closing brackets `{closers}` (for unclosed {where})',
  },

  /* ---------------- 修复：一行摘要 ---------------- */
  'core.repair.summary.deletedChars': {
    one: '{count} character deleted',
    other: '{count} characters deleted',
  },
  'core.repair.summary.bracket': {
    one: '{count} closing bracket',
    other: '{count} closing brackets',
  },
  'core.repair.summary.quote': {
    one: '{count} closing quote',
    other: '{count} closing quotes',
  },
  /** 闭合符/结束引号合并成一组，统一加前缀（旧文案「补 6 个闭合符、1 个结束引号」） */
  'core.repair.summary.closes': 'Added {list}',
  'core.repair.summary.repaired':
    'Repaired: {bits} (syntax closed only; no existing values changed)',
  'core.repair.summary.repairedNone':
    'Repaired (syntax closed only; no existing values changed)',

  /* ---------------- 搜索：正则不可用 ---------------- */
  'core.pattern.syntax': 'Invalid regular expression: {reason}',
  'core.pattern.tooLong': 'Pattern too long (limit: {n} characters)',
  'core.pattern.backtracking': 'This pattern may cause catastrophic backtracking',

  /* ---------------- 补全：detail ---------------- */
  'core.complete.kind.mixed': 'mixed',
  'core.complete.detail.sampled': '{kind} · sampled {freq}/{samples}',
  'core.complete.detail.rootField': 'root field · {kind}',
  'core.complete.detail.rootFieldPlain': 'root field',
  'core.complete.detail.global': 'global',
  'core.complete.detail.mathMethod': 'Math method',
  'core.complete.detail.arrayMethod': 'array method',
  'core.complete.detail.stringMethod': 'string method',
  'core.complete.detail.jsonMethod': 'JSON method',
  'core.complete.detail.property': 'property',
} as const;

export type CoreMessages = typeof core;
