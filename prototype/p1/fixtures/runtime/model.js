/**
 * Row models for the runtime bench (shared by the extension page and its worker).
 *
 * Three variants, same surface:
 *   - IndexedModel: expansion set + per-open-container Fenwick index. Row lookup is
 *     O(depth * log children) without building a flat row table. Toggle updates only
 *     the ancestor chain (O(depth * log n)).
 *   - FlatModel: full flatten array, rebuilt on every toggle (classic flatten-on-change).
 *   - NaiveModel: skip-by-count DFS walk with no index at all (worst-case O(rows before target)).
 *
 * A "row" is one node. A container that is open contributes its own row plus its
 * children's rows; a closed container contributes exactly 1 row.
 */

export const isContainer = (v) => v !== null && typeof v === 'object';

export function childCountOf(node) {
  return Array.isArray(node) ? node.length : Object.keys(node).length;
}

export function childOf(node, idx, keys) {
  return keys ? node[keys[idx]] : node[idx];
}

export function labelOf(keys, idx) {
  return keys ? keys[idx] : idx;
}

const PREVIEW_MAX = 64;

export function previewOf(v) {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'string':
      return v.length > PREVIEW_MAX ? JSON.stringify(v.slice(0, PREVIEW_MAX)) + '…' : JSON.stringify(v);
    case 'number':
    case 'boolean':
      return String(v);
    default:
      return typeof v;
  }
}

/** Row payload as it would cross the worker boundary / go into the DOM. */
export function describeRow(node, label, depth, open) {
  if (Array.isArray(node)) {
    return { label, depth, kind: 'array', preview: '', count: node.length, open };
  }
  if (isContainer(node)) {
    return { label, depth, kind: 'object', preview: '', count: Object.keys(node).length, open };
  }
  return { label, depth, kind: node === null ? 'null' : typeof node, preview: previewOf(node), count: 0, open };
}

export class Fenwick {
  constructor(n) {
    this.n = n;
    this.t = new Int32Array(n + 1);
    this.total = 0;
  }
  add(i, d) {
    this.total += d;
    for (let x = i + 1; x <= this.n; x += x & -x) this.t[x] += d;
  }
  /** sum of entries [0, i) */
  prefix(i) {
    let s = 0;
    for (let x = i; x > 0; x -= x & -x) s += this.t[x];
    return s;
  }
  /** 0-based slot whose cumulative range contains k (k < total). */
  find(k) {
    let pos = 0;
    let rem = k;
    let step = 1;
    while (step * 2 <= this.n) step *= 2;
    for (; step > 0; step >>= 1) {
      const next = pos + step;
      if (next <= this.n && this.t[next] <= rem) {
        pos = next;
        rem -= this.t[next];
      }
    }
    return pos; // slot index; prefix(pos) = rows before this slot
  }
}

export class IndexedModel {
  constructor(root) {
    this.root = root;
    this.open = new Set([root]);
    this.fen = new Map(); // open node -> { f: Fenwick, keys: string[]|null }
    this._build(root);
  }

  _build(node) {
    const keys = Array.isArray(node) ? null : Object.keys(node);
    const n = keys ? keys.length : node.length;
    const f = new Fenwick(n);
    for (let i = 0; i < n; i++) {
      const c = childOf(node, i, keys);
      const cf = this.fen.get(c);
      f.add(i, this.open.has(c) && cf ? 1 + cf.f.total : 1);
    }
    this.fen.set(node, { f, keys });
  }

  visibleTotal() {
    return 1 + this.fen.get(this.root).f.total;
  }

  rowAt(idx) {
    let node = this.root;
    let k = idx;
    let depth = 0;
    let label = '$';
    for (;;) {
      if (k === 0) return { node, label, depth };
      const entry = this.fen.get(node);
      if (!entry) return { node, label, depth }; // defensive: idx out of range
      k -= 1;
      const slot = entry.f.find(k);
      k -= entry.f.prefix(slot);
      const child = childOf(node, slot, entry.keys);
      label = labelOf(entry.keys, slot);
      node = child;
      depth += 1;
      if (!this.open.has(child)) return { node, label, depth };
    }
  }

  window(start, count) {
    const total = this.visibleTotal();
    const end = Math.min(start + count, total);
    const out = [];
    for (let i = Math.max(0, start); i < end; i++) {
      const r = this.rowAt(i);
      out.push(describeRow(r.node, r.label, r.depth, this.open.has(r.node)));
    }
    return out;
  }

