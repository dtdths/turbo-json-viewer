/**
 * view/panels/expression-panel — 表达式左面板（#27 / ADR-0018 §1、§8）。
 *
 * 职责边界：
 *   - 自建 DOM；page.html 只留 `<div class="panel panel--expression" id="expressionPanel">` 挂载点。
 *   - 只回调、不发命令、不 import core / 协议实现；输入区 CM6 走 `expression-editor.ts` 懒加载。
 *   - 文案全部来自 `shared/expression-copy.ts`（中文单一来源），这里不重复造字。
 *
 * DOM 契约（冒烟脚本依赖，不要改名）：
 *   #exprEditor / #exprRun / #exprStrict / #exprStatus / #exprError
 *   #exprExamples（.expr-example[data-example-index]）
 *   #exprHistory（.expr-history-item[data-history-index]）
 *
 * 键盘（ADR-0018 §1 / #12 §2）：
 *   - Enter / Mod-Enter = 执行，Shift-Enter = 换行（编辑器 keymap）；
 *   - ↑↓ 在输入为空或光标处于文本边界时切历史（编辑器派发 `expr:history` 内部事件，
 *     见 expression-editor.ts 头部「内部协议」；其余情况交给 CM6 正常移动光标）；
 *   - Escape 清行内错误。
 */
import { mountExpressionEditor, type ExpressionEditor } from './expression-editor';
import { EXPR_COPY } from '../../shared/expression-copy';
import { EXPR_HISTORY_MAX } from '../../protocol/versions';
import type { ExprCompletion } from '../../protocol/types';

export interface ExpressionPanelOptions {
  onRun: (text: string, strict: boolean) => void;
  onComplete: (text: string, pos: number) => Promise<ExprCompletion[]>;
  onTextChange?: (text: string) => void;
  onStrictChange?: (strict: boolean) => void;
}

export interface ExpressionPanelState {
  text: string;
  strict: boolean;
  running: boolean;
  status: string;
  error: string | null;
  examples: string[];
  history: string[];
}

/** 面板 ↔ 编辑器之间切换历史的内部 DOM 事件（expression-editor.ts 派发）。 */
const HISTORY_EVENT = 'expr:history';

interface ExpressionError {
  message: string;
  line?: number;
  column?: number;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

/** `（第 L 行第 C 列）` 后缀；message 里已含行列时不再重复拼（app 可能传 exprErrorText 结果）。 */
function formatErrorLocation(error: ExpressionError): string {
  if (error.line === undefined) return '';
  if (/（第 \d+ 行/.test(error.message)) return '';
  if (error.column === undefined) return `（第 ${error.line} 行）`;
  return `（第 ${error.line} 行第 ${error.column} 列）`;
}

export class ExpressionPanel {
  private readonly host: HTMLElement;
  private readonly opts: ExpressionPanelOptions;

  private mounted = false;
  private editor: ExpressionEditor | null = null;
  private editorPromise: Promise<void> | null = null;
  private focusPending = false;

  private text = '';
  private strict = false;
  private running = false;
  private statusText = '';
  private errorState: ExpressionError | null = null;
  private errorText = '';
  private examples: string[] = [];
  private history: string[] = [];

  /** 历史导航指针：-1 = 不在历史里（当前是草稿）；0 = 最新一条。 */
  private historyIndex = -1;
  private historyDraft: string | null = null;

  private editorHost: HTMLElement | null = null;
  private runBtn: HTMLButtonElement | null = null;
  private strictInput: HTMLInputElement | null = null;
  private statusEl: HTMLElement | null = null;
  private errorEl: HTMLElement | null = null;
  private examplesEl: HTMLElement | null = null;
  private historyEl: HTMLElement | null = null;

  constructor(host: HTMLElement, opts: ExpressionPanelOptions) {
    this.host = host;
    this.opts = opts;
  }

  /* ------------------------------------------------------------------ */
  /* 生命周期                                                            */
  /* ------------------------------------------------------------------ */

