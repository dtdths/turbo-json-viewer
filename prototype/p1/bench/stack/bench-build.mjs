#!/usr/bin/env node
/** Driver: build / dev-loop / test-loop feasibility + timings (Node only).
 *  Measures: esbuild multi-entry cold build, incremental watch rebuild latency,
 *  vitest run time, tsc --noEmit time.
 *  Usage: node bench-build.mjs */
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { measureWatch } from './lib/watch.mjs';

const here = import.meta.dirname;
const OUTDIR = path.resolve(here, '../../fixtures/stack');
const run = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    const t0 = performance.now();
    const p = spawn(cmd, args, { cwd: here, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, ms: Math.round(performance.now() - t0), out }));
  });

const multiEntry = await run(process.execPath, ['build.mjs']);
const buildJson = JSON.parse(await readFile(path.join(here, 'results/build.json'), 'utf8'));

const watch = await measureWatch({ here, outdir: path.join('/tmp', 'watch-out') });

const vitest = await run(path.join(here, 'node_modules/.bin/vitest'), ['run']);
const testCount = /Tests\s+(\d+) passed/.exec(vitest.out);
const testFiles = /Test Files\s+(\d+) passed/.exec(vitest.out);

const tsc = await run(path.join(here, 'node_modules/.bin/tsc'), ['--noEmit']);

const out = {
  multiEntry: { wallMs: multiEntry.ms, buildMs: buildJson.buildMs, entries: buildJson.entries, modules: buildJson.inputs, outputs: buildJson.outputs, code: multiEntry.code },
  watch,
  vitest: { wallMs: vitest.ms, code: vitest.code, files: testFiles?.[1], tests: testCount?.[1] },
  tsc: { wallMs: tsc.ms, code: tsc.code, errors: tsc.out.trim() ? tsc.out.trim().split('\n').length : 0, sample: tsc.out.trim().split('\n').slice(0, 5) },
};
await mkdir(path.join(here, 'results'), { recursive: true });
await writeFile(path.join(here, 'results/build-all.json'), JSON.stringify(out, null, 2));

console.log(`esbuild multi-entry (5 entries incl. page+worker+SW): ${out.multiEntry.wallMs}ms wall (esbuild ${out.multiEntry.buildMs}ms), ${out.multiEntry.modules} modules`);
console.log('outputs:', Object.entries(out.multiEntry.outputs).map(([k, v]) => `${k}=${v.gzKB}KB gz`).join(' '));
console.log(`esbuild watch rebuild: ${JSON.stringify(watch.rebuildMs)} ms (median ${watch.medianMs && watch.medianMs.toFixed(1)}ms)`);
console.log(`vitest: ${out.vitest.wallMs}ms, ${out.vitest.files} files / ${out.vitest.tests} tests, exit ${out.vitest.code}`);
console.log(`tsc --noEmit: ${out.tsc.wallMs}ms, exit ${out.tsc.code}, errors ${out.tsc.errors}`);
