/**
 * app/import/layer — 导入入口层的 **DOM adapter**（#47 / ADR-0008 修订 2026-11-19）。
 *
 * 与 `layer-state.ts` 的分工：
 *   - 状态机出 `LayerView`（文案是 key、错误是结构化对象）；本模块把 view 写成 DOM、
 *     管开合动效（入场 keyframes 由 CSS 自动播，出场 110ms 由这里挂 `.is-leaving`）、
 *     焦点（打开进卡片 / pending 进非破坏性按钮 / 关闭归还 `focusReturn`）。
 *   - 外部动作（真正的导入、满 8 的 toast、丢弃确认）由 app 通过 `ImportLayerActions` 注入：
 *     状态机只出意图，这里把意图翻成 app 动作。
 *
 * 事件：层**内部**的交互（关闭按钮 / 遮罩点击 / 落点 radio / 精简层两个按钮 /
 * 出场 animationend）在这里接线；层**外部**的入口（导入按钮 / file chip / ⌘O / 拖放 / 粘贴）
 * 仍归 app —— 它们还要管「初始空态直接导入」「拖放落点分流」等不属于层的东西。
 */
import type { MessageKey } from '../../i18n';
import type { Params } from '../../i18n/types';
import type { CoreError } from '../../protocol/errors';
import {
  ImportLayerState,
  LIMIT_HINT_KEY,
  WARN_AFTER_KEY,
  WARN_BEFORE_KEY,
  type ImportLayerMode,
  type ImportTarget,
  type LayerContext,
  type LayerHookState,
  type LayerView,
  type OpenResult,
  type PendingImport,
} from './layer-state';

/** 入口层要写的那批 DOM 节点（`page.html` 的 `#empty` 子树）。 */
export interface ImportLayerDom {
  root: HTMLElement;
  inner: HTMLElement;
  title: HTMLElement;
  sub: HTMLElement;
  warn: HTMLElement;
  hint: HTMLElement;
  target: HTMLElement;
  targetNewTab: HTMLInputElement;
  targetReplace: HTMLInputElement;
  close: HTMLButtonElement;
  pending: HTMLElement;
  pendingText: HTMLElement;
  pendingNewTab: HTMLButtonElement;
  pendingReplace: HTMLButtonElement;
  busy: HTMLElement;
  error: HTMLElement;
  pick: HTMLButtonElement;
  /** 关闭后归还焦点（工具栏「导入」按钮）。 */
  focusReturn: HTMLElement;
}

/** 只读环境：本地化、格式化、以及「打开层时取一次」的策略快照。 */
export interface ImportLayerEnv {
  t(key: MessageKey, params?: Params): string;
  formatBytes(bytes: number): string;
  formatError(error: unknown): string;
  /** 打开层时的环境快照（hasDoc / 默认落点 / canAddTab / maxTabs / 活动文档）。 */
  context(): LayerContext;
  /** 当前能否再加一个标签（层开着时可能变化：开关标签）。 */
  canAddTab(): boolean;
  maxTabs(): number;
}

/** 层向外要的 app 动作（状态机只出意图，由 app 执行副作用）。 */
export interface ImportLayerActions {
  /** 关闭前：丢弃在途导入回包（busy 时递增 loadSeq）。 */
  onBeforeClose(): void;
  /** 精简确认层选定落点后真正执行导入。 */
  onImport(payload: PendingImport, target: ImportTarget): void;
  /** 替换前确认「丢弃临时修改」；false = 用户取消。 */
  confirmDiscard(): boolean;
  /** 显式请求新标签但满 8（app 弹 toast）。 */
  onLimitDenied(): void;
}

export interface ImportLayerDeps {
  dom: ImportLayerDom;
  env: ImportLayerEnv;
  actions: ImportLayerActions;
}

/** 关闭动效时长：与 CSS `.empty.is-leaving` 的 `--dur-fast`（110ms）对齐。 */
const EXIT_MS = 110;

/**
 * 入口层 adapter：对外是语义命令（open / openNewTab / openPending / choose / close / hide…），
 * 对内持状态机 + DOM 写 + 动效 + 焦点。调用方不碰 `LayerView`，也不需要知道入场/出场时序。
 */
export class ImportLayer {
  private readonly state = new ImportLayerState();
  private readonly dom: ImportLayerDom;
  private readonly env: ImportLayerEnv;
  private readonly actions: ImportLayerActions;
  private exitTimer: number | null = null;

  constructor(deps: ImportLayerDeps) {
    this.dom = deps.dom;
    this.env = deps.env;
    this.actions = deps.actions;
    this.mount();
  }

  /* ------------------------------ 查询（app / dev-hook） ------------------------------ */

  isOpen(): boolean {
    return this.state.isOpen();
  }

  isBusy(): boolean {
    return this.state.isBusy();
  }

  mode(): ImportLayerMode {
    return this.state.mode();
  }

  /** dev-hook `layer` 快照（5 个字段，形状与历史 `window.__tjv` 逐字一致）。 */
  hookState(): LayerHookState {
    return this.state.state();
  }

  /* ------------------------------ 命令（app 入口） ------------------------------ */

