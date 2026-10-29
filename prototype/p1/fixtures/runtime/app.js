/**
 * Runtime bench page (fixture). Drives architecture A/B/H trials, scroll runs,
 * toggle/jump latencies, protocol RTT, and the browser scroll-height cap probe.
 *
 * Exposed as `globalThis.__rt`; the Node driver evaluates these methods.
 */
import { IndexedModel, FlatModel, describeRow, walkStats, isContainer } from './model.js';

const vp = document.getElementById('vp');
const content = document.getElementById('content');
const ROW_H = 22;
const qs = new URLSearchParams(location.search);
const BASE = qs.get('base') || '';

const heapMB = () => {
  const m = performance.memory;
  return m ? +(m.usedJSHeapSize / 1048576).toFixed(2) : null;
};
const gcNow = () => {
  if (typeof gc === 'function') gc();
};
const raf = () => new Promise((r) => requestAnimationFrame(r));
const doubleRaf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

const quantile = (arr, q) => {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const pos = Math.min(a.length - 1, Math.max(0, Math.ceil(q * a.length) - 1));
  return +a[pos].toFixed(3);
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
    max: +max.toFixed(3),
    mean: +(sum / arr.length).toFixed(3),
  };
};

// long tasks (page-wide, installed before any trial)
const longTasks = [];
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) longTasks.push(e.duration);
  }).observe({ entryTypes: ['longtask'] });
} catch {
  /* unsupported */
}

class W {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
    this.pendingWin = new Map();
    this.winSeq = 0;
    this.docMsg = null;
    this.docWaiters = [];
    this.worker = new Worker(chrome.runtime.getURL('worker.js'), { type: 'module' });
    this.worker.onmessage = (e) => this.onMsg(e.data);
    this.worker.onerror = (e) => {
      this.error = String(e.message || e);
    };
    const ch = new MessageChannel();
    this.port = ch.port1;
    this.port.onmessage = (e) => this.onPort(e.data);
    this.port.start?.();
    this.worker.postMessage({ type: 'init', port: ch.port2 }, [ch.port2]);
  }
  onMsg(m) {
    if (m.type === 'reply') {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.ok) p.resolve(m.result);
      else p.reject(new Error(m.error));
    } else if (m.type === 'doc') {
      this.docMsg = m;
      for (const w of this.docWaiters) w(m);
      this.docWaiters = [];
    }
  }
  onPort(m) {
    if (m.type === 'window' || m.type === 'window-error') {
      const p = this.pendingWin.get(m.seq);
      if (!p) return;
      this.pendingWin.delete(m.seq);
      p(m);
    } else if (m.type === 'pong') {
      const p = this.pendingWin.get('p' + m.seq);
      if (p) {
        this.pendingWin.delete('p' + m.seq);
        p(m);
      }
    }
  }
  call(type, payload = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ type, id, ...payload });
    });
  }
  waitDoc() {
    if (this.docMsg) return Promise.resolve(this.docMsg);
    return new Promise((resolve) => this.docWaiters.push(resolve));
  }
  requestWindow({ rootId = 'doc', start, count }) {
    const seq = ++this.winSeq;
    return new Promise((resolve) => {
      this.pendingWin.set(seq, resolve);
      this.port.postMessage({ type: 'window', seq, rootId, start, count });
    });
  }
  portPing() {
    const seq = ++this.winSeq;
    return new Promise((resolve) => {
      this.pendingWin.set('p' + seq, resolve);
      this.port.postMessage({ type: 'ping', seq });
    });
  }
  destroy() {
    try {
      this.worker.terminate();
    } catch {
      /* ignore */
    }
  }
}

function fmtRow(r) {
  const indent = '  '.repeat(r.depth);
  let val;
  if (r.kind === 'array') val = 'Array(' + r.count + ')';
  else if (r.kind === 'object') val = 'Object(' + r.count + ')';
  else val = r.preview;
  const open = r.kind === 'array' || r.kind === 'object' ? (r.open ? ' ▾' : ' ▸') : '';
  const annot = !r.open && r.count ? '  共 ' + r.count + ' 项' : '';
  return indent + r.label + ': ' + val + open + annot;
}

