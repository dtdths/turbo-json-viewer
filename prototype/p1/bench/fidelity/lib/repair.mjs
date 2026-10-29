/**
 * Conservative truncation repair (prototype).
 *
 * Contract: only *syntax-level closure* — insert missing closers/quotes, drop dangling
 * separators, half-keys and half-tokens. Never invent content: a truncated number keeps
 * only its valid prefix, a half-written `tru`/`nul` is dropped, a half-written key is
 * dropped (it has no value anyway).
 *
 * Emits an edit list with offsets into the ORIGINAL text so the UI can show "补了什么"
 * and export can keep the repair provenance.
 */
import { C } from './json-lex.mjs';

const isDigit = (c) => c >= 48 && c <= 57;
const isWs = (c) => c === 32 || c === 10 || c === 13 || c === 9;
const isHex = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);

/**
 * @param {string} text
 */
export function repairTruncated(text) {
  const n = text.length;
  const parseError = tryParseError(text);
  if (parseError === null) {
    return {
      status: 'ok',
      parseError: null,
      ops: [],
      counts: { brackets: 0, quotes: 0, commas: 0, deletedChars: 0 },
      summaryText: '无需修复',
      repairedText: text,
      check: { parseOk: true },
    };
  }
  if (!looksTruncated(text)) {
    return {
      status: 'unrepairable',
      parseError,
      ops: [],
      counts: { brackets: 0, quotes: 0, commas: 0, deletedChars: 0 },
      summaryText: '文档不是「末尾被截断」的形态（错误不在 EOF），不自动修复',
      repairedText: null,
      check: { parseOk: false, error: parseError },
    };
  }

  // ── scan ──
  const stack = []; // { ch: 123|91, at }
  let inString = false;
  let stringStart = -1;
  let stringIsKey = false;
  let incompleteEscapeAt = -1; // backslash offset of a half-written escape at EOF
  let expect = 'value'; // 'key' | 'colon' | 'value' | 'commaOrEnd'
  let lastToken = null; // { type, at, end, isKey? }
  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === C.BACKSLASH) {
        const e = i + 1 < n ? text.charCodeAt(i + 1) : -1;
        if (e < 0) {
          incompleteEscapeAt = i;
          i = n;
          break;
        }
        if (e === 117 /* u */) {
          let ok = true;
          for (let k = 2; k <= 5; k++) {
            if (i + k >= n) {
              ok = false;
              incompleteEscapeAt = i;
              break;
            }
            if (!isHex(text.charCodeAt(i + k))) {
              ok = false;
              break;
            }
          }
          if (!ok) {
            i = n;
            break;
          }
          i += 6;
          continue;
        }
        i += 2;
        continue;
      }
      if (c === C.QUOTE) {
        inString = false;
        lastToken = { type: 'string', at: stringStart, end: i + 1, isKey: stringIsKey };
        expect = stringIsKey ? 'colon' : 'commaOrEnd';
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (isWs(c)) {
      i++;
      continue;
    }
    if (c === C.QUOTE) {
      inString = true;
      stringStart = i;
      stringIsKey = expect === 'key';
      i++;
      continue;
    }
    if (c === C.LBRACE) {
      stack.push({ ch: c, at: i });
      expect = 'key';
      i++;
      continue;
    }
    if (c === C.LBRACK) {
      stack.push({ ch: c, at: i });
      expect = 'value';
      i++;
      continue;
    }
    if (c === C.RBRACE || c === C.RBRACK) {
      stack.pop();
      expect = 'commaOrEnd';
      lastToken = { type: 'close', at: i, end: i + 1 };
      i++;
      continue;
    }
    if (c === C.COMMA) {
      const top = stack[stack.length - 1];
      expect = top && top.ch === C.LBRACE ? 'key' : 'value';
      lastToken = { type: 'comma', at: i, end: i + 1 };
      i++;
      continue;
    }
    if (c === C.COLON) {
      expect = 'value';
      i++;
      continue;
    }
    let j = i;
    if (c === C.MINUS || isDigit(c)) {
      while (j < n) {
        const d = text.charCodeAt(j);
        if (isDigit(d) || d === C.DOT || d === 101 || d === 69 || d === 43 || d === C.MINUS) j++;
        else break;
      }
      lastToken = { type: 'number', at: i, end: j };
    } else {
      while (j < n) {
        const d = text.charCodeAt(j);
        if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122)) j++;
        else break;
      }
      lastToken = { type: 'literal', at: i, end: j };
    }
    expect = 'commaOrEnd';
    i = j;
  }

  // ── EOF fixups ──
  const ops = [];
  const push = (op) => ops.push(op);
  const tEnd = trimEnd(text);
  // earliest offset of a planned deletion that eats the tail — the "effective end"
  // used by the dangling-member heuristics below
  let tailCutAt = -1;
  const cutTail = (at) => {
    if (tailCutAt < 0 || at < tailCutAt) tailCutAt = at;
  };

  // (1) dangling half-key: `{"a":1,"bb` → drop the key (it has no value to keep)
  if (inString && stringIsKey) {
    cutTail(stringStart);
    push({
      at: stringStart,
      op: 'delete',
      text: text.slice(stringStart, n),
      scope: 'key',
      note: '不完整键名（且没有值可保留）→ 丢弃整个成员',
    });
    let p = backWs(text, stringStart);
    if (p > 0 && text.charCodeAt(p - 1) === C.COMMA) {
      push({ at: p - 1, op: 'delete', text: ',', scope: 'comma', note: '尾随逗号 → 移除' });
      stringStart = p - 1;
    }
    const key = lastStringTokenBefore(text, stringStart);
    if (key) {
      push({ at: key.at, op: 'delete', text: ':', scope: 'key', note: '遗留冒号 → 移除' });
    }
    inString = false;
    expect = 'commaOrEnd';
  } else if (inString) {
    if (incompleteEscapeAt >= 0) {
      push({
        at: incompleteEscapeAt,
        op: 'delete',
        text: text.slice(incompleteEscapeAt, n),
        scope: 'string',
        note: '末尾是不完整转义 → 丢弃（不猜测字符）',
      });
    }
    push({ at: n, op: 'insert', text: '"', scope: 'string', note: '字符串未闭合 → 补结束引号' });
    expect = 'commaOrEnd';
  } else if (incompleteEscapeAt >= 0) {
    push({ at: incompleteEscapeAt, op: 'delete', text: text.slice(incompleteEscapeAt, n), scope: 'string', note: '末尾是不完整转义 → 丢弃' });
    expect = 'commaOrEnd';
  }

  // (2) half-written trailing token (only when it really ends at EOF)
  if (!inString && lastToken && lastToken.end === tEnd) {
    const lit = text.slice(lastToken.at, lastToken.end);
    if (lastToken.type === 'literal' && !['true', 'false', 'null'].includes(lit)) {
      cutTail(lastToken.at);
      push({
        at: lastToken.at,
        op: 'delete',
        text: lit,
        scope: 'literal',
        note: `不完整字面量 \`${lit}\` → 丢弃（不猜测 true/false/null）`,
      });
      lastToken = { type: 'literal', at: lastToken.at, end: lastToken.at };
      expect = 'value'; // the value slot is now empty → drop the dangling member below
    } else if (lastToken.type === 'number' && !isValidJsonNumber(lit)) {
      const keep = longestValidNumberPrefix(lit);
      cutTail(lastToken.at + keep.length);
      push({
        at: lastToken.at + keep.length,
        op: 'delete',
        text: lit.slice(keep.length),
        scope: 'number',
        note: `不完整数字 \`${lit}\` → 只保留合法前缀 \`${keep}\`（不补数字）`,
      });
      expect = 'commaOrEnd';
    }
  }

  // (3) a comma can never precede a closer
  if (!inString && lastToken && lastToken.type === 'comma' && lastToken.end === tEnd) {
    push({ at: lastToken.at, op: 'delete', text: ',', scope: 'comma', note: '尾随逗号 → 移除' });
    expect = 'commaOrEnd';
  }

  // (4) dangling member: `{"a":` / `{"a":1,` (value slot empty)
  if (!inString && (expect === 'value' || expect === 'colon')) {
    const dropped = dropDanglingMember(text, ops, tailCutAt >= 0 ? tailCutAt : tEnd);
    if (dropped) expect = 'commaOrEnd';
  }

  // (5) close every open container, innermost first
  const closers = stack
    .slice()
    .reverse()
    .map((f) => (f.ch === C.LBRACE ? '}' : ']'));
  if (closers.length) {
    push({
      at: n,
      op: 'insert',
      text: closers.join(''),
      scope: 'container',
      note: `补 ${closers.length} 个闭合符 \`${closers.join('')}\`（对应未闭合的 ${stack
        .map((f) => (f.ch === C.LBRACE ? '{' : '[') + '@' + f.at)
        .join(', ')}）`,
    });
  }

  // ── apply right-to-left ──
  const sorted = ops
    .map((op, idx) => ({ op, idx }))
    .sort((a, b) => b.op.at - a.op.at || (a.op.op === 'insert' ? -1 : 1) || a.idx - b.idx)
    .map((x) => x.op);
  let out = text;
  for (const op of sorted) {
    if (op.op === 'insert') out = out.slice(0, op.at) + op.text + out.slice(op.at);
    else out = out.slice(0, op.at) + out.slice(op.at + (op.text ? op.text.length : 1));
  }

  const counts = { brackets: 0, quotes: 0, commas: 0, deletedChars: 0 };
  for (const op of ops) {
    if (op.scope === 'container') counts.brackets += op.text.length;
    else if (op.scope === 'string' && op.op === 'insert') counts.quotes++;
    else if (op.scope === 'comma') counts.commas++;
    else counts.deletedChars += (op.text || '').length;
  }
  const err2 = tryParseError(out);
  return {
    status: err2 === null ? 'repaired' : 'unrepairable',
    parseError,
    ops,
    counts,
    summaryText: summarize(counts),
    repairedText: out,
    check: err2 === null ? { parseOk: true } : { parseOk: false, error: err2 },
  };
}

