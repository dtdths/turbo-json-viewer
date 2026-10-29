/** Minimal per-line JSON tokenizer for the raw-text view (unit-test target). */

export type TokenType = 'ws' | 'punct' | 'string' | 'number' | 'literal' | 'key' | 'error';
export interface Token {
  type: TokenType;
  start: number;
  end: number;
}

const LITERALS = new Set(['true', 'false', 'null']);

export function tokenizeJsonLine(line: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === ' ' || c === '\t' || c === '\r') {
      const s = i;
      while (i < line.length && (line[i] === ' ' || line[i] === '\t' || line[i] === '\r')) i++;
      out.push({ type: 'ws', start: s, end: i });
      continue;
    }
    if (c === '"') {
      const s = i;
      i++;
      let closed = false;
      while (i < line.length) {
        if (line[i] === '\\') {
          i += 2;
          continue;
        }
        if (line[i] === '"') {
          i++;
          closed = true;
          break;
        }
        i++;
      }
      // key = string immediately followed by ':' (skipping spaces)
      let j = i;
      while (j < line.length && (line[j] === ' ' || line[j] === '\t')) j++;
      const isKey = closed && line[j] === ':';
      out.push({ type: closed ? (isKey ? 'key' : 'string') : 'error', start: s, end: i });
      continue;
    }
    if (c === '{' || c === '}' || c === '[' || c === ']' || c === ':' || c === ',') {
      out.push({ type: 'punct', start: i, end: i + 1 });
      i++;
      continue;
    }
    const rest = line.slice(i);
    const num = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest);
    if (num) {
      out.push({ type: 'number', start: i, end: i + num[0].length });
      i += num[0].length;
      continue;
    }
    const lit = /^[a-z]+/.exec(rest);
    if (lit && LITERALS.has(lit[0])) {
      out.push({ type: 'literal', start: i, end: i + lit[0].length });
      i += lit[0].length;
      continue;
    }
    out.push({ type: 'error', start: i, end: i + 1 });
    i++;
  }
  return out;
}