class View {
  /**
   * @param {'A'|'B'|'H'} mode
   * @param {W} w
   * @param {number} overscan rows on each side
   */
  constructor(mode, w, overscan = 2) {
    this.mode = mode;
    this.w = w;
    this.overscan = overscan;
    this.totalRows = 0;
    this.data = new Map();
    this.cacheCap = 4000;
    this.covered = { start: 0, end: 0 };
    this.inflight = false;
    this.queued = null;
    this.windowLatencies = [];
    this.visibleRows = Math.ceil(vp.clientHeight / ROW_H) + 1;
    this.els = [];
    for (let i = 0; i < this.visibleRows + 1; i++) {
      const el = document.createElement('div');
      el.className = 'row';
      content.appendChild(el);
      this.els.push(el);
    }
    this.renders = 0;
    if (mode === 'B') this.model = null;
  }
  setModel(model) {
    this.model = model;
  }
  setTotal(n) {
    this.totalRows = n;
    content.style.height = n * ROW_H + 'px';
  }
  range() {
    const first = Math.floor(vp.scrollTop / ROW_H);
    return { first, count: this.visibleRows };
  }
  lookup(idx) {
    if (this.mode === 'B') {
      const r = this.model.rowAt(idx);
      return r ? describeRow(r.node, r.label, r.depth, this.model.open.has(r.node)) : null;
    }
    return this.data.get(idx) || null;
  }
  render(range = this.range()) {
    let blankVisible = 0;
    for (let i = 0; i < this.els.length; i++) {
      const idx = range.first + i;
      const el = this.els[i];
      if (idx >= this.totalRows || idx < 0) {
        el.style.display = 'none';
        continue;
      }
      el.style.display = '';
      el.style.top = idx * ROW_H + 'px';
      const row = this.lookup(idx);
      if (row) {
        el.className = 'row';
        el.textContent = fmtRow(row);
      } else {
        el.className = 'row blank';
        el.textContent = '';
        if (i < this.visibleRows) blankVisible++;
      }
    }
    this.renders++;
    return { blankVisible };
  }
  missingRange(start, end) {
    start = Math.max(0, start);
    end = Math.min(this.totalRows, end);
    if (end <= start) return null;
    if (this.mode === 'A') {
      if (this.covered.start <= start && this.covered.end >= end) return null;
      return { start, end };
    }
    let s = -1;
    let e = -1;
    for (let i = start; i < end; i++) {
      if (!this.data.has(i)) {
        if (s < 0) s = i;
        e = i;
      }
    }
    return s < 0 ? null : { start: s, end: e + 1 };
  }
  requestRange(range) {
    if (this.mode === 'B') return;
    const start = Math.max(0, range.first - this.overscan);
    const end = Math.min(this.totalRows, range.first + this.visibleRows + this.overscan);
    const miss = this.missingRange(start, end);
    if (!miss) return;
    if (this.inflight) {
      this.queued = miss;
      return;
    }
    this.send(miss);
  }
  send(miss) {
    this.inflight = true;
    const t0 = performance.now();
    this.w.requestWindow({ start: miss.start, count: miss.end - miss.start }).then((res) => {
      this.inflight = false;
      this.windowLatencies.push(performance.now() - t0);
      if (res.error) {
        this.lastError = res.error;
        return;
      }
      if (this.mode === 'H') {
        for (let i = 0; i < res.rows.length; i++) this.data.set(res.start + i, res.rows[i]);
        this.trimCache();
        this.covered = { start: 0, end: 0 };
      } else {
        this.data.clear();
        for (let i = 0; i < res.rows.length; i++) this.data.set(res.start + i, res.rows[i]);
        this.covered = { start: res.start, end: res.start + res.rows.length };
      }
      this.queued = null;
      this.renderAndRequest();
    });
  }
  trimCache() {
    if (this.data.size <= this.cacheCap) return;
    const keys = [...this.data.keys()];
    for (let i = 0; i < keys.length - this.cacheCap; i++) this.data.delete(keys[i]);
  }
  renderAndRequest() {
    const range = this.range();
    this.render(range);
    this.requestRange(range);
    if (this.mode === 'H') {
      // one-screen prefetch ahead (hybrid keeps a small main-thread cache)
      const next = { first: range.first + this.visibleRows, count: 1 };
      if (next.first < this.totalRows) this.requestRange(next);
    }
  }
  async requestWindowAwait(range) {
    const start = Math.max(0, range.first - this.overscan);
    const end = Math.min(this.totalRows, range.first + this.visibleRows + this.overscan);
    const res = await this.w.requestWindow({ start, count: end - start });
    this.data.clear();
    for (let i = 0; i < res.rows.length; i++) this.data.set(res.start + i, res.rows[i]);
    this.covered = { start: res.start, end: res.start + res.rows.length };
    return res;
  }
  async scrollRun({ frames = 90, stepRows = 6, random = false } = {}) {
    const maxScroll = Math.max(0, this.totalRows * ROW_H - vp.clientHeight);
    vp.scrollTop = 0;
    await raf();
    const deltas = [];
    let blankFrames = 0;
    let blankRows = 0;
    let framesRendered = 0;
    let prev = performance.now();
    const t0 = prev;
    for (let i = 0; i < frames; i++) {
      await raf();
      const now = performance.now();
      deltas.push(now - prev);
      prev = now;
      const top = random ? Math.random() * maxScroll : Math.min(maxScroll, (i + 1) * stepRows * ROW_H);
      vp.scrollTop = top;
      const range = this.range();
      this.requestRange(range);
      const { blankVisible } = this.render(range);
      framesRendered++;
      if (blankVisible > 0) {
        blankFrames++;
        blankRows += blankVisible;
      }
      if (this.mode === 'H') {
        const next = { first: range.first + this.visibleRows, count: 1 };
        if (next.first < this.totalRows) this.requestRange(next);
      }
    }
    const wallMs = performance.now() - t0;
    const dropped = deltas.filter((d) => d > 25).length;
    return {
      frames: framesRendered,
      wallMs: +wallMs.toFixed(1),
      blankFrames,
      blankRate: +(blankFrames / framesRendered).toFixed(3),
      blankRows,
      blankRowRate: +(blankRows / (framesRendered * this.visibleRows)).toFixed(4),
      frameMs: stats(deltas),
      droppedFrames: dropped,
      droppedRate: +(dropped / framesRendered).toFixed(3),
      windowLatencyMs: this.windowLatencies.length ? stats(this.windowLatencies) : null,
    };
  }
  async toggleToPaint(row) {
    const t0 = performance.now();
    let total;
    let workerMs = null;
    let rebuildMs = null;
    if (this.mode === 'B') {
      const res = this.model.toggleAt(row);
      total = res.total;
      rebuildMs = res.rebuildMs ?? null;
      this.setTotal(total);
      this.render();
    } else {
      const res = await this.w.call('toggle', { row, rootId: 'doc' });
      total = res.total;
      workerMs = res.toggleMs;
      this.setTotal(total);
      await this.requestWindowAwait(this.range());
      this.render();
    }
    const workMs = performance.now() - t0; // data ready + rows committed
    await doubleRaf();
    return { total, workerMs, rebuildMs, workMs: +workMs.toFixed(2), frameWaitMs: +(performance.now() - t0 - workMs).toFixed(2), ms: +(performance.now() - t0).toFixed(2) };
  }
  async jumpToRow(targetRow) {
    const maxScroll = Math.max(0, this.totalRows * ROW_H - vp.clientHeight);
    const top = Math.min(maxScroll, Math.max(0, targetRow * ROW_H));
    vp.scrollTop = top;
    const range = this.range();
    const t0 = performance.now();
    if (this.mode === 'B') {
      this.render(range);
      await raf();
      return { requestedRow: targetRow, actualRow: range.first, ms: +(performance.now() - t0).toFixed(2), waitFrames: 0, blankFrames: 0 };
    }
    this.covered = { start: 0, end: 0 };
    this.requestRange(range);
    let blankFrames = 0;
    for (let f = 0; f < 60; f++) {
      const { blankVisible } = this.render(this.range());
      if (blankVisible === 0) {
        const ms = +(performance.now() - t0).toFixed(2);
        await doubleRaf();
        return { requestedRow: targetRow, actualRow: range.first, ms, waitFrames: f, blankFrames };
      }
      blankFrames++;
      await raf();
    }
    return { requestedRow: targetRow, actualRow: range.first, ms: null, waitFrames: 60, blankFrames, timeout: true };
  }
}

