/** CodeMirror 6 minimal bundle for the expression input: state + view +
 *  autocomplete + commands (no language package, no theme package). */
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { autocompletion, closeBrackets, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { completionSource } from './cm6-completion';


// Run the CSP probe at module evaluation time (page script context). Calling it
// later through CDP Runtime.evaluate would bypass CSP and give a false negative.
const cspAtLoad = (() => {
  let evalBlocked = false;
  let newFunctionBlocked = false;
  let evalError = '';
  let newFunctionError = '';
  try {
    (0, eval)('1 + 1');
  } catch (e) {
    evalBlocked = true;
    evalError = String(e).slice(0, 160);
  }
  try {
    // eslint-disable-next-line no-new-func
    new Function('return 1');
  } catch (e) {
    newFunctionBlocked = true;
    newFunctionError = String(e).slice(0, 160);
  }
  return { evalBlocked, newFunctionBlocked, evalError, newFunctionError };
})();

let view: EditorView | null = null;
let host: HTMLElement | null = null;
const inputTimes: number[] = [];
const popupTimes: number[] = [];

function makeState(extra: import('@codemirror/state').Extension[] = []) {
  return EditorState.create({
    doc: '',
    extensions: [
      history(),
      closeBrackets(),
      autocompletion({ override: [completionSource], activateOnTyping: true }),
      keymap.of([...completionKeymap, ...defaultKeymap, ...historyKeymap]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) inputTimes.push(performance.now());
      }),
      EditorView.contentAttributes.of({ 'aria-label': 'JSON expression' }),
      ...extra,
    ],
  });
}

function mountInto(el: HTMLElement, extra: import('@codemirror/state').Extension[] = []): number {
  const t0 = performance.now();
  const v = new EditorView({ state: makeState(extra), parent: el });
  const ms = performance.now() - t0;
  host = el;
  view = v;
  v.focus();
  return ms;
}

let observer: MutationObserver | null = null;
function watchPopup() {
  observer?.disconnect();
  observer = new MutationObserver(() => {
    if (document.querySelector('.cm-tooltip-autocomplete')) popupTimes.push(performance.now());
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

const api = {
  mount(): { ms: number; nodes: number; docLen: number } {
    const el = document.getElementById('cm6-min-host') as HTMLElement;
    el.replaceChildren();
    const ms = mountInto(el);
    watchPopup();
    return { ms, nodes: el.querySelectorAll('*').length, docLen: view!.state.doc.length };
  },
  mountMany(n: number): number[] {
    const el = document.getElementById('cm6-mount-host') as HTMLElement;
    const ms: number[] = [];
    for (let i = 0; i < n; i++) {
      el.replaceChildren();
      ms.push(mountInto(el));
      el.replaceChildren();
    }
    return ms;
  },
  insert(s: string): void {
    const v = view!;
    v.dispatch({ changes: { from: v.state.doc.length, insert: s }, userEvent: 'input.type' });
  },
  clear(): void {
    view?.dispatch({ changes: { from: 0, to: view.state.doc.length } });
    inputTimes.length = 0;
    popupTimes.length = 0;
  },
  doc(): string {
    return view?.state.doc.toString() ?? '';
  },
  stats(): { nodes: number; docLen: number; tooltips: number } {
    return {
      nodes: host?.querySelectorAll('*').length ?? 0,
      docLen: view?.state.doc.length ?? 0,
      tooltips: host?.querySelectorAll('.cm-tooltip').length ?? 0,
    };
  },
  popupState(): {
    visible: boolean;
    options: number;
    role: string | null;
    optionRole: string | null;
    ariaActiveDescendant: string | null;
    activeOption: string | null;
    rect: { w: number; h: number } | null;
  } {
    const pop = document.querySelector('.cm-tooltip-autocomplete') as HTMLElement | null;
    const list = pop?.querySelector('ul') as HTMLElement | null;
    const active = pop?.querySelector('li[aria-selected="true"]') as HTMLElement | null;
    const viewEl = host?.querySelector('.cm-content') as HTMLElement | null;
    return {
      visible: !!pop,
      options: list ? list.querySelectorAll('li').length : 0,
      role: list?.getAttribute('role') ?? null,
      optionRole: list?.querySelector('li')?.getAttribute('role') ?? null,
      ariaActiveDescendant: viewEl?.getAttribute('aria-activedescendant') ?? null,
      activeOption: active?.textContent ?? null,
      rect: pop ? { w: Math.round(pop.getBoundingClientRect().width), h: Math.round(pop.getBoundingClientRect().height) } : null,
    };
  },
  popupWait(ms = 1500): Promise<number> {
    const t0 = performance.now();
    return new Promise((resolve, reject) => {
      const check = () => {
        if (document.querySelector('.cm-tooltip-autocomplete')) resolve(performance.now() - t0);
        else if (performance.now() - t0 > ms) reject(new Error('popup timeout'));
        else setTimeout(check, 5);
      };
      check();
    });
  },
  inputLatencies(): number[] {
    return inputTimes.slice();
  },
  resetTimes(): void {
    inputTimes.length = 0;
    popupTimes.length = 0;
  },
  cspAtLoad,
  cspProbe(): { evalBlocked: boolean; newFunctionBlocked: boolean; evalError: string; newFunctionError: string } {
    let evalBlocked = false;
    let newFunctionBlocked = false;
    let evalError = '';
    let newFunctionError = '';
    try {
      (0, eval)('1 + 1');
    } catch (e) {
      evalBlocked = true;
      evalError = String(e);
    }
    try {
      // eslint-disable-next-line no-new-func
      new Function('return 1');
    } catch (e) {
      newFunctionBlocked = true;
      newFunctionError = String(e);
    }
    return { evalBlocked, newFunctionBlocked, evalError, newFunctionError };
  },
  activeElement(): string {
    const el = document.activeElement as HTMLElement | null;
    return el ? el.className || el.tagName : 'none';
  },
};

(window as unknown as { __cm6: unknown }).__cm6 = api;
