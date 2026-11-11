/**
 * view/panels/expression-editor — 表达式输入区（CM6 适配器，ADR-0018 §1）。
 *
 * 预算约束（docs/architecture/README.md §8 / ADR-0018 §1）：CM6 **不能进首屏**。
 * 因此下列包全部走动态 `import()`，esbuild 的 `splitting:true` 把它们拆成独立 chunk，
 * 只有第一次打开表达式面板时才加载：
 *   `state` / `view` / `commands` / `language` / `autocomplete` / `lint`
 * **不引** `@codemirror/lang-javascript`（引擎只支持一个受限子集，上色是本文件自写的轻量正则）。
 *
 * 分层：
 *   - 上色：`tokenizeExpr()`（纯函数）→ ViewPlugin + Decoration.mark（`.cm-expr-*` 颜色在 CSS）；
 *   - 补全：`autocompletion({ override: [source] })`，source 把 `ExprCompletion[]` 映射成 CM `Completion`；
 *   - 错误：引擎在 worker 侧算出行列，这里用 `@codemirror/lint` 的 `setDiagnostics` 画行内波浪线；
 *   - 键盘：Enter / Mod-Enter = 执行，Shift-Enter = 换行，Escape 交回外层，↑↓ 在文本边界派发
 *     `expr:history` DOM 事件（历史列表属于面板，见下方协议说明）。
 *
 * 内部协议（仅本适配器与 ExpressionPanel 之间）：
 *   光标在文档边界（空文档 / 首字符前 / 末字符后）按 ↑↓ 时，向 `view.dom` 派发可取消的
 *   `expr:history` CustomEvent（detail = { dir: -1 | 1 }）；面板在 `#exprEditor` 上监听并
 *   `preventDefault()` 表示已消费（切历史），否则照常交给 CM6 移动光标。
 */

import type {
  EditorView as CmEditorView,
  ViewUpdate as CmViewUpdate,
  DecorationSet as CmDecorationSet,
  Decoration as CmDecoration,
} from '@codemirror/view';
import type {
  Completion,
  CompletionContext,
  CompletionSource,
} from '@codemirror/autocomplete';
import type { Diagnostic as CmDiagnostic } from '@codemirror/lint';
import type { ExprCompletion } from '../../protocol/types';

export interface ExpressionEditorOptions {
  /** Enter / Mod-Enter */
  onRun: () => void;
  onTextChange?: (text: string) => void;
  complete: (text: string, pos: number) => Promise<ExprCompletion[]>;
  /** Escape（默认无操作；面板用它清错误） */
  onEscape?: () => void;
}

export interface ExpressionEditorError {
  message: string;
  line?: number;
  column?: number;
}

export interface ExpressionEditor {
  setText(text: string): void;
  getText(): string;
  setError(error: ExpressionEditorError | null): void;
  focus(): void;
  destroy(): void;
}

/* -------------------------------------------------------------------------- */
/* 懒加载：模块级单例 Promise（并发 mount 只加载一次）                          */
/* -------------------------------------------------------------------------- */

interface Cm6 {
  state: typeof import('@codemirror/state');
  view: typeof import('@codemirror/view');
  commands: typeof import('@codemirror/commands');
  language: typeof import('@codemirror/language');
  autocomplete: typeof import('@codemirror/autocomplete');
  lint: typeof import('@codemirror/lint');
}

let cm6Promise: Promise<Cm6> | null = null;

function loadCm6(): Promise<Cm6> {
  if (!cm6Promise) {
    cm6Promise = (async () => {
      const [state, view, commands, language, autocomplete, lint] = await Promise.all([
        import('@codemirror/state'),
        import('@codemirror/view'),
        import('@codemirror/commands'),
        import('@codemirror/language'),
        import('@codemirror/autocomplete'),
        import('@codemirror/lint'),
      ]);
      return { state, view, commands, language, autocomplete, lint };
    })();
  }
  return cm6Promise;
}

/** 预算测量用：CM6 是否已加载（不在业务逻辑里用）。 */
export function isExpressionEditorLoaded(): boolean {
  return cm6Promise !== null;
}

/* -------------------------------------------------------------------------- */
/* 轻量上色：正则扫描 → Decoration.mark（不引 lang-javascript）                  */
/* -------------------------------------------------------------------------- */

