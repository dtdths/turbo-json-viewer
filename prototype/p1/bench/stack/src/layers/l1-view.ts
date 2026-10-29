import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
export const mk = (el: HTMLElement) => new EditorView({ state: EditorState.create({ doc: '' }), parent: el });
