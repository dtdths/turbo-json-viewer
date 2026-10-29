#!/usr/bin/env node
/** Driver: hand-written UI parts + a11y in real Chrome (tests/stack/ui.html). */
import { withChrome, extensionUrl } from '../../lib/chrome.mjs';
import { FIXTURE_DIR, RESULTS_DIR } from './lib/chrome-path.mjs';
import { key, click, drag, axSummary } from './lib/cdp-input.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const round2 = (x) => Math.round(x * 100) / 100;
const rectOf = (page, sel) => page.eval(`document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect().toJSON()`);
const center = (r) => [r.left + r.width / 2, r.top + r.height / 2];

const result = await withChrome({ extensionDirs: [FIXTURE_DIR], windowSize: '1280,900' }, async (chrome) => {
  const page = await chrome.openPage();
  await page.goto(extensionUrl(FIXTURE_DIR, 'ui.html'));
  await page.waitFor('globalThis.__uiBench !== undefined', { timeoutMs: 15000 });
  const sid = page.sessionId;
  const out = {};

  // ---------- context menu ----------
  const menu = {};
  await page.eval('__uiBench.menu.open()');
  menu.opened = await page.eval('__uiBench.menu.state()');
  await key(chrome, sid, 'ArrowDown');
  menu.afterArrowDownFocused = await page.eval('__uiBench.menu.itemIndexFocused()');
  await key(chrome, sid, 'ArrowDown');
  await key(chrome, sid, 'Enter');
  menu.afterEnter = { actions: await page.eval('__uiBench.menu.actions()'), open: await page.eval('__uiBench.menu.isOpen()') };
  await page.eval('__uiBench.menu.open()');
  await key(chrome, sid, 'Escape');
  menu.afterEscape = { open: await page.eval('__uiBench.menu.isOpen()'), focusRestored: await page.eval('document.activeElement.id') };
  const clamp = await page.eval('(() => { window.__uiBench.menu.openAt(innerWidth - 4, innerHeight - 4); return window.__uiBench.menu.state(); })()');
  menu.clamped = { rect: clamp.rect, innerW: await page.eval('innerWidth'), innerH: await page.eval('innerHeight') };
  menu.clamped.inside =
    clamp.rect.right <= menu.clamped.innerW && clamp.rect.bottom <= menu.clamped.innerH && clamp.rect.left >= 0;
  await page.eval('__uiBench.menu.clickOutside()');
  menu.afterOutsideClick = await page.eval('__uiBench.menu.isOpen()');
  menu.roles = { role: menu.opened.role, itemRole: menu.opened.itemRole, items: menu.opened.items };
  out.menu = menu;

  // ---------- modal dialog (native <dialog>) ----------
  const dlg = {};
  await page.eval('__uiBench.dialog.open()');
  dlg.opened = await page.eval('__uiBench.dialog.state()');
  const focusSeq = [];
  for (let i = 0; i < 5; i++) {
    await key(chrome, sid, 'Tab');
    focusSeq.push(await page.eval('__uiBench.dialog.active()'));
  }
  dlg.tabSequence = focusSeq.map((f) => `${f.tag}:${f.text}`.slice(0, 40));
  dlg.allTabsStayInside = focusSeq.every((f) => f.inDialog);
  await key(chrome, sid, 'Escape');
  await new Promise((r) => setTimeout(r, 50));
  dlg.afterEscape = await page.eval('__uiBench.dialog.state()');
  out.dialog = dlg;

  // ---------- toast ----------
  await page.eval('__uiBench.toast.show("Copied path to clipboard")');
  out.toast = await page.eval('__uiBench.toast.state()');

  // ---------- splitter drag (trusted pointer input) ----------
  const sp = {};
  const r0 = await rectOf(page, '.splitter');
  const w0 = await page.eval('__uiBench.splitter.width()');
  await drag(chrome, sid, ...center(r0), center(r0)[0] + 80, center(r0)[1]);
  sp.afterDrag = { width: await page.eval('__uiBench.splitter.width()'), aria: await page.eval('__uiBench.splitter.attr()') };
  sp.deltaPx = round2(sp.afterDrag.width - w0);
  await page.eval('__uiBench.splitter.key("ArrowRight")');
  sp.afterArrowRight = await page.eval('__uiBench.splitter.width()');
  sp.role = await page.eval('__uiBench.splitter.role()');
  out.splitter = sp;

  // ---------- toolbar (roving tabindex) ----------
  const tb = {};
  await page.eval('__uiBench.toolbar.focusFirst()');
  tb.initial = await page.eval('__uiBench.toolbar.state()');
  await key(chrome, sid, 'ArrowRight');
  tb.afterArrowRight = await page.eval('__uiBench.toolbar.state()');
  await key(chrome, sid, 'End');
  tb.afterEnd = await page.eval('__uiBench.toolbar.state()');
  out.toolbar = tb;

  // ---------- virtual-row keyboard nav: activedescendant vs roving ----------
  const tree = {};
  for (const which of ['activedescendant', 'roving']) {
    await page.eval(`__uiBench.tree.mount(${JSON.stringify(which)})`);
    const keys = [];
    for (let i = 0; i < 25; i++) keys.push(await page.eval(`__uiBench.tree.key(${JSON.stringify(which)}, 'ArrowDown')`));
    const ms = keys.map((k) => k.ms);
    await key(chrome, sid, 'ArrowDown');
    const afterTrusted = await page.eval(`__uiBench.tree.state(${JSON.stringify(which)})`);
    tree[which] = {
      handlerMedianMs: round2(ms.slice().sort((a, b) => a - b)[Math.floor(ms.length / 2)]),
      handlerP95Ms: round2(ms.slice().sort((a, b) => a - b)[Math.floor(ms.length * 0.95)]),
      afterTrusted,
      focusedIsContainer: await page.eval('document.activeElement.className'),
    };
  }
  out.tree = tree;
  out.ax = await axSummary(chrome, sid);

  // ---------- i18n ----------
  out.i18n = {
    uiLanguage: await page.eval('__uiBench.i18n.uiLanguage()'),
    name: await page.eval('__uiBench.i18n.name()'),
    raw1000LookupsMs: round2(await page.eval('__uiBench.i18n.raw1000()')),
    cached1000LookupsMs: round2(await page.eval('__uiBench.i18n.cached1000()')),
  };

  out.logs = page.logs;
  out.exceptions = page.exceptions;
  return out;
});

