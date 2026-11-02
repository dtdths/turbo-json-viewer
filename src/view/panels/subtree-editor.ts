/**
 * view/panels/subtree-editor — 子树 JSON 编辑弹层（slice 5 / ADR-0006 / edit-spec §2）。
 *
 * 边界：本模块只管 DOM 与交互，**不解析 JSON**（parse 由 app/core 负责，错误经 setError 回显）；
 * 编辑器通过 S5 适配器 mountCodeEditor 挂载（CM6 懒加载，本模块不直接 import CM6）。
 *
 * 打开：填路径/类型/大小 → 挂编辑器 → focus。
 * Apply：Cmd/Ctrl+Enter 或按钮 → `await onApply(getValue())`（成功由 app 调 close()）。
 * 取消：Esc / 取消按钮 / × / 点遮罩 → onClose()。
 */
import { mountCodeEditor, type CodeEditor, type CodeEditorDiagnostic } from './code-editor';

export interface SubtreeEditorRequest {
  path: string;
  kind: string;
  bytes: number;
  text: string;
  readOnly: boolean;
}

export interface SubtreeEditorOptions {
  /** 弹层根节点（`#editModal`）。 */
  modal: HTMLElement;
  /** app 负责调 core.replaceNode；抛错由 app 调 setError（本模块也会兜底显示）。 */
  onApply: (text: string) => Promise<void>;
  /** Esc / 取消 / × / 点遮罩。 */
  onClose: () => void;
  /** 「恢复当前值」= 回到打开时文本（app 可只记日志）。 */
  onRestore: () => void;
}

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`subtree-editor: missing #${id}`);
  return el as T;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDiagnostic(d: CodeEditorDiagnostic): string {
  const at = d.line ? `（第 ${d.line} 行${d.column ? ` 第 ${d.column} 列` : ''}）` : '';
  return `${d.message}${at}`;
}

export class SubtreeEditor {
  private readonly opts: SubtreeEditorOptions;
  private readonly modal: HTMLElement;
  private readonly editTitle: HTMLElement;
  private readonly editKind: HTMLElement;
  private readonly editSize: HTMLElement;
  private readonly editPath: HTMLElement;
  private readonly editHost: HTMLElement;
  private readonly editError: HTMLElement;
  private readonly editRestore: HTMLButtonElement;
  private readonly editCancel: HTMLButtonElement;
  private readonly editApply: HTMLButtonElement;

  private editor: CodeEditor | null = null;
  private editorPromise: Promise<CodeEditor> | null = null;

  private request: SubtreeEditorRequest | null = null;
  private openSeq = 0;
  private busy = false;
  private readOnly = false;
  private hasLintError = false;
  private serverError: { message: string; line?: number; column?: number } | null = null;
  /** JSON lint 的最新错误（用户一改就会被重新计算）。 */
  private lintMessage: string | null = null;
  /** 只读原因（>5 MB）——与 lint 错误分开存，否则合法 JSON 的 lint 空结果会把它清掉。 */
  private limitHint: string | null = null;
  private previousFocus: HTMLElement | null = null;

