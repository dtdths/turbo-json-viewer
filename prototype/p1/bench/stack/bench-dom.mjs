#!/usr/bin/env node
/** Driver: DOM row-render variants in a real Chrome MV3 extension page.
 *  Usage: node bench-dom.mjs [--quick] */
import { withChrome, extensionUrl } from '../../lib/chrome.mjs';
import { FIXTURE_DIR, RESULTS_DIR } from './lib/chrome-path.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const quick = process.argv.includes('--quick');
const cfg = quick
  ? { logicalRows: 50_000, frames: 60, rounds: 1, rafFrames: 60 }
  : { logicalRows: 200_000, frames: 1000, rounds: 5, rafFrames: 600 };

const t0 = Date.now();
const result = await withChrome(
  {
    extensionDirs: [FIXTURE_DIR],
    windowSize: '1280,900',
    extraArgs: ['--enable-precise-memory-info', '--force-device-scale-factor=1'],
  },
  async (chrome) => {
    const page = await chrome.openPage();
    await page.goto(extensionUrl(FIXTURE_DIR, 'page.html'));
    await page.waitFor('globalThis.__domBench?.runDom !== undefined', { timeoutMs: 15000 });
    const res = await page.eval(`__domBench.runDom(${JSON.stringify(cfg)})`, { timeout: 420000 });
    return { res, logs: page.logs, exceptions: page.exceptions };
  },
);
const wallMs = Date.now() - t0;
if (result.exceptions.length) console.error('page exceptions:', result.exceptions);
await mkdir(RESULTS_DIR, { recursive: true });
const out = { cfg, wallMs, date: new Date().toISOString(), ...result.res };
await writeFile(path.join(RESULTS_DIR, 'dom.json'), JSON.stringify(out, null, 2));

const { variants, meta, checks } = out;
console.log(`\nDOM row bench — ${meta.rowsNote ?? ''}Chrome ${meta.ua.match(/Chrome\/[\d.]+/)?.[0]} · dpr=${meta.dpr} · ${meta.viewportRows} rows/frame @ ${meta.rowHeight}px · logical rows ${meta.logicalRows} · ${meta.rounds} interleaved rounds × ${meta.frames} frames (sync) + ${cfg.rafFrames} rAF frames\n`);
console.log(`| variant | JS median | JS p95 | JS max | JS total/${meta.frames}f | layout+style median | nodes/frame | heap Δ | longtasks | rAF mean frame | rAF p95 | dropped |`);
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const [name, v] of Object.entries(variants)) {
  const s = v.sync;
  const r = v.raf || {};
  console.log(
    `| ${name} | ${s.jsMedianMs} ms | ${s.jsP95Ms} ms | ${s.jsMaxMs} ms | ${s.jsTotalMs} ms | ${s.layoutMedianMs} ms | ${s.nodes} | ${s.heapDeltaKB} KB | ${s.longTasks} | ${r.meanFrameMs ?? '-'} ms | ${r.p95FrameMs ?? '-'} ms | ${r.droppedFrames ?? '-'} (${r.dropRate ?? '-'}%) |`,
  );
}
console.log('\nchecks:', JSON.stringify(checks, null, 2));
console.log(`\nwall ${wallMs}ms`);