  /**
   * 打开完整导入层（⌘O / 导入按钮 / 文件 chip）。返回是否真的打开。
   * 满 8 的显式拒绝与「丢弃临时修改」确认在这里翻成 app 动作后重试。
   */
  open(target?: ImportTarget): boolean {
    const ctx = this.env.context();
    const result = this.state.open(ctx, target);
    return this.applyOpenResult(result, ctx, target);
  }

  /** 「新标签」入口（标签条 `＋` / ⌘⇧O / 标签条空白拖放）。 */
  openNewTab(): void {
    const ctx = this.env.context();
    this.applyOpenResult(this.state.openNewTab(ctx), ctx, undefined);
  }

  /** 打开精简确认层（拖入文档正文 / 文档视图内 ⌘V；#47 #2）。 */
  openPending(entry: PendingImport): void {
    const ctx = this.env.context();
    this.applyOpenResult(this.state.openPending(ctx, entry), ctx, undefined);
  }

  /** 精简确认层里选定落点（两个按钮）：替换前过丢弃确认。 */
  choose(target: ImportTarget): void {
    const ctx = this.env.context();
    let result = this.state.choose(target, ctx);
    if (result.kind === 'needs-discard-confirm') {
      if (!this.actions.confirmDiscard()) return;
      result = this.state.choose(target, ctx, true);
    }
    if (result.kind === 'import') this.actions.onImport(result.payload, result.target);
  }

  /** 解析中：禁用层内输入与待确认按钮。 */
  setBusy(busy: boolean): void {
    this.render(this.state.setBusy(busy));
  }

  /** 结构化错误（按当前语言格式化；切语言重画即可）。 */
  setError(error: CoreError | null): void {
    this.render(this.state.setError(error));
  }

  /** 用户关闭（× / 遮罩 / Esc）：110ms 淡出后收尾，焦点归还工具栏。 */
  close(): void {
    if (!this.beginHide()) return;
    this.dom.focusReturn.focus();
  }

  /** 导入成功后隐藏：同样淡出，但不抢焦点（焦点交给新文档）。 */
  hide(): void {
    this.beginHide();
  }

  /** 回初始空态并显示（关掉最后一个标签时）。 */
  showInitial(): void {
    this.render(this.state.showInitial(this.env.context()));
    this.show();
  }

  /** 切语言：按同一份 view 重画（文案是 key，重画即完成本地化）。 */
  relabel(): void {
    if (this.state.isOpen()) this.render(this.state.view());
  }

  /* ------------------------------ 内部：打开结果 / 动效 ------------------------------ */

  private applyOpenResult(
    result: OpenResult,
    ctx: LayerContext,
    target: ImportTarget | undefined,
  ): boolean {
    switch (result.kind) {
      case 'denied-limit':
        this.actions.onLimitDenied();
        return false;
      case 'needs-discard-confirm':
        if (!this.actions.confirmDiscard()) return false;
        return this.applyOpenResult(this.state.open(ctx, target, true), ctx, target);
      case 'opened':
        this.render(result.view);
        this.show();
        this.focus(result.focus);
        return true;
      case 'noop':
        return false;
    }
  }

  /** 开始隐藏：状态立刻关闭，再走 110ms 淡出（reduce 下瞬切）。 */
  private beginHide(): boolean {
    if (!this.state.isOpen()) return false;
    this.state.close();
    this.actions.onBeforeClose();
    // 焦点先归还（`aria-hidden` / `inert` 之前）：reduce 分支同样要还
    if (this.dom.root.contains(document.activeElement)) {
      (document.activeElement as HTMLElement).blur();
    }
    if (this.reducedMotion()) {
      this.settle();
      return true;
    }
    this.dom.root.classList.add('is-leaving');
    this.dom.root.setAttribute('aria-hidden', 'true');
    // 淡出期间整层不可聚焦（`aria-hidden` 里有可聚焦元素是违规），收尾 / 撤销时摘掉
    this.dom.root.inert = true;
    this.exitTimer = window.setTimeout(() => this.settle(), EXIT_MS);
    return true;
  }

  /** 收尾：落 `is-hidden` 并按空态复位。 */
  private settle(): void {
    if (this.exitTimer !== null) {
      window.clearTimeout(this.exitTimer);
      this.exitTimer = null;
    }
    this.dom.root.classList.remove('is-leaving');
    this.dom.root.classList.add('is-hidden');
    this.dom.root.removeAttribute('aria-hidden');
    this.dom.root.inert = false;
    this.render(this.state.settle(this.env.context()));
  }

  /** 显示：撤掉进行中的退场再解除隐藏（入场 keyframes 自动重播）。 */
  private show(): void {
    if (this.exitTimer !== null) {
      window.clearTimeout(this.exitTimer);
      this.exitTimer = null;
    }
    if (this.dom.root.classList.contains('is-leaving')) {
      this.dom.root.classList.remove('is-leaving');
      this.dom.root.removeAttribute('aria-hidden');
      this.dom.root.inert = false;
    }
    this.dom.root.inert = false;
    this.dom.root.classList.remove('is-hidden');
    this.dom.root.removeAttribute('aria-hidden');
  }