type ExprTokenKind = 'string' | 'number' | 'keyword' | 'comment';

interface ExprToken {
  from: number;
  to: number;
  kind: ExprTokenKind;
}

/**
 * 关键字集合只用于**上色**（白名单执行在 worker 侧 validate.ts）：
 * 列全 JS 关键字，让用户写错时仍能看清语法高亮。
 */
const KEYWORDS = new Set([
  'true',
  'false',
  'null',
  'undefined',
  'typeof',
  'in',
  'instanceof',
  'new',
  'delete',
  'void',
  'return',
  'function',
  'class',
  'async',
  'await',
  'yield',
  'let',
  'const',
  'var',
  'if',
  'else',
  'for',
  'while',
  'do',
  'switch',
  'case',
  'default',
  'break',
  'continue',
  'throw',
  'try',
  'catch',
  'finally',
  'this',
]);

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '9';
}

function isIdentStart(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z_$]/.test(ch);
}

function isIdentPart(ch: string | undefined): boolean {
  return ch !== undefined && /[\w$]/.test(ch);
}

/**
 * 把表达式文本切成可上色区间（从左到右、互不重叠，可直接喂 RangeSetBuilder）。
 * 覆盖：行注释 / 块注释 / 单双引号与模板字符串 / 数字 / 关键字。
 * 括号配对由 `bracketMatching()` 负责，不在这里处理。
 */
export function tokenizeExpr(text: string): ExprToken[] {
  const tokens: ExprToken[] = [];
  const n = text.length;
  let i = 0;

  while (i < n) {
    const ch = text[i];

    // 行注释：`// …`（到行尾）
    if (ch === '/' && text[i + 1] === '/') {
      let j = i + 2;
      while (j < n && text[j] !== '\n') j++;
      tokens.push({ from: i, to: j, kind: 'comment' });
      i = j;
      continue;
    }

    // 块注释：`/* … *​/`
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const j = end < 0 ? n : end + 2;
      tokens.push({ from: i, to: j, kind: 'comment' });
      i = j;
      continue;
    }

    // 字符串：单引号 / 双引号（不跨行）与模板串
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < n) {
        const c = text[j];
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (c === ch) {
          j += 1;
          break;
        }
        if (c === '\n' && ch !== '`') break;
        j++;
      }
      const to = Math.min(j, n);
      tokens.push({ from: i, to, kind: 'string' });
      i = to;
      continue;
    }

    // 数字（含小数 / 指数）
    if (isDigit(ch)) {
      let j = i + 1;
      while (j < n) {
        const c = text[j];
        if (isDigit(c) || c === '.') {
          j++;
          continue;
        }
        if (c === 'e' || c === 'E') {
          j++;
          if (text[j] === '+' || text[j] === '-') j++;
          continue;
        }
        break;
      }
      tokens.push({ from: i, to: j, kind: 'number' });
      i = j;
      continue;
    }

    // 标识符 / 关键字
    if (isIdentStart(ch)) {
      let j = i + 1;
      while (j < n && isIdentPart(text[j])) j++;
      const word = text.slice(i, j);
      if (KEYWORDS.has(word)) tokens.push({ from: i, to: j, kind: 'keyword' });
      i = j;
      continue;
    }

    i++;
  }

  return tokens;
}

