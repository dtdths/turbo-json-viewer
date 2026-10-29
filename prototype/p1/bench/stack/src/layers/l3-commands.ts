import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { autocompletion, closeBrackets, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { completionSource } from '../cm6-completion';
export const mk = (el: HTMLElement) =>
  new EditorView({
    state: EditorState.create({
      doc: '',
      extensions: [
        history(),
        closeBrackets(),
        autocompletion({ override: [completionSource] }),
        keymap.of([...completionKeymap, ...defaultKeymap, ...historyKeymap]),
      ],
    }),
    parent: el,
  });
