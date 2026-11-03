/**
 * shared/json-lex — 零依赖单趟 JSON lexer 原语（ADR-0003 修订 2026-11-03）。
 *
 * 一份实现两处消费：
 *   - core/raw-text 的检查点 pretty 行走器（只认结构、不建值图）；
 *   - view/raw 的行高亮（只对屏幕内几十行做 lexLine）。
 *
 * 性能纪律：热循环零分配 —— `lexToken` 把结果写进模块级 `last`，调用方必须在下次调用前读走；
 * 单线程使用（Node 单测 / 一个 Worker / 主线程各一份实例，互不共享）。
 *
 * 来源：`prototype/p1/bench/fidelity/lib/json-lex.mjs`（重评估实测 0.2µs/行）。
 */

export const T = {
  OBJ: 1,
  ARR: 2,
  OBJ_END: 3,
  ARR_END: 4,
  STR: 5,
  NUM: 6,
  LIT: 7, // true / false / null
  COLON: 8,
  COMMA: 9,
  BAD: 10,
  EOF: 11,
} as const;

export type TokenType = (typeof T)[keyof typeof T];

export const C = {
  TAB: 9,
  LF: 10,
  CR: 13,
  SPACE: 32,
  QUOTE: 34,
  COMMA: 44,
  MINUS: 45,
  DOT: 46,
  COLON: 58,
  LBRACK: 91,
  BACKSLASH: 92,
  RBRACK: 93,
  LBRACE: 123,
  RBRACE: 125,
} as const;

/** 最近一次 `lexToken` 的结果（end = token 结束偏移，type = TokenType） */
export interface LastToken {
  end: number;
  type: TokenType;
}

export const last: LastToken = { end: 0, type: T.EOF };

export function isWs(c: number): boolean {
  return c === C.SPACE || c === C.LF || c === C.CR || c === C.TAB;
}

/** 跳过空白，返回第一个非空白字符偏移。 */
export function skipWs(s: string, i: number): number {
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === C.SPACE || c === C.LF || c === C.CR || c === C.TAB) i++;
    else break;
  }
  return i;
}

const isDigit = (c: number): boolean => c >= 48 && c <= 57;

/**
 * 从 i（必须指向 token 首字符、无前导空白）开始 lex 一个 JSON token，返回结束偏移。
 * 结果写进模块级 `last`。字符串：跳到闭合引号之后；未闭合字符串到 EOF 结束（type 仍是 STR）。
 */
export function lexToken(s: string, i: number): number {
  const n = s.length;
  if (i >= n) {
    last.end = i;
    last.type = T.EOF;
    return i;
  }
  const c = s.charCodeAt(i);
  switch (c) {
    case C.LBRACE:
      last.end = i + 1;
      last.type = T.OBJ;
      return i + 1;
    case C.RBRACE:
      last.end = i + 1;
      last.type = T.OBJ_END;
      return i + 1;
    case C.LBRACK:
      last.end = i + 1;
      last.type = T.ARR;
      return i + 1;
    case C.RBRACK:
      last.end = i + 1;
      last.type = T.ARR_END;
      return i + 1;
    case C.COLON:
      last.end = i + 1;
      last.type = T.COLON;
      return i + 1;
    case C.COMMA:
      last.end = i + 1;
      last.type = T.COMMA;
      return i + 1;
    case C.QUOTE: {
      let j = i + 1;
      while (j < n) {
        const d = s.charCodeAt(j);
        if (d === C.BACKSLASH) {
          j += 2;
          continue;
        }
        if (d === C.QUOTE) {
          last.end = j + 1;
          last.type = T.STR;
          return j + 1;
        }
        j++;
      }
      last.end = n;
      last.type = T.STR;
      return n;
    }
    default: {
      if (c === C.MINUS || isDigit(c)) {
        let j = i + 1;
        while (j < n) {
          const d = s.charCodeAt(j);
          if (isDigit(d) || d === C.DOT || d === 101 || d === 69 || d === 43 || d === C.MINUS) j++;
          else break;
        }
        last.end = j;
        last.type = T.NUM;
        return j;
      }
      if (c === 116 || c === 102 || c === 110) {
        // t / f / n 字面量
        let j = i + 1;
        while (j < n) {
          const d = s.charCodeAt(j);
          if ((d >= 97 && d <= 122) || (d >= 65 && d <= 90)) j++;
          else break;
        }
        last.end = j;
        last.type = T.LIT;
        return j;
      }
      last.end = i + 1;
      last.type = T.BAD;
      return i + 1;
    }
  }
}

/** 高亮 run：token 类型 + `[s, e)` 偏移（相对传入的行文本）。 */
export interface HighlightRun {
  t: TokenType;
  s: number;
  e: number;
}

/**
 * 把一行文本 lex 成高亮 run（view 只对屏幕内行调用）。
 * 偏移相对 `line`；空白不进 run（由 CSS 保留）。
 */
export function lexLine(line: string): HighlightRun[] {
  const out: HighlightRun[] = [];
  let i = skipWs(line, 0);
  const n = line.length;
  while (i < n) {
    const start = i;
    const end = lexToken(line, i);
    const type = last.type;
    out.push({ t: type, s: start, e: end });
    i = skipWs(line, end);
  }
  return out;
}
