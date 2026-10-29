/**
 * Runtime bench worker (fixture).
 *
 * Holds the document ("document-resident Worker" architecture) and answers:
 *   - row-window requests (over a dedicated MessageChannel port, coalesced by seq)
 *   - toggle requests (by row index, so no path parsing is needed on the hot path)
 *   - root bookkeeping: `doc` / expression-result roots / (future) repaired roots
 *   - in-worker micro-benchmarks for row models, node identity and multi-root cost
 */
import { IndexedModel, FlatModel, NaiveModel, describeRow, walkStats, isContainer } from './model.js';

const heapMB = () => {
  const m = performance.memory;
  return m ? +(m.usedJSHeapSize / 1048576).toFixed(2) : null;
};
const gcNow = () => {
  if (typeof gc === 'function') gc();
};
const heapD = (h) => (heapMB() == null ? null : +(heapMB() - h).toFixed(2));

let port = null;
let state = null; // { text, root, roots: Map, sample, mode }

function setState(next) {
  state = next;
}
const roots = new Map();

function rootOf(rootId) {
  const r = roots.get(rootId);
  if (!r) throw new Error('unknown rootId: ' + rootId);
  return r;
}

async function loadDoc({ sample, base }) {
  const tFetch0 = performance.now();
  const res = await fetch(`${base}/${sample}.json`, { cache: 'no-store' });
  const text = await res.text();
  const fetchMs = performance.now() - tFetch0;
  const tParse0 = performance.now();
  const root = JSON.parse(text);
  const parseMs = performance.now() - tParse0;
  return { text, root, fetchMs, parseMs };
}

async function handleLoad(msg) {
  roots.clear();
  const { text, root, fetchMs, parseMs } = await loadDoc(msg);
  const tModel0 = performance.now();
  const model = new IndexedModel(root);
  const modelMs = performance.now() - tModel0;
  roots.set('doc', { id: 'doc', kind: 'document', version: 1, root, model });
  const out = {
    sample: msg.sample,
    bytes: text.length,
    fetchMs: +fetchMs.toFixed(2),
    parseMs: +parseMs.toFixed(2),
    modelMs: +modelMs.toFixed(2),
    totalRows: model.visibleTotal(),
    heapMB: heapMB(),
  };
  if (msg.mode === 'B') {
    // Architecture B: page owns the model -> whole-tree structured clone.
    const tClone0 = performance.now();
    postMessage({ type: 'doc', root, parseMs, fetchMs, modelMs, totalRows: out.totalRows, bytes: text.length });
    out.clonePostMs = +(performance.now() - tClone0).toFixed(2);
    // node/container stats while the page is already cloning/painting
    const tWalk0 = performance.now();
    const walk = walkStats(root);
    out.nodes = walk.nodes;
    out.containers = walk.containers;
    out.statsWalkMs = +(performance.now() - tWalk0).toFixed(2);
    // release the worker-side tree; the page now owns the document
    roots.clear();
    state = null;
  }
  return out;
}

function handleWindow(req) {
  const root = rootOf(req.rootId || 'doc');
  const t0 = performance.now();
  const rows = root.model.window(req.start, req.count);
  const workerMs = performance.now() - t0;
  return {
    type: 'window',
    seq: req.seq,
    rootId: root.id,
    rootVersion: root.version,
    start: req.start,
    count: rows.length,
    total: root.model.visibleTotal(),
    rows,
    workerMs: +workerMs.toFixed(3),
  };
}

function handleToggle({ rootId = 'doc', row }) {
  const root = rootOf(rootId);
  const t0 = performance.now();
  const res = root.model.toggleAt(row);
  const toggleMs = performance.now() - t0;
  root.version += 1;
  return {
    rootId: root.id,
    rootVersion: root.version,
    opened: res.opened,
    total: root.model.visibleTotal(),
    toggleMs: +toggleMs.toFixed(3),
    rebuildMs: res.rebuildMs ?? null,
    heapMB: heapMB(),
  };
}

