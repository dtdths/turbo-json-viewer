const out = { startedAt: performance.now(), steps: [] };
globalThis.__smoke = out;

try {
  // Indirect eval: should be blocked by the extension-page CSP.
  // eslint-disable-next-line no-eval
  (0, eval)('1 + 1');
  out.cspEvalBlocked = false;
} catch (e) {
  out.cspEvalBlocked = true;
  out.cspEvalError = String(e).slice(0, 160);
}
out.origin = location.origin;
out.chromeRuntime = typeof chrome !== 'undefined' && !!chrome.runtime;

const worker = new Worker(chrome.runtime.getURL('worker.js'), { type: 'module' });
out.workerGettable = true;

worker.onmessage = (e) => {
  out.worker = e.data;
  worker.terminate();
  out.done = true;
  out.totalMs = performance.now() - out.startedAt;
};
worker.onerror = (e) => {
  out.workerError = e.message || String(e);
  out.done = true;
};
worker.postMessage({ text: '{"a":[1,2,3],"b":"x","c":true}' });
