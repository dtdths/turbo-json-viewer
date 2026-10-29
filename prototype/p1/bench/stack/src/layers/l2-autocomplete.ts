import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { autocompletion } from '@codemirror/autocomplete';
import { completionSource } from '../cm6-completion';
export const mk = (el: HTMLElement) =>
  new EditorView({ state: EditorState.create({ doc: '', extensions: [autocompletion({ override: [completionSource] })] }), parent: el });
