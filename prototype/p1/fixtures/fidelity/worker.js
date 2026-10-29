/**
 * Bench worker: measures the *worker side* of each import path.
 * Time origin for arrival is taken on the first line of onmessage, so the reported
 * numbers exclude the page-side cost of producing the bytes.
 */
const post = (id, payload) => self.postMessage({ id, ...payload });
const now = () => performance.now();

function countNodes(v) {
  // iterative, cheap: only counts containers + scalars reached
  let n = 0;
  const stack = [v];
  while (stack.length) {
    const x = stack.pop();
    n++;
    if (x && typeof x === 'object') {
      if (Array.isArray(x)) for (let i = 0; i < x.length; i++) stack.push(x[i]);
      else for (const k in x) stack.push(x[k]);
    }
  }
  return n;
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  const tArrive = now();
  const id = msg.id;
  try {
    if (msg.cmd === 'ping') return post(id, { ok: true, tArrive });
    if (msg.cmd === 'echo-transfer') {
      return post(id, { ok: true, arriveMs: now() - tArrive, byteLength: msg.buf?.byteLength ?? 0 });
    }
    if (msg.cmd === 'parse-text') {
      // text arrives as a structured-cloned JS string
      const t0 = now();
      const v = JSON.parse(msg.text);
      const parseMs = now() - t0;
      return post(id, { ok: true, arriveMs: t0 - tArrive, parseMs, chars: msg.text.length, nodes: msg.countNodes ? countNodes(v) : undefined });
    }
    if (msg.cmd === 'decode-parse') {
      const t0 = now();
      const text = new TextDecoder('utf-8').decode(msg.buf);
      const decodeMs = now() - t0;
      const t1 = now();
      const v = JSON.parse(text);
      const parseMs = now() - t1;
      return post(id, { ok: true, arriveMs: t0 - tArrive, decodeMs, parseMs, chars: text.length, bytes: msg.buf.byteLength });
    }
    if (msg.cmd === 'decode-only') {
      const t0 = now();
      const text = new TextDecoder('utf-8').decode(msg.buf);
      return post(id, { ok: true, arriveMs: t0 - tArrive, decodeMs: now() - t0, chars: text.length });
    }
    if (msg.cmd === 'stream-parse') {
      const stream = msg.stream;
      const reader = stream.getReader();
      const t0 = now();
      const dec = new TextDecoder('utf-8');
      const chunks = [];
      let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        chunks.push(dec.decode(value, { stream: true }));
      }
      chunks.push(dec.decode());
      const text = chunks.join('');
      const decodeMs = now() - t0;
      const t1 = now();
      JSON.parse(text);
      return post(id, { ok: true, arriveMs: t0 - tArrive, decodeMs, parseMs: now() - t1, chars: text.length, bytes, chunks: chunks.length });
    }
    if (msg.cmd === 'rawview') {
      const t0 = now();
      const text = msg.text ?? new TextDecoder('utf-8').decode(msg.buf);
      const decodeMs = msg.text ? 0 : now() - t0;
      const { buildRawView } = await import('./gen/lib/raw-view.mjs');
      const t1 = now();
      const view = buildRawView(text);
      const buildMs = now() - t1;
      const windows = [0, Math.floor(view.lineCount / 2), view.lineCount - 50].map((start) => {
        const ts = [];
        for (let r = 0; r < 9; r++) {
          const t = now();
          view.windowText(start, 50);
          ts.push(now() - t);
        }
        ts.sort((a, b) => a - b);
        return { startLine: start, medianMs: ts[4], maxMs: ts[8] };
      });
      return post(id, { ok: true, arriveMs: t0 - tArrive, decodeMs, buildMs, windows, mode: view.mode, lineCount: view.lineCount, indexBytes: view.indexBytes, cpCount: view.cpCount, probeMs: view.probe?.probeMs, chars: text.length, sampleLines: view.windowText(0, 4) });
    }
    if (msg.cmd === 'fidelity-scan') {
      const text = msg.text ?? new TextDecoder('utf-8').decode(msg.buf);
      const { scanFidelity } = await import('./gen/lib/fidelity.mjs');
      const t = now();
      const r = scanFidelity(text, { maxSamples: 4 });
      return post(id, { ok: true, arriveMs: t - tArrive, scanMs: now() - t, findings: r.findings, numbers: r.numbers, keys: r.keys, duplicates: r.duplicates, samples: r.samples });
    }
    post(id, { ok: false, error: 'unknown cmd ' + msg.cmd });
  } catch (e) {
    post(id, { ok: false, error: String(e && e.message || e), stack: String(e && e.stack || '').slice(0, 400) });
  }
};
