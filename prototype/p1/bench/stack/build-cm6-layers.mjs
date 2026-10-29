#!/usr/bin/env node
/** Incremental CodeMirror 6 cost: which package adds how many KB gz. */
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { reportSizes } from './lib/size.mjs';

const here = import.meta.dirname;
const OUT = path.resolve(here, 'results/layers');
await mkdir(OUT, { recursive: true });
const layers = [
  ['l0-state', 'src/layers/l0-state.ts'],
  ['l1-view', 'src/layers/l1-view.ts'],
  ['l2-autocomplete', 'src/layers/l2-autocomplete.ts'],
  ['l3-commands', 'src/layers/l3-commands.ts'],
  ['l4-lang', 'src/layers/l4-lang.ts'],
];
const files = {};
const times = {};
for (const [name, src] of layers) {
  const outfile = path.join(OUT, name + '.js');
  const t0 = performance.now();
  await build({
    entryPoints: [path.join(here, src)],
    outfile,
    bundle: true,
    format: 'esm',
    target: ['chrome120'],
    minify: true,
    legalComments: 'none',
    logLevel: 'warning',
  });
  times[name] = Math.round(performance.now() - t0);
  files[name] = outfile;
}
const sizes = await reportSizes(files);
const rows = [];
let prevGz = 0;
for (const [name] of layers) {
  rows.push({ layer: name, gz: sizes[name].gz, deltaGz: sizes[name].gz - prevGz, raw: sizes[name].raw });
  prevGz = sizes[name].gz;
}
await writeFile(path.join(here, 'results/cm6-layers.json'), JSON.stringify({ rows, times }, null, 2));
for (const r of rows) console.log(`  ${r.layer.padEnd(16)} ${String(r.raw).padStart(8)} raw ${String(r.gz).padStart(7)} gz  Δ${r.deltaGz >= 0 ? '+' : ''}${r.deltaGz}`);
