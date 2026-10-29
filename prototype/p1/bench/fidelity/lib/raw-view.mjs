/**
 * Raw text view engines (zero-dep, platform-agnostic).
 *
 * Three strategies for rendering a huge JSON document as lines:
 *   (a) `SourceLineView`  — index the source's own newlines (works when the text is
 *                           already pretty-printed / has short lines).
 *   (b) `PrettyLineView`  — the source is minified (one huge line): synthesize the
 *                           *pretty* line layout from a single lexing pass, but do not
 *                           materialize any text. Line n is recovered by resuming the
 *                           walker from the nearest checkpoint (≤ CP_EVERY lines back)
 *                           and re-lexing only that many lines.
 *   (c) `prettifyToString` — reference baseline: materialize the whole pretty text.
 *
 * No line offsets are stored per line for (b): only (lineIndex, srcOffset, depth)
 * every CP_EVERY lines, so the index is O(lineCount / CP_EVERY) instead of O(lineCount).
 */
import { C, T, last, lexToken, skipWs } from './json-lex.mjs';

export const K = { OPEN: 0, CLOSE: 1, KEY: 2, KEY_OPEN: 3, SCALAR: 4 };

export const DEFAULT_CP_EVERY = 2048;
/** Above this source-line length the "raw lines" mode is considered unusable (minified). */
export const DEFAULT_MAX_LINE = 4096;

function now() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}
const r3 = (v) => Math.round(v * 1000) / 1000;

/** Cheap shape probe: number of '\n' + longest line. One pass, no allocation. */
export function probeText(text) {
  const t0 = now();
  const n = text.length;
  let lines = 1;
  let maxLine = 0;
  let lastNl = -1;
  let nl = text.indexOf('\n');
  while (nl >= 0) {
    lines++;
    if (nl - lastNl > maxLine) maxLine = nl - lastNl;
    lastNl = nl;
    nl = text.indexOf('\n', nl + 1);
  }
  if (n - lastNl > maxLine) maxLine = n - lastNl;
  return { lines, maxLine, probeMs: r3(now() - t0) };
}

/**
 * Walk pretty-print line records forward from (pos, depth).
 * Calls cb(rec) for each line; rec = {start, end, depth, kind}.
 * Stateless apart from (pos, depth) → resumable from a checkpoint.
 */
export function walkPretty(text, pos, depth, cb, lineIndex0 = 0) {
  const n = text.length;
  let lineIndex = lineIndex0;
  for (;;) {
    pos = skipWs(text, pos);
    if (pos >= n) break;
    const c = text.charCodeAt(pos);
    let rec;

    if (c === C.RBRACE || c === C.RBRACK) {
      depth--;
      rec = { start: pos, end: pos + 1, depth, kind: K.CLOSE };
      pos++;
    } else if (c === C.LBRACE || c === C.LBRACK) {
      const closer = c === C.LBRACE ? C.RBRACE : C.RBRACK;
      let p = skipWs(text, pos + 1);
      if (text.charCodeAt(p) === closer) {
        rec = { start: pos, end: p + 1, depth, kind: K.SCALAR }; // empty {} / []
        pos = p + 1;
      } else {
        rec = { start: pos, end: pos + 1, depth, kind: K.OPEN };
        depth++;
        pos++;
      }
    } else if (c === C.QUOTE) {
      // string: either an object key (followed by ':') or a plain value
      const keyEnd = lexToken(text, pos);
      const ktype = last.type;
      let p = skipWs(text, keyEnd);
      if (ktype === T.STR && text.charCodeAt(p) === C.COLON) {
        p = skipWs(text, p + 1);
        const vc = text.charCodeAt(p);
        if (vc === C.LBRACE || vc === C.LBRACK) {
          const closer = vc === C.LBRACE ? C.RBRACE : C.RBRACK;
          const q = skipWs(text, p + 1);
          if (text.charCodeAt(q) === closer) {
            rec = { start: pos, end: q + 1, depth, kind: K.KEY }; // "k": {}
            pos = q + 1;
          } else {
            rec = { start: pos, end: p + 1, depth, kind: K.KEY_OPEN }; // "k": {
            depth++;
            pos = p + 1;
          }
        } else {
          const ve = lexToken(text, p);
          rec = { start: pos, end: ve, depth, kind: K.KEY };
          pos = ve;
        }
      } else {
        rec = { start: pos, end: keyEnd, depth, kind: K.SCALAR };
        pos = keyEnd;
      }
    } else {
      const ve = lexToken(text, pos);
      rec = { start: pos, end: ve, depth, kind: K.SCALAR };
      pos = ve;
    }

    if (cb(rec, lineIndex, depth) === false) return lineIndex + 1;
    lineIndex++;
    // uniform tail: an optional comma separates this line from the next
    pos = skipWs(text, pos);
    if (text.charCodeAt(pos) === C.COMMA) pos++;
  }
  return lineIndex;
}