function buildExprHighlighter(cm: Cm6) {
  const { Decoration, ViewPlugin } = cm.view;
  const { RangeSetBuilder } = cm.state;

  const marks: Record<ExprTokenKind, CmDecoration> = {
    string: Decoration.mark({ class: 'cm-expr-string' }),
    number: Decoration.mark({ class: 'cm-expr-number' }),
    keyword: Decoration.mark({ class: 'cm-expr-keyword' }),
    comment: Decoration.mark({ class: 'cm-expr-comment' }),
  };

  const build = (view: CmEditorView): CmDecorationSet => {
    const builder = new RangeSetBuilder<CmDecoration>();
    for (const token of tokenizeExpr(view.state.doc.toString())) {
      builder.add(token.from, token.to, marks[token.kind]);
    }
    return builder.finish();
  };

  return ViewPlugin.fromClass(
    class {
      decorations: CmDecorationSet;
      constructor(view: CmEditorView) {
        this.decorations = build(view);
      }
      update(update: CmViewUpdate): void {
        if (update.docChanged) this.decorations = build(update.view);
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}

/* -------------------------------------------------------------------------- */
/* 主题：全部走 CSS 变量（跟随 data-theme 深/亮自动切换）                       */
/* -------------------------------------------------------------------------- */

function buildTheme(cm: Cm6) {
  const { EditorView } = cm.view;
  return EditorView.theme(
    {
      '&': {
        height: '100%',
        color: 'var(--text)',
        backgroundColor: 'var(--bg-input)',
        fontSize: 'var(--text-caption)',
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
      '.cm-line': { padding: '0 8px' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
      '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground':
        { backgroundColor: 'var(--accent-soft)' },
      '.cm-selectionMatch': { backgroundColor: 'var(--accent-soft)' },
      '.cm-matchingBracket, .cm-nonmatchingBracket': {
        backgroundColor: 'var(--bg-selected)',
        outline: '1px solid var(--border-strong)',
      },
      '.cm-lintRange-error': { textDecoration: 'underline wavy var(--danger)' },
      '.cm-tooltip': {
        backgroundColor: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        color: 'var(--text)',
        borderRadius: 'var(--radius-sm)',
      },
      '.cm-tooltip-autocomplete': { overflow: 'hidden' },
      '.cm-tooltip-autocomplete > ul': {
        maxHeight: '168px',
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--text-caption)',
      },
      '.cm-tooltip-autocomplete > ul > li': { padding: '3px 8px' },
      '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
        backgroundColor: 'var(--bg-selected)',
        color: 'var(--text)',
      },
      '.cm-completionLabel': { color: 'var(--text)' },
      '.cm-completionDetail': { color: 'var(--faint)', fontStyle: 'normal', marginLeft: '8px' },
      '.cm-completionIcon': { color: 'var(--accent-text)' },
    },
    { dark: true },
  );
}

/* -------------------------------------------------------------------------- */
/* 行列 → CM6 诊断                                                             */
/* -------------------------------------------------------------------------- */

/**
 * 与 code-editor.ts 同口径：`from === to` 只出 gutter 标记、没有下划线，
 * 所以 EOF 时把范围左移一个码元；空文档退化为 `[0,0)`。
 */
function diagAt(view: CmEditorView, error: ExpressionEditorError): CmDiagnostic {
  const doc = view.state.doc;
  const lineNo = Math.min(Math.max(1, error.line ?? 1), doc.lines);
  const line = doc.line(lineNo);
  const offset = Math.min(Math.max(0, (error.column ?? 1) - 1), line.length);
  const pos = Math.min(line.from + offset, doc.length);
  const from = pos < doc.length ? pos : Math.max(0, doc.length - 1);
  const to = pos < doc.length ? pos + 1 : doc.length;
  return { from, to, severity: 'error', message: error.message };
}

/* -------------------------------------------------------------------------- */
/* 挂载                                                                        */
/* -------------------------------------------------------------------------- */

/** 面板 ↔ 适配器的历史键内部事件（见文件头「内部协议」）。 */
const HISTORY_EVENT = 'expr:history';

/** Completion.kind → CM6 Completion.type（内置图标集：property / method / variable / keyword）。 */
const COMPLETION_TYPE: Record<ExprCompletion['kind'], string> = {
  field: 'property',
  method: 'method',
  global: 'variable',
  keyword: 'keyword',
};

export async function mountExpressionEditor(
  host: HTMLElement,
  opts: ExpressionEditorOptions,
): Promise<ExpressionEditor> {
  const cm = await loadCm6();
  const { EditorState } = cm.state;
  const { EditorView, keymap, drawSelection } = cm.view;
  const { defaultKeymap, history, historyKeymap, insertNewlineAndIndent } = cm.commands;
  const { bracketMatching } = cm.language;
  const { autocompletion } = cm.autocomplete;
  const { linter, setDiagnostics } = cm.lint;

  // 占位（「编辑器加载中…」）由面板写在 host 里；CM 挂载前清掉，避免两层内容叠着。
  host.replaceChildren();
  host.dataset.exprEditor = 'ready';

  let silent = false;
  let destroyed = false;

  /* ---------------- 补全 source ---------------- */

  const completionSource: CompletionSource = async (context: CompletionContext) => {
    const text = context.state.doc.toString();
    const pos = Math.min(Math.max(0, context.pos), text.length);
    // 标识符起点：`foo.ba|` → from = `ba` 起点；`data.|` → 无标识符，from = pos。
    const word = context.matchBefore(/[\w$]+/);
    if (!word && !context.explicit) {
      // 只有 `.` 后自动弹补全；其它标点/空白不打扰（手动 Ctrl-Space 仍可唤起）。
      const before = pos > 0 ? text.slice(pos - 1, pos) : '';
      if (before !== '.') return null;
    }

    let items: ExprCompletion[];
    try {
      items = await opts.complete(text, pos);
    } catch {
      // 异步 source 必须容错：worker 错误/看门狗终止都不能冒泡到 CM6。
      return null;
    }
    if (destroyed || items.length === 0) return null;

    const options: Completion[] = items.map((item) => ({
      label: item.label,
      detail: item.detail,
      type: COMPLETION_TYPE[item.kind],
      apply: item.insertText ?? item.label,
    }));

    return { from: word ? word.from : pos, options, validFor: /^[\w$]*$/ };
  };

  /* ---------------- 键盘 ---------------- */

  const runEditor = (view: CmEditorView): boolean => {
    // 输入法组合中的 Enter 用于上屏，不当作执行。
    if (view.composing) return false;
    opts.onRun();
    return true;
  };

  /**
   * ↑↓：只在「输入为空或光标处于文本边界（文档首/尾）」时切历史，否则交回 CM6 移动光标。
   * 返回 true = 本次按键已被外层消费。
   */
  const moveHistory = (dir: -1 | 1) => (view: CmEditorView): boolean => {
    const sel = view.state.selection.main;
    if (!sel.empty) return false;
    const length = view.state.doc.length;
    const atBoundary = length === 0 || sel.head === 0 || sel.head === length;
    if (!atBoundary) return false;
    const event = new CustomEvent<{ dir: -1 | 1 }>(HISTORY_EVENT, {
      bubbles: true,
      cancelable: true,
      detail: { dir },
    });
    // dispatchEvent 返回 false = 面板调用了 preventDefault（已切历史）。
    if (view.dom.dispatchEvent(event)) return false;
    // 历史填充后光标放到末尾：上一/下一仍是「文本边界」，用户也可直接续写。
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    return true;
  };

  const escape = (): boolean => {
    if (!opts.onEscape) return false;
    opts.onEscape();
    return true;
  };

  /* ---------------- state / view ---------------- */

  const state = EditorState.create({
    doc: '',
    extensions: [
      EditorView.lineWrapping,
      drawSelection(),
      history(),
      bracketMatching(),
      buildExprHighlighter(cm),
      buildTheme(cm),
      autocompletion({ override: [completionSource] }),
      // lint 的「容器」：真正要显示的错误由 setError() 用 setDiagnostics 外部写入；
      // 这里用超长 delay 的空 source 保证 lintPlugin 存在且不会把外部诊断清掉。
      linter(() => [], { delay: 2_000_000_000 }),
      EditorView.contentAttributes.of({
        'aria-label': '表达式输入',
        spellcheck: 'false',
        autocapitalize: 'off',
        autocorrect: 'off',
      }),
      keymap.of([
        { key: 'Enter', run: runEditor },
        { key: 'Mod-Enter', run: runEditor },
        { key: 'Shift-Enter', run: insertNewlineAndIndent },
        { key: 'Escape', run: escape },
        { key: 'ArrowUp', run: moveHistory(-1) },
        { key: 'ArrowDown', run: moveHistory(1) },
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      EditorView.updateListener.of((update: CmViewUpdate) => {
        if (update.docChanged && !silent) opts.onTextChange?.(update.state.doc.toString());
      }),
    ],
  });

  const view = new EditorView({ state, parent: host });

  const api: ExpressionEditor = {
    setText(text: string): void {
      if (destroyed) return;
      silent = true;
      try {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
      } finally {
        silent = false;
      }
    },
    getText(): string {
      return destroyed ? '' : view.state.doc.toString();
    },
    setError(error: ExpressionEditorError | null): void {
      if (destroyed) return;
      const diagnostics = error ? [diagAt(view, error)] : [];
      view.dispatch(setDiagnostics(view.state, diagnostics));
    },
    focus(): void {
      if (!destroyed) view.focus();
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      view.destroy();
      host.replaceChildren();
      delete host.dataset.exprEditor;
    },
  };

  return api;
}
