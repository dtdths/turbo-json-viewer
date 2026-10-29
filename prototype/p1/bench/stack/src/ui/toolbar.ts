/** Roving-tabindex toolbar (WAI-ARIA APG pattern): only the active item is
 *  tabbable, arrow keys move focus — ~45 LOC. */
export function createToolbar(labels: string[]): {
  el: HTMLElement;
  activeIndex(): number;
  focusFirst(): void;
} {
  const el = document.createElement('div');
  el.className = 'toolbar';
  el.setAttribute('role', 'toolbar');
  el.setAttribute('aria-label', 'JSON actions');
  const btns = labels.map((label, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tool-btn';
    b.textContent = label;
    b.tabIndex = i === 0 ? 0 : -1;
    el.appendChild(b);
    return b;
  });
  let active = 0;
  function setActive(i: number, focus = true) {
    btns[active].tabIndex = -1;
    active = (i + btns.length) % btns.length;
    btns[active].tabIndex = 0;
    if (focus) btns[active].focus();
  }
  el.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowRight') (ev.preventDefault(), setActive(active + 1));
    else if (ev.key === 'ArrowLeft') (ev.preventDefault(), setActive(active - 1));
    else if (ev.key === 'Home') (ev.preventDefault(), setActive(0));
    else if (ev.key === 'End') (ev.preventDefault(), setActive(btns.length - 1));
  });
  return { el, activeIndex: () => active, focusFirst: () => setActive(0) };
}
