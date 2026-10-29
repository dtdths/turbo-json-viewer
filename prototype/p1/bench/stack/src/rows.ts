/** Row model shared by the DOM-render bench and unit tests. */

export type RowKind =
  | 'string'
  | 'number'
  | 'boolean'
  | 'null'
  | 'obj-open'
  | 'obj-close'
  | 'arr-open'
  | 'arr-close';

export interface Row {
  depth: number;
  key: string;
  kind: RowKind;
  value: string;
}

export const ROW_HEIGHT = 24;
export const VIEWPORT_ROWS = 40;

/** Deterministic mixed-shape rows (keys unique-ish so text nodes are not shared). */
export function makeRows(n: number): Row[] {
  const rows: Row[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const m = i % 9;
    let r: Row;
    switch (m) {
      case 0:
        r = { depth: 2, key: '"hotel_id_' + i + '"', kind: 'number', value: String(100000 + i) };
        break;
      case 1:
        r = { depth: 3, key: '"hotel_name"', kind: 'string', value: '"Grand Plaza Hotel & Spa ' + i + '"' };
        break;
      case 2:
        r = { depth: 3, key: '"price"', kind: 'number', value: (49.5 + (i % 900)).toFixed(2) };
        break;
      case 3:
        r = { depth: 3, key: '"available"', kind: 'boolean', value: i % 2 ? 'true' : 'false' };
        break;
      case 4:
        r = { depth: 3, key: '"eta"', kind: 'null', value: 'null' };
        break;
      case 5:
        r = { depth: 2, key: '"hotel_tags"', kind: 'arr-open', value: '[' };
        break;
      case 6:
        r = { depth: 1, key: '"review_count_very_long_field_name_for_truncation ' + i + '"', kind: 'number', value: String(1000 + i) };
        break;
      case 7:
        r = { depth: 4, key: '"note"', kind: 'string', value: '"' + 'x'.repeat(380) + '"' };
        break;
      default:
        r = { depth: 1, key: '"data"', kind: 'obj-open', value: '{' };
        break;
    }
    rows[i] = r;
  }
  return rows;
}

/** Pure arithmetic for fixed-height virtualization. */
export function visibleWindow(
  scrollTop: number,
  rowHeight: number,
  viewportRows: number,
  total: number,
  overscan = 0,
): { first: number; count: number } {
  const rawFirst = Math.floor(Math.max(0, scrollTop) / rowHeight) - overscan;
  const first = Math.max(0, rawFirst);
  const count = Math.max(0, Math.min(viewportRows + overscan * 2, total - first));
  return { first, count };
}
