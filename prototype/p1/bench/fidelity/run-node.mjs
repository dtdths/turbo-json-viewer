/**
 * Node-side fidelity bench (same V8 as Chrome for JSON.parse / lexing throughput).
 *
 *   node --expose-gc prototype/p1/bench/fidelity/run-node.mjs
 *
 * Sections:
 *   A. JSON.parse distortion truth table on fixtures (+ .mock/1.json real-world scan)
 *   B. fidelity scanner cost on 10MB / 50MB minified samples
 *   C. full token-offset index cost (the "raw slice per node" display layer)
 *   D. raw text view: shape probe, pretty-line index build, window latency, memory
 *   E. baseline: materialize the whole pretty text (strategy c)
 *   F. tokenizer throughput
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { scanFidelity, buildTokenIndex } from './lib/fidelity.mjs';
import {
  buildRawView,
  PrettyLineView,
  SourceLineView,
  prettifyToString,
  probeText,
  renderPrettyLine,
  walkPretty,
  DEFAULT_CP_EVERY,
} from './lib/raw-view.mjs';
import { lexLine, lexToken } from './lib/json-lex.mjs';
const lexTokenShim = lexToken;

const REPO = path.resolve(import.meta.dirname, '../../../..');
const DATA = path.join(import.meta.dirname, '../../fixtures/fidelity/data');
const SAMPLES = {
  '2mb': path.join(REPO, '.spike/samples/2mb.json'),
  '10mb': path.join(REPO, '.spike/samples/10mb.json'),
  '50mb': path.join(REPO, '.spike/samples/50mb.json'),
  mock: path.join(REPO, '.mock/1.json'),
};

const now = () => Number(process.hrtime.bigint() / 1000n) / 1000; // ms, µs resolution
const r3 = (v) => Math.round(v * 1000) / 1000;
const MIB = 1024 * 1024;
const gc = globalThis.gc || (() => {});
const heapMB = () => {
  gc();
  return r3(process.memoryUsage().heapUsed / MIB);
};

function bench(fn, reps = 5) {
  const ts = [];
  for (let i = 0; i < reps; i++) {
    const t0 = now();
    fn();
    ts.push(r3(now() - t0));
  }
  ts.sort((a, b) => a - b);
  return {
    medianMs: ts[Math.floor(ts.length / 2)],
    p95Ms: ts[Math.min(ts.length - 1, Math.floor(ts.length * 0.95))],
    minMs: ts[0],
    reps,
    all: ts,
  };
}

const out = { env: {}, A_fidelity: {}, B_scanner: {}, C_tokenIndex: {}, D_rawView: {}, E_prettify: {}, F_tokenizer: {} };

out.env = {
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  cpu: (await import('node:os')).cpus()[0]?.model,
  loadavg: (await import('node:os')).loadavg().map((v) => r3(v)),
  note: '并发：同期其他成员在跑重负载 Chrome；取中位数/p95，重跑用安静环境',
};

// ─────────────────────────── A. distortion truth table ───────────────────────────
{
  const text = readFileSync(path.join(DATA, 'pathological.json'), 'utf8');
  const keyOrderText = readFileSync(path.join(DATA, 'key-order.json'), 'utf8');
  const v = JSON.parse(text);
  const ko = JSON.parse(keyOrderText);

  const scalarCases = [
    ['big_int_inexact', '1234567890123456789'],
    ['big_int_2p53_plus1', '9007199254740993'],
    ['big_int_pow2_exact', '9007199254740992'],
    ['big_int_2p64', '18446744073709551616'],
    ['big_int_inexact_22', '1234567890123456789012'],
    ['neg_zero', '-0'],
    ['neg_zero_frac', '-0.0'],
    ['overflow_1e400', '1e400'],
    ['underflow_1e_m400', '1e-400'],
  ];
  const rows = scalarCases.map(([k, srcLit]) => {
    const val = v[k];
    return {
      key: k,
      sourceLiteral: srcLit,
      parsedType: typeof val,
      parsedString: String(val),
      isNegZero: Object.is(val, -0),
      roundTripLiteral: JSON.stringify(val),
      byteIdentical: JSON.stringify(val) === srcLit,
      valueExact: typeof val === 'number' && Number.isFinite(val) ? (srcLit.includes('.') || /e/i.test(srcLit) ? null : BigInt(srcLit) === BigInt(val)) : null,
    };
  });

  const stringRows = [
    ['lone_high', '\\ud800'],
    ['lone_low', 'x\\udc00y'],
    ['escape_pairs', 'caf\\u00e9 \\uD83D\\uDE00'],
    ['escaped_solidus', 'a\\/b'],
    ['escaped_quote', '\\"q\\" and \\\\ backslash'],
  ].map(([k, src]) => {
    const val = v[k];
    const reencoded = new TextEncoder().encode(val);
    return {
      key: k,
      source: src,
      valueCodeUnits: val.length,
      jsonRoundTrip: JSON.stringify(val),
      utf8BytesAfterEncode: reencoded.length,
      // lone surrogate → U+FFFD on UTF-8 encode (clipboard/download/Blob paths)
      lostOnUtf8Encode: reencoded.includes(0xef) && val !== new TextDecoder().decode(reencoded),
    };
  });

  const srcOrders = keyOrdersFromSource(keyOrderText);
  const keyOrderRows = Object.entries(ko).map(([k, obj]) => {
    const target = Array.isArray(obj) ? obj[0] : obj;
    const srcKeyOrder = srcOrders[k] || [];
    const parsedKeyOrder = Object.keys(target);
    return {
      object: k,
      sourceKeyOrder: srcKeyOrder,
      parsedKeyOrder,
      orderPreserved: JSON.stringify(srcKeyOrder) === JSON.stringify(parsedKeyOrder),
    };
  });

  // duplicate keys: parse the raw fixture that still has them
  const dupText = readFileSync(path.join(DATA, 'pathological.raw-with-dup-and-comma.json'), 'utf8');
  if (dupText.includes('"a":2,')) {
    // make it parseable: duplicate key object also has a trailing comma by construction
    const fixed = dupText.replace('"b":3,}', '"b":3}');
    const dv = JSON.parse(fixed);
    out.A_fidelity.duplicateKeys = {
      source: '{"a":1,"a":2,"b":3}',
      parsedKeys: Object.keys(dv.dup_keys),
      parsedA: dv.dup_keys.a,
      note: '后者胜出，前者静默消失；JSON.parse 无 reviver 钩子可观察重复键',
    };
  }

  out.A_fidelity.fixtures = { pathological: rows, strings: stringRows, keyOrder: keyOrderRows };
  out.A_fidelity.roundTripWholeDocIdentical = JSON.stringify(v) === text;
  out.A_fidelity.wholeDocDiffChars = diffSummary(text, JSON.stringify(v));
}

// .mock/1.json — the real-world shape
{
  const text = readFileSync(SAMPLES.mock, 'utf8');
  const scan = scanFidelity(text, { detectDuplicates: true, maxSamples: 12 });
  const parsed = JSON.parse(text);
  const reser = JSON.stringify(parsed);
  out.A_fidelity.mock1 = {
    chars: text.length,
    scanMs: scan.elapsedMs,
    numbers: scan.numbers,
    keys: scan.keys,
    strings: scan.strings,
    duplicates: scan.duplicates,
    findings: scan.findings,
    samples: scan.samples,
    tokenIndexTokens: scan.tokens,
    reserializedIdentical: reser === text,
    reserializeLenDelta: reser.length - text.length,
    reserializeDiff: diffSummary(text, reser),
  };
}


/** Recover the *source* key order of every root-level member (object or first array element). */
function keyOrdersFromSource(text) {
  const out = {};
  let pos = skipWsGlobal(text, 0);
  // root '{'
  if (text.charCodeAt(pos) !== 123) return out;
  pos = skipWsGlobal(text, pos + 1);
  while (pos < text.length && text.charCodeAt(pos) !== 125) {
    const keyEnd = lexTokenGlobal(text, pos);
    const key = JSON.parse(text.slice(pos, keyEnd));
    pos = skipWsGlobal(text, keyEnd);
    if (text.charCodeAt(pos) === 58) pos = skipWsGlobal(text, pos + 1);
    const keys = [];
    const vc = text.charCodeAt(pos);
    let p = pos;
    if (vc === 123 || vc === 91) {
      const closer = vc === 123 ? 125 : 93;
      let q = skipWsGlobal(text, p + 1);
      if (q < text.length && text.charCodeAt(q) !== closer) {
        if (vc === 91) {
          // array: only the first element
          const ec = text.charCodeAt(q);
          if (ec === 123) {
            q = skipWsGlobal(text, q + 1);
            while (q < text.length && text.charCodeAt(q) !== 125) {
              const ke = lexTokenGlobal(text, q);
              keys.push(JSON.parse(text.slice(q, ke)));
              q = skipWsGlobal(text, ke);
              if (text.charCodeAt(q) === 58) q = skipWsGlobal(text, q + 1);
              // skip the value: re-lex one structural value
              q = skipValue(text, q);
              q = skipWsGlobal(text, q);
              if (text.charCodeAt(q) === 44) q = skipWsGlobal(text, q + 1);
            }
          }
        } else {
          while (q < text.length && text.charCodeAt(q) !== 125) {
            const ke = lexTokenGlobal(text, q);
            keys.push(JSON.parse(text.slice(q, ke)));
            q = skipWsGlobal(text, ke);
            if (text.charCodeAt(q) === 58) q = skipWsGlobal(text, q + 1);
            q = skipValue(text, q);
            q = skipWsGlobal(text, q);
            if (text.charCodeAt(q) === 44) q = skipWsGlobal(text, q + 1);
          }
        }
      }
    }
    out[key] = keys;
    // advance past this value (balance-aware)
    pos = skipValue(text, pos);
    pos = skipWsGlobal(text, pos);
    if (text.charCodeAt(pos) === 44) pos = skipWsGlobal(text, pos + 1);
  }
  return out;
}

