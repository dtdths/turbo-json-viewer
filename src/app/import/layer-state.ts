/**
 * app/import/layer-state — 导入入口层的**纯状态机**（#47 / ADR-0008 修订 2026-11-19）。
 *
 * 为什么单独成 module：入口层的四种形态（initial / replace / new-tab / pending）背后是
 * 「设置默认落点 → 满 8 自动降为替换 → 丢弃编辑确认 → pending 两个落点」这套策略，
 * 原来和 DOM 写在一起（`main.ts` 的 `openImportLayer` / `applyImportLayerMode` /
 * `renderPendingText`），只能靠 17 套真机冒烟回归。拆出来后策略是纯函数：
 *
 *   - **零 DOM、零 i18n**：只出 `LayerView`（文案是 key，不是字符串），渲染由
 *     `app/import/layer.ts` 的 adapter 负责；切语言 = adapter 拿同一份 view 重画。
 *   - **副作用出栈**：满 8 的显式拒绝、替换前的「丢弃编辑」确认都作为 `OpenResult` /
 *     `ChooseResult` 返回，由 app 执行（`showToast` / `window.confirm`），本模块不调。
 *   - **待确认载荷归本模块**：`pendingImport` 是「待确认的导入」这个概念的一部分，
 *     不放在 app 的会话态里（否则会出现第二个「哪份 pending」真相源）。
 *
 * 生命周期：`open*` 置 open=true → `close()` 立刻把 open 置 false（淡出期间按已关闭处理）
 * → `settle()` 收尾复位成 initial。状态机不关心 110ms 动效，只看这两个时点。
 */
import type { MessageKey } from '../../i18n';
import type { CoreError } from '../../protocol/errors';

/** 入口层四形态（#18 / ADR-0009 §5；#47 #1/#2）。 */
export type ImportLayerMode = 'initial' | 'replace' | 'new-tab' | 'pending';

/** 导入落点（ADR-0028）：一次导入落到新标签还是替换当前文档。 */
export type ImportTarget = 'replace' | 'new-tab';

/** 精简确认层的待导入载荷（#47 #2）：拖入的文件或粘贴的文本。 */
export type PendingImport =
  | { kind: 'file'; file: File }
  | { kind: 'text'; text: string; name: string };

/** 渲染一份 `LayerView` 需要的环境快照（打开层时取一次；策略不读外部状态）。 */
export interface LayerContext {
  /** 当前是否已有文档（空工作区 = initial 形态）。 */
  hasDoc: boolean;
  /** 设置项 `importTarget`「导入位置」（ADR-0028 §1）。 */
  importTarget: ImportTarget;
  /** 标签条是否还能再加一个（软上限 8；空工作区恒 true）。 */
  canAddTab: boolean;
  /** 标签软上限（满 8 提示文案用）。 */
  maxTabs: number;
  /** 活动文档（替换层的覆盖警示用）。 */
  currentDoc: { name: string; bytes: number } | null;
}

/** 声明式视图：adapter 照着画，不含 DOM、不含已格式化文案。 */
export interface LayerView {
  mode: ImportLayerMode;
  titleKey: MessageKey;
  subKey: MessageKey | null;
  /** 覆盖警示（只有 replace 形态）；null = 隐藏。 */
  warn: { name: string; bytes: number } | null;
  /** 「标签已满、本次自动降为替换」说明（#47 #1.4）；null = 隐藏。 */
  hint: { n: number } | null;
  /** 落点控件选中项；null = 整行隐藏（initial / pending）。 */
  target: ImportTarget | null;
  closeVisible: boolean;
  pending: { name: string; size: number } | null;
  busy: boolean;
  error: CoreError | null;
}

/** 打开层后该把焦点交给谁（adapter 负责聚焦；null = 不主动聚焦）。 */
export type LayerFocus = 'inner' | 'pendingNewTab' | 'pendingReplace';

/** 打开层的结果：成功出 view，其余是交给 app 执行的意图。 */
export type OpenResult =
  | { kind: 'opened'; view: LayerView; focus: LayerFocus | null }
  | { kind: 'denied-limit' }
  | { kind: 'needs-discard-confirm' }
  | { kind: 'noop' };

/** 精简确认层选落点的结果：import 由 app 执行，confirm 由 app 确认后重试。 */
export type ChooseResult =
  | { kind: 'import'; payload: PendingImport; target: ImportTarget }
  | { kind: 'needs-discard-confirm'; target: ImportTarget }
  | { kind: 'noop' };

/** 覆盖警示的前后缀文案 key（中间是活动文档「名称（大小）」，由 adapter 渲染成 <b>）。 */
export const WARN_BEFORE_KEY = 'app.empty.warn.before' as const;
export const WARN_AFTER_KEY = 'app.empty.warn.after' as const;
/** 「标签已满、本次自动降为替换」的说明文案 key。 */
export const LIMIT_HINT_KEY = 'app.empty.limitNotice' as const;