// ---------------------------------------------------------------------------
// trials
// ---------------------------------------------------------------------------

const rt = {};
window.__rt = rt;
rt.ready = false;

rt.arch = async ({ sample = '50mb', mode = 'A', overscan = 2, smoothFrames = 90, jumpFrames = 60 } = {}) => {
  const w = new W();
  const view = new View(mode, w, overscan);
  gcNow();
  const heap0 = heapMB();
  const longTaskStart = longTasks.length;
  const t0 = performance.now();
  const loadP = w.call('load', { sample, base: BASE, mode });
  let load = null;
  let doc = null;
  let cloneArriveMs = null;
  let modelBuildMs = null;
  let arriveMs = null;
  if (mode === 'B') {
    doc = await w.waitDoc();
    arriveMs = performance.now();
    cloneArriveMs = +(arriveMs - t0).toFixed(2);
    const t1 = performance.now();
    view.setModel(new FlatModel(doc.root));
    modelBuildMs = +(performance.now() - t1).toFixed(2);
    view.setTotal(view.model.visibleTotal());
  } else {
    load = await loadP;
    arriveMs = performance.now();
    view.setTotal(load.totalRows);
  }
  const firstRange = view.range();
  let firstWindowMs = null;
  if (mode === 'B') {
    view.render(firstRange);
  } else {
    const tReq = performance.now();
    await view.requestWindowAwait(firstRange);
    firstWindowMs = +(performance.now() - tReq).toFixed(2);
    view.render(firstRange);
  }
  const firstRenderMs = +(performance.now() - arriveMs).toFixed(2);
  await doubleRaf();
  const paintMs = +(performance.now() - t0).toFixed(2);
  const heapAfterPaint = heapMB();
  if (mode === 'B') load = await loadP;

  // expand data -> items (both toggles measured end-to-end)
  const toggleData = await view.toggleToPaint(2);
  const toggleItems = await view.toggleToPaint(3);

  vp.scrollTop = 0;
  await raf();
  const smooth = await view.scrollRun({ frames: smoothFrames, stepRows: 6 });
  const randomScroll = await view.scrollRun({ frames: jumpFrames, random: true });
  // scroll back to the top: architecture A must re-request, hybrid may hit its cache
  const scrollBack = await view.jumpToRow(0);
  const target = Math.min(view.totalRows - view.visibleRows - 1, 100000);
  const jump = await view.jumpToRow(target);

  const lt = longTasks.slice(longTaskStart);
  // node/container stats + memory (after interaction traces; A does a worker-side walk here)
  let st = { nodes: load?.nodes ?? null, containers: load?.containers ?? null, walkMs: load?.statsWalkMs ?? null, heapMB: null };
  let wHeap = { heapMB: null };
  if (mode !== 'B') {
    st = await w.call('stats');
    wHeap = await w.call('gc');
  }
  gcNow();
  const heapEnd = heapMB();

  const result = {
    sample,
    mode,
    overscan,
    bytes: load?.bytes ?? doc?.bytes ?? null,
    nodes: st.nodes,
    containers: st.containers,
    rowsAfter: { total: view.totalRows, defaultTotal: mode === 'B' ? doc?.totalRows ?? null : load?.totalRows ?? null },
    segments: {
      fetchMs: load?.fetchMs ?? null,
      parseMs: load?.parseMs ?? null,
      modelMs: load?.modelMs ?? null,
      clonePostMs: load?.clonePostMs ?? null,
      cloneArriveMs,
      firstWindowMs,
      firstRenderMs,
      paintMs,
      modelBuildMs,
    },
    toggles: { data: toggleData, items: toggleItems },
    scroll: {
      smooth,
      random: randomScroll,
      scrollBack,
      jump,
      windowLatencyMs: view.windowLatencies.length ? stats(view.windowLatencies) : null,
    },
    statsWalkMs: st.walkMs,
    heap: {
      pageStartMB: heap0,
      pageAfterPaintMB: heapAfterPaint,
      pageEndMB: heapEnd,
      workerAfterParseMB: load?.heapMB ?? null,
      workerAfterGC_MB: wHeap.heapMB,
    },
    longTasks: { count: lt.length, totalMs: +lt.reduce((s, v) => s + v, 0).toFixed(1), maxMs: lt.length ? +Math.max(...lt).toFixed(1) : 0 },
    errors: w.error ? [w.error] : [],
  };
  w.destroy();
  return result;
};