  constructor(opts: SubtreeEditorOptions) {
    this.opts = opts;
    this.modal = opts.modal;
    this.editTitle = byId('editTitle');
    this.editKind = byId('editKind');
    this.editSize = byId('editSize');
    this.editPath = byId('editPath');
    this.editHost = byId('editHost');
    this.editError = byId('editError');
    this.editRestore = byId<HTMLButtonElement>('editRestore');
    this.editCancel = byId<HTMLButtonElement>('editCancel');
    this.editApply = byId<HTMLButtonElement>('editApply');

    this.editCancel.addEventListener('click', () => this.close());
    this.editApply.addEventListener('click', () => {
      void this.apply();
    });
    this.editRestore.addEventListener('click', () => this.restore());

    // 点遮罩 / ×（[data-close]）取消
    this.modal.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (target.closest('[data-close]')) {
        this.close();
        return;
      }
      if (target.classList.contains('modal__backdrop')) this.close();
    });

    // 焦点在按钮上时 Esc 也能取消（编辑器内的 Esc 由 CM6 keymap 处理；close() 幂等）
    this.modal.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.close();
      }
    });
  }

  async open(req: SubtreeEditorRequest): Promise<void> {
    this.request = req;
    this.readOnly = req.readOnly;
    this.busy = false;
    this.hasLintError = false;
    this.serverError = null;
    this.lintMessage = null;
    this.limitHint = req.readOnly ? '该子树超过 5 MB，已只读；请选择更小的子树' : null;

    this.editPath.textContent = req.path || '$';
    this.editPath.title = req.path || '$';
    this.editKind.textContent = req.kind || '—';
    this.editSize.textContent = formatBytes(req.bytes);
    this.editTitle.textContent = '编辑节点 JSON';

    if (this.modal.hidden) {
      this.previousFocus =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      this.modal.hidden = false;
    }
    this.renderError();
    this.applyGating();

    const seq = ++this.openSeq;
    const editor = await this.ensureEditor();
    if (seq !== this.openSeq || !this.isOpen()) return;

    editor.setReadOnly(req.readOnly);
    editor.setValue(req.text);
    editor.setDiagnostic(null);
    this.renderError();
    this.applyGating();
    editor.focus();
  }

  /**
   * 关闭（Esc / 取消 / × / 遮罩，以及 app 在 onApply 成功后的调用）。
   *
   * 注意：**不能被 `busy` 阻塞**——app 的成功路径在 `await onApply(text)` 内部就调 close()，
   * 此刻 apply() 还把 busy 置为 true；早期版本在这里 early-return 会让「Apply 成功后弹层不关」。
   * 关闭时顺手复位 busy，保证下次打开状态干净。
   */
  close(): void {
    if (this.modal.hidden) return;
    this.openSeq += 1;
    this.busy = false;
    this.editApply.textContent = 'Apply';
    this.modal.hidden = true;
    this.editor?.setDiagnostic(null);
    const previous = this.previousFocus;
    this.previousFocus = null;
    if (previous && previous.isConnected) previous.focus();
    this.applyGating();
    this.opts.onClose();
  }

  setError(err: { message: string; line?: number; column?: number } | null): void {
    this.serverError = err;
    if (err) this.editor?.setDiagnostic(err);
    else this.editor?.setDiagnostic(null);
    this.renderError();
    this.applyGating();
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    this.editApply.textContent = busy ? 'Applying…' : 'Apply';
    this.applyGating();
  }

  isOpen(): boolean {
    return !this.modal.hidden;
  }

  /** 当前编辑器文本（供 smoke 脚本 / 「恢复当前值」共用）。 */
  getValue(): string {
    return this.editor?.getValue() ?? this.request?.text ?? '';
  }

  /** 覆盖编辑器文本（「恢复当前值」内部也走它）。 */
  setValue(text: string): void {
    this.serverError = null;
    this.lintMessage = null;
    this.hasLintError = false;
    this.editor?.setValue(text);
    this.editor?.setDiagnostic(null);
    this.renderError();
    this.applyGating();
  }

  /* ------------------------------- internals ------------------------------ */

  private async ensureEditor(): Promise<CodeEditor> {
    if (this.editor) return this.editor;
    if (!this.editorPromise) {
      this.editorPromise = mountCodeEditor(this.editHost, {
        onChange: () => {
          // 用户改动后：清掉服务端错误与旧 lint 文案（lint 会在 ~150ms 内重新报）
          this.serverError = null;
          this.lintMessage = null;
          this.renderError();
          this.applyGating();
        },
        onDiagnostics: (diags) => {
          this.hasLintError = diags.length > 0;
          const first = diags[0];
          this.lintMessage = first ? formatDiagnostic(first) : null;
          this.renderError();
          this.applyGating();
        },
        onApplyShortcut: () => {
          void this.apply();
        },
        onEscape: () => this.close(),
      });
    }
    this.editor = await this.editorPromise;
    return this.editor;
  }

  private restore(): void {
    const req = this.request;
    if (!req) return;
    this.setValue(req.text);
    this.opts.onRestore();
    this.editor?.focus();
  }

  private async apply(): Promise<void> {
    if (this.editApply.disabled || this.busy) return;
    const text = this.getValue();
    this.setBusy(true);
    try {
      await this.opts.onApply(text);
    } catch (err) {
      this.setError({ message: err instanceof Error ? err.message : String(err) });
    } finally {
      this.setBusy(false);
    }
  }

  private applyGating(): void {
    const blocked = !this.isOpen() || this.busy || this.readOnly || this.hasLintError;
    this.editApply.disabled = blocked;
    this.editCancel.disabled = this.busy;
    this.editRestore.disabled = this.busy || this.readOnly;
  }

  private renderError(): void {
    const text =
      (this.serverError ? formatDiagnostic(this.serverError) : null) ??
      this.lintMessage ??
      this.limitHint ??
      '';
    if (!text) {
      this.editError.hidden = true;
      this.editError.textContent = '';
      return;
    }
    this.editError.hidden = false;
    this.editError.textContent = text;
  }
}
