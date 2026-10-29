/**
 * Main-thread half of the import-path bench.
 *
 * For each sample size it compares four ways of getting the bytes into the Worker:
 *   A) file.text()            — UTF-8 decode on the MAIN thread, string then structured-cloned
 *   B) file.arrayBuffer()     — bytes on main (no decode), buffer transferred (zero-copy)
 *   C) file.stream()          — ReadableStream transferred, Worker decodes incrementally
 *   D) arrayBuffer + worker decode only (no parse) — isolates decode vs parse
 * plus the paste path (DataTransfer → ClipboardEvent → handler reads clipboardData only)
 * and a negative control that puts the text into a DOM text node.
 */
const q = new URLSearchParams(location.search);
const BASE = q.get('base');
const SIZES = (q.get('sizes') || '10mb').split(',');
const ROUNDS = Number(q.get('rounds') || 2);
const NEGATIVE_CONTROL = q.get('negative') === '1';
const phaseEl = document.getElementById('phase');

const now = () => performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
const memMB = () => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null);

const longTasks = [];
const ltObserver = new PerformanceObserver((list) => {
  for (const e of list.getEntries()) longTasks.push({ start: e.startTime, dur: e.duration });
});
try {
  ltObserver.observe({ type: 'longtask', buffered: false });
} catch {
  /* longtask unsupported */
}
function takeLongTask(duringMs) {
  const out = longTasks.filter((t) => t.start >= duringMs.a && t.start <= duringMs.b);
  return { count: out.length, sumMs: Math.round(out.reduce((s, t) => s + t.dur, 0) * 10) / 10, maxMs: out.length ? Math.round(Math.max(...out.map((t) => t.dur))) : 0 };
}

// ── worker RPC ──
const worker = new Worker('./worker.js', { type: 'module' });
const pending = new Map();
let seq = 0;
worker.onmessage = (ev) => {
  const { id, ...rest } = ev.data;
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  rest.readyMs = now() - p.t0;
  p.resolve(rest);
};
function rpc(msg, transfer = []) {
  const id = ++seq;
  return new Promise((resolve) => {
    pending.set(id, { resolve, t0: now() });
    worker.postMessage({ ...msg, id }, transfer);
  });
}

async function round(fn, reps = ROUNDS) {
  const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const acc = {};
  const runs = [];
  for (let r = 0; r < reps; r++) {
    const res = await fn();
    runs.push(res);
    for (const [k, v] of Object.entries(res)) {
      if (typeof v === 'number') (acc[k] ||= []).push(v);
    }
  }
  const out = {};
  for (const [k, arr] of Object.entries(acc)) {
    const s = arr.slice().sort((a, b) => a - b);
    out[k] = { median: Math.round(med(arr) * 100) / 100, p95: Math.round(s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)] * 100) / 100, all: arr.map((v) => Math.round(v * 100) / 100) };
  }
  return out;
}

async function getFile(size) {
  const res = await fetch(`${BASE}/${size}.json`, { cache: 'force-cache' });
  const blob = await res.blob();
  return new File([blob], `${size}.json`, { type: 'application/json' });
}

const result = { env: {}, sizes: {} };
result.env = {
  ua: navigator.userAgent,
  hardwareConcurrency: navigator.hardwareConcurrency,
  deviceMemory: navigator.deviceMemory,
  crossOriginIsolated: self.crossOriginIsolated,
  heapLimitMB: performance.memory ? Math.round(performance.memory.jsHeapSizeLimit / 1048576) : null,
  memoryPrecise: !!(performance.memory && performance.memory.usedJSHeapSize % 1024 !== 0),
};

const ping = await rpc({ cmd: 'ping' });
result.env.workerRttMs = Math.round(ping.readyMs * 100) / 100;