// hand-written LOC per part (source lines, comments included)
const here = import.meta.dirname;
const parts = {};
for (const f of ['menu', 'toast', 'dialog', 'splitter', 'toolbar', 'treeNav', 'i18n']) {
  const src = await readFile(path.join(here, 'src/ui', f + '.ts'), 'utf8');
  parts[f] = { lines: src.split('\n').length, bytes: Buffer.byteLength(src) };
}
result.loc = parts;
result.locTotal = Object.values(parts).reduce((a, p) => a + p.lines, 0);

await mkdir(RESULTS_DIR, { recursive: true });
await writeFile(path.join(RESULTS_DIR, 'ui.json'), JSON.stringify(result, null, 2));

console.log('--- context menu ---');
console.log(JSON.stringify({ roles: result.menu.roles, afterArrowDownFocused: result.menu.afterArrowDownFocused, afterEnter: result.menu.afterEnter, afterEscape: result.menu.afterEscape, clampedInside: result.menu.clamped.inside, afterOutsideClick: result.menu.afterOutsideClick }, null, 1));
console.log('--- dialog ---');
console.log(JSON.stringify({ open: result.dialog.opened.open, modal: result.dialog.opened.modal, inertBackground: result.dialog.opened.inertBackground, role: result.dialog.opened.role, tabSequence: result.dialog.tabSequence, allTabsStayInside: result.dialog.allTabsStayInside, afterEscapeOpen: result.dialog.afterEscape.open }, null, 1));
console.log('--- toast ---', JSON.stringify(result.toast));
console.log('--- splitter ---', JSON.stringify(result.splitter));
console.log('--- toolbar ---', JSON.stringify({ initial: result.toolbar.initial, afterArrowRight: result.toolbar.afterArrowRight, afterEnd: result.toolbar.afterEnd }));
console.log('--- tree nav ---', JSON.stringify(result.tree, null, 1));
console.log('--- AX roles ---', JSON.stringify(result.ax.roles));
console.log('--- AX sample ---', JSON.stringify(result.ax.interesting.slice(0, 8)));
console.log('--- i18n ---', JSON.stringify(result.i18n));
console.log('--- LOC ---', JSON.stringify(result.loc));
if (result.exceptions.length) console.error('exceptions:', result.exceptions);
