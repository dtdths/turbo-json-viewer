/** Draggable split pane divider with pointer capture + keyboard resize
 *  (role=separator, aria-valuenow) — ~50 LOC. */
export function createSplitter(opts: {
  left: HTMLElement;
  min?: number;
  max?: number;
}): { el: HTMLElement; width(): number } {
  const min = opts.min ?? 160;
  const max = opts.max ?? 720;
  const el = document.createElement('div');
  el.className = 'splitter';
  el.setAttribute('role', 'separator');
  el.setAttribute('aria-orientation', 'vertical');
  el.tabIndex = 0;
  let width = 320;
  let dragging = false;
  function apply(w: number) {
    width = Math.max(min, Math.min(max, w));
    opts.left.style.width = width + 'px';
    el.setAttribute('aria-valuenow', String(Math.round(width)));
    el.setAttribute('aria-valuemin', String(min));
    el.setAttribute('aria-valuemax', String(max));
  }
  el.addEventListener('pointerdown', (ev) => {
    dragging = true;
    el.setPointerCapture(ev.pointerId);
    el.classList.add('dragging');
  });
  el.addEventListener('pointermove', (ev) => {
    if (dragging) apply(width + ev.movementX);
  });
  const stop = (ev: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove('dragging');
    try {
      el.releasePointerCapture(ev.pointerId);
    } catch {
      /* already released */
    }
  };
  el.addEventListener('pointerup', stop);
  el.addEventListener('pointercancel', stop);
  el.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowLeft') (ev.preventDefault(), apply(width - 16));
    else if (ev.key === 'ArrowRight') (ev.preventDefault(), apply(width + 16));
  });
  apply(width);
  return { el, width: () => width };
}