/** Expression-result style root: a new array that references original nodes (no clone). */
function handleMakeResult({ sourceRootId = 'doc', minPrice = 500 }) {
  const doc = rootOf(sourceRootId);
  const items = doc.root.data.items;
  const t0 = performance.now();
  const result = items.filter((it) => it && typeof it === 'object' && it.price > minPrice);
  const filterMs = performance.now() - t0;
  const t1 = performance.now();
  const model = new IndexedModel(result);
  const modelMs = performance.now() - t1;
  const id = 'expr-' + (roots.size + 1);
  roots.set(id, { id, kind: 'expression', version: 1, root: result, model });
  return {
    rootId: id,
    rows: result.length,
    filterMs: +filterMs.toFixed(2),
    modelMs: +modelMs.toFixed(2),
    totalRows: model.visibleTotal(),
    heapMB: heapMB(),
  };
}

// ---------------------------------------------------------------------------
// micro-benchmarks
// ---------------------------------------------------------------------------

const quantile = (arr, q) => {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const pos = Math.min(a.length - 1, Math.max(0, Math.ceil(q * a.length) - 1));
  return +a[pos].toFixed(4);
};
const stats = (arr) => {
  let max = -Infinity;
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v > max) max = v;
    sum += v;
  }
  return {
    n: arr.length,
    p50: quantile(arr, 0.5),
    p95: quantile(arr, 0.95),
    max: +max.toFixed(4),
    mean: +(sum / arr.length).toFixed(4),
  };
};

function windowTimings(model, count, iterations, label) {
  const total = model.visibleTotal();
  const starts = [0, 100, 1000, 10000, Math.max(0, Math.min(total - count, 100000)), Math.max(0, total - count)];
  const targeted = {};
  for (const s of starts) {
    const t0 = performance.now();
    model.window(s, count);
    targeted['row' + s] = +(performance.now() - t0).toFixed(4);
  }
  const t = [];
  for (let i = 0; i < iterations; i++) {
    const s = Math.floor(Math.random() * Math.max(1, total - count));
    const t0 = performance.now();
    model.window(s, count);
    t.push(performance.now() - t0);
  }
  return { label, total, targeted, random: stats(t) };
}

