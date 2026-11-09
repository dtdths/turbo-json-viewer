/**
 * view/panels/notice-bar — 常驻提示条（32px warn 条）的公共 DOM 行为。
 *
 * code review 收口：体积提示条与保真提示条原先各自复制了一份「显隐 + 文案 + 关闭」逻辑与 CSS，
 * 这里抽成一个形状；**文案与显隐条件仍留在 app 层**（哪条提示什么时候出现是业务），
 * 本模块不碰协议、不发命令、不读 core。
 *
 * page.html 的约定标记：
 *   - `[data-notice-text]`   文案元素（必填）
 *   - `[data-notice-close]`  关闭按钮（必填；点击 = 只隐藏本条）
 *   - `[data-notice-action]` 动作按钮（可选，如「查看原文」）
 *
 * 图标、`role=status`、`aria-live` 由 HTML 静态声明，这里只管状态。
 */
export class NoticeBar {
  readonly root: HTMLElement;
  private readonly textEl: HTMLElement;
  private readonly actionEl: HTMLButtonElement | null;
  private closeHandler: (() => void) | null = null;
  private actionHandler: (() => void) | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    const textEl = root.querySelector<HTMLElement>('[data-notice-text]');
    const closeEl = root.querySelector<HTMLButtonElement>('[data-notice-close]');
    if (!textEl || !closeEl) {
      throw new Error('notice-bar: 缺少 [data-notice-text] / [data-notice-close]');
    }
    this.textEl = textEl;
    this.actionEl = root.querySelector<HTMLButtonElement>('[data-notice-action]');
    // 关闭只隐藏本条；业务要感知关闭再挂 onClose（本 slice 两条提示都不需要）
    closeEl.addEventListener('click', () => {
      this.hide();
      this.closeHandler?.();
    });
    this.actionEl?.addEventListener('click', () => this.actionHandler?.());
  }

  get hidden(): boolean {
    return this.root.hidden;
  }

  /** 当前文案（dev hook / 验收断言用）。 */
  text(): string {
    return this.textEl.textContent ?? '';
  }

  /** 显示并写文案；`title` 同步，单行省略时悬停可看全文。 */
  show(text: string): void {
    this.textEl.textContent = text;
    this.textEl.title = text;
    this.root.hidden = false;
  }

  /** 隐藏并清空文案（不让旧文案留在隐藏节点里被读到）。 */
  hide(): void {
    this.root.hidden = true;
    this.textEl.textContent = '—';
    this.textEl.removeAttribute('title');
  }

  /** 动作按钮的显隐（无动作按钮的条调用无副作用）。 */
  setActionVisible(visible: boolean): void {
    if (this.actionEl !== null) this.actionEl.hidden = !visible;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  onAction(handler: () => void): void {
    this.actionHandler = handler;
  }
}
