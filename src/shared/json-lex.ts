/**
 * shared/json-lex — 零依赖单趟 JSON lexer（ADR-0003 修订 2026-11-03）。
 *
 * 一份实现两处消费：
 *   - core/raw-text 的检查点 pretty 行走器（只认结构、不建值图）；
 *   - view/raw 的行高亮（只对屏幕内几十行做 lexLine）。
 *
 * 状态是**实例**字段（`JsonLexer.last`），不是模块级单例：每个消费方（Worker 里的 RawTextIndex、
 * 主线程里的 RawView）持有自己的实例，同 realm 内多份使用互不串味。这样 shared 保持「零依赖、
 * 无模块状态」的纪律，同时热循环仍然零分配（`lexToken` 把端偏移与类型写进 `last`，调用方立即读走）。
 *
 * 来源：`prototype/p1/bench/fidelity/lib/json-lex.mjs`（重评估实测 0.2µs/行）。
 */

export const TOK = {
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

export type TokenType = (typeof TOK)[keyof typeof TOK];

export const CH = {
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

/** 高亮 run：token 类型 + `[s, e)` 偏移（相对传入的行文本）。 */
export interface HighlightRun {
  t: TokenType;
  s: number;
  e: number;
}

function isWs(c: number): boolean {
  return c === CH.SPACE || c === CH.LF || c === CH.CR || c === CH.TAB;
}

function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}

export class JsonLexer {
  /**
   * 上一次 `lexToken` 的结果。热循环零分配：`lexToken` 只写这个对象，不返回新对象。
   * 调用方必须在下次 `lexToken` 之前读走。
   */
  readonly last: LastToken = { end: 0, type: TOK.EOF };

  /** 跳过空白，返回第一个非空白字符偏移。 */
  skipWs(s: string, i: number): number {
    const n = s.length;
    while (i < n) {
      const c = s.charCodeAt(i);
      if (c === CH.SPACE || c === CH.LF || c === CH.CR || c === CH.TAB) i++;
      else break;
    }
    return i;
  }

  /**
   * 从 i（必须指向 token 首字符、无前导空白）开始 lex 一个 JSON token，返回结束偏移。
   * 结果写进 `last`。字符串：跳到闭合引号之后；未闭合字符串到 EOF 结束（type 仍是 STR）。
   */
  lexToken(s: string, i: number): number {
    const last = this.last;
    const n = s.length;
    if (i >= n) {
      last.end = i;
      last.type = TOK.EOF;
      return i;
    }
    const c = s.charCodeAt(i);
    switch (c) {
      case CH.LBRACE:
        last.end = i + 1;
        last.type = TOK.OBJ;
        return i + 1;
      case CH.RBRACE:
        last.end = i + 1;
        last.type = TOK.OBJ_END;
        return i + 1;
      case CH.LBRACK:
        last.end = i + 1;
        last.type = TOK.ARR;
        return i + 1;
      case CH.RBRACK:
        last.end = i + 1;
        last.type = TOK.ARR_END;
        return i + 1;
      case CH.COLON:
        last.end = i + 1;
        last.type = TOK.COLON;
        return i + 1;
      case CH.COMMA:
        last.end = i + 1;
        last.type = TOK.COMMA;
        return i + 1;
      case CH.QUOTE: {
        let j = i + 1;
        while (j < n) {
          const d = s.charCodeAt(j);
          if (d === CH.BACKSLASH) {
            j += 2;
            continue;
          }
          if (d === CH.QUOTE) {
            last.end = j + 1;
            last.type = TOK.STR;
            return j + 1;
          }
          j++;
        }
        last.end = n;
        last.type = TOK.STR;
        return n;
      }
      default: {
        if (c === CH.MINUS || isDigit(c)) {
          let j = i + 1;
          while (j < n) {
            const d = s.charCodeAt(j);
            if (isDigit(d) || d === CH.DOT || d === 101 || d === 69 || d === 43 || d === CH.MINUS) j++;
            else break;
          }
          last.end = j;
          last.type = TOK.NUM;
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
          last.type = TOK.LIT;
          return j;
        }
        last.end = i + 1;
        last.type = TOK.BAD;
        return i + 1;
      }
    }
  }

  /**
   * 把一行文本 lex 成高亮 run（view 只对屏幕内行调用）。
   * 偏移相对 `line`；空白不进 run（由 CSS 保留）。
   */
  lexLine(line: string): HighlightRun[] {
    const out: HighlightRun[] = [];
    let i = this.skipWs(line, 0);
    const n = line.length;
    while (i < n) {
      const start = i;
      const end = this.lexToken(line, i);
      out.push({ t: this.last.type, s: start, e: end });
      i = this.skipWs(line, end);
    }
    return out;
  }
}