  /** Open/close the node whose own row is `idx`. Returns { opened, total }. */
  toggleAt(idx) {
    const probe = this.rowAt(idx);
    if (!probe || !isContainer(probe.node)) return { opened: false, total: this.visibleTotal() };
    let node = this.root;
    let k = idx;
    const chain = [];
    for (;;) {
      if (k === 0) break;
      const entry = this.fen.get(node);
      if (!entry) break;
      k -= 1;
      const slot = entry.f.find(k);
      k -= entry.f.prefix(slot);
      const child = childOf(node, slot, entry.keys);
      chain.push({ parent: node, slot });
      node = child;
      if (!this.open.has(child)) break;
    }
    const wasOpen = this.open.has(node);
    let delta;
    if (wasOpen) {
      this.open.delete(node);
      delta = -this.fen.get(node).f.total;
    } else {
      this.open.add(node);
      this._build(node);
      delta = this.fen.get(node).f.total;
    }
    for (let i = chain.length - 1; i >= 0; i--) {
      const { parent, slot } = chain[i];
      this.fen.get(parent).f.add(slot, delta);
    }
    return { opened: !wasOpen, total: this.visibleTotal() };
  }
}

export class FlatModel {
  constructor(root) {
    this.root = root;
    this.open = new Set([root]);
    this.rebuildMs = 0;
    this.rebuild();
  }

  rebuild() {
    const t0 = performance.now();
    const rows = [];
    const walk = (node, label, depth) => {
      rows.push({ node, label, depth });
      if (this.open.has(node)) {
        const keys = Array.isArray(node) ? null : Object.keys(node);
        const n = keys ? keys.length : node.length;
        for (let i = 0; i < n; i++) walk(childOf(node, i, keys), labelOf(keys, i), depth + 1);
      }
    };
    walk(this.root, '$', 0);
    this.rows = rows;
    this.rebuildMs = performance.now() - t0;
  }

  visibleTotal() {
    return this.rows.length;
  }

  rowAt(idx) {
    return this.rows[idx];
  }

  window(start, count) {
    const out = [];
    const end = Math.min(start + count, this.rows.length);
    for (let i = Math.max(0, start); i < end; i++) {
      const r = this.rows[i];
      out.push(describeRow(r.node, r.label, r.depth, this.open.has(r.node)));
    }
    return out;
  }

  toggleAt(idx) {
    const r = this.rows[idx];
    if (!r || !isContainer(r.node)) return { opened: false, total: this.rows.length };
    const wasOpen = this.open.has(r.node);
    if (wasOpen) this.open.delete(r.node);
    else this.open.add(r.node);
    this.rebuild();
    return { opened: !wasOpen, total: this.rows.length, rebuildMs: this.rebuildMs };
  }
}

export class NaiveModel {
  constructor(root) {
    this.root = root;
    this.open = new Set([root]);
  }

  _count(node) {
    let n = 1;
    if (this.open.has(node)) {
      const keys = Array.isArray(node) ? null : Object.keys(node);
      const len = keys ? keys.length : node.length;
      for (let i = 0; i < len; i++) n += this._count(childOf(node, i, keys));
    }
    return n;
  }

  visibleTotal() {
    return this._count(this.root);
  }

  rowAt(idx) {
    let seen = 0;
    let hit = null;
    const walk = (node, label, depth) => {
      if (hit) return;
      if (seen === idx) {
        hit = { node, label, depth };
        return;
      }
      seen++;
      if (this.open.has(node)) {
        const keys = Array.isArray(node) ? null : Object.keys(node);
        const len = keys ? keys.length : node.length;
        for (let i = 0; i < len && !hit; i++) walk(childOf(node, i, keys), labelOf(keys, i), depth + 1);
      }
    };
    walk(this.root, '$', 0);
    return hit;
  }

  window(start, count) {
    const out = [];
    let seen = 0;
    const end = start + count;
    const walk = (node, label, depth) => {
      if (seen >= end) return;
      if (seen >= start) out.push(describeRow(node, label, depth, this.open.has(node)));
      seen++;
      if (this.open.has(node)) {
        const keys = Array.isArray(node) ? null : Object.keys(node);
        const len = keys ? keys.length : node.length;
        for (let i = 0; i < len && seen < end; i++) walk(childOf(node, i, keys), labelOf(keys, i), depth + 1);
      }
    };
    walk(this.root, '$', 0);
    return out;
  }

  toggleAt(idx) {
    const row = this.rowAt(idx);
    if (!row || !isContainer(row.node)) return { opened: false };
    const wasOpen = this.open.has(row.node);
    if (wasOpen) this.open.delete(row.node);
    else this.open.add(row.node);
    return { opened: !wasOpen };
  }
}

/** Full DFS walk: node/container counts and per-container descendant counts. */
export function walkStats(root) {
  let nodes = 0;
  let containers = 0;
  let scalars = 0;
  let maxDepth = 0;
  const stack = [[root, 0]];
  while (stack.length) {
    const [v, d] = stack.pop();
    nodes++;
    if (d > maxDepth) maxDepth = d;
    if (isContainer(v)) {
      containers++;
      const keys = Array.isArray(v) ? null : Object.keys(v);
      const n = keys ? keys.length : v.length;
      for (let i = 0; i < n; i++) stack.push([childOf(v, i, keys), d + 1]);
    } else {
      scalars++;
    }
  }
  return { nodes, containers, scalars, maxDepth };
}
