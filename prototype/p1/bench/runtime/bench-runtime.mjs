#!/usr/bin/env node
/**
 * Re-runnable runtime / IR bench for the "document-resident Worker + row window"
 * re-assessment. Boots Chrome for Testing (via prototype/p1/lib/chrome.mjs) with the
 * `fixtures/runtime` extension, drives it over CDP, and prints JSON.
 *
 *   node prototype/p1/bench/runtime/bench-runtime.mjs arch [--reps=5] [--samples=10mb,50mb] [--modes=A,B,H]
 *   node prototype/p1/bench/runtime/bench-runtime.mjs rowmodel [--sample=50mb]
 *   node prototype/p1/bench/runtime/bench-runtime.mjs identity [--sample=50mb]
 *   node prototype/p1/bench/runtime/bench-runtime.mjs roots    [--sample=50mb]
 *   node prototype/p1/bench/runtime/bench-runtime.mjs protocol [--sample=2mb]
 *   node prototype/p1/bench/runtime/bench-runtime.mjs scrollcap
 *   node prototype/p1/bench/runtime/bench-runtime.mjs all
 *
 * Results are also written to .spike/runtime-bench/<command>-<ts>.json (gitignored).
 * Samples are read from .spike/samples; nothing is copied into the repo.
 */
import path from 'node:path';
import os from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { launchChrome, extensionUrl, REPO_ROOT } from '../../lib/chrome.mjs';
import { startStaticServer } from '../../lib/http.mjs';

const FIXTURE = path.resolve(import.meta.dirname, '../../fixtures/runtime');
const SAMPLE_DIR = path.join(REPO_ROOT, '.spike/samples');
const OUT_DIR = path.join(REPO_ROOT, '.spike/runtime-bench');

const argv = process.argv.slice(2);
const command = argv[0] || 'all';
const flags = Object.fromEntries(
  argv
    .slice(1)
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, ...rest] = a.slice(2).split('=');
      return [k, rest.join('=') || true];
    }),
);
const reps = Number(flags.reps ?? (command === 'arch' ? 5 : 1));
const samples = String(flags.samples ?? '10mb,50mb').split(',');
const modes = String(flags.modes ?? 'A,B,H').split(',');

const quantile = (arr, q) => {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const pos = Math.min(a.length - 1, Math.max(0, Math.ceil(q * a.length) - 1));
  return +a[pos].toFixed(4);
};
const summarize = (values) => ({
  n: values.length,
  median: quantile(values, 0.5),
  p95: quantile(values, 0.95),
  min: +Math.min(...values).toFixed(4),
  max: +Math.max(...values).toFixed(4),
});

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? prefix + '.' + k : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
  }
  return out;
}

function summarizeRuns(runs) {
  const perPath = {};
  for (const run of runs) {
    for (const [k, v] of Object.entries(flatten(run))) (perPath[k] ||= []).push(v);
  }
  const out = {};
  for (const [k, vals] of Object.entries(perPath)) out[k] = summarize(vals);
  return out;
}

async function openTrialPage(chrome, base) {
  const page = await chrome.openPage();
  const url = extensionUrl(FIXTURE, 'page.html') + '?base=' + encodeURIComponent(base);
  await page.goto(url, { timeoutMs: 30000 });
  await page.waitFor('globalThis.__rt && globalThis.__rt.ready === true', { timeoutMs: 20000 });
  return page;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, tag) =>
  Promise.race([
    p,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timed out: ' + tag)), ms)),
  ]);

async function runEval(chrome, base, expr, timeout = 300000) {
  const page = await openTrialPage(chrome, base);
  try {
    return await page.eval(expr, { timeout });
  } finally {
    await page.close();
  }
}

