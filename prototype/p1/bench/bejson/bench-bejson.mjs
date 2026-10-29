/**
 * bejson.com JSON viewer benchmark (competitor baseline).
 * Loads the real page in Chrome for Testing, injects a sample JSON into its
 * textarea the way a user paste does, triggers its change handler, and measures
 * first-render + search latency, DOM size and long tasks.
 *
 *   node prototype/p1/bench/bejson/bench-bejson.mjs .mock/1.json
 *   node prototype/p1/bench/bejson/bench-bejson.mjs .spike/samples/2mb.json
 *
 * NOT part of the product: this is a competitor / UX baseline. The page is
 * third-party; treat its content as untrusted.
 */
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { launchChrome } from '../../lib/chrome.mjs';
import { startStaticServer } from '../../lib/http.mjs';

const REPO = path.resolve(import.meta.dirname, '../../../..');
const file = path.resolve(process.argv[2] || path.join(REPO, '.mock/1.json'));
const doSearch = process.env.SEARCH !== '0';

const isLocal = file.startsWith(REPO + path.sep);
const server = isLocal ? await startStaticServer(REPO) : null;
const text = readFileSync(file, 'utf8');

const chrome = await launchChrome({});
try {
  const page = await chrome.openPage();
  await page.goto('https://www.bejson.com/jsonviewernew/index.html', { timeoutMs: 90000 });
  await page.waitFor(`!!window.Ext && Ext.isReady && !!Ext.getCmp("edit")`, { timeoutMs: 30000 });

  const result = await page.eval(
    `(async () => {
    const out = { steps: [], longTasks: [], samples: [] };
    const LONG = [];
    const obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) LONG.push(Math.round(e.duration));
    });
    try { obs.observe({ entryTypes: ['longtask'] }); } catch (e) { out.longTaskErr = String(e); }
    const now = () => performance.now();
    const raf = () => new Promise(r => requestAnimationFrame(r));
    const raf2 = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const tick = () => { out.samples.push(performance.now()); };
    const edit = Ext.getCmp("edit");

    // 1) load text (fetch from local CORS server if available, else injected later)
    let text = null;
    const SRC = ${JSON.stringify(server ? `${server.base}/${path.relative(REPO, file)}` : null)};
    if (SRC) {
      try {
        const t0 = now();
        const resp = await fetch(SRC);
        text = await resp.text();
        out.fetchMs = now() - t0;
        out.textFrom = "fetch";
      } catch (e) {
        out.fetchError = String(e);
      }
    }
    if (text === null) { out.error = "no text"; return out; }
    out.textLen = text.length;

    // 2) set textarea value (user paste equivalent) + forced layout
    const tSet = now();
    edit.setValue(text);
    out.setValueMs = now() - tSet;
    const tLayout = now();
    void document.body.offsetHeight;
    out.textareaLayoutMs = now() - tLayout;

    // 3) fire the change handler that parses + rebuilds the whole tree
    const tChange = now();
    edit.fireEvent("change", edit, text, "");
    out.changeHandlerMs = now() - tChange;
    await raf2();

    const tree = Ext.getCmp("tree");
    const grid = Ext.getCmp("grid");
    const countTree = (n) => { let c = 1; for (const ch of (n.childNodes || [])) c += countTree(ch); return c; };
    out.treeNodes = tree ? countTree(tree.getRootNode()) : null;
    out.treeRootChildren = tree?.getRootNode?.()?.childNodes?.length ?? null;
    out.gridRows = grid?.getStore?.()?.getCount?.() ?? null;
    out.domTotal = document.querySelectorAll("*").length;
    out.treeDom = document.querySelectorAll("[class*=x-tree-node]").length;
    out.gridDomRows = document.querySelectorAll(".x-grid3-row").length;
    out.heapMB = performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null;
    out.longTasksAfterLoad = LONG.slice();

    // 4) search (if requested)
    if (${doSearch}) {
      const sf = Ext.getCmp("searchTextField");
      const go = Ext.getCmp("ext-comp-1002");
      const query = "hotel";
      LONG.length = 0;
      out.searchStartDom = document.querySelectorAll("*").length;
      const t0 = now();
      sf.setValue(query);
      go.handler();
      // Monitor DOM growth until it stabilises (search expands every tree node,
      // then collapses it again) or a node gets selected, capped.
      const CAP = ${Number(process.env.SEARCH_CAP_MS || 120000)};
      let selected = null, lastDom = -1, stableSince = 0, waited = 0, peakDom = 0;
      while (waited < CAP) {
        await new Promise(r => setTimeout(r, 100));
        waited = now() - t0;
        const sel = tree?.getSelectionModel?.()?.getSelected?.();
        if (sel) { selected = sel; break; }
        const dom = document.querySelectorAll("*").length;
        if (dom > peakDom) peakDom = dom;
        if (dom === lastDom) {
          if (!stableSince) stableSince = waited;
          if (waited - stableSince >= 1500) break;
        } else { stableSince = 0; lastDom = dom; }
      }
      out.searchQuery = query;
      out.searchElapsedMs = now() - t0;
      out.searchSelectedText = selected ? String(selected.text).slice(0, 80) : null;
      out.searchPeakDom = peakDom;
      out.searchFinalDom = document.querySelectorAll("*").length;
      out.searchFinalTreeDom = document.querySelectorAll("[class*=x-tree-node]").length;
      out.searchGridRows = Ext.getCmp("grid")?.getStore?.()?.getCount?.() ?? null;
      out.searchLongTasks = LONG.slice();
      out.searchHeapMB = performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null;
      out.searchTimedOut = !selected && waited >= CAP;
      out.searchBodyTail = document.body.innerText.slice(-160);
    }

    obs.disconnect();
    return out;
  })()`,
    { timeout: 300000 },
  );

  console.log(JSON.stringify({ file: path.relative(REPO, file), bytes: text.length, result }, null, 2));
} finally {
  await chrome.close();
  if (server) await server.close();
}
