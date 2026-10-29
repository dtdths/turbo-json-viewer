#!/usr/bin/env node
/** Driver: CodeMirror 6 under MV3 extension-page CSP (real Chrome).
 *  Measures: bundle load, mount, typing latency/frames, autocomplete popup,
 *  CSP eval blocking, plus a hand-rolled textarea+completion baseline.
 *  Usage: node bench-cm6.mjs */
import { withChrome, extensionUrl } from '../../lib/chrome.mjs';
import { FIXTURE_DIR, RESULTS_DIR } from './lib/chrome-path.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const median = (xs) => (xs.length ? xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
const p95 = (xs) => (xs.length ? xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.95))] : null);
const round2 = (x) => (x === null ? null : Math.round(x * 100) / 100);

const TYPED = 'data.hotel_tags.filter(item => item.pri';
const front = (chrome, sid) => chrome.browser.send('Page.bringToFront', {}, sid);
const step = (m) => console.error('[step]', m, (performance.now()/1000).toFixed(1)+'s');

async function frameWatch(page, on) {
  if (on) {
    await page.eval(`(() => {
      window.__frames = [];
      window.__watch = true;
      let last = performance.now();
      const tick = () => { const n = performance.now(); window.__frames.push(n - last); last = n; if (window.__watch) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      window.__longtasks = 0;
      try { window.__ltObs = new PerformanceObserver((l) => { window.__longtasks += l.getEntries().length; }); window.__ltObs.observe({ entryTypes: ['longtask'] }); } catch {}
      return true;
    })()`);
  } else {
    return await page.eval(`(() => { window.__watch = false; window.__ltObs?.disconnect(); const f = window.__frames || []; return { frames: f.length, p95: f.slice().sort((a,b)=>a-b)[Math.min(f.length-1, Math.floor(f.length*0.95))] || 0, max: Math.max(0, ...f), longtasks: window.__longtasks || 0 }; })()`);
  }
}

async function typeViaCdp(page, chrome, text) {
  const t0 = Date.now();
  for (const ch of text) {
    await chrome.browser.send('Input.insertText', { text: ch }, page.sessionId);
  }
  return Date.now() - t0;
}

