/** CodeMirror 6 + javascript language support (syntax highlighting in the
 *  expression box). Same API surface as the minimal bundle. */
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { autocompletion, closeBrackets, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { completionSource } from './cm6-completion';

let view: EditorView | null = null;
const inputTimes: number[] = [];

const api = {
  mount(): { ms: number; nodes: number } {
    const el = document.getElementById('cm6-lang-host') as HTMLElement;
    el.replaceChildren();
    const t0 = performance.now();
    view = new EditorView({
      state: EditorState.create({
        doc: '',
        extensions: [
          javascript(),
          syntaxHighlighting(defaultHighlightStyle),
          history(),
          closeBrackets(),
          autocompletion({ override: [completionSource], activateOnTyping: true }),
          keymap.of([...completionKeymap, ...defaultKeymap, ...historyKeymap]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) inputTimes.push(performance.now());
          }),
        ],
      }),
      parent: el,
    });
    const ms = performance.now() - t0;
    view.focus();
    return { ms, nodes: el.querySelectorAll('*').length };
  },
  insert(s: string): void {
    const v = view!;
    v.dispatch({ changes: { from: v.state.doc.length, insert: s }, userEvent: 'input.type' });
  },
  tokenSpans(): number {
    return document.querySelectorAll('#cm6-lang-host .cm-line span').length;
  },
  popupState(): { visible: boolean; options: number; highlighted: number } {
    const pop = document.querySelector('.cm-tooltip-autocomplete');
    return {
      visible: !!pop,
      options: pop ? pop.querySelectorAll('li').length : 0,
      highlighted: document.querySelectorAll('.cm-tooltip-autocomplete .cm-completionMatchedText').length,
    };
  },
  inputLatencies(): number[] {
    return inputTimes.slice();
  },
};
(window as unknown as { __cm6Lang: unknown }).__cm6Lang = api;