async function benchRowModel(msg) {
  const { text, root, fetchMs, parseMs } = await loadDoc(msg);
  const tWalk = performance.now();
  const walk = walkStats(root);
  const walkMs = +(performance.now() - tWalk).toFixed(2);
  const out = { sample: msg.sample, bytes: text.length, fetchMs: +fetchMs.toFixed(2), parseMs: +parseMs.toFixed(2), walk, walkMs, heapMB: heapMB() };

  // ---- IndexedModel (recommended): derived rows + per-open-container Fenwick
  const tIdx0 = performance.now();
  const idx = new IndexedModel(root);
  out.indexed = { buildMs: +(performance.now() - tIdx0).toFixed(3), defaultTotal: idx.visibleTotal() };
  let t0 = performance.now();
  idx.toggleAt(2); // data
  const dataToggleMs = performance.now() - t0;
  t0 = performance.now();
  idx.toggleAt(3); // items (184,909 children in 50MB sample)
  const itemsToggleMs = performance.now() - t0;
  const itemsTotal = idx.visibleTotal();
  out.indexed.toggle = { dataToggleMs: +dataToggleMs.toFixed(3), itemsToggleMs: +itemsToggleMs.toFixed(3), totalAfterItems: itemsTotal };
  out.indexed.heapAfterOpenMB = heapMB();
  out.indexed.window = windowTimings(idx, 40, 300, 'indexed');

  // ---- NaiveModel: no index, DFS skip-by-count only
  const naive = new NaiveModel(root);
  t0 = performance.now();
  naive.toggleAt(2);
  naive.toggleAt(3);
  out.naive = { expandMs: +(performance.now() - t0).toFixed(3), totalAfterItems: naive.visibleTotal() };
  out.naive.window = windowTimings(naive, 40, 60, 'naive');

  // ---- FlatModel: flatten-on-change
  const flat = new FlatModel(root);
  t0 = performance.now();
  flat.toggleAt(2);
  flat.toggleAt(3);
  out.flat = { itemsExpandedRebuildMs: +flat.rebuildMs.toFixed(3), totalAfterItems: flat.visibleTotal(), heapMB: heapMB() };
  out.flat.window = windowTimings(flat, 40, 300, 'flat');

  // ---- "共 N 项" annotation costs
  t0 = performance.now();
  let childCountSum = 0;
  {
    // child count is O(width) per container row and needs no precomputation
    const stack = [root];
    let seen = 0;
    while (stack.length && seen < 10000) {
      const v = stack.pop();
      if (!isContainer(v)) continue;
      seen++;
      childCountSum += Array.isArray(v) ? v.length : Object.keys(v).length;
      const keys = Array.isArray(v) ? null : Object.keys(v);
      const n = keys ? keys.length : v.length;
      for (let i = 0; i < n; i++) stack.push(keys ? v[keys[i]] : v[i]);
    }
  }
  const annotateMs = +(performance.now() - t0).toFixed(3);
  // descendant counts (full subtree sizes) require a full post-order pass + a map
  t0 = performance.now();
  const sizes = new Map();
  {
    const order = [];
    const stack = [root];
    while (stack.length) {
      const v = stack.pop();
      order.push(v);
      if (!isContainer(v)) continue;
      const keys = Array.isArray(v) ? null : Object.keys(v);
      const n = keys ? keys.length : v.length;
      for (let i = 0; i < n; i++) stack.push(keys ? v[keys[i]] : v[i]);
    }
    for (let i = order.length - 1; i >= 0; i--) {
      const v = order[i];
      if (!isContainer(v)) continue;
      const keys = Array.isArray(v) ? null : Object.keys(v);
      const n = keys ? keys.length : v.length;
      let s = 0;
      for (let j = 0; j < n; j++) s += 1 + (sizes.get(keys ? v[keys[j]] : v[j]) || 0);
      sizes.set(v, s);
    }
  }
  out.subtreeCount = { containers: sizes.size, precomputeMs: +(performance.now() - t0).toFixed(2), heapMB: heapMB() };
  out.annotate = { sampledContainers: 10000, childCountSum, childCountOnlyMs: annotateMs };

  // ---- memory of a flat row table at full expansion (2.96M rows for 50MB)
  gcNow();
  const heapBeforeFull = heapMB();
  const flatAll = new FlatModel(root);
  t0 = performance.now();
  const openAll = (node) => {
    if (!isContainer(node)) return;
    flatAll.open.add(node);
    const keys = Array.isArray(node) ? null : Object.keys(node);
    const n = keys ? keys.length : node.length;
    for (let i = 0; i < n; i++) openAll(keys ? node[keys[i]] : node[i]);
  };
  openAll(root);
  const openAllMs = performance.now() - t0;
  t0 = performance.now();
  flatAll.rebuild();
  const flatFullRebuildMs = +(performance.now() - t0).toFixed(2);
  gcNow();
  out.flatFullExpand = {
    rows: flatAll.visibleTotal(),
    openAllMs: +openAllMs.toFixed(2),
    rebuildMs: flatFullRebuildMs,
    heapDeltaMB: heapD(heapBeforeFull),
    heapMB: heapMB(),
    rowAtP50: null,
  };
  {
    const t = [];
    for (let i = 0; i < 1000; i++) {
      const t1 = performance.now();
      flatAll.rowAt(Math.floor(Math.random() * flatAll.rows.length));
      t.push(performance.now() - t1);
    }
    out.flatFullExpand.rowAtRandom = stats(t);
  }
  // toggle cost while fully expanded: close data (collapses to few rows) then reopen (rebuild 2.96M rows)
  t0 = performance.now();
  flatAll.toggleAt(2);
  out.flatFullExpand.closeRebuildMs = +(performance.now() - t0).toFixed(2);
  t0 = performance.now();
  flatAll.toggleAt(2);
  out.flatFullExpand.reopenRebuildMs = +(performance.now() - t0).toFixed(2);

  // naive skip-by-count at full expansion: worst case is a window deep inside the tree
  const naiveFull = new NaiveModel(root);
  {
    const stack = [root];
    while (stack.length) {
      const v = stack.pop();
      if (!isContainer(v)) continue;
      naiveFull.open.add(v);
      const keys = Array.isArray(v) ? null : Object.keys(v);
      const n = keys ? keys.length : v.length;
      for (let i = 0; i < n; i++) stack.push(keys ? v[keys[i]] : v[i]);
    }
  }
  t0 = performance.now();
  const naiveFullTotal = naiveFull.visibleTotal();
  const naiveFullTotalMs = +(performance.now() - t0).toFixed(2);
  const naiveTargets = {};
  for (const row of [0, 1000, 100000, 500000, 1500000, 2900000]) {
    t0 = performance.now();
    naiveFull.window(row, 40);
    naiveTargets['row' + row] = +(performance.now() - t0).toFixed(2);
  }
  out.naiveFullExpand = { total: naiveFullTotal, countMs: naiveFullTotalMs, window: naiveTargets };

  // ---- many containers open (guard-limit scenario): open data+items, then first N item objects
  const many = new IndexedModel(root);
  many.toggleAt(2);
  many.toggleAt(3);
  t0 = performance.now();
  const N = Math.min(50000, root.data.items.length);
  let opened = 0;
  for (let r = 4; r < many.visibleTotal() && opened < N; r++) {
    const row = many.rowAt(r);
    if (row && (Array.isArray(row.node) || (row.node && typeof row.node === 'object'))) {
      many.toggleAt(r); // items object -> its fields become rows
      opened++;
    }
  }
  const expandManyMs = +(performance.now() - t0).toFixed(2);
  gcNow();
  out.manyOpen = {
    openedContainers: opened,
    expandManyMs,
    totalRows: many.visibleTotal(),
    heapMB: heapMB(),
    window: windowTimings(many, 40, 200, 'indexed-many'),
  };

  // ---- path strings vs ids for persisted view state (dual format)
  t0 = performance.now();
  const parentMap = new Map();
  {
    const stack = [[root, null, '$']];
    while (stack.length) {
      const [v, p, label] = stack.pop();
      if (p && isContainer(v)) parentMap.set(v, { p, label });
      if (!isContainer(v)) continue;
      const keys = Array.isArray(v) ? null : Object.keys(v);
      const n = keys ? keys.length : v.length;
      for (let i = 0; i < n; i++) stack.push([keys ? v[keys[i]] : v[i], v, keys ? keys[i] : i]);
    }
  }
  const parentMapMs = +(performance.now() - t0).toFixed(2);
  const pathTargets = [];
  {
    let i = 0;
    for (const it of root.data.items) {
      if (i++ % 997 === 0) pathTargets.push(it);
      if (pathTargets.length >= 200) break;
    }
  }
  const tPath = [];
  for (const node of pathTargets) {
    const t1 = performance.now();
    const segs = [];
    let cur = node;
    while (parentMap.has(cur)) {
      const { p, label } = parentMap.get(cur);
      segs.push(label);
      cur = p;
    }
    segs.reverse();
    segs.join('.');
    tPath.push(performance.now() - t1);
  }
  // resolving a persisted path back to a node (fresh process) is O(depth) from root
  const tResolve = [];
  for (let i = 0; i < 200; i++) {
    const t1 = performance.now();
    const path = ['data', 'items', i * 7, 'name'];
    let cur = root;
    for (const seg of path) cur = cur[seg];
    tResolve.push(performance.now() - t1);
  }
  out.identityFormats = {
    parentMapBuildMs: parentMapMs,
    parentMapEntries: parentMap.size,
    heapMB: heapMB(),
    pathBuild: stats(tPath),
    pathResolveDepth4: stats(tResolve),
  };
  return out;
}