function skipValue(text, pos) {
  const c = text.charCodeAt(pos);
  if (c === 123 || c === 91) {
    const opener = c;
    const closer = c === 123 ? 125 : 93;
    let depth = 0;
    let i = pos;
    while (i < text.length) {
      const d = text.charCodeAt(i);
      if (d === 34) {
        i = lexTokenGlobal(text, i);
        continue;
      }
      if (d === opener) depth++;
      else if (d === closer) {
        depth--;
        if (depth === 0) return i + 1;
      }
      i++;
    }
    return i;
  }
  return lexTokenGlobal(text, pos);
}

function skipWsGlobal(s, i) {
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 10 || c === 13 || c === 9) i++;
    else break;
  }
  return i;
}
function lexTokenGlobal(s, i) {
  return lexTokenShim(s, i);
}

/** cheap diff classification between two texts of the same doc */
function diffSummary(a, b) {
  if (a === b) return { identical: true };
  let i = 0;
  const n = Math.min(a.length, b.length);
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return { identical: false, firstDiffAt: i, aAround: a.slice(Math.max(0, i - 30), i + 30), bAround: b.slice(Math.max(0, i - 30), i + 30), lenA: a.length, lenB: b.length };
}

// ─────────────────────────── B. scanner cost ───────────────────────────
for (const name of ['2mb', '10mb', '50mb']) {
  const text = readFileSync(SAMPLES[name], 'utf8');
  const fast = bench(() => scanFidelity(text, { detectDuplicates: false }), 3);
  const full = name === '50mb' ? null : bench(() => scanFidelity(text, { detectDuplicates: true }), 3);
  const scan = scanFidelity(text, { detectDuplicates: false, maxSamples: 5 });
  out.B_scanner[name] = {
    chars: text.length,
    mib: r3(text.length / MIB),
    fast: { ...fast, findings: scan.findings, throughputMBs: r3(text.length / MIB / (fast.medianMs / 1000)) },
    full: full ? { ...full, throughputMBs: r3(text.length / MIB / (full.medianMs / 1000)) } : 'skipped (memory: per-object Set)',
    scan,
  };
}