/** Rebuild the pretty text of one line record (≤ ~2 tokens) from the source slice. */
export function renderPrettyLine(text, rec) {
  const indent = rec.depth > 0 ? ' '.repeat(rec.depth * 2) : '';
  let body;
  if (rec.kind === K.KEY || rec.kind === K.KEY_OPEN) {
    const keyEnd = lexToken(text, rec.start);
    let p = skipWs(text, keyEnd);
    if (text.charCodeAt(p) === C.COLON) p = skipWs(text, p + 1);
    body = text.slice(rec.start, keyEnd) + ': ' + text.slice(p, rec.end);
  } else {
    body = text.slice(rec.start, rec.end);
  }
  // trailing comma, if the source has one right after this line
  let p = skipWs(text, rec.end);
  const comma = text.charCodeAt(p) === C.COMMA;
  return indent + body + (comma && rec.kind !== K.OPEN ? ',' : '');
}

export class PrettyLineView {
  /** @param {string} text @param {{cpEvery?:number}} opts */
  constructor(text, opts = {}) {
    this.text = text;
    this.cpEvery = opts.cpEvery ?? DEFAULT_CP_EVERY;
    this.mode = 'pretty';
    this.lineCount = 0;
    /** Int32Array, 3 slots per checkpoint: lineIndex, srcOffset, depth */
    this.cp = null;
    this.cpCount = 0;
    this.buildMs = 0;
    this.indexBytes = 0;
  }

  build() {
    const t0 = now();
    const every = this.cpEvery;
    const tmp = [0, skipWs(this.text, 0), 0]; // lineIndex, srcOffset, depth
    let lineCount = 0;
    walkPretty(this.text, 0, 0, (rec, li, depth) => {
      if (li > 0 && li % every === 0) tmp.push(li, rec.start, rec.depth);
      lineCount = li + 1;
    });
    this.lineCount = lineCount;
    this.cp = Int32Array.from(tmp);
    this.cpCount = tmp.length / 3;
    this.indexBytes = this.cp.byteLength;
    this.buildMs = r3(now() - t0);
    return this;
  }

  /** @returns {{start:number,end:number,depth:number,kind:number}[]} */
  window(startLine, count) {
    const out = [];
    if (startLine >= this.lineCount) return out;
    const cp = this.cp;
    const every = this.cpEvery;
    // binary search the checkpoint with the greatest lineIndex <= startLine
    let lo = 0;
    let hi = this.cpCount - 1;
    let best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cp[mid * 3] <= startLine) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    const fromLine = cp[best * 3];
    const pos = cp[best * 3 + 1];
    const depth = cp[best * 3 + 2];
    const need = Math.min(count, this.lineCount - startLine);
    const skip = startLine - fromLine;
    walkPretty(this.text, pos, depth, (rec, li) => {
      if (li >= startLine) {
        out.push(rec);
        if (out.length >= need) return false;
      }
    }, fromLine);
    return out;
  }

  /** Rendered text for a window (the thing the virtualizer would mount). */
  windowText(startLine, count) {
    return this.window(startLine, count).map((rec) => renderPrettyLine(this.text, rec));
  }

  /** Lines to re-lex to serve a window at the measured worst case (before the first CP). */
  get maxResumeLines() {
    return this.cpEvery;
  }
}

export class SourceLineView {
  constructor(text, opts = {}) {
    this.text = text;
    this.cpEvery = opts.cpEvery ?? DEFAULT_CP_EVERY;
    this.mode = 'source';
    this.lineCount = 0;
    this.cp = null;
    this.cpCount = 0;
    this.buildMs = 0;
    this.indexBytes = 0;
  }

