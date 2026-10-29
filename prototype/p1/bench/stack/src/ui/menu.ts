/** Hand-written context menu: ~90 LOC, no dependency. */
export interface MenuItem {
  label: string;
  action: () => void;
}
export interface MenuHandle {
  el: HTMLElement;
  open(x: number, y: number): void;
  close(restoreFocus?: boolean): void;
  isOpen(): boolean;
  itemEls(): HTMLElement[];
}

export function createMenu(items: MenuItem[]): MenuHandle {
  const el = document.createElement('div');
  el.className = 'menu';
  el.setAttribute('role', 'menu');
  el.tabIndex = -1;
  el.hidden = true;
  for (const it of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'menu-item';
    b.setAttribute('role', 'menuitem');
    b.tabIndex = -1;
    b.textContent = it.label;
    b.addEventListener('click', () => {
      it.action();
      close(true);
    });
    el.appendChild(b);
  }
  document.body.appendChild(el);

  let opener: HTMLElement | null = null;
  let active = 0;

  function focusItem(i: number) {
    const els = itemEls();
    if (!els.length) return;
    active = (i + els.length) % els.length;
    els.forEach((e, n) => e.classList.toggle('active', n === active));
    els[active].focus();
  }
  function itemEls() {
    return Array.from(el.querySelectorAll<HTMLElement>('.menu-item'));
  }
  function open(x: number, y: number) {
    opener = (document.activeElement as HTMLElement) ?? null;
    el.hidden = false;
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    // clamp inside viewport (flip at right/bottom edges)
    const r = el.getBoundingClientRect();
    if (x + r.width > innerWidth) el.style.left = Math.max(0, innerWidth - r.width - 4) + 'px';
    if (y + r.height > innerHeight) el.style.top = Math.max(0, innerHeight - r.height - 4) + 'px';
    focusItem(0);
  }
  function close(restoreFocus = false) {
    el.hidden = true;
    if (restoreFocus) opener?.focus();
    opener = null;
  }
  el.addEventListener('keydown', (ev) => {
    const k = ev.key;
    if (k === 'ArrowDown') (ev.preventDefault(), focusItem(active + 1));
    else if (k === 'ArrowUp') (ev.preventDefault(), focusItem(active - 1));
    else if (k === 'Home') (ev.preventDefault(), focusItem(0));
    else if (k === 'End') (ev.preventDefault(), focusItem(itemEls().length - 1));
    else if (k === 'Enter' || k === ' ') (ev.preventDefault(), itemEls()[active].click());
    else if (k === 'Escape') (ev.preventDefault(), close(true));
    else if (k === 'Tab') (ev.preventDefault(), close(true));
  });
  document.addEventListener('pointerdown', (ev) => {
    if (!el.hidden && !el.contains(ev.target as Node)) close(false);
  });
  return { el, open, close, isOpen: () => !el.hidden, itemEls };
}