async function benchIdentity(msg) {
  const { text, root, fetchMs, parseMs } = await loadDoc(msg);
  const out = { sample: msg.sample, bytes: text.length, fetchMs: +fetchMs.toFixed(2), parseMs: +parseMs.toFixed(2) };
  const nodes = [];
  walkStats(root);
  {
    const stack = [root];
    while (stack.length) {
      const v = stack.pop();
      nodes.push(v);
      if (!isContainer(v)) continue;
      const keys = Array.isArray(v) ? null : Object.keys(v);
      const n = keys ? keys.length : v.length;
      for (let i = 0; i < n; i++) stack.push(keys ? v[keys[i]] : v[i]);
    }
  }
  out.nodeCount = nodes.length;
  gcNow();
  const heapBefore = heapMB();

  // eager Map<node,id> for all nodes
  let t0 = performance.now();
  const map = new Map();
  for (let i = 0; i < nodes.length; i++) map.set(nodes[i], i);
  const mapBuildMs = performance.now() - t0;
  gcNow();
  out.map = { buildMs: +mapBuildMs.toFixed(2), size: map.size, heapDeltaMB: heapD(heapBefore), heapMB: heapMB() };
  {
    const t0 = performance.now();
    let sink = 0;
    for (let i = 0; i < 200000; i++) sink += map.get(nodes[(i * 7919) % nodes.length]);
    out.map.lookupBatch = { ops: 200000, totalMs: +(performance.now() - t0).toFixed(2), nsPerOp: +((performance.now() - t0) * 1e6 / 200000).toFixed(1) };
  }
  map.clear();
  gcNow();

  // id -> node array (what a node-id-based runtime needs)
  const heapBeforeArr = heapMB();
  t0 = performance.now();
  const byId = new Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) byId[i] = nodes[i];
  out.idArray = {
    buildMs: +(performance.now() - t0).toFixed(2),
    heapDeltaMB: heapD(heapBeforeArr),
  };
  {
    const t0 = performance.now();
    let sink = 0;
    for (let i = 0; i < 200000; i++) sink += byId[(i * 7919) % nodes.length] === undefined ? 0 : 1;
    out.idArray.lookupBatch = { ops: 200000, totalMs: +(performance.now() - t0).toFixed(2), nsPerOp: +((performance.now() - t0) * 1e6 / 200000).toFixed(1) };
  }
  byId.length = 0;
  gcNow();

  // eager WeakMap (objects only: containers)
  const containersOnly = nodes.filter((v) => isContainer(v));
  t0 = performance.now();
  const weak = new WeakMap();
  for (let i = 0; i < containersOnly.length; i++) weak.set(containersOnly[i], i);
  out.weakMap = {
    keys: containersOnly.length,
    buildMs: +(performance.now() - t0).toFixed(2),
    heapMB: heapMB(),
  };
  {
    const t0 = performance.now();
    let sink = 0;
    for (let i = 0; i < 200000; i++) sink += weak.get(containersOnly[(i * 7919) % containersOnly.length]) || 0;
    out.weakMap.lookupBatch = { ops: 200000, totalMs: +(performance.now() - t0).toFixed(2), nsPerOp: +((performance.now() - t0) * 1e6 / 200000).toFixed(1) };
  }

  // lazy ids: only touched nodes (e.g. expanded containers + selection + anchors)
  gcNow();
  const heapBeforeLazy = heapMB();
  t0 = performance.now();
  const lazy = new WeakMap();
  let nextId = 1;
  const touched = [];
  for (let i = 0; i < 2000; i++) {
    const n = containersOnly[(i * 104729) % containersOnly.length];
    if (!lazy.has(n)) lazy.set(n, nextId++);
    touched.push(n);
  }
  out.lazy = {
    touched: 2000,
    assignMs: +(performance.now() - t0).toFixed(3),
    heapDeltaMB: +(heapMB() - heapBeforeLazy).toFixed(2),
  };
  {
    const t0 = performance.now();
    let sink = 0;
    for (let i = 0; i < 200000; i++) sink += lazy.get(touched[i % touched.length]) || 0;
    out.lazy.lookupBatch = { ops: 200000, totalMs: +(performance.now() - t0).toFixed(2), nsPerOp: +((performance.now() - t0) * 1e6 / 200000).toFixed(1) };
  }
  out.finalHeapMB = heapMB();
  return out;
}

