import { build, context } from 'esbuild';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = import.meta.dirname;
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
const watch = process.argv.includes('--watch');
const analyze = process.argv.includes('--analyze');

const entryPoints = {
  page: path.join(SRC, 'app/main.ts'),
  worker: path.join(SRC, 'app/worker.ts'),
  sw: path.join(SRC, 'app/sw.ts'),
};

const staticFiles = [
  ['src/app/page.html', 'page.html'],
  ['src/app/manifest.json', 'manifest.json'],
];

const options = {
  entryPoints,
  outdir: DIST,
  bundle: true,
  format: 'esm',
  target: 'chrome120',
  splitting: true,
  sourcemap: watch ? 'linked' : false,
  // 产物体积预算按 minify 后的 gz 计（架构 §8）：CM6 首开闭包 200→129KB gz、page.js 25.6→17.0KB gz
  minify: true,
  metafile: analyze,
  logLevel: 'info',
  chunkNames: 'chunks/[name]-[hash]',
  assetNames: 'assets/[name]-[hash]',
  loader: { '.css': 'css' },
};

async function copyStatic() {
  await mkdir(DIST, { recursive: true });
  for (const [from, to] of staticFiles) {
    const target = path.join(DIST, to);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(ROOT, from), target);
  }
}

function gzKB(buf) {
  return (zlib.gzipSync(buf).length / 1024).toFixed(1);
}

async function reportSize(metafile) {
  if (!metafile) return;
  const files = Object.keys(metafile.outputs).sort();
  const rows = [];
  for (const f of files) {
    if (!f.endsWith('.js') && !f.endsWith('.css')) continue;
    const buf = await readFile(path.join(ROOT, f));
    rows.push({ file: path.relative(DIST, path.join(ROOT, f)), raw: (buf.length / 1024).toFixed(1), gz: gzKB(buf) });
  }
  rows.sort((a, b) => Number(b.gz) - Number(a.gz));
  console.log('\nfile'.padEnd(34), 'raw KB'.padStart(8), 'gzip KB'.padStart(8));
  for (const r of rows) console.log(r.file.padEnd(34), r.raw.padStart(8), r.gz.padStart(8));
  const page = rows.find((r) => r.file.startsWith('page.js'));
  // 预算演进：45（slice 6.19 前）→ 46 → 47 → 48（2026-11-11 晚）→ 50（2026-11-12，#29 / ADR-0021，用户拍板）→ 51（2026-11-13，#41 / ADR-0024 修订 v1.1，用户拍板，实测 50.3）→ 52（2026-11-13，#43 / ADR-0025，用户拍板，实测 51.2）
  if (page) console.log(`\nfirst paint (page.js) gzip: ${page.gz} KB  (budget 52 KB)`);
}

await rm(DIST, { recursive: true, force: true });
await copyStatic();

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('watching… (reload the extension to pick up changes)');
} else {
  const result = await build({ ...options, metafile: analyze });
  if (analyze) await reportSize(result.metafile);
}
