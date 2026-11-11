/**
 * view/panels/expression-bar — 表达式结果区常驻条（ADR-0018 §1 / §8）。
 *
 * 只负责 `#exprBar` 的显隐 / 文案 / 标记 / 两个动作按钮与关闭；**何时显示、count 从哪来、
 * 是否 stale 由 app 层决定**（与 notice-bar.ts 同一分工：本模块不碰协议、不发命令）。
 *
 * DOM 契约（冒烟依赖，不要改名）：
 *   #exprBar / #exprBarText / #exprBarBack / #exprBarRerun / #exprBarClose
 *   #exprBar[data-stale="1"] / #exprBar[data-truncated="1"]
 */
import { EXPR_COPY } from '../../shared/expression-copy';

export interface ExpressionBarView {
  rootId: string;
  count: number;
  ms: number;
  truncated: boolean;
  skipped: number;
  maxResult: number;
  stale: boolean;
}

export class ExpressionBar {
  readonly root: HTMLElement;
  private readonly textEl: HTMLElement;
  private readonly rerunBtn: HTMLButtonElement;
  private readonly backBtn: HTMLButtonElement;
  private readonly closeBtn: HTMLButtonElement;

  private backHandler: (() => void) | null = null;
  private rerunHandler: (() => void) | null = null;
  private closeHandler: (() => void) | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    const textEl = root.querySelector<HTMLElement>('#exprBarText');
    const rerunBtn = root.querySelector<HTMLButtonElement>('#exprBarRerun');
    const backBtn = root.querySelector<HTMLButtonElement>('#exprBarBack');
    const closeBtn = root.querySelector<HTMLButtonElement>('#exprBarClose');
    if (!textEl || !rerunBtn || !backBtn || !closeBtn) {
      throw new Error('expression-bar: 缺少 #exprBarText / #exprBarRerun / #exprBarBack / #exprBarClose');
    }
    this.textEl = textEl;
    this.rerunBtn = rerunBtn;
    this.backBtn = backBtn;
    this.closeBtn = closeBtn;

    this.backBtn.addEventListener('click', () => this.backHandler?.());
    this.rerunBtn.addEventListener('click', () => this.rerunHandler?.());
    this.closeBtn.addEventListener('click', () => {
      // 关闭只隐藏本条；业务要感知关闭再挂 onClose（结果根保留在 worker LRU）。
      this.hide();
      this.closeHandler?.();
    });
  }

  /**
   * 显示并渲染一帧。
   *
   * 文案 = `表达式结果 · expr:N · N 项 · X ms`，截断/跳过/过期都追加在同一行；
   * stale 时整条走警告色 + 显示「重新执行」（不自动重跑）。
   */
  show(view: ExpressionBarView): void {
    const parts: string[] = [
      EXPR_COPY.resultTitle(view.rootId),
      // ms 由 worker 计时（浮点）；展示口径与面板状态行一致，取整。
      EXPR_COPY.status(view.count, Math.round(view.ms)),
    ];
    if (view.truncated) parts.push(EXPR_COPY.truncated(view.maxResult));
    if (view.skipped > 0) parts.push(EXPR_COPY.skipped(view.skipped));
    if (view.stale) parts.push(EXPR_COPY.stale);

    const text = parts.join(' · ');
    this.textEl.textContent = text;
    this.textEl.title = text;

    if (view.stale) this.root.dataset.stale = '1';
    else delete this.root.dataset.stale;
    if (view.truncated) this.root.dataset.truncated = '1';
    else delete this.root.dataset.truncated;

    this.rerunBtn.hidden = !view.stale;
    this.backBtn.hidden = false;
    this.root.hidden = false;
  }

  hide(): void {
    this.root.hidden = true;
    this.textEl.textContent = '—';
    this.textEl.removeAttribute('title');
    delete this.root.dataset.stale;
    delete this.root.dataset.truncated;
    this.rerunBtn.hidden = true;
  }

  isVisible(): boolean {
    return !this.root.hidden;
  }

  /** 自报状态快照（dev hook / 冒烟断言用）。 */
  state(): {
    hidden: boolean;
    text: string;
    stale: boolean;
    truncated: boolean;
    rerunVisible: boolean;
    backVisible: boolean;
  } {
    return {
      hidden: this.root.hidden,
      text: this.textEl.textContent ?? '',
      stale: this.root.dataset.stale === '1',
      truncated: this.root.dataset.truncated === '1',
      rerunVisible: !this.rerunBtn.hidden,
      backVisible: !this.backBtn.hidden,
    };
  }

  onBack(handler: () => void): void {
    this.backHandler = handler;
  }

  onRerun(handler: () => void): void {
    this.rerunHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }
}
