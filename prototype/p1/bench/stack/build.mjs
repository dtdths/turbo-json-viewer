#!/usr/bin/env node
/** esbuild multi-entry build: extension page + module worker + service worker.
 *  Also emits an "application-shaped" bundle for the size budget.
 *  Usage: node build.mjs [--dev]   (--dev: unminified + sourcemap, no size report)
 */
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { reportSizes } from './lib/size.mjs';

const here = import.meta.dirname;
const OUT = path.resolve(here, '../../fixtures/stack');
const dev = process.argv.includes('--dev');

const entries = {
  'bench-dom': 'src/bench-dom.ts',
  'bench-ui': 'src/bench-ui.ts',
  worker: 'src/worker.ts',
  sw: 'src/sw.ts',
  app: 'src/app.ts',
};

await mkdir(OUT, { recursive: true });
const t0 = performance.now();
const result = await build({
  entryPoints: Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, path.join(here, v)])),
  outdir: OUT,
  bundle: true,
  format: 'esm',
  target: ['chrome120'],
  platform: 'browser',
  minify: !dev,
  sourcemap: dev ? 'inline' : false,
  metafile: true,
  logLevel: dev ? 'info' : 'warning',
  splitting: false,
  legalComments: 'none',
});
const buildMs = performance.now() - t0;

const sizes = dev
  ? {}
  : await reportSizes(
      Object.fromEntries(
        ['bench-dom', 'bench-ui', 'worker', 'sw', 'app'].map((n) => [n, path.join(OUT, n + '.js')]),
      ),
    );

const inputs = result.metafile.inputs;
const inputBytes = Object.values(inputs).reduce((a, i) => a + i.bytesInOutput, 0);

const summary = {
  mode: dev ? 'dev' : 'prod',
  buildMs: Math.round(buildMs),
  entries: Object.keys(entries).length,
  inputs: Object.keys(inputs).length,
  inputBytesInOutput: inputBytes,
  outputs: sizes,
  outdir: OUT,
};
await writeFile(path.join(here, 'results/build.json'), JSON.stringify(summary, null, 2));

console.log(`esbuild multi-entry (${summary.mode}) ${summary.buildMs}ms, ${summary.inputs} modules inlined`);
for (const [name, s] of Object.entries(sizes)) {
  console.log(`  ${name.padEnd(10)} ${String(s.raw).padStart(8)} raw  ${String(s.gz).padStart(7)} gz  (${s.gzKB} KB gz)`);
}