rt.protocol = async ({ sample = '50mb' } = {}) => {
  const w = new W();
  const load = await w.call('load', { sample, base: BASE, mode: 'A' });
  // expand data -> items so windows carry realistic rows (not just 3 top-level rows)
  await w.call('toggle', { row: 2 });
  await w.call('toggle', { row: 3 });
  const totalRows = (await w.call('stats')).totalRows;

  const pingBatch = async (n, fn) => {
    const ops = [];
    const tAll = performance.now();
    for (let i = 0; i < n; i++) {
      const t = performance.now();
      await fn();
      ops.push(performance.now() - t);
    }
    const totalMs = performance.now() - tAll;
    return { ...stats(ops), totalMs: +totalMs.toFixed(2), usPerOp: +((totalMs * 1000) / n).toFixed(2), resolutionMs: 0.1 };
  };
  const rttPost = await pingBatch(1000, () => w.call('ping'));
  const rttPort = await pingBatch(1000, () => w.portPing());

  const rnd = () => Math.floor(Math.random() * Math.max(1, totalRows - 40));
  const win40 = [];
  let payload40 = 0;
  let payload400 = 0;
  for (let i = 0; i < 300; i++) {
    const t = performance.now();
    const res = await w.requestWindow({ start: rnd(), count: 40 });
    win40.push(performance.now() - t);
    if (i === 0) payload40 = JSON.stringify(res.rows).length;
  }
  const win400 = [];
  for (let i = 0; i < 200; i++) {
    const t = performance.now();
    const res = await w.requestWindow({ start: 0, count: 400 });
    win400.push(performance.now() - t);
    if (i === 0) payload400 = JSON.stringify(res.rows).length;
  }
  // main-thread DOM cost per frame: render the viewport then force layout
  const view = new View('A', w, 2);
  view.setTotal(totalRows);
  const first = await w.requestWindow({ start: 0, count: view.visibleRows + 4 });
  for (let i = 0; i < first.rows.length; i++) view.data.set(first.start + i, first.rows[i]);
  view.covered = { start: first.start, end: first.start + first.rows.length };
  const dom = [];
  const domLayout = [];
  for (let i = 0; i < 200; i++) {
    const t = performance.now();
    view.render(view.range());
    dom.push(performance.now() - t);
    const t2 = performance.now();
    void content.offsetHeight;
    domLayout.push(performance.now() - t2);
  }
  // apply-window cost (Map fill for a 40-row window)
  const apply = [];
  for (let i = 0; i < 300; i++) {
    const res = await w.requestWindow({ start: rnd(), count: 40 });
    const t = performance.now();
    view.data.clear();
    for (let j = 0; j < res.rows.length; j++) view.data.set(res.start + j, res.rows[j]);
    apply.push(performance.now() - t);
  }
  w.destroy();
  return {
    sample,
    load,
    totalRows,
    visibleRows: view.visibleRows,
    rttPostMessage: rttPost,
    rttMessageChannel: rttPort,
    windowRequest40: stats(win40),
    windowRequest400: stats(win400),
    payloadBytes40: payload40,
    payloadBytes400: payload400,
    renderViewportDom: stats(dom),
    forceLayoutViewport: stats(domLayout),
    applyWindow40: stats(apply),
  };
};