const TITLE_INITIAL = 'app.empty.title.initial' as const;
const TITLE_REPLACE = 'app.empty.title.replace' as const;
const TITLE_NEW_TAB = 'app.empty.title.newTab' as const;
const TITLE_PENDING = 'app.empty.title.pending' as const;
const SUB_INITIAL = 'app.empty.sub.initial' as const;
const SUB_REPLACE = 'app.empty.sub.replace' as const;
const SUB_NEW_TAB = 'app.empty.sub.newTab' as const;

/** dev-hook `layer` 快照的字段（与 `WorkspaceHookState.layer` 逐字一致）。 */
export interface LayerHookState {
  open: boolean;
  mode: ImportLayerMode;
  target: ImportTarget | null;
  pendingName: string | null;
  limitNotice: boolean;
}

function pendingName(entry: PendingImport | null): string | null {
  if (!entry) return null;
  return entry.kind === 'file' ? entry.file.name || 'document.json' : entry.name;
}

function pendingSize(entry: PendingImport | null): number {
  if (!entry) return 0;
  return entry.kind === 'file' ? entry.file.size : new TextEncoder().encode(entry.text).length;
}

/**
 * 入口层状态机。所有查询都是纯读；所有命令要么返回 `LayerView`，要么返回交给 app 的意图。
 * 动效（110ms 淡出）与焦点归还属于 adapter，本模块只区分 `close()` / `settle()` 两个时点。
 */
export class ImportLayerState {
  private modeValue: ImportLayerMode = 'initial';
  /** 初始空态本身就是「显示中的层」——与旧 `!empty.classList.contains('is-hidden')` 同口径。 */
  private openValue = true;
  private pending: PendingImport | null = null;
  private busy = false;
  private error: CoreError | null = null;
  private limitNotice = false;
  /** 打开层时快照的活动文档（替换层覆盖警示；之后换文档不影响已开的层）。 */
  private currentDoc: { name: string; bytes: number } | null = null;
  /** 打开层时快照的标签上限（满 8 说明文案用）。 */
  private maxTabs = 0;

  /** 层是否处于打开态（淡出期间即 false，见文件头）。 */
  isOpen(): boolean {
    return this.openValue;
  }

  /** 层是否在解析中（busy 期间拒绝新的粘贴 / 拖放）。 */
  isBusy(): boolean {
    return this.openValue && this.busy;
  }

  /** 当前形态。 */
  mode(): ImportLayerMode {
    return this.modeValue;
  }

  /** 待确认载荷（adapter 的「导入」动作要用）。 */
  pendingImport(): PendingImport | null {
    return this.pending;
  }

  /** dev-hook 快照（`WorkspaceHookState.layer` 的 5 个字段）。 */
  state(): LayerHookState {
    return {
      open: this.openValue,
      mode: this.modeValue,
      target: this.modeValue === 'new-tab' ? 'new-tab' : this.modeValue === 'replace' ? 'replace' : null,
      pendingName: pendingName(this.pending),
      limitNotice: this.limitNotice,
    };
  }

  /** 当前视图（adapter 重画用；不含焦点，重画不抢焦点）。 */
  view(): LayerView {
    const mode = this.modeValue;
    const isDialog = mode === 'replace' || mode === 'new-tab' || mode === 'pending';
    return {
      mode,
      titleKey:
        mode === 'replace'
          ? TITLE_REPLACE
          : mode === 'new-tab'
            ? TITLE_NEW_TAB
            : mode === 'pending'
              ? TITLE_PENDING
              : TITLE_INITIAL,
      subKey:
        mode === 'replace'
          ? SUB_REPLACE
          : mode === 'new-tab'
            ? SUB_NEW_TAB
            : mode === 'initial'
              ? SUB_INITIAL
              : null,
      warn: mode === 'replace' && this.currentDoc ? { ...this.currentDoc } : null,
      hint: mode === 'replace' && this.limitNotice ? { n: this.maxTabs } : null,
      target: mode === 'replace' || mode === 'new-tab' ? (mode === 'replace' ? 'replace' : 'new-tab') : null,
      closeVisible: isDialog,
      pending:
        mode === 'pending' && this.pending
          ? { name: pendingName(this.pending) ?? '', size: pendingSize(this.pending) }
          : null,
      busy: this.busy,
      error: this.error,
    };
  }