  private reducedMotion(): boolean {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  private focus(focus: 'inner' | 'pendingNewTab' | 'pendingReplace' | null): void {
    if (focus === 'inner') this.dom.inner.focus();
    else if (focus === 'pendingNewTab') this.dom.pendingNewTab.focus();
    else if (focus === 'pendingReplace') this.dom.pendingReplace.focus();
  }

  /* ------------------------------ 内部：view → DOM ------------------------------ */

  /**
   * 把一份 `LayerView` 写成 DOM：文案（key → 当前语言）、可见性、禁用态、aria、待确认条目。
   * 只做机械映射，不判定策略——哪个形态该显示什么已经在 view 里。
   */
  private render(view: LayerView): void {
    const { dom, env } = this;
    dom.root.dataset.mode = view.mode;
    dom.title.textContent = env.t(view.titleKey);
    dom.sub.textContent = view.subKey ? env.t(view.subKey) : '';
    // 覆盖警示：前缀 / 活动文档 / 后缀三段渲染，文件名用 <b> 强调（direction.md 空态形态）
    if (view.warn) {
      const current = `${view.warn.name}（${env.formatBytes(view.warn.bytes)}）`;
      const strong = document.createElement('b');
      strong.textContent = current;
      dom.warn.replaceChildren(
        document.createTextNode(env.t(WARN_BEFORE_KEY)),
        strong,
        document.createTextNode(env.t(WARN_AFTER_KEY)),
      );
      dom.warn.hidden = false;
    } else {
      dom.warn.replaceChildren();
      dom.warn.hidden = true;
    }
    if (view.hint) {
      dom.hint.textContent = env.t(LIMIT_HINT_KEY, { n: view.hint.n });
      dom.hint.hidden = false;
    } else {
      dom.hint.textContent = '';
      dom.hint.hidden = true;
    }
    dom.target.hidden = view.target === null;
    dom.targetNewTab.checked = view.target === 'new-tab';
    dom.targetReplace.checked = view.target === 'replace';
    dom.close.hidden = !view.closeVisible;
    if (view.pending) {
      dom.pending.hidden = false;
      const nameEl = document.createElement('strong');
      nameEl.textContent = view.pending.name;
      nameEl.title = view.pending.name;
      const sizeEl = document.createElement('span');
      sizeEl.className = 'empty__pending-size';
      sizeEl.textContent = env.formatBytes(view.pending.size);
      dom.pendingText.replaceChildren(nameEl, sizeEl);
    } else {
      dom.pending.hidden = true;
      dom.pendingText.replaceChildren();
    }
    dom.busy.hidden = !view.busy;
    dom.root.classList.toggle('is-busy', view.busy);
    const canAdd = env.canAddTab();
    dom.pick.disabled = view.busy;
    dom.targetNewTab.disabled = view.busy;
    dom.targetReplace.disabled = view.busy;
    dom.pendingNewTab.disabled = view.busy || !canAdd;
    dom.pendingNewTab.title = dom.pendingNewTab.disabled
      ? env.t('app.tabs.limit', { n: env.maxTabs() })
      : '';
    dom.pendingReplace.disabled = view.busy;
    const message = view.error ? env.formatError(view.error) : '';
    dom.error.textContent = message;
    dom.error.hidden = !message;
    // 对话框语义只在 replace / new-tab / pending 三形态挂（initial = 普通空态）
    if (view.closeVisible) {
      dom.root.setAttribute('role', 'dialog');
      dom.root.setAttribute('aria-modal', 'true');
      dom.root.setAttribute('aria-labelledby', dom.title.id);
    } else {
      dom.root.removeAttribute('role');
      dom.root.removeAttribute('aria-modal');
      dom.root.removeAttribute('aria-labelledby');
    }
  }

  /* ------------------------------ 内部：层内交互接线 ------------------------------ */

  private mount(): void {
    const { dom } = this;
    dom.close.addEventListener('click', () => this.close());
    // 点遮罩（inner 之外）关闭：initial 形态不是对话框，不响应
    dom.root.addEventListener('click', (event: MouseEvent) => {
      if (event.target === dom.root && this.state.mode() !== 'initial') this.close();
    });
    // 落点 radio：只改本次形态，不写设置（ADR-0028 §1）
    dom.target.addEventListener('change', () => {
      const view = this.state.chooseTarget(
        dom.targetNewTab.checked ? 'new-tab' : 'replace',
        this.env.context(),
      );
      if (view) this.render(view);
    });
    dom.pendingNewTab.addEventListener('click', () => this.choose('new-tab'));
    dom.pendingReplace.addEventListener('click', () => this.choose('replace'));
    // 出场收尾：淡出播完立即落 is-hidden（计时器只是兜底：后台标签页节流 / animation: none）。
    // 只认出场自己的关键帧：入场 animationend 不能把刚挂上的 `.is-leaving` 收掉。
    dom.root.addEventListener('animationend', (event: AnimationEvent) => {
      if (event.target === dom.root && event.animationName === 'tjv-fade-out') this.settle();
    });
  }
}
