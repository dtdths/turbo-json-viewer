/**
 * Smoke test for the Chrome/CDP harness: boots headless Chrome with the smoke
 * extension, opens its page, and checks CSP / worker / chrome.runtime.
 *   node prototype/p1/smoke.mjs
 */
import path from 'node:path';
import { extensionUrl, launchChrome, extensionId } from './lib/chrome.mjs';

const ext = path.resolve(import.meta.dirname, 'fixtures/smoke');
const chrome = await launchChrome({ extensionDirs: [ext] });
try {
  console.log('extension id :', extensionId(ext));
  console.log('page url     :', extensionUrl(ext, 'page.html'));
  const page = await chrome.openPage();
  await page.goto(extensionUrl(ext, 'page.html'));
  await page.waitFor('globalThis.__smoke?.done === true', { timeoutMs: 15000 });
  const smoke = await page.eval('globalThis.__smoke');
  console.log(JSON.stringify(smoke, null, 2));
  const ok =
    smoke.cspEvalBlocked === true &&
    smoke.workerGettable === true &&
    smoke.worker?.jsonLen === 30 &&
    smoke.worker?.workerChrome === 'undefined' &&
    smoke.chromeRuntime === true;
  if (page.exceptions.length) console.log('page exceptions:', page.exceptions);
  console.log(ok ? 'SMOKE: PASS' : 'SMOKE: FAIL');
  process.exitCode = ok ? 0 : 1;
} finally {
  await chrome.close();
}
