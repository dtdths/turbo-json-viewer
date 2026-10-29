/** Measure esbuild incremental rebuild latency (watch mode). */
import { context } from 'esbuild';
import { writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

export async function measureWatch({ here, outdir, rounds = 10 }) {
  const probe = path.join(here, 'src/_watch-probe.ts');
  await writeFile(probe, 'export const v = 0;\n');
  let resolveBuild = null;
  const hook = {
    name: 'watch-timer',
    setup(b) {
      b.onEnd(() => {
        resolveBuild?.(performance.now());
        resolveBuild = null;
      });
    },
  };
  const ctx = await context({
    entryPoints: { 'watch-probe': path.join(here, 'src/_watch-probe.ts') },
    outdir,
    bundle: true,
    format: 'esm',
    logLevel: 'silent',
    plugins: [hook],
  });
  await ctx.watch();
  const latencies = [];
  for (let i = 0; i < rounds; i++) {
    const next = new Promise((r) => (resolveBuild = r));
    const t0 = performance.now();
    await writeFile(probe, `export const v = ${i + 1};\n// ${Date.now()}\n`);
    const done = await Promise.race([next, new Promise((r) => setTimeout(() => r(null), 5000))]);
    if (done !== null) latencies.push(done - t0);
  }
  await ctx.dispose();
  await rm(probe, { force: true });
  return {
    rounds,
    rebuildMs: latencies.map((x) => Math.round(x * 100) / 100),
    medianMs: latencies.length ? latencies.slice().sort((a, b) => a - b)[Math.floor(latencies.length / 2)] : null,
  };
}
