/**
 * Fidelity scanner: one linear pass over JSON *source text* reporting every place where
 * `JSON.parse` (double math + JS object key ordering + duplicate-key collapse) loses
 * information that the source text carries.
 *
 * Zero dependencies, no evaluation, no recursion (explicit depth stack) — safe on 50MB.
 */
import { C, T, last, lexToken, skipWs, classifyNumberLiteral, classifyStringToken } from './json-lex.mjs';

const INT_INDEX_MAX = 4294967294; // 2^32 - 2

/** JS canonical array-index key test: "0".."4294967294", no leading zeros. */
function canonicalIndex(key) {
  const n = key.length;
  if (n === 0 || n > 10) return -1;
  if (key.charCodeAt(0) === 48) return n === 1 ? 0 : -1;
  let v = 0;
  for (let i = 0; i < n; i++) {
    const c = key.charCodeAt(i);
    if (c < 48 || c > 57) return -1;
    v = v * 10 + (c - 48);
  }
  return v <= INT_INDEX_MAX ? v : -1;
}

function unquote(tok) {
  if (tok.indexOf('\\') < 0) return tok.slice(1, -1);
  try {
    return JSON.parse(tok);
  } catch {
    return tok.slice(1, -1);
  }
}

function now() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}
const r3 = (v) => Math.round(v * 1000) / 1000;

/**
 * @param {string} text JSON source text
 * @param {{detectDuplicates?: boolean, maxSamples?: number}} opts
 */
