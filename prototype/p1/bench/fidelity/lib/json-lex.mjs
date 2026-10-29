/**
 * Zero-dependency single-pass JSON lexer primitives.
 * Platform-agnostic (no Node APIs) so the same file runs in Node, a page, and a Worker.
 *
 * NOTE on the `last` singleton: lexToken() writes into a module-level record to keep the
 * hot loop allocation-free. Callers must read it before the next lexToken() call.
 * Single-threaded usage only (fine for Node + one Worker).
 */

export const T = {
  OBJ: 1,
  ARR: 2,
  OBJ_END: 3,
  ARR_END: 4,
  STR: 5,
  NUM: 6,
  LIT: 7, // true/false/null
  COLON: 8,
  COMMA: 9,
  BAD: 10,
  EOF: 11,
};

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
};

/** token end offset + type of the last lexToken() call */
export const last = { end: 0, type: 0 };

export function isWs(c) {
  return c === 32 || c === 10 || c === 13 || c === 9;
}

export function skipWs(s, i) {
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 10 || c === 13 || c === 9) i++;
    else break;
  }
  return i;
}

const isDigit = (c) => c >= 48 && c <= 57;

/**
 * Lex one JSON token starting at i (i must point at the first char, no leading ws).
 * Records {end, type} in `last` and returns end.
 * Strings: stops after the closing quote; unterminated string ends at EOF (type STR,
 * caller can tell by `last.end === s.length && s[last.end-1] !== '"'`).
 */
export function lexToken(s, i) {
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
        // t/f/n literal
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

/** Lex a whole line slice into highlight runs. Returns array of {t: type, s, e} (offsets in `line`). */
export function lexLine(line) {
  const out = [];
  let i = skipWs(line, 0);
  const n = line.length;
  while (i < n) {
    const start = i;
    const end = lexToken(line, i);
    const type = last.type;
    if (type === T.BAD) {
      out.push({ t: T.BAD, s: start, e: end });
      i = end;
      continue;
    }
    // merge "literal tail" tokens but keep it simple: one run per token
    out.push({ t: type, s: start, e: end });
    i = skipWs(line, end);
  }
  return out;
}

/**
 * Does the literal at [start,end) denote an integer that a double cannot hold exactly?
 * Returns { kind, detail } or null when exact.
 *
 * kinds: 'bigint-inexact' | 'bigint-exact' | 'nonfinite' | 'neg-zero'
 */
export function classifyNumberLiteral(lit) {
  if (lit === '-0' || /^-0(?:\.0*)?(?:[eE][-+]?0+)?$/.test(lit)) {
    return { kind: 'neg-zero', detail: 'JSON.parse → -0；JSON.stringify → 0' };
  }
  // exponent / fraction => not an integer; only look for overflow/underflow
  const hasFrac = lit.indexOf('.') >= 0;
  const hasExp = lit.indexOf('e') >= 0 || lit.indexOf('E') >= 0;
  const v = Number(lit);
  if (!Number.isFinite(v)) return { kind: 'nonfinite', detail: `→ ${v}（JSON.stringify → null）` };
  if (!hasFrac && !hasExp) {
    // pure integer literal: exact iff it has <= 15 digits, or BigInt round-trips
    const neg = lit.charCodeAt(0) === C.MINUS;
    const digits = neg ? lit.slice(1) : lit;
    const sig = digits.replace(/^0+/, '') || '0';
    if (sig.length <= 15) return null;
    let big;
    try {
      big = BigInt(digits);
      if (neg) big = -big;
    } catch {
      return null;
    }
    if (BigInt(v) === big) return { kind: 'bigint-exact', detail: '>15 位但可被 double 精确表示' };
    return {
      kind: 'bigint-inexact',
      detail: `源 ${lit} → ${String(v)}（丢 ${sig.length - String(Math.abs(v)).length >= 0 ? '精度' : '精度'}）`,
    };
  }
  if (v === 0) {
    // 1e-400 underflows to 0
    return { kind: 'underflow', detail: `源 ${lit} → 0` };
  }
  return null;
}

/** Scan a JSON string token (source incl. quotes) for lone surrogates / escapes. */
export function classifyStringToken(tok) {
  const findings = [];
  const n = tok.length;
  let i = 1;
  let hasEscape = false;
  const end = tok.charCodeAt(n - 1) === C.QUOTE && n > 1 ? n - 1 : n;
  while (i < end) {
    const c = tok.charCodeAt(i);
    if (c === C.BACKSLASH) {
      hasEscape = true;
      const e = tok.charCodeAt(i + 1);
      if (e === 117) {
        // \uXXXX
        const hex = tok.slice(i + 2, i + 6);
        if (hex.length === 4 && /^[0-9a-fA-F]{4}$/.test(hex)) {
          const cu = parseInt(hex, 16);
          if (cu >= 0xd800 && cu <= 0xdbff) {
            // high surrogate: needs a low surrogate escape right after
            const nxt = tok.slice(i + 6, i + 12);
            const m = /^\\u([0-9a-fA-F]{4})$/.exec(nxt);
            const lo = m ? parseInt(m[1], 16) : -1;
            if (!(lo >= 0xdc00 && lo <= 0xdfff)) {
              findings.push({ kind: 'lone-surrogate', at: i, detail: `高位代理 \\u${hex} 无配对低位` });
            } else {
              i += 12;
              continue;
            }
          } else if (cu >= 0xdc00 && cu <= 0xdfff) {
            findings.push({ kind: 'lone-surrogate', at: i, detail: `低位代理 \\u${hex} 无配对高位` });
          }
        }
        i += 6;
        continue;
      }
      i += 2;
      continue;
    }
    if (c >= 0xd800 && c <= 0xdfff) {
      // raw surrogate code unit in source (only possible when the source is a JS string,
      // e.g. pasted text — a UTF-8 file cannot carry a lone surrogate)
      const isHigh = c <= 0xdbff;
      const nxt = tok.charCodeAt(i + 1);
      if (!(isHigh ? nxt >= 0xdc00 && nxt <= 0xdfff : false)) {
        findings.push({ kind: 'raw-lone-surrogate', at: i, detail: '源文本含孤立代理码元' });
      }
      i += 2;
      continue;
    }
    i++;
  }
  if (hasEscape) findings.push({ kind: 'escaped', at: -1, detail: '含转义（值不变，但源文本 ≠ 值文本）' });
  return findings;
}