  /** 首次显示面板时调用；幂等（DOM 只建一次，CM6 只加载一次）。 */
  async mount(): Promise<void> {
    if (!this.mounted) this.buildUi();
    if (this.editor || this.editorPromise) {
      await this.editorPromise;
      return;
    }
    this.editorPromise = this.createEditor();
    await this.editorPromise;
  }

  focus(): void {
    if (this.editor) {
      this.editor.focus();
      return;
    }
    this.focusPending = true;
    void this.mount().then(() => {
      if (this.focusPending && this.editor) {
        this.focusPending = false;
        this.editor.focus();
      }
    });
  }

  destroy(): void {
    this.mounted = false;
    this.editor?.destroy();
    this.editor = null;
    this.editorPromise = null;
    this.editorHost?.removeEventListener(HISTORY_EVENT, this.handleHistoryEvent);
    this.host.replaceChildren();
    this.editorHost = null;
    this.runBtn = null;
    this.strictInput = null;
    this.statusEl = null;
    this.errorEl = null;
    this.examplesEl = null;
    this.historyEl = null;
  }

  /* ------------------------------------------------------------------ */
  /* 文本 / 严格模式                                                     */
  /* ------------------------------------------------------------------ */

  getText(): string {
    return this.editor ? this.editor.getText() : this.text;
  }

  setText(text: string): void {
    this.historyIndex = -1;
    this.historyDraft = null;
    this.applyText(text);
  }

  getStrict(): boolean {
    return this.strict;
  }

  setStrict(strict: boolean): void {
    this.strict = strict;
    if (this.strictInput) this.strictInput.checked = strict;
  }

  /* ------------------------------------------------------------------ */
  /* 运行态 / 状态行 / 错误                                               */
  /* ------------------------------------------------------------------ */

  setRunning(running: boolean): void {
    this.running = running;
    if (this.runBtn) {
      this.runBtn.disabled = running;
      if (running) this.runBtn.setAttribute('aria-busy', 'true');
      else this.runBtn.removeAttribute('aria-busy');
      this.runBtn.textContent = running ? EXPR_COPY.running : EXPR_COPY.run;
    }
    if (running) this.setStatus(EXPR_COPY.running);
    else if (this.statusText === EXPR_COPY.running) this.setStatus('');
  }

  setStatus(text: string): void {
    this.statusText = text;
    if (!this.statusEl) return;
    this.statusEl.textContent = text;
    this.statusEl.hidden = text === '';
  }

  setError(error: ExpressionError | null): void {
    this.errorState = error;
    this.errorText = error ? `${error.message}${formatErrorLocation(error)}` : '';
    this.renderError();
    this.editor?.setError(error);
  }

  setExamples(examples: string[]): void {
    this.examples = examples.filter((text) => text.trim() !== '');
    this.renderExamples();
  }

  addHistory(text: string): void {
    const value = text.trim();
    if (value === '') return;
    if (this.history[0] !== undefined && this.history[0].trim() === value) return;
    this.history.unshift(text);
    if (this.history.length > EXPR_HISTORY_MAX) this.history.length = EXPR_HISTORY_MAX;
    this.historyIndex = -1;
    this.historyDraft = null;
    this.renderHistory();
  }

  setHistory(history: string[]): void {
    this.history = history.filter((text) => text.trim() !== '').slice(0, EXPR_HISTORY_MAX);
    this.historyIndex = -1;
    this.historyDraft = null;
    this.renderHistory();
  }

  state(): ExpressionPanelState {
    return {
      text: this.getText(),
      strict: this.strict,
      running: this.running,
      status: this.statusEl?.textContent ?? this.statusText,
      error: this.errorText === '' ? null : this.errorText,
      examples: [...this.examples],
      history: [...this.history],
    };
  }

  /* ------------------------------------------------------------------ */
  /* DOM                                                                 */
  /* ------------------------------------------------------------------ */