  /**
   * 打开完整导入层（⌘O / 导入按钮）。
   *
   * - `target` 省略 = 用设置里的默认落点；显式传入 = 本次覆盖设置（ADR-0028 §1）。
   * - 默认新标签但标签已满 → **自动降为替换**并出 `hint`（#47 #1.4）；
   *   显式请求新标签且已满 → `denied-limit`（app 弹 toast，不静默改落点）。
   * - `replace` 需要先过「丢弃临时修改」确认：`confirmed=false` 时返回
   *   `needs-discard-confirm`，app 确认后带 `confirmed=true` 再调一次。
   */
  open(ctx: LayerContext, target?: ImportTarget, confirmed = false): OpenResult {
    if (!ctx.hasDoc || this.openValue) return { kind: 'noop' };
    const fromSettings = target === undefined;
    let mode: ImportTarget = target ?? ctx.importTarget;
    let limitFallback = false;
    if (mode === 'new-tab' && !ctx.canAddTab) {
      if (!fromSettings) return { kind: 'denied-limit' };
      mode = 'replace';
      limitFallback = true;
    }
    if (mode === 'replace' && !confirmed) return { kind: 'needs-discard-confirm' };
    this.reset(ctx);
    this.openValue = true;
    this.currentDoc = ctx.currentDoc ? { ...ctx.currentDoc } : null;
    this.maxTabs = ctx.maxTabs;
    this.limitNotice = limitFallback;
    this.applyMode(mode);
    return { kind: 'opened', view: this.view(), focus: 'inner' };
  }

  /**
   * 「新标签」入口（标签条 `＋` / ⌘⇧O / 标签条空白拖放）。
   * 层已开时不切形态（pending 的落点由层内两个按钮决定；已是 new-tab 则无操作）。
   */
  openNewTab(ctx: LayerContext): OpenResult {
    if (!ctx.hasDoc) return { kind: 'noop' };
    if (this.openValue) {
      if (this.modeValue === 'pending' || this.modeValue === 'new-tab') return { kind: 'noop' };
      if (!ctx.canAddTab) return { kind: 'denied-limit' };
      this.applyMode('new-tab');
      this.error = null;
      return { kind: 'opened', view: this.view(), focus: null };
    }
    return this.open(ctx, 'new-tab');
  }

  /** 打开精简确认层（拖入文档正文 / 文档视图内 ⌘V；#47 #2）。 */
  openPending(ctx: LayerContext, entry: PendingImport): OpenResult {
    if (!ctx.hasDoc) return { kind: 'noop' };
    this.reset(ctx);
    this.openValue = true;
    this.maxTabs = ctx.maxTabs;
    this.pending = entry;
    this.modeValue = 'pending';
    return {
      kind: 'opened',
      view: this.view(),
      focus: ctx.canAddTab ? 'pendingNewTab' : 'pendingReplace',
    };
  }

  /**
   * 精简确认层里选定落点（#47 #2）：
   * - 「新标签」在满 8 时无操作（按钮本应已禁用）；
   * - 「替换当前文档」需要先过丢弃确认（`confirmed=false` 时返回意图）。
   */
  choose(target: ImportTarget, ctx: LayerContext, confirmed = false): ChooseResult {
    if (!this.openValue || this.modeValue !== 'pending' || !this.pending) return { kind: 'noop' };
    if (target === 'new-tab' && !ctx.canAddTab) return { kind: 'noop' };
    if (target === 'replace' && !confirmed) return { kind: 'needs-discard-confirm', target };
    return { kind: 'import', payload: this.pending, target };
  }

  /** 完整层里切换落点（radio change）：只改本次形态，不写设置。 */
  chooseTarget(target: ImportTarget, ctx: LayerContext): LayerView | null {
    if (!this.openValue || (this.modeValue !== 'replace' && this.modeValue !== 'new-tab')) return null;
    if (target === 'new-tab' && !ctx.canAddTab) return null;
    this.applyMode(target);
    this.error = null;
    return this.view();
  }

  /** 解析中（busy 期间禁用输入与层内控件；开始解析即清掉待确认条目）。 */
  setBusy(busy: boolean): LayerView {
    this.busy = busy;
    if (busy) this.pending = null;
    return this.view();
  }

  /** 结构化错误（adapter 按当前语言格式化；切语言后重画即可）。 */
  setError(error: CoreError | null): LayerView {
    this.error = error;
    return this.view();
  }

  /** 关闭：立刻按「已关闭」处理（淡出期间 ⌘V / Esc / 拖放看到的是关闭后的世界）。 */
  close(): void {
    this.openValue = false;
    this.busy = false;
  }

  /** 关闭收尾：复位成初始空态（adapter 在 110ms 后 / reduce 时调）。 */
  settle(ctx: LayerContext): LayerView {
    this.reset(ctx);
    return this.view();
  }

  /** 回初始空态并显示（关掉最后一个标签时）。 */
  showInitial(ctx: LayerContext): LayerView {
    this.reset(ctx);
    this.openValue = true;
    return this.view();
  }

  private applyMode(mode: ImportTarget): void {
    this.modeValue = mode;
  }

  private reset(ctx: LayerContext): void {
    this.modeValue = 'initial';
    this.openValue = false;
    this.pending = null;
    this.busy = false;
    this.error = null;
    this.limitNotice = false;
    this.currentDoc = null;
    this.maxTabs = 0;
  }
}