function summarize(c) {
  const bits = [];
  if (c.brackets) bits.push(`补 ${c.brackets} 个闭合符`);
  if (c.quotes) bits.push(`补 ${c.quotes} 个结束引号`);
  if (c.commas) bits.push(`移除 ${c.commas} 个尾随逗号`);
  if (c.deletedChars) bits.push(`丢弃 ${c.deletedChars} 个无法恢复的字符`);
  return bits.length ? '已修复：' + bits.join('、') + '（仅语法闭合，未修改任何已有值）' : '已修复';
}

/** `{"a":` → drop `"a":`; `{"a":1,` handled by the comma rule. */
function dropDanglingMember(text, ops, tEnd) {
  let i = tEnd;
  if (i <= 0) return false;
  let changed = false;
  if (text.charCodeAt(i - 1) === C.COLON) {
    let j = backWs(text, i - 1);
    if (j > 0 && text.charCodeAt(j - 1) === C.QUOTE) {
      let k = j - 2;
      while (k >= 0) {
        const c = text.charCodeAt(k);
        if (c === C.BACKSLASH) {
          k -= 2;
          continue;
        }
        if (c === C.QUOTE) break;
        k--;
      }
      const at = k < 0 ? 0 : k;
      ops.push({
        at,
        op: 'delete',
        text: text.slice(at, i),
        scope: 'key',
        note: '悬空的键（后面没有值）→ 连同冒号删除',
      });
      j = at;
      changed = true;
    } else {
      ops.push({ at: j, op: 'delete', text: text.slice(j, i), scope: 'key', note: '悬空的冒号 → 删除' });
      changed = true;
    }
    const p = backWs(text, j);
    if (p > 0 && text.charCodeAt(p - 1) === C.COMMA) {
      ops.push({ at: p - 1, op: 'delete', text: ',', scope: 'comma', note: '尾随逗号 → 移除' });
    }
  }
  return changed;
}