rt.heapNow = () => heapMB();

let heldW = null;
rt.memStart = async ({ sample = '50mb', mode = 'A' } = {}) => {
  gcNow();
  const pageHeapStartMB = heapMB();
  heldW = new W();
  const load = await heldW.call('load', { sample, base: BASE, mode });
  if (mode === 'B') await heldW.waitDoc();
  await new Promise((r) => setTimeout(r, 250));
  gcNow();
  return { load, mode, sample, pageHeapStartMB, pageHeapAfterLoadMB: heapMB() };
};
rt.memEnd = async () => {
  heldW?.destroy();
  heldW = null;
  gcNow();
  return { pageHeapMB: heapMB() };
};

rt.bench = async ({ kind = 'rowmodel', sample = '50mb' } = {}) => {
  const w = new W();
  try {
    return await w.call('bench:' + kind, { sample, base: BASE });
  } finally {
    w.destroy();
  }
};

rt.memProbe = async ({ sample = '50mb' } = {}) => {
  gcNow();
  const out = { sample, pageHeapStartMB: heapMB() };
  const tF = performance.now();
  const res = await fetch(`${BASE}/${sample}.json`, { cache: 'no-store' });
  let text = await res.text();
  out.fetchMs = +(performance.now() - tF).toFixed(2);
  out.textMB = +((text.length * 2) / 1048576).toFixed(2);
  const tP = performance.now();
  let root = JSON.parse(text);
  out.parseMs = +(performance.now() - tP).toFixed(2);
  text = null;
  gcNow();
  out.heapAfterParseMB = heapMB();
  out.treeHeapDeltaMB = +(out.heapAfterParseMB - out.pageHeapStartMB).toFixed(2);
  const tW = performance.now();
  const walk = walkStats(root);
  out.walkMs = +(performance.now() - tW).toFixed(2);
  out.nodes = walk.nodes;
  out.containers = walk.containers;
  const nodes = [];
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
  // eager Map<node,id>
  gcNow();
  let h = heapMB();
  let t = performance.now();
  let map = new Map();
  for (let i = 0; i < nodes.length; i++) map.set(nodes[i], i);
  out.eagerMap = { buildMs: +(performance.now() - t).toFixed(2), heapDeltaMB: +(heapMB() - h).toFixed(2), size: map.size };
  {
    const ts = [];
    for (let i = 0; i < 100000; i++) {
      const a = performance.now();
      map.get(nodes[(i * 7919) % nodes.length]);
      ts.push(performance.now() - a);
    }
    out.eagerMap.lookupP50 = quantile(ts, 0.5);
    out.eagerMap.lookupP95 = quantile(ts, 0.95);
  }
  map.clear();
  map = null;
  gcNow();
  // eager WeakMap (only objects can be keys -> containers only, 369,822 of 2.96M nodes)
  const containersOnly = nodes.filter((v) => isContainer(v));
  h = heapMB();
  t = performance.now();
  let weak = new WeakMap();
  for (let i = 0; i < containersOnly.length; i++) weak.set(containersOnly[i], i);
  out.eagerWeakMap = {
    keys: containersOnly.length,
    buildMs: +(performance.now() - t).toFixed(2),
    heapDeltaMB: +(heapMB() - h).toFixed(2),
  };
  {
    const ts = [];
    for (let i = 0; i < 100000; i++) {
      const a = performance.now();
      weak.get(containersOnly[(i * 7919) % containersOnly.length]);
      ts.push(performance.now() - a);
    }
    out.eagerWeakMap.lookupP50 = quantile(ts, 0.5);
    out.eagerWeakMap.lookupP95 = quantile(ts, 0.95);
  }
  weak = null;
  gcNow();
  // id -> node array
  h = heapMB();
  t = performance.now();
  const byId = new Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) byId[i] = nodes[i];
  out.idArray = { buildMs: +(performance.now() - t).toFixed(2), heapDeltaMB: +(heapMB() - h).toFixed(2) };
  byId.length = 0;
  gcNow();
  // lazy ids: only touched nodes (expanded containers + anchors + selection)
  h = heapMB();
  t = performance.now();
  let lazy = new WeakMap();
  let nextId = 1;
  for (let i = 0; i < 2000; i++) lazy.set(containersOnly[(i * 104729) % containersOnly.length], nextId++);
  out.lazy = { touched: 2000, assignMs: +(performance.now() - t).toFixed(3), heapDeltaMB: +(heapMB() - h).toFixed(2) };
  lazy = undefined;
  gcNow();
  // parent map (containers only) for path generation
  h = heapMB();
  t = performance.now();
  const parent = new Map();
  {
    const stack = [[root, null, '$']];
    while (stack.length) {
      const [v, p, label] = stack.pop();
      if (p && isContainer(v)) parent.set(v, { p, label });
      if (!isContainer(v)) continue;
      const keys = Array.isArray(v) ? null : Object.keys(v);
      const n = keys ? keys.length : v.length;
      for (let i = 0; i < n; i++) stack.push([keys ? v[keys[i]] : v[i], v, keys ? keys[i] : i]);
    }
  }
  out.parentMap = { entries: parent.size, buildMs: +(performance.now() - t).toFixed(2), heapDeltaMB: +(heapMB() - h).toFixed(2) };
  parent.clear();
  // IndexedModel with items expanded (doc root + data + items open)
  gcNow();
  h = heapMB();
  t = performance.now();
  const idx = new IndexedModel(root);
  idx.toggleAt(2);
  idx.toggleAt(3);
  out.indexedModel = { totalRows: idx.visibleTotal(), buildMs: +(performance.now() - t).toFixed(2), heapDeltaMB: +(heapMB() - h).toFixed(2) };
  // FlatModel at items-expanded and at full expansion
  gcNow();
  h = heapMB();
  t = performance.now();
  const flat = new FlatModel(root);
  flat.toggleAt(2);
  flat.toggleAt(3);
  out.flatItems = { rows: flat.rows.length, buildMs: +(performance.now() - t).toFixed(2), heapDeltaMB: +(heapMB() - h).toFixed(2) };
  const flatFull = new FlatModel(root);
  {
    const stack = [flatFull.root];
    while (stack.length) {
      const v = stack.pop();
      if (!isContainer(v)) continue;
      flatFull.open.add(v);
      const keys = Array.isArray(v) ? null : Object.keys(v);
      const n = keys ? keys.length : v.length;
      for (let i = 0; i < n; i++) stack.push(keys ? v[keys[i]] : v[i]);
    }
  }
  gcNow();
  h = heapMB();
  t = performance.now();
  flatFull.rebuild();
  out.flatFull = { rows: flatFull.rows.length, rebuildMs: +(performance.now() - t).toFixed(2), heapDeltaMB: +(heapMB() - h).toFixed(2) };
  return out;
};