  private buildUi(): void {
    this.mounted = true;
    this.host.classList.add('panel', 'panel--expression');
    if (!this.host.hasAttribute('aria-label')) this.host.setAttribute('aria-label', '表达式面板');

    /* ---- 输入区：CM6 懒加载；加载前显示占位 ---- */
    const editorHost = el('div', 'expr__editor');
    editorHost.id = 'exprEditor';
    const placeholder = el('div', 'expr__placeholder');
    placeholder.textContent = '编辑器加载中…';
    editorHost.appendChild(placeholder);
    this.editorHost = editorHost;

    /* ---- 操作行：执行 / 严格模式 / 状态 ---- */
    const ops = el('div', 'expr__ops');

    const runBtn = el('button', 'btn btn--primary expr__run');
    runBtn.id = 'exprRun';
    runBtn.type = 'button';
    runBtn.textContent = EXPR_COPY.run;
    runBtn.title = '执行表达式（Enter）';
    runBtn.addEventListener('click', () => this.opts.onRun(this.getText(), this.strict));
    this.runBtn = runBtn;

    const strictLabel = el('label', 'expr__strict');
    const strictInput = el('input', 'expr__checkbox');
    strictInput.id = 'exprStrict';
    strictInput.type = 'checkbox';
    strictInput.checked = this.strict;
    strictInput.addEventListener('change', () => {
      this.strict = strictInput.checked;
      this.opts.onStrictChange?.(this.strict);
    });
    this.strictInput = strictInput;
    const strictText = el('span');
    strictText.textContent = EXPR_COPY.strict;
    strictLabel.append(strictInput, strictText);

    const statusEl = el('span', 'expr__status');
    statusEl.id = 'exprStatus';
    statusEl.setAttribute('role', 'status');
    statusEl.setAttribute('aria-live', 'polite');
    statusEl.textContent = this.statusText;
    statusEl.hidden = this.statusText === '';
    this.statusEl = statusEl;

    ops.append(runBtn, strictLabel, statusEl);

    /* ---- 行内错误（role=alert；默认 hidden） ---- */
    const errorEl = el('div', 'expr__error');
    errorEl.id = 'exprError';
    errorEl.setAttribute('role', 'alert');
    errorEl.hidden = true;
    this.errorEl = errorEl;

    /* ---- 示例 / 历史（可滚动区） ---- */
    const lists = el('div', 'expr__lists');
    const examplesEl = el('div', 'expr__section');
    examplesEl.id = 'exprExamples';
    const historyEl = el('div', 'expr__section');
    historyEl.id = 'exprHistory';
    this.examplesEl = examplesEl;
    this.historyEl = historyEl;
    lists.append(examplesEl, historyEl);

    this.host.append(editorHost, ops, errorEl, lists);

    // 历史键：编辑器在文本边界派发可取消事件，这里消费（见 expression-editor.ts 内部协议）
    editorHost.addEventListener(HISTORY_EVENT, this.handleHistoryEvent);

    this.renderError();
    this.renderExamples();
    this.renderHistory();
  }

  private renderError(): void {
    if (!this.errorEl) return;
    if (this.errorText === '') {
      this.errorEl.hidden = true;
      this.errorEl.textContent = '';
      return;
    }
    this.errorEl.textContent = this.errorText;
    this.errorEl.hidden = false;
  }

  private renderExamples(): void {
    if (!this.examplesEl) return;
    if (this.examples.length === 0) {
      this.examplesEl.hidden = true;
      return;
    }
    const title = el('div', 'expr__section-title');
    title.textContent = EXPR_COPY.examplesTitle;
    const buttons: HTMLElement[] = [title];
    this.examples.forEach((text, index) => {
      const button = el('button', 'expr-example');
      button.type = 'button';
      button.dataset.exampleIndex = String(index);
      button.textContent = text;
      button.title = text;
      button.addEventListener('click', () => this.applySnippet(text));
      buttons.push(button);
    });
    this.examplesEl.replaceChildren(...buttons);
    this.examplesEl.hidden = false;
  }