for (const size of SIZES) {
  phaseEl.textContent = `fetching ${size}`;
  const file = await getFile(size);
  const sizeOut = { bytes: file.size };
  const hBase = memMB();

  // A) file.text() on main → clone string to worker
  sizeOut.A_text = await round(async () => {
    const m0 = memMB();
    const a = now();
    const text = await file.text();
    const getTextMs = now() - a;
    const b = now();
    const r = await rpc({ cmd: 'parse-text', text, countNodes: false });
    const rtMs = now() - b;
    await raf();
    const paintMs = now() - a;
    return { getTextMs, rtMs, workerParseMs: r.parseMs, workerArriveMs: r.arriveMs, totalMs: paintMs, mainLongTaskMs: takeLongTask({ a, b }).sumMs, heapDelta: memMB() - m0, chars: r.chars };
  });

  // B) arrayBuffer on main (transfer) → worker TextDecoder + parse
  sizeOut.B_arrayBufferTransfer = await round(async () => {
    const m0 = memMB();
    const a = now();
    const buf = await file.arrayBuffer();
    const getBytesMs = now() - a;
    const b = now();
    const r = await rpc({ cmd: 'decode-parse', buf }, [buf]);
    const rtMs = now() - b;
    await raf();
    return { getBytesMs, rtMs, workerDecodeMs: r.decodeMs, workerParseMs: r.parseMs, workerArriveMs: r.arriveMs, totalMs: now() - a, mainLongTaskMs: takeLongTask({ a, b }).sumMs, heapDelta: memMB() - m0 };
  });

  // C) file.stream() transferred → worker streaming decode + parse
  sizeOut.C_streamTransfer = await round(async () => {
    const m0 = memMB();
    const a = now();
    const stream = file.stream();
    const openMs = now() - a;
    const b = now();
    const r = await rpc({ cmd: 'stream-parse', stream }, [stream]);
    const rtMs = now() - b;
    await raf();
    return { getStreamMs: openMs, rtMs, workerDecodeMs: r.decodeMs, workerParseMs: r.parseMs, arriveMs: r.arriveMs, totalMs: now() - a, mainLongTaskMs: takeLongTask({ a, b }).sumMs, heapDelta: memMB() - m0 };
  });

  // D) arrayBuffer transfer + worker decode only (separates decode from parse)
  sizeOut.D_decodeOnly = await round(async () => {
    const a = now();
    const buf = await file.arrayBuffer();
    const r = await rpc({ cmd: 'decode-only', buf }, [buf]);
    return { totalMs: now() - a, workerDecodeMs: r.decodeMs, workerArriveMs: r.arriveMs, chars: r.chars };
  });

  // paste path: DataTransfer → ClipboardEvent(paste) → handler reads clipboardData only
  sizeOut.E_pasteEvent = await round(async () => {
    const res = await fetch(`${BASE}/${size}.json`, { cache: 'force-cache' });
    const text = await res.text(); // already needed to build the event; measured separately
    const m0 = memMB();
    const a = now();
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    const setDataMs = now() - a;
    let handlerMs = -1;
    let sawText = 0;
    const onPaste = (e) => {
      e.preventDefault(); // <- the product rule: text never reaches the DOM
      const h0 = now();
      const t = e.clipboardData.getData('text');
      sawText = t.length;
      handlerMs = now() - h0;
    };
    document.addEventListener('paste', onPaste, { once: true });
    const b = now();
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    const dispatchMs = now() - b;
    document.removeEventListener('paste', onPaste);
    return { setDataMs, dispatchMs, handlerGetDataMs: handlerMs, chars: sawText, mainLongTaskMs: takeLongTask({ a, b: now() }).sumMs, heapDelta: memMB() - m0 };
  }, 2);

  // negative control: render the text into a DOM text node (what we must never do)
  if (NEGATIVE_CONTROL && size === SIZES[0]) {
    const res = await fetch(`${BASE}/${size}.json`, { cache: 'force-cache' });
    const text = await res.text();
    const el = document.getElementById('log');
    const a = now();
    el.textContent = text;
    const setTextMs = now() - a;
    const b = now();
    document.body.offsetHeight; // force layout
    const layoutMs = now() - b;
    sizeOut.F_domTextNode_negativeControl = {
      setTextMs: Math.round(setTextMs * 100) / 100,
      forcedLayoutMs: Math.round(layoutMs * 100) / 100,
      longTaskMs: takeLongTask({ a, b: now() }).sumMs,
      chars: text.length,
    };
    el.textContent = '';
  }

  // Q2/Q3 confirmation inside a real Chrome worker
  phaseEl.textContent = `rawview ${size}`;
  const buf = await file.arrayBuffer();
  const rv = await rpc({ cmd: 'rawview', buf }, [buf]);
  sizeOut.rawViewInWorker = rv;
  sizeOut.heapAfterAllMB = memMB() - hBase;

  result.sizes[size] = sizeOut;
  phaseEl.textContent = `done ${size}`;
}

result.heapFinalMB = memMB();
result.done = true;
window.__bench = { done: true, result };