rt.roots = async ({ sample = '50mb' } = {}) => {
  const w = new W();
  const load = await w.call('load', { sample, base: BASE, mode: 'A' });
  const res = await w.call('makeResult', { sourceRootId: 'doc', minPrice: 500 });
  const docRows = load.totalRows;
  const v = new View('A', w, 2);
  v.setTotal(res.totalRows);
  const range = { first: 0, count: 40 };
  const t0 = performance.now();
  const first = await w.requestWindow({ start: 0, count: 40, rootId: res.rootId });
  const firstWindowMs = +(performance.now() - t0).toFixed(3);
  w.destroy();
  return { sample, docRows, result: res, firstWindowMs, firstRows: first.rows.length, resultWindow: first.total };
};

rt.scrollCap = async () => {
  const CAP_PROBES = [1e6, 1e7, 33e6, 33554427, 33554428, 33554429, 34e6, 4e7, 6.5e7];
  const probes = [];
  for (const h of CAP_PROBES) {
    content.style.height = h + 'px';
    probes.push({ setPx: h, contentScrollHeight: content.scrollHeight, vpScrollHeight: vp.scrollHeight });
  }
  // documentElement as well (Lead measured documentElement.scrollHeight)
  const body = document.body;
  const docProbes = [];
  for (const h of [1e7, 33554428, 33554429, 4e7]) {
    body.style.height = h + 'px';
    docProbes.push({ setPx: h, docScrollHeight: document.documentElement.scrollHeight });
  }
  body.style.height = '';
  // mapping demo: rows -> required px -> clamped px, and error of a scaled scrollbar mapping
  content.style.height = '1px';
  const totalPx = 2958550 * 24; // 50MB fully expanded at 24px rows
  content.style.height = Math.min(totalPx, 33554428) + 'px';
  const effective = content.scrollHeight;
  const scale = totalPx / effective;
  const mapping = [];
  for (const row of [0, 1000, 100000, 500000, 1000000, 1398101, 2000000, 2958550]) {
    const scrollTop = Math.min(effective - 900, (row * 24) / scale);
    const backRow = Math.floor((scrollTop * scale) / 24);
    mapping.push({ row, scrollTop: +scrollTop.toFixed(1), backRow, errRows: backRow - row });
  }
  return {
    capPx: 33554428,
    probes,
    docProbes,
    maxRows24: Math.floor(33554428 / 24),
    maxRows22: Math.floor(33554428 / 22),
    totalPx50mb24: totalPx,
    effectivePx: effective,
    scale,
    mapping,
  };
};

rt.ready = true;
