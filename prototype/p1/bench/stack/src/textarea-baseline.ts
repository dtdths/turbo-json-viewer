/** Baseline for "textarea + hand-rolled completion": ~80 LOC, no dependency. */
const FIELDS = ['$', 'data', 'status', 'hotel_id', 'hotel_name', 'price', 'available', 'eta', 'hotel_tags', 'review_count'];
const ARRAY_METHODS = ['filter', 'find', 'map', 'reduce', 'some', 'every', 'slice', 'length', 'flat'];

let ta: HTMLTextAreaElement | null = null;
let pop: HTMLElement | null = null;
const showLatencies: number[] = [];
const inputLatencies: number[] = [];
let pending: number | null = null;

function currentToken(): { prefix: string; member: boolean } {
  const pos = ta!.selectionStart;
  const before = ta!.value.slice(0, pos);
  const m = /([A-Za-z_$][\w$]*)(\.)?([\w$]*)$/.exec(before);
  if (!m) return { prefix: '', member: false };
  if (m[2]) return { prefix: m[3], member: true };
  return { prefix: m[1], member: false };
}

function refresh() {
  if (!ta || !pop) return;
  const { prefix, member } = currentToken();
  const pool = member ? ARRAY_METHODS : FIELDS;
  const items = pool.filter((f) => f.startsWith(prefix) && f !== prefix);
  if (!items.length) {
    pop.hidden = true;
    return;
  }
  pop.replaceChildren(
    ...items.slice(0, 8).map((it) => {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.textContent = it;
      li.addEventListener('mousedown', (e) => (e.preventDefault(), accept(it)));
      return li;
    }),
  );
  pop.hidden = false;
  const r = ta.getBoundingClientRect();
  pop.style.left = r.left + 'px';
  pop.style.top = r.bottom + 'px';
}

function accept(item: string) {
  if (!ta) return;
  const pos = ta.selectionStart;
  const before = ta.value.slice(0, pos);
  const m = /([\w$]*)$/.exec(before)!;
  const start = pos - m[1].length;
  ta.value = ta.value.slice(0, start) + item + ta.value.slice(pos);
  ta.selectionStart = ta.selectionEnd = start + item.length;
  if (pop) pop.hidden = true;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

const api = {
  mount(): { ms: number } {
    const host = document.getElementById('ta-host') as HTMLElement;
    host.replaceChildren();
    const t0 = performance.now();
    ta = document.createElement('textarea');
    ta.id = 'expr-ta';
    ta.rows = 1;
    ta.setAttribute('aria-label', 'JSON expression');
    host.appendChild(ta);
    pop = document.createElement('ul');
    pop.id = 'ta-pop';
    pop.setAttribute('role', 'listbox');
    pop.hidden = true;
    document.body.appendChild(pop);
    ta.addEventListener('input', () => {
      inputLatencies.push(performance.now());
      const t = performance.now();
      refresh();
      showLatencies.push(performance.now() - t);
    });
    ta.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && pop) pop.hidden = true;
      else if (ev.key === 'Enter' && pop && !pop.hidden) {
        const first = pop.querySelector('li');
        if (first) {
          ev.preventDefault();
          accept(first.textContent!);
        }
      }
    });
    const ms = performance.now() - t0;
    ta.focus();
    return { ms };
  },
  focus(): void {
    ta?.focus();
  },
  value: () => ta?.value ?? '',
  popupState: () => ({
    visible: !!pop && !pop.hidden,
    options: pop?.querySelectorAll('li').length ?? 0,
    role: pop?.getAttribute('role') ?? null,
    optionRole: pop?.querySelector('li')?.getAttribute('role') ?? null,
  }),
  showLatencies: () => showLatencies.slice(),
  inputLatencies: () => inputLatencies.slice(),
  reset(): void {
    showLatencies.length = 0;
    inputLatencies.length = 0;
    if (pending) cancelAnimationFrame(pending);
  },
  setValue(v: string): void {
    if (!ta) return;
    ta.value = v;
    ta.selectionStart = ta.selectionEnd = v.length;
  },
};
(window as unknown as { __textareaBench: unknown }).__textareaBench = api;
