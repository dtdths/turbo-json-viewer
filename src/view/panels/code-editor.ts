/**
 * view/panels/code-editor — S5 编辑器适配器（v1 用 CodeMirror 6）。
 *
 * 预算约束（docs/architecture/README.md §8）：CM6 **不能进首屏**。
 * 因此这里所有 CM6 依赖都走动态 `import()`，esbuild 的 `splitting:true` 会把它们拆成
 * 独立 chunk，只有第一次打开编辑弹层时才加载。
 *
 * 只取最小包集合（state / view / commands / language / lang-json / lint），
 * 不用 `codemirror` meta 的 `basicSetup`（会带上 search/autocomplete 等）。
 * 主题不新增颜色：语法色复用树的 `--syntax-*` token，其余用 shell 的 surface token。
 */
import type { EditorView as CmEditorView, ViewUpdate } from '@codemirror/view';
import type { Diagnostic as CmDiagnostic } from '@codemirror/lint';

export interface CodeEditorDiagnostic {
  message: string;
  line?: number;
  column?: number;
}

export interface CodeEditorOptions {
  onChange?: (text: string) => void;
  /** JSON lint 结果（只报 error），供外层禁用 Apply / 显示错误条。 */
  onDiagnostics?: (diags: CodeEditorDiagnostic[]) => void;
  /** Cmd/Ctrl+Enter */
  onApplyShortcut?: () => void;
  /** Escape（编辑器内） */
  onEscape?: () => void;
}

export interface CodeEditor {
  setValue(text: string): void;
  getValue(): string;
  setReadOnly(readOnly: boolean): void;
  /** 服务端/外层错误（例如 core 的 PARSE）也显示在编辑器里。 */
  setDiagnostic(diagnostic: CodeEditorDiagnostic | null): void;
  focus(): void;
  destroy(): void;
}

/* -------------------------------------------------------------------------- */
/* 懒加载：模块级单例 Promise，并发 open 只加载一次                              */
/* -------------------------------------------------------------------------- */

type StateModule = typeof import('@codemirror/state');
type ViewModule = typeof import('@codemirror/view');
type CommandsModule = typeof import('@codemirror/commands');
type LanguageModule = typeof import('@codemirror/language');
type LangJsonModule = typeof import('@codemirror/lang-json');
type LintModule = typeof import('@codemirror/lint');
type LezerHighlightModule = typeof import('@lezer/highlight');

interface Cm6 {
  state: StateModule;
  view: ViewModule;
  commands: CommandsModule;
  language: LanguageModule;
  langJson: LangJsonModule;
  lint: LintModule;
  lezer: LezerHighlightModule;
}

let cm6Promise: Promise<Cm6> | null = null;

function loadCm6(): Promise<Cm6> {
  if (!cm6Promise) {
    cm6Promise = (async () => {
      const [state, view, commands, language, langJson, lint, lezer] = await Promise.all([
        import('@codemirror/state'),
        import('@codemirror/view'),
        import('@codemirror/commands'),
        import('@codemirror/language'),
        import('@codemirror/lang-json'),
        import('@codemirror/lint'),
        import('@lezer/highlight'),
      ]);
      return { state, view, commands, language, langJson, lint, lezer };
    })();
  }
  return cm6Promise;
}

/** 预算测量用：当前是否已加载 CM6（不在业务逻辑里用）。 */
export function isCodeEditorLoaded(): boolean {
  return cm6Promise !== null;
}

/* -------------------------------------------------------------------------- */
/* 主题：全部走 CSS 变量，跟随 data-theme 自动切换                              */
/* -------------------------------------------------------------------------- */