export function scanFidelity(text, opts = {}) {
  const detectDuplicates = !!opts.detectDuplicates;
  const maxSamples = opts.maxSamples ?? 8;
  const t0 = now();
  const n = text.length;

  const res = {
    chars: n,
    tokens: 0,
    values: 0,
    containers: 0,
    maxDepth: 0,
    numbers: { total: 0, exact: 0, gt15: 0, gt15Exact: 0, gt15Inexact: 0, nonfinite: 0, negZero: 0, underflow: 0 },
    strings: { total: 0, escaped: 0, loneSurrogate: 0, rawLoneSurrogate: 0 },
    keys: { total: 0, intStyle: 0, objects: 0, objectsWithIntKeys: 0, reorderRiskObjects: 0, reorderRiskEvents: 0 },
    duplicates: { keys: 0 },
    findings: 0,
    samples: {
      bigintInexact: [],
      bigintExact: [],
      nonfinite: [],
      negZero: [],
      loneSurrogate: [],
      reorderRisk: [],
      duplicates: [],
    },
    elapsedMs: 0,
  };
  const push = (b, item) => {
    if (res.samples[b].length < maxSamples) res.samples[b].push(item);
  };
  const finding = (b, item) => {
    res.findings++;
    push(b, item);
  };

  // container stack: 0 = object, 1 = array. Per-object key-order state.
  let cap = 256;
  let kindStack = new Uint8Array(cap);
  let lastIntStack = new Float64Array(cap);
  let sawNonIntStack = new Uint8Array(cap);
  let reorderFlagStack = new Uint8Array(cap); // 1 = this object already counted as a risk
  let depth = 0;
  let inObject = false; // current container is an object
  let expectKey = false;
  const dupStack = detectDuplicates ? [new Set()] : null;
  /** @param {number} d @returns {boolean} true if this is the first risk for object d */
  const noteRisk = (d) => {
    res.keys.reorderRiskEvents++;
    if (reorderFlagStack[d]) return false;
    reorderFlagStack[d] = 1;
    res.keys.reorderRiskObjects++;
    return true;
  };

  let i = 0;
  while (i < n) {
    i = skipWs(text, i);
    if (i >= n) break;
    const c = text.charCodeAt(i);

    if (c === C.LBRACE || c === C.LBRACK) {
      const isObj = c === C.LBRACE;
      if (depth === cap) {
        cap *= 2;
        const k2 = new Uint8Array(cap);
        k2.set(kindStack);
        kindStack = k2;
        const l2 = new Float64Array(cap);
        l2.set(lastIntStack);
        lastIntStack = l2;
        const s2 = new Uint8Array(cap);
        s2.set(sawNonIntStack);
        sawNonIntStack = s2;
        const f2 = new Uint8Array(cap);
        f2.set(reorderFlagStack);
        reorderFlagStack = f2;
      }
      kindStack[depth] = isObj ? 0 : 1;
      lastIntStack[depth] = -1;
      sawNonIntStack[depth] = 0;
      reorderFlagStack[depth] = 0;
      depth++;
      if (depth > res.maxDepth) res.maxDepth = depth;
      if (isObj) res.keys.objects++;
      res.containers++;
      i = skipWs(text, i + 1);
      // consume an immediate closer so the comma/close bookkeeping below stays correct
      const closer = isObj ? C.RBRACE : C.RBRACK;
      if (text.charCodeAt(i) === closer) {
        i++;
        depth--;
        res.containers++;
      }
      inObject = depth > 0 && kindStack[depth - 1] === 0;
      expectKey = inObject;
      if (dupStack) dupStack.length = depth + 1;
      continue;
    }

    if (c === C.RBRACE || c === C.RBRACK) {
      i++;
      depth--;
      res.containers++;
      inObject = depth > 0 && kindStack[depth - 1] === 0;
      expectKey = false;
      if (dupStack) dupStack.length = depth + 1;
      continue;
    }

    if (c === C.COMMA) {
      i++;
      inObject = depth > 0 && kindStack[depth - 1] === 0;
      expectKey = inObject;
      continue;
    }

    if (c === C.COLON) {
      i++;
      continue;
    }

    const start = i;
    const end = lexToken(text, i);
    const type = last.type;
    res.tokens++;
    i = end;

    if (type === T.STR) {
      const tok = text.slice(start, end);
      res.strings.total++;
      const sf = classifyStringToken(tok);
      for (const f of sf) {
        if (f.kind === 'escaped') res.strings.escaped++;
        else {
          res.strings.loneSurrogate++;
          if (f.kind === 'raw-lone-surrogate') res.strings.rawLoneSurrogate++;
          finding('loneSurrogate', { tok: tok.slice(0, 40), kind: f.kind, detail: f.detail });
        }
      }
      if (expectKey) {
        res.keys.total++;
        const key = unquote(tok);
        const d = depth - 1;
        const idx = canonicalIndex(key);
        if (idx >= 0) {
          res.keys.intStyle++;
          const li = lastIntStack[d];
          if (li < 0) res.keys.objectsWithIntKeys++;
          if (sawNonIntStack[d] || (li >= 0 && idx < li)) {
            const first = noteRisk(d);
            if (first) finding('reorderRisk', {
              key,
              at: start,
              note: '整数样式键乱序/与字符串键混排 → JSON.parse 后键序改变，原序不可恢复',
            });
          }
          if (idx > li) lastIntStack[d] = idx;
        } else {
          // a string key arriving after integer-style keys is NOT a risk by itself:
          // JS keeps integers first (ascending) then strings in insertion order, so
          // {"0","1","10","tag"} round-trips unchanged. Only "string BEFORE integer"
          // and "integers out of ascending order" reorder.
          sawNonIntStack[d] = 1;
        }
        if (dupStack) {
          const set = dupStack[depth];
          if (set) {
            if (set.has(key)) {
              res.duplicates.keys++;
              finding('duplicates', { key, at: start, depth, note: '重复键：后者胜出，前者静默消失' });
            } else set.add(key);
          }
        }
        expectKey = false;
      } else {
        res.values++;
      }
      continue;
    }

    if (type === T.NUM) {
      res.values++;
      res.numbers.total++;
      const lit = text.slice(start, end);
      const cls = classifyNumberLiteral(lit);
      if (!cls) res.numbers.exact++;
      else if (cls.kind === 'bigint-exact') {
        res.numbers.gt15++;
        res.numbers.gt15Exact++;
        push('bigintExact', { lit, detail: cls.detail });
      } else if (cls.kind === 'bigint-inexact') {
        res.numbers.gt15++;
        res.numbers.gt15Inexact++;
        finding('bigintInexact', { lit, parsed: String(Number(lit)), at: start, detail: cls.detail });
      } else if (cls.kind === 'nonfinite') {
        res.numbers.nonfinite++;
        finding('nonfinite', { lit, at: start, detail: cls.detail });
      } else if (cls.kind === 'neg-zero') {
        res.numbers.negZero++;
        finding('negZero', { lit, at: start, detail: cls.detail });
      } else if (cls.kind === 'underflow') {
        res.numbers.underflow++;
        finding('bigintInexact', { lit, at: start, detail: cls.detail });
      }
      expectKey = false;
      continue;
    }

    if (type === T.LIT) {
      res.values++;
      expectKey = false;
      continue;
    }

    if (type === T.EOF) break;
    i = start + 1; // BAD token: guarantee progress
  }

  res.elapsedMs = r3(now() - t0);
  return res;
}

/** Full token offset index — the *cost evidence* for a "raw slice per node" display layer. */
export function buildTokenIndex(text) {
  const t0 = now();
  const n = text.length;
  let count = 0;
  let i = 0;
  while (i < n) {
    i = skipWs(text, i);
    if (i >= n) break;
    i = lexToken(text, i);
    count++;
  }
  const starts = new Int32Array(count);
  const ends = new Int32Array(count);
  const types = new Uint8Array(count);
  let k = 0;
  i = 0;
  while (i < n && k < count) {
    i = skipWs(text, i);
    if (i >= n) break;
    const start = i;
    const end = lexToken(text, i);
    starts[k] = start;
    ends[k] = end;
    types[k] = last.type;
    k++;
    i = end;
  }
  return {
    count,
    starts,
    ends,
    types,
    bytes: starts.byteLength + ends.byteLength + types.byteLength,
    elapsedMs: r3(now() - t0),
  };
}