/** Is the first parse error at/near EOF? (we only repair truncation, not arbitrary breakage) */
function looksTruncated(text) {
  try {
    JSON.parse(text);
    return false;
  } catch (e) {
    const msg = String(e.message || '');
    const m = /position (\d+)/.exec(msg);
    const at = m ? Number(m[1]) : text.length;
    const tail = text.slice(Math.max(0, at - 1)).trim();
    // A truncation error always lands within the last token / at EOF.
    return at >= text.trimEnd().length - 1 || tail.length <= 2;
  }
}

function lastStringTokenBefore(text, pos) {
  // crude: is there a ':' immediately before pos (after ws)?
  let j = backWs(text, pos);
  if (j > 0 && text.charCodeAt(j - 1) === C.COLON) return { at: j - 1 };
  return null;
}

function backWs(s, i) {
  while (i > 0 && isWs(s.charCodeAt(i - 1))) i--;
  return i;
}
function trimEnd(s) {
  let i = s.length;
  while (i > 0 && isWs(s.charCodeAt(i - 1))) i--;
  return i;
}
function isValidJsonNumber(lit) {
  return /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(lit);
}
function longestValidNumberPrefix(lit) {
  for (let k = lit.length - 1; k > 0; k--) {
    if (isValidJsonNumber(lit.slice(0, k))) return lit.slice(0, k);
  }
  return '0';
}
function tryParseError(text) {
  try {
    JSON.parse(text);
    return null;
  } catch (e) {
    return e.message;
  }
}