  build() {
    const t0 = now();
    const text = this.text;
    const n = text.length;
    const every = this.cpEvery;
    let lines = 1;
    let lastCpLine = 0;
    const tmp = [];
    tmp.push(0, 0);
    for (let i = 0; i < n; i++) {
      if (text.charCodeAt(i) === 10) {
        lines++;
        if (lines - 1 > 0 && (lines - 1) % every === 0) tmp.push(lines - 1, i + 1);
      }
    }
    this.lineCount = lines;
    this.cp = Int32Array.from(tmp);
    this.cpCount = tmp.length / 2;
    this.indexBytes = this.cp.byteLength;
    this.buildMs = r3(now() - t0);
    return this;
  }

  /** @returns {string[]} raw source lines */
  window(startLine, count) {
    const text = this.text;
    const n = text.length;
    const cp = this.cp;
    const every = this.cpEvery;
    let lo = 0;
    let hi = this.cpCount - 1;
    let best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cp[mid * 2] <= startLine) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    let line = cp[best * 2];
    let pos = cp[best * 2 + 1];
    while (line < startLine) {
      const nl = text.indexOf('\n', pos);
      if (nl < 0) {
        pos = n;
        line = this.lineCount;
        break;
      }
      pos = nl + 1;
      line++;
    }
    const out = [];
    const need = Math.min(count, this.lineCount - startLine);
    while (out.length < need && pos <= n) {
      let nl = text.indexOf('\n', pos);
      if (nl < 0) nl = n;
      out.push(text.slice(pos, nl));
      pos = nl + 1;
    }
    return out;
  }
}

/**
 * Baseline (c): materialize the pretty text. Rebuilds from a token stream (not from a
 * parsed value graph) so this measures the *text* cost only.
 */
export function prettifyToString(text, indentUnit = 2) {
  const t0 = now();
  const parts = [];
  let depth = 0;
  const pad = (d) => '\n' + ' '.repeat(d * indentUnit);
  let pos = skipWs(text, 0);
  const n = text.length;
  let prevOpen = false;
  while (pos < n) {
    const c = text.charCodeAt(pos);
    if (c === C.RBRACE || c === C.RBRACK) {
      depth--;
      parts.push(pad(depth) + text[pos]);
      pos = skipWs(text, pos + 1);
    } else if (c === C.LBRACE || c === C.LBRACK) {
      const closer = c === C.LBRACE ? C.RBRACE : C.RBRACK;
      const p = skipWs(text, pos + 1);
      if (text.charCodeAt(p) === closer) {
        parts.push(text.slice(pos, p + 1));
        pos = p + 1;
      } else {
        parts.push(text[pos]);
        depth++;
        parts.push(pad(depth));
        pos = skipWs(text, pos + 1);
        prevOpen = true;
        continue;
      }
    } else if (c === C.QUOTE) {
      const end = lexToken(text, pos);
      const tok = text.slice(pos, end);
      let p = skipWs(text, end);
      if (text.charCodeAt(p) === C.COLON) {
        p = skipWs(text, p + 1);
        parts.push(tok + ': ');
        pos = p;
      } else {
        parts.push(tok);
        pos = end;
      }
    } else if (c === C.COMMA) {
      parts.push(',');
      parts.push(pad(depth));
      pos = skipWs(text, pos + 1);
      continue;
    } else {
      const end = lexToken(text, pos);
      parts.push(text.slice(pos, end));
      pos = end;
    }
    // whitespace between sibling values already handled by pad() after commas
    pos = skipWs(text, pos);
    if (text.charCodeAt(pos) === C.COMMA) {
      parts.push(',');
      parts.push(pad(depth));
      pos = skipWs(text, pos + 1);
    }
    prevOpen = false;
  }
  const out = parts.join('');
  return { text: out, chars: out.length, elapsedMs: r3(now() - t0) };
}

/**
 * Build the right view for a document: probe shape, then pick source-lines or pretty.
 * @param {string} text
 * @param {{maxLine?:number, cpEvery?:number}} opts
 */
export function buildRawView(text, opts = {}) {
  const maxLine = opts.maxLine ?? DEFAULT_MAX_LINE;
  const probe = probeText(text);
  const useSource = probe.maxLine <= maxLine;
  const view = useSource
    ? new SourceLineView(text, opts).build()
    : new PrettyLineView(text, opts).build();
  view.probe = probe;
  return view;
}
