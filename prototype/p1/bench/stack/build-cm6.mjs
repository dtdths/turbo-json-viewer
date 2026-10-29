#!/usr/bin/env node
/** Bundle-size + build-time probe for CodeMirror 6 (minimal vs +javascript),
 *  acorn, focus-trap, @floating-ui/dom, and a splitting:true comparison. */
import { build } from 'esbuild';
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { reportSizes } from './lib/size.mjs';

const here = import.meta.dirname;
const OUT = path.resolve(here, '../../fixtures/stack');
await mkdir(OUT, { recursive: true });

const entry = (rel) => path.join(here, rel);
const common = {
  bundle: true,
  format: 'esm',
  target: ['chrome120'],
  platform: 'browser',
  minify: true,
  legalComments: 'none',
  logLevel: 'warning',
};

async function timedBuild(name, opts) {
  const t0 = performance.now();
  await build(opts);
  return { name, ms: Math.round(performance.now() - t0) };
}

const singles = [
  ['cm6-min', 'src/cm6-min.ts'],
  ['cm6-lang', 'src/cm6-lang.ts'],
  ['textarea-baseline', 'src/textarea-baseline.ts'],
  ['acorn', 'src/acorn-only.ts'],
  ['focus-trap', 'src/libs-focus-trap.ts'],
  ['floating-ui', 'src/libs-floating.ts'],
];
const buildTimes = [];
const sizeFiles = {};
for (const [name, src] of singles) {
  const outfile = path.join(OUT, name + '.js');
  buildTimes.push(await timedBuild(name, { ...common, entryPoints: [entry(src)], outfile }));
  sizeFiles[name] = outfile;
}
const sizes = await reportSizes(sizeFiles);

const splitOut = path.join(OUT, 'split');
await mkdir(splitOut, { recursive: true });
const splitTime = await timedBuild('cm6-split', {
  ...common,
  entryPoints: { 'cm6-min': entry('src/cm6-min.ts'), 'cm6-lang': entry('src/cm6-lang.ts') },
  outdir: splitOut,
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
});
const splitSizes = await reportSizes({
  'cm6-min': path.join(splitOut, 'cm6-min.js'),
  'cm6-lang': path.join(splitOut, 'cm6-lang.js'),
});
const chunkNames = (await readdir(path.join(splitOut, 'chunks'))).map((f) => path.join(splitOut, 'chunks', f));
const chunkSizes = await reportSizes(Object.fromEntries(chunkNames.map((f) => [path.basename(f), f])));
const splitTotal = {
  raw: Object.values(splitSizes).reduce((a, s) => a + s.raw, 0) + Object.values(chunkSizes).reduce((a, s) => a + s.raw, 0),
  gz: Object.values(splitSizes).reduce((a, s) => a + s.gz, 0) + Object.values(chunkSizes).reduce((a, s) => a + s.gz, 0),
};
const unsplitTotal = {
  raw: sizes['cm6-min'].raw + sizes['cm6-lang'].raw,
  gz: sizes['cm6-min'].gz + sizes['cm6-lang'].gz,
};

const repeat = [];
for (let i = 0; i < 5; i++)
  repeat.push((await timedBuild('cm6-min-rep', { ...common, entryPoints: [entry('src/cm6-min.ts')], outfile: path.join('/tmp', 'cm6-rep-' + i + '.js') })).ms);

const summary = { sizes, buildTimes, repeatMs: repeat, split: { timeMs: splitTime.ms, sizes: splitSizes, chunks: chunkSizes, total: splitTotal, unsplitTotal } };
await writeFile(path.join(here, 'results/cm6-build.json'), JSON.stringify(summary, null, 2));
console.log('bundle sizes (minified, bundle:true, format=esm):');
for (const [name, s] of Object.entries(sizes)) {
  console.log(`  ${name.padEnd(18)} ${String(s.raw).padStart(8)} raw ${String(s.gz).padStart(7)} gz (${s.gzKB} KB)`);
}
console.log('build times ms:', buildTimes.map((b) => `${b.name}=${b.ms}`).join(' '));
console.log('cm6-min repeated builds ms:', repeat.join(' '));
console.log(`splitting:true → two entries ${splitTotal.gz} gz vs unsplit ${unsplitTotal.gz} gz`);
