/**
 * Chrome bench: import paths on the real main thread (Q4), plus a real-Chrome-worker
 * confirmation of the raw-text view + fidelity scan (Q2/Q3).
 *
 *   node prototype/p1/bench/fidelity/run-chrome.mjs [--sizes=10mb,50mb] [--rounds=2] [--negative]
 *
 * Needs the Node-side libs inside the extension directory (MV3 CSP only allows
 * `script-src 'self'`), so this script copies bench/fidelity/lib → fixtures/fidelity/gen/lib
 * before launching Chrome and leaves it in place (generated, safe to delete).
 */
import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { withChrome, extensionUrl } from '../../lib/chrome.mjs';
import { startStaticServer } from '../../lib/http.mjs';

const HERE = import.meta.dirname;
const REPO = path.resolve(HERE, '../../../..');
const FIXTURE = path.join(REPO, 'prototype/p1/fixtures/fidelity');
const GEN = path.join(FIXTURE, 'gen/lib');

const argv = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? '1'] : [a, '1'];
  }),
);
const sizes = argv.sizes ?? '10mb,50mb';
const rounds = argv.rounds ?? '2';
const negative = argv.negative ? '1' : '0';

await rm(path.join(FIXTURE, 'gen'), { recursive: true, force: true });
await mkdir(GEN, { recursive: true });
await cp(path.join(HERE, 'lib'), GEN, { recursive: true });

const server = await startStaticServer(path.join(REPO, '.spike/samples'));
const t0 = Date.now();
let out;
try {
  out = await withChrome(
    {
      extensionDirs: [FIXTURE],
      extraArgs: ['--enable-precise-memory-info', '--js-flags=--expose-gc'],
      profileDir: path.join(REPO, '.spike', `chrome-profile-fidelity-${Date.now()}`),
    },
    async (chrome) => {
      const page = await chrome.openPage();
      const url =
        extensionUrl(FIXTURE, 'page.html') +
        `?base=${encodeURIComponent(server.base)}&sizes=${sizes}&rounds=${rounds}&negative=${negative}`;
      await page.goto(url);
      await page.waitFor('globalThis.__bench?.done === true', { timeoutMs: 300000, intervalMs: 250 });
      const result = await page.eval('globalThis.__bench.result', { timeout: 60000 });
      return { result, logs: page.logs.filter((l) => l.type === 'error').slice(0, 10), exceptions: page.exceptions.slice(0, 10) };
    },
  );
} finally {
  await server.close();
}

const payload = {
  harness: { wallMs: Date.now() - t0, chrome: process.env.CHROME_BIN || 'harness default (CfT)', sizes, rounds, negativeControl: negative === '1' },
  ...out,
};
console.log(JSON.stringify(payload, null, 2));