// ─────────────────────────── C. token offset index (raw-slice evidence) ───────────────────────────
for (const name of ['10mb', '50mb']) {
  const text = readFileSync(SAMPLES[name], 'utf8');
  const h0 = heapMB();
  const idx = buildTokenIndex(text);
  const h1 = heapMB();
  out.C_tokenIndex[name] = {
    chars: text.length,
    tokenCount: idx.count,
    indexBytes: idx.bytes,
    indexMiB: r3(idx.bytes / MIB),
    buildMs: idx.elapsedMs,
    heapDeltaMiB: r3(h1 - h0),
    bytesPerToken: r3(idx.bytes / idx.count),
    note: '若要支持「树里显示原始数字/键序」的 raw-slice 层，需保留 token 起止偏移（或等价的 node→[start,end) 映射）',
  };
}

// ─────────────────────────── D. raw text view ───────────────────────────
for (const name of ['2mb', '10mb', '50mb']) {
  const text = readFileSync(SAMPLES[name], 'utf8');
  const h0 = heapMB();
  const probe = probeText(text);
  const view = buildRawView(text, { cpEvery: DEFAULT_CP_EVERY });
  const h1 = heapMB();

  const windows = [0, Math.floor(view.lineCount * 0.5), Math.max(0, view.lineCount - 50)].map((startLine) => ({
    startLine,
    ...bench(() => view.windowText(startLine, 50), 9),
  }));
  // worst case: just before a checkpoint boundary (max re-lex distance)
  const nearCp = Math.min(view.lineCount - 1, DEFAULT_CP_EVERY - 1);
  windows.push({ startLine: nearCp, worstCase: true, ...bench(() => view.windowText(nearCp, 50), 9) });

  out.D_rawView[name] = {
    chars: text.length,
    probe,
    mode: view.mode,
    lineCount: view.lineCount,
    cpEvery: DEFAULT_CP_EVERY,
    cpCount: view.cpCount,
    indexBytes: view.indexBytes,
    indexKiB: r3(view.indexBytes / 1024),
    buildMs: view.buildMs,
    heapDeltaMiB: r3(h1 - h0),
    bytesPerLine: r3(view.indexBytes / view.lineCount),
    windowText: windows,
    sampleLines: view.windowText(0, 6),
  };
}

