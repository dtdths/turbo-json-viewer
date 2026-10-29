/**
 * DOM row-rendering bench (real Chrome, extension page).
 * Five strategies render the same 40-row window of a fixed-24px-height tree list.
 */
import { makeRows, visibleWindow, ROW_HEIGHT, VIEWPORT_ROWS, type Row } from './rows';

const ESC: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c] as string);
}

function valClass(kind: string): string {
  return 'tk-val ' + kind;
}

type VariantName = 'innerHTML' | 'createElement' | 'cloneNode' | 'fragment' | 'reuse';

interface Variant {
  name: VariantName;
  /** Rebuild the mounted rows for [first, first+count). */
  render(first: number, count: number): void;
}

function mkRowEl(r: Row): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'row';
  row.style.paddingLeft = r.depth * 12 + 'px';
  const key = document.createElement('span');
  key.className = 'tk-key';
  key.textContent = r.key;
  const p = document.createElement('span');
  p.className = 'tk-p';
  p.textContent = ': ';
  const val = document.createElement('span');
  val.className = valClass(r.kind);
  val.textContent = r.value;
  row.append(key, p, val);
  return row;
}

function createVariants(host: HTMLElement, rows: Row[]): Variant[] {
  const template = document.createElement('template');
  template.innerHTML =
    '<div class="row"><span class="tk-key"></span><span class="tk-p">: </span><span class="tk-val"></span></div>';
  const tplRoot = template.content.firstElementChild as HTMLDivElement;

  // reuse pool
  const pool: HTMLDivElement[] = [];
  for (let i = 0; i < VIEWPORT_ROWS; i++) {
    const el = mkRowEl(rows[i % rows.length]);
    el.style.display = 'none';
    host.appendChild(el);
    pool.push(el);
  }

  return [
    {
      name: 'innerHTML',
      render(first, count) {
        let html = '';
        for (let i = 0; i < count; i++) {
          const r = rows[first + i];
          html +=
            '<div class="row" style="padding-left:' +
            r.depth * 12 +
            'px"><span class="tk-key">' +
            esc(r.key) +
            '</span><span class="tk-p">: </span><span class="' +
            valClass(r.kind) +
            '">' +
            esc(r.value) +
            '</span></div>';
        }
        host.innerHTML = html;
      },
    },
    {
      name: 'createElement',
      render(first, count) {
        host.replaceChildren();
        for (let i = 0; i < count; i++) host.appendChild(mkRowEl(rows[first + i]));
      },
    },
    {
      name: 'cloneNode',
      render(first, count) {
        host.replaceChildren();
        for (let i = 0; i < count; i++) {
          const r = rows[first + i];
          const el = tplRoot.cloneNode(true) as HTMLDivElement;
          el.style.paddingLeft = r.depth * 12 + 'px';
          const spans = el.children;
          (spans[0] as HTMLSpanElement).textContent = r.key;
          (spans[2] as HTMLSpanElement).className = valClass(r.kind);
          (spans[2] as HTMLSpanElement).textContent = r.value;
          host.appendChild(el);
        }
      },
    },
    {
      name: 'fragment',
      render(first, count) {
        host.replaceChildren();
        const frag = document.createDocumentFragment();
        for (let i = 0; i < count; i++) frag.appendChild(mkRowEl(rows[first + i]));
        host.appendChild(frag);
      },
    },
    {
      name: 'reuse',
      render(first, count) {
        if (pool[0].parentNode !== host) {
          host.replaceChildren();
          for (const el of pool) host.appendChild(el);
        }
        for (let i = 0; i < VIEWPORT_ROWS; i++) {
          const el = pool[i];
          if (i < count) {
            const r = rows[first + i];
            const spans = el.children;
            el.style.paddingLeft = r.depth * 12 + 'px';
            (spans[0] as HTMLSpanElement).textContent = r.key;
            (spans[2] as HTMLSpanElement).className = valClass(r.kind);
            (spans[2] as HTMLSpanElement).textContent = r.value;
            el.style.display = '';
          } else {
            el.style.display = 'none';
          }
        }
      },
    },
  ];
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function p95(xs: number[]): number {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
}
const round2 = (x: number) => Math.round(x * 100) / 100;

interface SyncStats {
  frames: number;
  jsTotalMs: number;
  jsMedianMs: number;
  jsP95Ms: number;
  jsMaxMs: number;
  layoutTotalMs: number;
  layoutMedianMs: number;
  layoutP95Ms: number;
  nodes: number;
  heapDeltaKB: number;
  longTasks: number;
}

interface RafStats {
  frames: number;
  wallMs: number;
  meanFrameMs: number;
  p95FrameMs: number;
  droppedFrames: number;
  dropRate: number;
  longTasks: number;
  jsTotalMs: number;
  jsP95Ms: number;
}

function heapKB(): number {
  const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return m ? Math.round(m.usedJSHeapSize / 1024) : -1;
}

function longTaskCounter(): { count(): number; stop(): void } {
  let n = 0;
  let obs: PerformanceObserver | undefined;
  try {
    obs = new PerformanceObserver((list) => {
      n += list.getEntries().length;
    });
    obs.observe({ entryTypes: ['longtask'] });
  } catch {
    /* longtask unsupported */
  }
  return { count: () => n, stop: () => obs?.disconnect() };
}

export interface DomBenchResult {
  meta: {
    ua: string;
    dpr: number;
    rowHeight: number;
    viewportRows: number;
    logicalRows: number;
    rounds: number;
    frames: number;
    heapApi: boolean;
  };
  variants: Record<
    string,
    {
      sync: SyncStats;
      raf?: RafStats;
    }
  >;
  checks: {
    xss: Record<string, boolean>;
    ellipsis: { textOverflow: string; scrollWidth: number; clientWidth: number; works: boolean };
    heights: Record<string, number>;
    nodesPerFrame: Record<string, number>;
  };
}

async function runSync(
  variant: Variant,
  rows: Row[],
  frames: number,
  scroller: HTMLElement,
  firstStart: number,
): Promise<SyncStats> {
  const host = scroller.firstElementChild as HTMLElement;
  const counts: number[] = [];
  const layoutCounts: number[] = [];
  const heapBefore = heapKB();
  const lt = longTaskCounter();
  let jsTotal = 0;
  let layoutTotal = 0;
  for (let f = 0; f < frames; f++) {
    const { first, count } = visibleWindow(firstStart + f * ROW_HEIGHT, ROW_HEIGHT, VIEWPORT_ROWS, rows.length);
    const t0 = performance.now();
    variant.render(first, count);
    const t1 = performance.now();
    // force style/layout: the browser would do this before paint anyway
    void scroller.offsetHeight;
    const t2 = performance.now();
    counts.push(t1 - t0);
    layoutCounts.push(t2 - t1);
    jsTotal += t1 - t0;
    layoutTotal += t2 - t1;
  }
  const heapAfter = heapKB();
  lt.stop();
  return {
    frames,
    jsTotalMs: round2(jsTotal),
    jsMedianMs: round2(median(counts)),
    jsP95Ms: round2(p95(counts)),
    jsMaxMs: round2(Math.max(...counts)),
    layoutTotalMs: round2(layoutTotal),
    layoutMedianMs: round2(median(layoutCounts)),
    layoutP95Ms: round2(p95(layoutCounts)),
    nodes: host.querySelectorAll('*').length,
    heapDeltaKB: heapAfter - heapBefore,
    longTasks: lt.count(),
  };
}

async function runRaf(
  variant: Variant,
  rows: Row[],
  frames: number,
  scroller: HTMLElement,
  firstStart: number,
): Promise<RafStats> {
  const lt = longTaskCounter();
  const frameGaps: number[] = [];
  const jsTimes: number[] = [];
  let jsTotal = 0;
  const wallStart = performance.now();
  await new Promise<void>((resolve) => {
    let f = 0;
    let last = performance.now();
    const tick = () => {
      const now = performance.now();
      if (f > 0) frameGaps.push(now - last);
      last = now;
      const scrollTop = firstStart + f * ROW_HEIGHT;
      scroller.scrollTop = scrollTop;
      const { first, count } = visibleWindow(scrollTop, ROW_HEIGHT, VIEWPORT_ROWS, rows.length);
      const t0 = performance.now();
      variant.render(first, count);
      jsTimes.push(performance.now() - t0);
      jsTotal += jsTimes[jsTimes.length - 1];
      if (++f >= frames) {
        resolve();
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const wallMs = performance.now() - wallStart;
  lt.stop();
  const dropped = frameGaps.filter((g) => g > 25).length;
  return {
    frames,
    wallMs: round2(wallMs),
    meanFrameMs: round2(wallMs / frames),
    p95FrameMs: round2(p95(frameGaps)),
    droppedFrames: dropped,
    dropRate: round2((dropped / Math.max(1, frameGaps.length)) * 100),
    longTasks: lt.count(),
    jsTotalMs: round2(jsTotal),
    jsP95Ms: round2(p95(jsTimes)),
  };
}

export async function runDom(cfg: {
  logicalRows?: number;
  frames?: number;
  rounds?: number;
  rafFrames?: number;
  variants?: string[];
}): Promise<DomBenchResult> {
  const logicalRows = cfg.logicalRows ?? 200_000;
  const frames = cfg.frames ?? 1000;
  const rounds = cfg.rounds ?? 5;
  const rafFrames = cfg.rafFrames ?? 1000;
  const rows = makeRows(logicalRows);

  const scroller = document.getElementById('scroller') as HTMLElement;
  scroller.style.height = VIEWPORT_ROWS * ROW_HEIGHT + 'px';
  const host = document.createElement('div');
  host.id = 'rows';
  scroller.replaceChildren(host);

  const variants = createVariants(host, rows);
  const wanted = new Set(cfg.variants ?? variants.map((v) => v.name));
  const variantsToRun = variants.filter((v) => wanted.has(v.name));

  const perVariant = new Map<string, { sync: SyncStats[]; raf?: RafStats[] }>();
  for (const v of variantsToRun) perVariant.set(v.name, { sync: [] });

  // interleave variants inside each round to decorrelate warm-up/ordering
  for (let round = 0; round < rounds; round++) {
    for (const v of variantsToRun) {
      const st = await runSync(v, rows, frames, scroller, round * 7 * ROW_HEIGHT);
      perVariant.get(v.name)!.sync.push(st);
    }
  }
  for (const v of variantsToRun) {
    perVariant.get(v.name)!.raf = [await runRaf(v, rows, rafFrames, scroller, 0)];
  }

  const out: DomBenchResult['variants'] = {};
  for (const [name, data] of perVariant) {
    const pooled = data.sync;
    out[name] = {
      sync: {
        frames: pooled.reduce((a, s) => a + s.frames, 0),
        jsTotalMs: round2(pooled.reduce((a, s) => a + s.jsTotalMs, 0) / pooled.length),
        jsMedianMs: median(pooled.map((s) => s.jsMedianMs)),
        jsP95Ms: Math.max(...pooled.map((s) => s.jsP95Ms)),
        jsMaxMs: Math.max(...pooled.map((s) => s.jsMaxMs)),
        layoutTotalMs: round2(pooled.reduce((a, s) => a + s.layoutTotalMs, 0) / pooled.length),
        layoutMedianMs: median(pooled.map((s) => s.layoutMedianMs)),
        layoutP95Ms: Math.max(...pooled.map((s) => s.layoutP95Ms)),
        nodes: Math.max(...pooled.map((s) => s.nodes)),
        heapDeltaKB: Math.round(pooled.reduce((a, s) => a + s.heapDeltaKB, 0) / pooled.length),
        longTasks: pooled.reduce((a, s) => a + s.longTasks, 0),
      },
      raf: data.raf?.[0],
    };
  }

  // ---- checks: XSS, ellipsis, fixed heights ----
  const xssRows: Row[] = [
    { depth: 1, key: '"<img src=x onerror=window.__xssFired=1>"', kind: 'string', value: '"</span><script>window.__xssFired=2</script>"' },
    { depth: 2, key: '"evil"', kind: 'string', value: '"<svg onload=window.__xssFired=3>"' },
  ];
  const xss: Record<string, boolean> = {};
  for (const v of variantsToRun) {
    const h = document.createElement('div');
    document.body.appendChild(h);
    const inst = createVariants(h, xssRows).find((x) => x.name === v.name)!;
    inst.render(0, xssRows.length);
    const injected = h.querySelector('img, svg, script') !== null;
    const fired = (window as unknown as { __xssFired?: number }).__xssFired !== undefined;
    const literal = h.textContent!.includes('<img');
    xss[v.name] = !injected && !fired && literal;
    h.remove();
  }

  // ellipsis behaviour inside a real scroller
  const ell = document.getElementById('ellipsis') as HTMLElement;
  const longRow: Row[] = [{ depth: 1, key: '"k"', kind: 'string', value: '"' + 'y'.repeat(500) + '"' }];
  const ellHost = document.createElement('div');
  ell.replaceChildren(ellHost);
  const ev = createVariants(ellHost, longRow)[1]; // createElement
  ev.render(0, 1);
  const rowEl = ellHost.querySelector('.row') as HTMLElement;
  const cs = getComputedStyle(rowEl);
  const checks: DomBenchResult['checks'] = {
    xss,
    ellipsis: {
      textOverflow: cs.textOverflow,
      scrollWidth: rowEl.scrollWidth,
      clientWidth: rowEl.clientWidth,
      works: rowEl.scrollWidth > rowEl.clientWidth && cs.textOverflow === 'ellipsis',
    },
    heights: {},
    nodesPerFrame: {},
  };
  for (const v of variantsToRun) {
    v.render(0, VIEWPORT_ROWS);
    const els = scroller.querySelectorAll('.row');
    checks.heights[v.name] = round2((els[0] as HTMLElement).getBoundingClientRect().height);
    checks.nodesPerFrame[v.name] = scroller.querySelectorAll('*').length;
  }
  host.replaceChildren();

  return {
    meta: {
      ua: navigator.userAgent,
      dpr: devicePixelRatio,
      rowHeight: ROW_HEIGHT,
      viewportRows: VIEWPORT_ROWS,
      logicalRows,
      rounds,
      frames,
      heapApi: heapKB() >= 0,
    },
    variants: out,
    checks,
  };
}

(window as unknown as { __domBench: unknown }).__domBench = { runDom };