async function benchRoots(msg) {
  const { text, root, fetchMs, parseMs } = await loadDoc(msg);
  const out = { sample: msg.sample, bytes: text.length, fetchMs: +fetchMs.toFixed(2), parseMs: +parseMs.toFixed(2) };
  out.heapMB = heapMB();
  // document root (baseline)
  const doc = new IndexedModel(root);
  doc.toggleAt(2);
  doc.toggleAt(3);
  out.docRoot = { totalRows: doc.visibleTotal(), heapMB: heapMB() };

  // expression result root: filter() produces a new array of refs to original nodes
  gcNow();
  const heapBefore = heapMB();
  let t0 = performance.now();
  const result = root.data.items.filter((it) => it && typeof it === 'object' && it.price > 500);
  const filterMs = performance.now() - t0;
  t0 = performance.now();
  const resultModel = new IndexedModel(result);
  const modelMs = performance.now() - t0;
  gcNow();
  out.expressionRoot = {
    rows: result.length,
    filterMs: +filterMs.toFixed(2),
    modelMs: +modelMs.toFixed(2),
    totalRows: resultModel.visibleTotal(),
    heapDeltaMB: heapD(heapBefore),
    window: windowTimings(resultModel, 40, 300, 'result-root'),
  };
  // copying / exporting from a result root uses the shared node refs (no clone)
  t0 = performance.now();
  const one = JSON.stringify(result[123]);
  out.expressionRoot.singleItemStringifyMs = +(performance.now() - t0).toFixed(4);
  out.expressionRoot.sampleItemBytes = one.length;
  // path of a result-row back into the original document (identity across roots)
  out.note = 'result array holds references to original item objects; no clone.';
  return out;
}