// correctness: reconstruct the whole pretty text from the view, re-parse, compare to source
{
  const text = readFileSync(SAMPLES['2mb'], 'utf8');
  const view = new PrettyLineView(text).build();
  const lines = [];
  walkPretty(text, 0, 0, (rec) => {
    lines.push(renderPrettyLine(text, rec));
  });
  const rebuilt = lines.join('\n');
  const okParse = (() => {
    try {
      JSON.stringify(JSON.parse(rebuilt)) === JSON.stringify(JSON.parse(text));
      return true;
    } catch (e) {
      return String(e.message);
    }
  })();
  out.D_rawView.correctness = {
    lines: lines.length,
    rebuiltChars: rebuilt.length,
    expectedLineCount: view.lineCount,
    lineCountMatches: lines.length === view.lineCount,
    reparseDeepEquals: okParse,
    verdict: okParse === true ? 'OK: 重建文本可解析且与源文档深度等价（键序=源序）' : 'FAIL',
  };
}

// SourceLineView on an already pretty-printed source
{
  const text = readFileSync(SAMPLES['2mb'], 'utf8');
  const pretty = prettifyToString(text);
  const h0 = heapMB();
  const view = new SourceLineView(pretty.text).build();
  const h1 = heapMB();
  out.D_rawView.sourceLineMode = {
    sourceChars: pretty.text.length,
    prettyMs: pretty.elapsedMs,
    lineCount: view.lineCount,
    buildMs: view.buildMs,
    indexBytes: view.indexBytes,
    indexMiB: r3(view.indexBytes / MIB),
    heapDeltaMiB: r3(h1 - h0),
    window: bench(() => view.window(Math.floor(view.lineCount / 2), 50), 9),
    sampleLines: view.window(3, 3),
  };
}

// ─────────────────────────── E. baseline: materialize pretty text ───────────────────────────
for (const name of ['2mb', '10mb']) {
  const text = readFileSync(SAMPLES[name], 'utf8');
  const h0 = heapMB();
  const r = prettifyToString(text);
  const h1 = heapMB();
  out.E_prettify[name] = {
    sourceChars: text.length,
    prettyChars: r.chars,
    prettyMiB: r3(r.chars / MIB),
    ratio: r3(r.chars / text.length),
    elapsedMs: r.elapsedMs,
    heapDeltaMiB: r3(h1 - h0),
    note: '策略 (c)：预生成 pretty 全文',
  };
}
// 50MB attempt: only if the previous ones suggest it fits (guard memory)
{
  const text = readFileSync(SAMPLES['50mb'], 'utf8');
  const h0 = heapMB();
  const r = prettifyToString(text);
  const h1 = heapMB();
  out.E_prettify['50mb'] = {
    sourceChars: text.length,
    prettyChars: r.chars,
    prettyMiB: r3(r.chars / MIB),
    ratio: r3(r.chars / text.length),
    elapsedMs: r.elapsedMs,
    heapDeltaMiB: r3(h1 - h0),
  };
}

// ─────────────────────────── F. tokenizer throughput ───────────────────────────
for (const name of ['10mb', '50mb']) {
  const text = readFileSync(SAMPLES[name], 'utf8');
  let tokens = 0;
  const t = bench(() => {
    tokens = 0;
    walkPretty(text, 0, 0, () => {
      tokens++;
    });
  }, 3);
  // per-window line lexing (what syntax highlighting actually costs per frame)
  const view = new PrettyLineView(text).build();
  const lines = view.windowText(1000, 50);
  const lexWin = bench(() => {
    for (const l of lines) lexLine(l);
  }, 21);
  out.F_tokenizer[name] = {
    tokens,
    fullPass: { ...t, throughputMBs: r3(text.length / MIB / (t.medianMs / 1000)) },
    tokensPerLineAvg: r3(tokens / view.lineCount),
    lex50LinesMs: lexWin.medianMs,
    lexPerLineUs: r3((lexWin.medianMs / 50) * 1000),
  };
}

console.log(JSON.stringify(out, null, 2));