  private renderHistory(): void {
    if (!this.historyEl) return;
    if (this.history.length === 0) {
      this.historyEl.hidden = true;
      return;
    }
    const title = el('div', 'expr__section-title');
    title.textContent = EXPR_COPY.historyTitle;
    const buttons: HTMLElement[] = [title];
    this.history.forEach((text, index) => {
      const button = el('button', 'expr-history-item');
      button.type = 'button';
      button.dataset.historyIndex = String(index);
      button.textContent = text;
      button.title = text;
      button.addEventListener('click', () => this.applySnippet(text));
      buttons.push(button);
    });
    this.historyEl.replaceChildren(...buttons);
    this.historyEl.hidden = false;
  }

  /* ------------------------------------------------------------------ */
  /* 内部                                                                */
  /* ------------------------------------------------------------------ */

  private async createEditor(): Promise<void> {
    const host = this.editorHost;
    if (!host) return;
    let editor: ExpressionEditor;
    try {
      editor = await mountExpressionEditor(host, {
        onRun: () => this.opts.onRun(this.getText(), this.strict),
        onTextChange: (text) => {
          this.text = text;
          this.historyIndex = -1;
          this.historyDraft = null;
          this.opts.onTextChange?.(text);
        },
        complete: (text, pos) => this.opts.onComplete(text, pos),
        // Escape 只清行内错误；没有错误时留给编辑器（无操作）。
        onEscape: () => {
          if (this.errorState) this.setError(null);
        },
      });
    } catch {
      // CM6 加载失败不该让面板抛未处理 rejection：占位改成可读文案，下次 mount 再重试。
      this.editorPromise = null;
      host.replaceChildren();
      const failed = el('div', 'expr__placeholder');
      failed.textContent = '编辑器加载失败，请重试';
      host.appendChild(failed);
      return;
    }

    if (!this.mounted) {
      editor.destroy();
      return;
    }

    this.editor = editor;
    editor.setText(this.text);
    if (this.errorState) editor.setError(this.errorState);
    if (this.focusPending) {
      this.focusPending = false;
      editor.focus();
    }
  }

  /** 写文本但不碰历史指针（历史导航内部用；外部 setText 会复位指针）。 */
  private applyText(text: string): void {
    this.text = text;
    if (this.editor) this.editor.setText(text);
  }

  /** 示例 / 历史项点击：填入编辑器并聚焦。 */
  private applySnippet(text: string): void {
    this.setText(text);
    this.focus();
  }

  private readonly handleHistoryEvent = (event: Event): void => {
    const detail = (event as CustomEvent<{ dir?: number }>).detail;
    const dir = detail?.dir;
    if (dir !== -1 && dir !== 1) return;
    if (this.moveHistory(dir)) event.preventDefault();
  };

  /**
   * ↑↓ 切历史：仅当输入为空或光标在文本边界时由编辑器派发事件（见内部协议）。
   * 返回 true = 本次按键已消费。到最旧/最新后继续按不环绕，只消费不动作。
   */
  private moveHistory(dir: -1 | 1): boolean {
    const history = this.history;
    if (history.length === 0) return false;

    if (dir < 0) {
      if (this.historyIndex === -1) this.historyDraft = this.getText();
      const next = this.historyIndex + 1;
      if (next >= history.length) return true;
      this.historyIndex = next;
      this.applyText(history[next]);
      return true;
    }

    if (this.historyIndex === -1) return false;
    const next = this.historyIndex - 1;
    if (next < 0) {
      this.historyIndex = -1;
      const draft = this.historyDraft ?? '';
      this.historyDraft = null;
      this.applyText(draft);
      return true;
    }
    this.historyIndex = next;
    this.applyText(history[next]);
    return true;
  }
}