function buildTheme(cm: Cm6) {
  const { EditorView } = cm.view;
  return EditorView.theme(
    {
      '&': {
        height: '100%',
        color: 'var(--text)',
        backgroundColor: 'var(--bg-input)',
        fontSize: '12.5px',
      },
      '&.cm-focused': { outline: 'none' },
      '.cm-scroller': {
        fontFamily: 'var(--font-mono)',
        lineHeight: '20px',
        overflow: 'auto',
      },
      '.cm-content': {
        fontFamily: 'var(--font-mono)',
        padding: '8px 0',
        caretColor: 'var(--accent)',
      },
      '.cm-line': { padding: '0 10px' },
      '.cm-gutters': {
        backgroundColor: 'var(--bg-panel-2)',
        color: 'var(--faint)',
        borderRight: '1px solid var(--border-subtle)',
      },
      '.cm-activeLine': { backgroundColor: 'var(--bg-hover)' },
      '.cm-activeLineGutter': { backgroundColor: 'var(--bg-hover)', color: 'var(--text-2)' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
      '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground':
        { backgroundColor: 'var(--accent-soft)' },
      '.cm-selectionMatch': { backgroundColor: 'var(--accent-soft)' },
      '.cm-matchingBracket, .cm-nonmatchingBracket': {
        backgroundColor: 'var(--bg-selected)',
        outline: '1px solid var(--border-strong)',
      },
      '.cm-lintRange-error': { textDecoration: 'underline wavy var(--danger, #ff7a85)' },
      '.cm-lint-marker-error': { content: 'none' },
      '.cm-tooltip': {
        backgroundColor: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        color: 'var(--text)',
        borderRadius: 'var(--radius-sm, 6px)',
      },
      '.cm-panels': { backgroundColor: 'var(--bg-panel)', color: 'var(--text)' },
    },
    { dark: true },
  );
}

function buildHighlight(cm: Cm6) {
  const { HighlightStyle, syntaxHighlighting } = cm.language;
  const { tags } = cm.lezer;
  const highlight = HighlightStyle.define([
    { tag: tags.propertyName, color: 'var(--syntax-key, #a9b8d8)' },
    { tag: tags.string, color: 'var(--syntax-string, #6fd3b5)' },
    { tag: tags.number, color: 'var(--syntax-number, #e3b778)' },
    { tag: tags.bool, color: 'var(--syntax-boolean, #b49cff)' },
    { tag: tags.null, color: 'var(--syntax-null, #7b8496)', fontStyle: 'italic' },
    { tag: tags.punctuation, color: 'var(--syntax-punct, #737c8e)' },
    { tag: tags.separator, color: 'var(--syntax-punct, #737c8e)' },
  ]);
  return syntaxHighlighting(highlight);
}

function diagAt(cm: Cm6, view: CmEditorView, d: CodeEditorDiagnostic): CmDiagnostic {
  const doc = view.state.doc;
  const lineNo = Math.min(Math.max(1, d.line ?? 1), doc.lines);
  const line = doc.line(lineNo);
  const offset = Math.min(Math.max(0, (d.column ?? 1) - 1), line.length);
  const pos = line.from + offset;
  void cm;
  return { from: pos, to: Math.min(doc.length, pos + 1), severity: 'error', message: d.message };
}

/* -------------------------------------------------------------------------- */
/* 挂载                                                                        */
/* -------------------------------------------------------------------------- */

export async function mountCodeEditor(
  host: HTMLElement,
  opts: CodeEditorOptions = {},
): Promise<CodeEditor> {
  const cm = await loadCm6();
  const { EditorState, Compartment } = cm.state;
  const { EditorView, keymap, lineNumbers, drawSelection } = cm.view;
  const { defaultKeymap, history, historyKeymap } = cm.commands;
  const { json, jsonParseLinter } = cm.langJson;
  const { linter, lintGutter, setDiagnostics } = cm.lint;

  const readOnlyCompartment = new Compartment();
  const parseLinter = jsonParseLinter();

  /** JSON lint：把 CM 的 Diagnostic 位置换算成 (line, column) 再回调给外层。 */
  const lintSource = (view: CmEditorView): CmDiagnostic[] => {
    const raw = parseLinter(view);
    const mapped: CodeEditorDiagnostic[] = raw.map((d) => {
      const line = view.state.doc.lineAt(d.from);
      return { message: d.message, line: line.number, column: d.from - line.from + 1 };
    });
    opts.onDiagnostics?.(mapped);
    return raw;
  };

  let silent = false;

  const state = EditorState.create({
    doc: '',
    extensions: [
      lineNumbers(),
      drawSelection(),
      history(),
      json(),
      lintGutter(),
      linter(lintSource, { delay: 150 }),
      buildHighlight(cm),
      readOnlyCompartment.of(EditorState.readOnly.of(false)),
      keymap.of([
        // 编辑器内先拦截：Cmd/Ctrl+Enter = Apply，Esc = 取消
        {
          key: 'Mod-Enter',
          run: () => {
            opts.onApplyShortcut?.();
            return true;
          },
        },
        {
          key: 'Escape',
          run: () => {
            opts.onEscape?.();
            return true;
          },
        },
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      EditorView.updateListener.of((update: ViewUpdate) => {
        if (update.docChanged && !silent) opts.onChange?.(update.state.doc.toString());
      }),
      buildTheme(cm),
    ],
  });

  const view = new EditorView({ state, parent: host });
  let destroyed = false;

  const api: CodeEditor = {
    setValue(text: string): void {
      if (destroyed) return;
      silent = true;
      try {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
      } finally {
        silent = false;
      }
    },
    getValue(): string {
      return destroyed ? '' : view.state.doc.toString();
    },
    setReadOnly(readOnly: boolean): void {
      if (destroyed) return;
      view.dispatch({
        effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(readOnly)),
      });
    },
    setDiagnostic(diagnostic: CodeEditorDiagnostic | null): void {
      if (destroyed) return;
      const diags = diagnostic ? [diagAt(cm, view, diagnostic)] : [];
      view.dispatch(setDiagnostics(view.state, diags));
    },
    focus(): void {
      if (!destroyed) view.focus();
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      view.destroy();
      host.textContent = '';
    },
  };

  return api;
}
