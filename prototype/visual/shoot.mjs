/**
 * Screenshot harness for the visual direction prototypes.
 *
 *   node prototype/visual/shoot.mjs            # both directions, all screens
 *   node prototype/visual/shoot.mjs a          # only direction a
 *
 * Serves prototype/visual over localhost (CORS not needed) and captures
 * 1440x900 PNGs into prototype/visual/shots/.
 */
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { launchChrome, REPO_ROOT } from '../p1/lib/chrome.mjs';
import { startStaticServer } from '../p1/lib/http.mjs';

const VISUAL = path.resolve(import.meta.dirname);
const SHOTS = path.join(VISUAL, 'shots');
const dirs = (process.argv[2] || 'a,b').split(',').map((s) => s.trim()).filter(Boolean);
const screens = ['main', 'empty', 'edit', 'expr', 'search', 'repair'];
const themes = ['dark', 'light'];

await mkdir(SHOTS, { recursive: true });
const server = await startStaticServer(VISUAL);
const chrome = await launchChrome({ windowSize: '1440,900' });
const results = [];

try {
  for (const dir of dirs) {
    for (const screen of screens) {
      for (const theme of themes) {
        const url = `${server.base}/${dir}/index.html?screen=${screen}&theme=${theme}`;
        const page = await chrome.openPage();
        const errorsBefore = page.exceptions.length;
        try {
          await page.setViewport(1440, 900);
          await page.goto(url, { timeoutMs: 20000 });
          await page.waitFor('document.readyState === "complete"', { timeoutMs: 10000 });
          await page.eval('document.fonts ? document.fonts.ready.then(() => true) : true', {
            timeout: 5000,
          });
          await new Promise((r) => setTimeout(r, 250));
          const file = path.join(SHOTS, `${dir}-${screen}-${theme}.png`);
          await page.screenshot(file);
          const title = await page.eval('document.title');
          results.push({ dir, screen, theme, file: path.relative(REPO_ROOT, file), title, errors: page.exceptions.slice(errorsBefore) });
        } catch (e) {
          results.push({ dir, screen, theme, error: String(e), errors: page.exceptions.slice(errorsBefore) });
        } finally {
          await page.close();
        }
      }
    }
    // direction board (C has no board page)
    for (const theme of dir !== 'c' ? themes : []) {
      const url = `${server.base}/${dir}/board.html?theme=${theme}`;
      const page = await chrome.openPage();
      try {
        await page.setViewport(1440, 900);
        await page.goto(url, { timeoutMs: 20000 });
        await page.waitFor('document.readyState === "complete"', { timeoutMs: 10000 });
        await new Promise((r) => setTimeout(r, 250));
        const file = path.join(SHOTS, `${dir}-board-${theme}.png`);
        await page.screenshot(file, { fullPage: true });
        results.push({ dir, screen: 'board', theme, file: path.relative(REPO_ROOT, file) });
      } catch (e) {
        results.push({ dir, screen: 'board', theme, error: String(e) });
      } finally {
        await page.close();
      }
    }
  }
  // Converged-direction variant: direction A with B's optional type column
  // (kept out of the default A shots; `?typecol=1` is a preview switch only).
  if (dirs.includes('a')) {
    const variants = [
      ...['main', 'search'].flatMap((s) => ['dark', 'light'].map((t) => ({ screen: s, theme: t, w: 1440 }))),
      { screen: 'main', theme: 'dark', w: 1280 },
    ];
    for (const v of variants) {
      const page = await chrome.openPage();
      try {
        await page.setViewport(v.w, v.w === 1280 ? 720 : 900);
        await page.goto(`${server.base}/a/index.html?screen=${v.screen}&theme=${v.theme}&typecol=1`, { timeoutMs: 20000 });
        await page.waitFor('document.readyState === "complete"', { timeoutMs: 10000 });
        await new Promise((r) => setTimeout(r, 250));
        const width = v.w === 1440 ? '' : `-${v.w}`;
        const file = path.join(SHOTS, `a-${v.screen}-${v.theme}${width}-typecol.png`);
        await page.screenshot(file);
        results.push({ dir: 'a', screen: v.screen, theme: v.theme, variant: 'typecol', file: path.relative(REPO_ROOT, file), errors: page.exceptions });
      } catch (e) {
        results.push({ dir: 'a', variant: 'typecol', error: String(e) });
      } finally {
        await page.close();
      }
    }
  }
  // Direction C — workbench (activity bar + side panels + right rail).
  // Extra states live outside the six canonical screens.
  if (dirs.includes('c')) {
    const cStates = [
      { name: 'outline', query: 'screen=main&panel=outline', w: 1440, h: 900 },
      { name: 'settings', query: 'screen=main&panel=settings', w: 1440, h: 900 },
      { name: 'rail-collapsed', query: 'screen=main&rail=0', w: 1440, h: 900 },
      { name: '1280', query: 'screen=main', w: 1280, h: 720 },
    ];
    for (const v of cStates) {
      const page = await chrome.openPage();
      try {
        await page.setViewport(v.w, v.h);
        await page.goto(`${server.base}/c/index.html?${v.query}&theme=dark`, { timeoutMs: 20000 });
        await page.waitFor('document.readyState === "complete"', { timeoutMs: 10000 });
        await new Promise((r) => setTimeout(r, 300));
        const file = path.join(SHOTS, `c-main-${v.name}.png`);
        await page.screenshot(file);
        results.push({ dir: 'c', screen: v.name, theme: 'dark', variant: v.name, file: path.relative(REPO_ROOT, file), errors: page.exceptions });
      } catch (e) {
        results.push({ dir: 'c', variant: v.name, error: String(e) });
      } finally {
        await page.close();
      }
    }
  }
} finally {
  await chrome.close();
  await server.close();
}

console.log(JSON.stringify(results, null, 2));
const failed = results.filter((r) => r.error);
console.log(`\nshots: ${results.length - failed.length}/${results.length} ok, ${failed.length} failed`);
if (failed.length) process.exitCode = 1;