// ---------------------------------------------------------------------------

const handlers = {
  load: handleLoad,
  toggle: handleToggle,
  makeResult: handleMakeResult,
  stats: async () => {
    const root = rootOf('doc');
    const t0 = performance.now();
    const w = walkStats(root.root);
    return { ...w, walkMs: +(performance.now() - t0).toFixed(2), heapMB: heapMB(), totalRows: root.model.visibleTotal() };
  },
  gc: async () => {
    gcNow();
    return { heapMB: heapMB() };
  },
  ping: async () => ({ t: performance.now() }),
  'heap': async () => ({ heapMB: heapMB() }),
  'bench:rowmodel': benchRowModel,
  'bench:identity': benchIdentity,
  'bench:roots': benchRoots,
};

self.onmessage = async (ev) => {
  const msg = ev.data;
  if (msg.type === 'init') {
    port = msg.port;
    port.onmessage = (e) => {
      const req = e.data;
      if (!req) return;
      if (req.type === 'ping') {
        port.postMessage({ type: 'pong', seq: req.seq });
        return;
      }
      if (req.type !== 'window') return;
      try {
        port.postMessage(handleWindow(req));
      } catch (err) {
        port.postMessage({ type: 'window', seq: req.seq, error: String(err) });
      }
    };
    port.start?.();
    return;
  }
  const id = msg.id;
  try {
    const fn = handlers[msg.type];
    if (!fn) throw new Error('unknown command ' + msg.type);
    const result = await fn(msg);
    postMessage({ type: 'reply', id, ok: true, result });
  } catch (err) {
    postMessage({ type: 'reply', id, ok: false, error: String((err && err.stack) || err) });
  }
};