async function save(commandName, payload) {
  await mkdir(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(OUT_DIR, `${commandName}-${stamp}.json`);
  await writeFile(file, JSON.stringify(payload, null, 2));
  return file;
}

const env = async (chrome) => {
  let chromeVersion = null;
  try {
    const v = await chrome.browser.send('Browser.getVersion');
    chromeVersion = v.product;
  } catch {
    /* ignore */
  }
  return {
    at: new Date().toISOString(),
    node: process.version,
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    cpus: os.cpus().length,
    loadavg: os.loadavg().map((v) => +v.toFixed(2)),
    chrome: chromeVersion,
    chromeBin: process.env.CHROME_BIN || '(default from lib/chrome.mjs)',
    samplesDir: SAMPLE_DIR,
    concurrencyNote: 'other repo teammates may have run light builds concurrently; measured interleaved, reported median/p95',
  };
};

async function withBench(fn) {
  const server = await startStaticServer(SAMPLE_DIR);
  const chrome = await launchChrome({
    extensionDirs: [FIXTURE],
    extraArgs: ['--enable-precise-memory-info', '--js-flags=--expose-gc'],
  });
  try {
    const e = await env(chrome);
    return await fn({ chrome, base: server.base, env: e });
  } finally {
    await chrome.close();
    await server.close();
  }
}

const ARCH_EXPR = (sample, mode, overscan) =>
  `__rt.arch(${JSON.stringify({ sample, mode, overscan })})`;

async function cmdArch() {
  return withBench(async ({ chrome, base, env: e }) => {
    const variants = [];
    for (const sample of samples) {
      for (const mode of modes) variants.push({ sample, mode, overscan: 2 });
      if (sample === '50mb') {
        variants.push({ sample, mode: 'A', overscan: 0 });
        variants.push({ sample, mode: 'A', overscan: 8 });
      }
    }
    const runs = [];
    for (let rep = 0; rep < reps; rep++) {
      for (const v of variants) {
        const startedAt = Date.now();
        const res = await runEval(chrome, base, ARCH_EXPR(v.sample, v.mode, v.overscan));
        runs.push({ ...v, rep, wallMs: Date.now() - startedAt, result: res });
        process.stderr.write(
          `[arch] rep=${rep} ${v.sample} ${v.mode} ov=${v.overscan} paint=${res?.segments?.paintMs}ms itemsToggle=${res?.toggles?.items?.ms}ms\n`,
        );
      }
    }
    // summary per variant
    const byVariant = {};
    for (const run of runs) {
      const key = `${run.sample}:${run.mode}:ov${run.overscan}`;
      (byVariant[key] ||= []).push(run.result);
    }
    const summary = {};
    for (const [k, rs] of Object.entries(byVariant)) summary[k] = summarizeRuns(rs);
    const payload = { command: 'arch', env: e, args: { reps, samples, modes }, summary, runs };
    const file = await save('arch', payload);
    return { file, payload };
  });
}

async function cmdOneWorkerBench(kind, sample) {
  return withBench(async ({ chrome, base, env: e }) => {
    const res = await runEval(chrome, base, `__rt.bench(${JSON.stringify({ kind, sample })})`);
    const payload = { command: kind, env: e, args: { sample }, result: res };
    const file = await save(kind, payload);
    return { file, payload };
  });
}

async function cmdMemProbe() {
  return withBench(async ({ chrome, base, env: e }) => {
    const sample = String(flags.sample ?? '50mb');
    const res = await runEval(chrome, base, `__rt.memProbe(${JSON.stringify({ sample })})`);
    const payload = { command: 'memprobe', env: e, args: { sample }, result: res };
    const file = await save('memprobe', payload);
    return { file, payload };
  });
}

async function cmdRoots() {
  return withBench(async ({ chrome, base, env: e }) => {
    const sample = String(flags.sample ?? '50mb');
    const res = await runEval(chrome, base, `__rt.roots(${JSON.stringify({ sample })})`);
    const payload = { command: 'roots', env: e, args: { sample }, result: res };
    const file = await save('roots', payload);
    return { file, payload };
  });
}

async function cmdMem() {
  return withBench(async ({ chrome, base, env: e }) => {
    const sampleList = String(flags.samples ?? '10mb,50mb').split(',');
    const modeList = String(flags.modes ?? 'A,B').split(',');
    const page = await openTrialPage(chrome, base);
    const workers = [];
    chrome.browser.on('Target.attachedToTarget', (p, sid) => {
      // flatten mode: the new session id is params.sessionId (NOT the parent sessionId arg)
      if (p.targetInfo?.type === 'worker') workers.push({ sid: p.sessionId ?? sid, targetId: p.targetInfo.targetId });
    });
    await chrome.browser.send(
      'Target.setAutoAttach',
      { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
      page.sessionId,
    );
    const out = {};
    try {
      for (const sample of sampleList) {
        for (const mode of modeList) {
          workers.length = 0;
          const start = await page.eval(`__rt.memStart(${JSON.stringify({ sample, mode })})`, { timeout: 120000 });
          const deadline = Date.now() + 5000;
          while (workers.length === 0 && Date.now() < deadline) await sleep(50);
          let workerHeap = null;
          let workerHeapAfterGC = null;
          if (workers.length) {
            const sid = workers[workers.length - 1].sid;
            try {
              workerHeap = await withTimeout(chrome.browser.send('Runtime.getHeapUsage', {}, sid), 5000, 'worker heap');
              await chrome.browser.send('Runtime.evaluate', { expression: "if (typeof gc === 'function') gc()", returnByValue: true }, sid);
              workerHeapAfterGC = await withTimeout(chrome.browser.send('Runtime.getHeapUsage', {}, sid), 5000, 'worker heap gc');
            } catch (err) {
              workerHeap = { error: String(err) };
            }
          }
          const pageHeap = await page.eval('__rt.heapNow()');
          out[`${sample}:${mode}`] = {
            start,
            workerHeapUsedMB: workerHeap?.usedSize != null ? +(workerHeap.usedSize / 1048576).toFixed(2) : null,
            workerHeapAfterGC_MB: workerHeapAfterGC?.usedSize != null ? +(workerHeapAfterGC.usedSize / 1048576).toFixed(2) : null,
            pageHeapMB: pageHeap,
            workerError: workerHeap?.error ?? null,
          };
          await page.eval('__rt.memEnd()');
          await sleep(300);
        }
      }
    } finally {
      await page.eval('__rt.memEnd()').catch(() => {});
      await page.close();
    }
    const payload = { command: 'mem', env: e, args: { sampleList, modeList }, summary: out };
    const file = await save('mem', payload);
    return { file, payload };
  });
}

async function cmdProtocol() {
  return withBench(async ({ chrome, base, env: e }) => {
    const sample = String(flags.sample ?? '2mb');
    const res = await runEval(chrome, base, `__rt.protocol(${JSON.stringify({ sample })})`);
    const payload = { command: 'protocol', env: e, args: { sample }, result: res };
    const file = await save('protocol', payload);
    return { file, payload };
  });
}

async function cmdScrollCap() {
  return withBench(async ({ chrome, base, env: e }) => {
    const res = await runEval(chrome, base, `__rt.scrollCap()`);
    const payload = { command: 'scrollcap', env: e, result: res };
    const file = await save('scrollcap', payload);
    return { file, payload };
  });
}

const main = async () => {
  const outputs = {};
  if (command === 'arch') outputs.arch = await cmdArch();
  else if (command === 'rowmodel') outputs.rowmodel = await cmdOneWorkerBench('rowmodel', String(flags.sample ?? '50mb'));
  else if (command === 'identity') outputs.identity = await cmdOneWorkerBench('identity', String(flags.sample ?? '50mb'));
  else if (command === 'roots') outputs.roots = await cmdRoots();
  else if (command === 'memprobe') outputs.memprobe = await cmdMemProbe();
  else if (command === 'protocol') outputs.protocol = await cmdProtocol();
  else if (command === 'mem') outputs.mem = await cmdMem();
  else if (command === 'scrollcap') outputs.scrollcap = await cmdScrollCap();
  else if (command === 'all') {
    outputs.protocol = await cmdProtocol();
    outputs.scrollcap = await cmdScrollCap();
    outputs.roots = await cmdRoots();
    outputs.memprobe = await cmdMemProbe();
    outputs.rowmodel = await cmdOneWorkerBench('rowmodel', '50mb');
    outputs.identity = await cmdOneWorkerBench('identity', '50mb');
    outputs.mem = await cmdMem();
    outputs.arch = await cmdArch();
  } else {
    throw new Error('unknown command: ' + command);
  }
  const files = Object.fromEntries(Object.entries(outputs).map(([k, v]) => [k, v.file]));
  console.log(JSON.stringify({ command, files, result: Object.fromEntries(Object.entries(outputs).map(([k, v]) => [k, v.payload])) }, null, 2));
};

main().catch((err) => {
  console.error('BENCH FAILED:', err);
  process.exitCode = 1;
});
