/** Virtual-row keyboard navigation: two focus strategies, same row model. */
export type NavStrategy = 'activedescendant' | 'roving';

export interface TreeNav {
  el: HTMLElement;
  activeIndex(): number;
  key(k: string): number; // returns handler duration in ms
  state(): { activeDescendant: string | null; focusedIndex: number; tabbable: number };
}

export function createTreeNav(strategy: NavStrategy, labels: string[]): TreeNav {
  const el = document.createElement('div');
  el.className = 'tree';
  el.setAttribute('role', 'tree');
  el.setAttribute('aria-label', 'JSON tree');
  if (strategy === 'activedescendant') el.tabIndex = 0;
  const rows = labels.map((label, i) => {
    const r = document.createElement('div');
    r.className = 'tree-row';
    r.id = 'tn-row-' + i;
    r.setAttribute('role', 'treeitem');
    r.setAttribute('aria-level', String(1 + (i % 3)));
    r.tabIndex = strategy === 'roving' ? (i === 0 ? 0 : -1) : -1;
    const key = document.createElement('span');
    key.className = 'tk-key';
    key.textContent = label;
    r.appendChild(key);
    el.appendChild(r);
    return r;
  });
  let active = 0;

  function paint() {
    rows.forEach((r, i) => {
      r.classList.toggle('active', i === active);
      if (strategy === 'activedescendant') {
        r.setAttribute('aria-selected', i === active ? 'true' : 'false');
        if (i === active) el.setAttribute('aria-activedescendant', r.id);
      }
    });
  }
  paint();

  function move(delta: number) {
    active = Math.max(0, Math.min(rows.length - 1, active + delta));
    if (strategy === 'roving') {
      rows.forEach((r, i) => (r.tabIndex = i === active ? 0 : -1));
      rows[active].focus();
    }
    paint();
  }
  el.addEventListener('keydown', (ev) => {
    const t0 = performance.now();
    if (ev.key === 'ArrowDown') (ev.preventDefault(), move(1));
    else if (ev.key === 'ArrowUp') (ev.preventDefault(), move(-1));
    else if (ev.key === 'PageDown') (ev.preventDefault(), move(10));
    else if (ev.key === 'PageUp') (ev.preventDefault(), move(-10));
    else if (ev.key === 'Home') (ev.preventDefault(), move(-active));
    else if (ev.key === 'End') (ev.preventDefault(), move(rows.length - 1 - active));
    lastKeyMs = performance.now() - t0;
  });
  let lastKeyMs = 0;

  return {
    el,
    activeIndex: () => active,
    key: (k: string) => {
      lastKeyMs = 0;
      el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
      return lastKeyMs;
    },
    state: () => ({
      activeDescendant: el.getAttribute('aria-activedescendant'),
      focusedIndex: rows.indexOf(document.activeElement as unknown as HTMLDivElement),
      tabbable: rows.filter((r) => r.tabIndex === 0).length,
    }),
  };
}
