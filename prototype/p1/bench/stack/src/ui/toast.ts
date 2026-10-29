/** Hand-written toast region: ~40 LOC, aria-live built in. */
export function createToastRegion(): {
  show(msg: string, ms?: number): HTMLElement;
  count(): number;
  clear(): void;
  el: HTMLElement;
} {
  const el = document.createElement('div');
  el.className = 'toast-region';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.setAttribute('aria-atomic', 'false');
  document.body.appendChild(el);
  const timers = new Set<ReturnType<typeof setTimeout>>();
  function show(msg: string, ms = 4000) {
    const node = document.createElement('div');
    node.className = 'toast';
    node.textContent = msg;
    el.appendChild(node);
    const t = setTimeout(() => {
      node.remove();
      timers.delete(t);
    }, ms);
    timers.add(t);
    return node;
  }
  return {
    el,
    show,
    count: () => el.childElementCount,
    clear: () => {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      el.replaceChildren();
    },
  };
}
