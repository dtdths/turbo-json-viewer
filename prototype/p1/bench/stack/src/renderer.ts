/** Recommended row renderer for fixed-height DOM virtualization (~70 LOC):
 *  pooled row nodes + textContent updates (no HTML parsing, no XSS surface). */
import type { Row } from './rows';

export interface RowRenderer {
  render(rows: Row[], startIndex: number): void;
  host: HTMLElement;
  poolSize(): number;
}

export function createRowRenderer(host: HTMLElement, viewportRows: number, opts?: { withSpans?: boolean }): RowRenderer {
  const withSpans = opts?.withSpans ?? true;
  const pool: { row: HTMLDivElement; key: HTMLSpanElement; punct: HTMLSpanElement; val: HTMLSpanElement }[] = [];
  for (let i = 0; i < viewportRows; i++) {
    const row = document.createElement('div');
    row.className = 'row';
    const key = document.createElement('span');
    key.className = 'tk-key';
    const punct = document.createElement('span');
    punct.className = 'tk-p';
    punct.textContent = ': ';
    const val = document.createElement('span');
    val.className = 'tk-val';
    if (withSpans) row.append(key, punct, val);
    else row.append(key, val);
    row.style.display = 'none';
    host.appendChild(row);
    pool.push({ row, key, punct, val });
  }
  return {
    host,
    poolSize: () => pool.length,
    render(rows, startIndex) {
      for (let i = 0; i < pool.length; i++) {
        const slot = pool[i];
        const r = rows[i];
        if (!r) {
          slot.row.style.display = 'none';
          continue;
        }
        slot.row.style.display = '';
        slot.row.style.paddingLeft = r.depth * 12 + 'px';
        slot.row.dataset.idx = String(startIndex + i);
        // textContent (never innerHTML) — immune to injected markup
        slot.key.textContent = r.key;
        slot.key.className = 'tk-key';
        slot.val.className = 'tk-val ' + r.kind;
        slot.val.textContent = r.value;
      }
    },
  };
}