const result = await withChrome(
  { extensionDirs: [FIXTURE_DIR], windowSize: '1280,900', extraArgs: ['--enable-precise-memory-info'] },
  async (chrome) => {
    const out = {};

    // ---------- CM6 minimal ----------
    step('chrome up');
    const page = await chrome.openPage();
    await page.goto(extensionUrl(FIXTURE_DIR, 'cm6-min.html'));
    await page.waitFor('globalThis.__cm6 !== undefined && globalThis.__textareaBench !== undefined', { timeoutMs: 15000 });
    step('cm6 page ready');
    out.csp = await page.eval('__cm6.cspAtLoad');
    out.cspViaCdp = await page.eval('__cm6.cspProbe()');
    out.cm6 = {};
    out.cm6.firstMount = await page.eval('__cm6.mount()');
    out.cm6.mountTimes = await page.eval('__cm6.mountMany(20)');
    await page.eval('__cm6.mount()');
    out.cm6.stats = await page.eval('__cm6.stats()');
    step('cm6 mount measured');

    // real keyboard input through CDP (goes through Blink's input pipeline)
    await front(chrome, page.sessionId);
    await frameWatch(page, true);
    const tTyping = await typeViaCdp(page, chrome, TYPED);
    await page.eval('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
    out.cm6.typing = { chars: TYPED.length, wallMs: tTyping, frames: await frameWatch(page, false) };
    out.cm6.docAfterTyping = await page.eval('__cm6.doc()');
    out.cm6.popup = await page.eval('__cm6.popupState()');
    out.cm6.afterTypingStats = await page.eval('__cm6.stats()');
    step('cm6 typing done');

    // autocomplete: clear, type "data." and wait for the popup
    await page.eval('__cm6.clear()');
    await page.eval('__cm6.mount()');
    const t0 = Date.now();
    await typeViaCdp(page, chrome, 'data.');
    let popupMs = null;
    try {
      popupMs = await page.eval('__cm6.popupWait(2000)', { timeout: 4000 });
    } catch {
      popupMs = null;
    }
    out.cm6.autocomplete = { ...(await page.eval('__cm6.popupState()')), waitMs: round2(popupMs), cdpTypeMs: Date.now() - t0 };
    // keep typing a prefix, then accept first option via input
    await typeViaCdp(page, chrome, 'hot');
    out.cm6.autocompleteFiltered = await page.eval('__cm6.popupState()');
    step('cm6 autocomplete done');

    // ---------- textarea + hand-rolled completion baseline ----------
    step('textarea start');
    out.textarea = {};
    out.textarea.mount = await page.eval('__textareaBench.mount()');
    step('textarea mounted');
    await front(chrome, page.sessionId);
    await frameWatch(page, true);
    step('textarea frame watch on');
    const tTa = await typeViaCdp(page, chrome, TYPED);
    step('textarea typed');
    await page.eval('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
    out.textarea.typing = { chars: TYPED.length, wallMs: tTa, frames: await frameWatch(page, false) };
    out.textarea.value = await page.eval('__textareaBench.value()');
    step('textarea value read');
    out.textarea.showLatency = await page.eval('__textareaBench.showLatencies()');
    await page.eval('__textareaBench.reset(); __textareaBench.setValue("")');
    const t1 = Date.now();
    await typeViaCdp(page, chrome, 'data.');
    await new Promise((r) => setTimeout(r, 60));
    out.textarea.autocomplete = { ...(await page.eval('__textareaBench.popupState()')), cdpTypeMs: Date.now() - t1 };

    step('textarea done');
    // ---------- CM6 + javascript language ----------
    step('opening lang page');
    const langPage = await chrome.openPage();
    await langPage.goto(extensionUrl(FIXTURE_DIR, 'cm6-lang.html'));
    await langPage.waitFor('globalThis.__cm6Lang !== undefined', { timeoutMs: 15000 });
    await langPage.bringToFront?.();
    await chrome.browser.send('Page.bringToFront', {}, langPage.sessionId);
    const langMounted = await langPage.eval('__cm6Lang.mount()');
    await langPage.eval('__cm6Lang.insert("data.hotel_tags.filter(item => item.price > 100)")');
    out.cm6Lang = { mount: langMounted, popup: await langPage.eval('__cm6Lang.popupState()'), tokenSpans: await langPage.eval('__cm6Lang.tokenSpans()') };
    step('lang page done');
    out.cm6Lang.nodes = await langPage.eval('document.querySelectorAll("#cm6-lang-host *").length');

    out.logs = page.logs.filter((l) => l.type === 'error');
    out.exceptions = [...page.exceptions, ...langPage.exceptions];
    return out;
  },
);

// static check: does the shipped bundle reference eval/new Function?
async function scanBundle(name) {
  const src = await readFile(path.join(FIXTURE_DIR, name), 'utf8');
  // strip this bench's own CSP-probe helper before scanning (it deliberately
  // contains eval/new Function to prove the CSP blocks them)
  const stripped = src.replace(/try\{\(0,eval\)\([^)]*\)[\s\S]{0,400}?newFunctionError:[a-z]*\}/g, '');
  const pats = [/[^.\w]eval\s*\(/g, /new\s+Function\s*\(/g, /Function\s*\(\s*["'`]/g];
  return pats.map((p) => (stripped.match(p) || []).length);
}
result.bundleScan = {
  'cm6-min.js': await scanBundle('cm6-min.js'),
  'cm6-lang.js': await scanBundle('cm6-lang.js'),
  'textarea-baseline.js': await scanBundle('textarea-baseline.js'),
  note: 'occurrences (eval( / new Function( / Function("…")) in the shipped minified bundle, bench CSP-probe stripped',
};

await mkdir(RESULTS_DIR, { recursive: true });
await writeFile(path.join(RESULTS_DIR, 'cm6.json'), JSON.stringify(result, null, 2));

const m = (xs) => `${round2(median(xs))} ms (p95 ${round2(p95(xs))} ms)`;
console.log('CSP:', JSON.stringify(result.csp).slice(0, 300));
console.log('CM6 minimal mount:', JSON.stringify(result.cm6.firstMount), 'repeated 20:', m(result.cm6.mountTimes));
console.log('CM6 typing:', `${result.cm6.typing.chars} chars in ${result.cm6.typing.wallMs}ms via CDP; frame p95 ${round2(result.cm6.typing.frames.p95)}ms, longtasks ${result.cm6.typing.frames.longtasks}`);
console.log('CM6 autocomplete:', JSON.stringify(result.cm6.autocomplete));
console.log('CM6 + javascript:', JSON.stringify(result.cm6Lang));
console.log('textarea baseline:', JSON.stringify(result.textarea.mount), 'typing', result.textarea.typing.wallMs + 'ms', 'popup refresh', m(result.textarea.showLatency));
console.log('textarea autocomplete:', JSON.stringify(result.textarea.autocomplete));
console.log('eval/new Function in bundles:', JSON.stringify(result.bundleScan));
if (result.exceptions.length) console.error('exceptions:', result.exceptions);
