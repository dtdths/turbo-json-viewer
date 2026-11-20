/**
 * app/expression-workspace — 表达式工作区（候选 6 / ADR-0008 修订 2026-11-20）。
 *
 * 收口「表达式视图」的全部会话规则，**一个 owner**：
 * - 最近一次结果视图态（`exprView`）与「结果根是否正显示」（`active`）；
 * - 结果视图激活期间的**文档会话存档**（`suspended`）——`session.*` 此刻是 expr 根，
 *   「当前文档根 / 文档版本」唯一口径由本模块回答（`documentRootId` / `documentRevision`）；
 * - 在途闸门（`seq` / `running`）、watchdog、stale、结果条 / 行内反馈、原路径缓存、
 *   补全、示例、LRU 恢复。
 *
 * 纯 TS、零 DOM import：面板 / 结果条 / 树 / 行窗口 / 会话 / core 全部经端口注入，
 * 单测用假端口即可覆盖 stale / 取消 / 幂等进入 / LRU 恢复。词条只经 `view/expression-copy`。
 *
 * 归属纪律（与 `TabViewState` 同一口径，ADR-0008 修订 2026-11-19）：**活状态问本模块，
 * 每标签存档问 `TabViewState`**。本模块不直接读写标签存档，只提供 `mirror` 给那张 accessor 表。
 */
import { t } from '../i18n/index';
import { CoreError } from '../protocol/errors';
import type { RootVersion } from '../protocol/messages';
import type { CoreApi } from '../protocol/core-api';
import {
  EXPR_BUDGETS,
  EXPR_EXAMPLES_DOC,
  EXPR_EXAMPLES_GENERIC,
  exprWatchdogMs,
} from '../protocol/versions';
import type {
  EvalReply,
  EvalSuccess,
  ExprBudgetLevel,
  ExprCompletion,
  ExprError,
  Path,
} from '../protocol/types';
import { EXPR_COPY, exprErrorText } from '../view/expression-copy';
import type { ExpressionBarView } from '../view/panels/expression-bar';
import type { LandingPlan, SessionState } from './doc-session';
import type { ExprStatusLine, ExprViewState } from '../viewmodel/tab-view-data';
import type { WindowSnapshot } from '../viewmodel/row-window-source';

/** 表达式面板的窄端口（`view/panels/expression-panel` 的结构子集）。 */
export interface ExpressionPanelPort {
  getText(): string;
  getStrict(): boolean;
  setRunning(running: boolean): void;
  setError(error: { message: string; line?: number; column?: number } | null): void;
  setStatus(text: string): void;
  addHistory(text: string): void;
  setExamples(examples: readonly string[]): void;
}

/** 结果条端口（`view/panels/expression-bar`）。 */
export interface ExpressionBarPort {
  show(view: ExpressionBarView): void;
  hide(): void;
}

/** 活动会话端口（`app/doc-session` 的 `DocSession`）。 */
export interface ExpressionSessionPort {
  readonly snapshot: SessionState;
  readonly rootId: string | null;
  readonly docRevision: number;
  restore(state: SessionState): void;
  land(reply: EvalSuccess, intent: { kind: 'expression' }): LandingPlan;
}

/** 树行窗口端口（`viewmodel/row-window-source`）。 */
export interface ExpressionRowsPort {
  setRoot(
    next: { rootId: string; rowVersion: number; totalRows: number },
    opts?: { scrollTopPx?: number },
  ): void;
  requestWindow(): void;
  snapshot(): WindowSnapshot;
}

/** 树视图端口（`view/tree/tree-view` 的两条几何 / 选中动作）。 */
export interface ExpressionTreePort {
  scrollToPx(px: number): void;
  setSelected(path: string | null): void;
}

/**
 * app 侧的少量装配动作（都是「模块不该知道的整体动作」）：
 * 回包落地执行器、选中、状态栏、提示条、面板 / 视图模式、跳转。
 */
export interface ExpressionViewActions {
  land(plan: LandingPlan): void;
  select(path: string | null): void;
  syncLocateRaw(): void;
  updateStatus(): void;
  focusTree(): void;
  isRaw(): boolean;
  setTreeMode(): void;
  setDocPanel(): void;
  jumpToPath(path: string): Promise<unknown>;
  selected(): string | null;
}

export interface ExpressionWorkspaceDeps {
  panel: ExpressionPanelPort;
  bar: ExpressionBarPort;
  session: ExpressionSessionPort;
  rows: ExpressionRowsPort;
  tree: ExpressionTreePort;
  core: Pick<CoreApi, 'eval' | 'complete' | 'exprLocate'>;
  view: ExpressionViewActions;
  /** 求值预算档位（读设置） */
  budget(): ExprBudgetLevel;
  /** watchdog 触发：终止 worker（模块自己写重载标记，调用方负责 reload） */
  terminate(): void;
  /** 用户可见 toast（kind = error 时样式为错误） */
  toast(text: string, ms: number, kind?: 'error'): void;
  /** 非表达式错误（CoreError / 协议错误）统一提示 */
  error(error: unknown): void;
  /** watchdog 重载标记键（`sessionStorage`，重载后读取） */
  watchdogFlag: string;
  /** 页面重载（watchdog 专用，便于单测注入） */
  reload(): void;
}

/** 表达式结果行在状态栏里展示的原文档路径缓存（#47 #8 / ADR-0027）。 */
export interface ExpressionOrigin {
  rootId: string;
  path: string;
  origin: string | null;
}

/** 每标签存档里属于本模块的四个字段（供 `TabViewState` 的 accessor 表使用）。 */
export interface ExpressionMirror {
  exprView: { get(): ExprViewState | null; set(value: ExprViewState | null): void };
  exprLastText: { get(): string; set(value: string): void };
  exprErrorState: { get(): ExprError | null; set(value: ExprError | null): void };
  exprStatusState: { get(): ExprStatusLine | null; set(value: ExprStatusLine | null): void };
}

export class ExpressionWorkspace {
  private readonly deps: ExpressionWorkspaceDeps;
  /** 最近一次成功结果（会话内保留；换文档 / 回空态清空）。 */
  private exprView: ExprViewState | null = null;
  /** 结果根是否正显示（切标签一律复位；回文档树保留结果本体）。 */
  private exprViewActive = false;
  /** 结果视图激活期间的文档会话（`session.*` 已切到 expr 根）。 */
  private suspended: SessionState | null = null;
  /** 求值序号：迟到回包丢弃（与 search 同口径）。 */
  private seq = 0;
  private running = false;
  /** 最近一次成功执行的表达式文本（「重新执行」用；面板被改过则以面板当前文本为准）。 */
  private lastText = '';
  /** 最近一次行内错误（结构化；切语言时按新语言重新格式化）。 */
  private errorState: ExprError | null = null;
  /** 最近一次状态行（count/ms；切语言时重算文案）。 */
  private statusState: ExprStatusLine | null = null;
  /** 选中行的原文档路径缓存（只存 worker 回包里给的值，不自己算映射）。 */
  private origin: ExpressionOrigin | null = null;
  /** 供 `TabViewState` 的 accessor 表使用（构造一次，闭包读实时字段）。 */
  readonly mirror: ExpressionMirror;

  constructor(deps: ExpressionWorkspaceDeps) {
    this.deps = deps;
    this.mirror = {
      exprView: { get: () => this.exprView, set: (value) => { this.exprView = value; } },
      exprLastText: { get: () => this.lastText, set: (value) => { this.lastText = value; } },
      exprErrorState: { get: () => this.errorState, set: (value) => { this.errorState = value; } },
      exprStatusState: { get: () => this.statusState, set: (value) => { this.statusState = value; } },
    };
  }

  /* ---------------- 只读状态 ---------------- */

  get view(): ExprViewState | null {
    return this.exprView;
  }

  get active(): boolean {
    return this.exprViewActive;
  }

  get lastExpressionText(): string {
    return this.lastText;
  }

  get inlineError(): ExprError | null {
    return this.errorState;
  }

  get statusLine(): ExprStatusLine | null {
    return this.statusState;
  }

  get selectedOrigin(): ExpressionOrigin | null {
    return this.origin;
  }

  /** 当前显示根：结果根（结果视图激活时）或 null（文档树）。 */
  activeRootId(): string | null {
    return this.exprViewActive && this.exprView ? this.exprView.rootId : null;
  }

  /**
   * 当前**文档**根：「表达式视图激活时 `session.rootId` 是 expr 根，不能用它求值/补全」——
   * 这条口径的唯一实现（原先 `main.ts` 的 `documentRootId`）。
   */
  documentRootId(): string | null {
    if (this.exprViewActive) return this.suspended?.rootId ?? null;
    return this.deps.session.rootId;
  }

  /** 当前**文档**版本（表达式视图激活时取进入前的文档会话）。 */
  documentRevision(): number {
    if (this.exprViewActive && this.suspended) return this.suspended.docRevision;
    return this.deps.session.docRevision;
  }

  /** 结果是否过期：文档改过（docRevision 不匹配）→ stale banner + 「重新执行」，**不自动重跑**。 */
  stale(): boolean {
    return this.exprView !== null && !this.exprViewActive && this.exprView.docRevision !== this.documentRevision();
  }

  /* ---------------- 生命周期 ---------------- */

  /** 切标签 / 关标签 / 回空态时作废在途求值（seq 自增让迟到回包被丢弃，并解开 running 闸门）。 */
  cancel(): void {
    this.seq += 1;
    this.running = false;
    this.deps.panel.setRunning(false);
  }

  /** 切标签 / 回空态：结果根不再显示（结果本体留在标签存档里，重进表达式模式可恢复）。 */
  resetTransient(): void {
    this.exprViewActive = false;
    this.suspended = null;
    this.origin = null;
  }

  /** 回空态：结果本体与行内反馈一起没了。 */
  clear(): void {
    this.cancel();
    this.exprView = null;
    this.errorState = null;
    this.statusState = null;
    this.resetTransient();
  }

  /**
   * 同步子键排序回包（#40 / ADR-0024 §6）的**活状态**侧：文档会话存档与结果视图的版本。
   * 标签存档侧由 `TabViewState.syncVersions` 负责（本模块不碰存档）。
   */
  syncVersions(roots: readonly RootVersion[]): void {
    for (const entry of roots) {
      if (this.suspended?.rootId === entry.rootId) {
        this.suspended = {
          ...this.suspended,
          rowVersion: entry.rowVersion,
          totalRows: entry.totalRows,
        };
      }
      if (this.exprView?.rootId === entry.rootId) {
        this.exprView.rowVersion = entry.rowVersion;
        this.exprView.totalRows = entry.totalRows;
      }
    }
  }

  /** 结果根上的展开 / 折叠 / 全部展开落地后，把新版本写回结果视图态（重进表达式模式时用）。 */
  syncLandedRoot(rootId: string, rowVersion: number, totalRows: number): void {
    if (this.exprViewActive && this.exprView?.rootId === rootId) {
      this.exprView.rowVersion = rowVersion;
      this.exprView.totalRows = totalRows;
    }
  }

  /**
   * 进入表达式模式时恢复最近一次结果（LRU 保留；stale 时结果条变警告色 + 「重新执行」）。
   * **幂等**：结果视图已激活时什么都不做——否则会把文档会话存档覆盖成 expr 会话
   * （候选 6 修的真漏洞；此前只有 dev hook 的 `expressionOpen()` 能踩到）。
   */
  enterFromArchive(): void {
    if (this.exprViewActive || !this.exprView) return;
    const view = this.exprView;
    // stale 必须在切 session 之前算：切完 session.docRevision 就是 expr 版本了
    const isStale = view.docRevision !== this.documentRevision();
    // 结果视图只在树形态下有意义（原文视图下恢复结果根会看不见）→ 先切回树
    if (this.deps.view.isRaw()) this.deps.view.setTreeMode();
    this.suspended = this.deps.session.snapshot;
    this.exprViewActive = true;
    // 结果行尾「在原文中定位」必须关（与 `enter()` 同一口径；此前这条路径漏了）
    this.deps.view.syncLocateRaw();
    this.deps.session.restore({
      rootId: view.rootId,
      docRevision: view.docRevision,
      rowVersion: view.rowVersion,
      totalRows: view.totalRows,
    });
    this.showResultRoot({ scrollTopPx: 0 });
    this.renderBar(isStale);
    this.statusState = { count: view.count, ms: Math.round(view.ms) };
    this.deps.panel.setStatus(EXPR_COPY.status(this.statusState.count, this.statusState.ms));
    this.deps.view.updateStatus();
  }

  /** 返回文档树：恢复进入表达式视图前的文档会话；结果根保留在 worker LRU（可重进恢复）。 */
  back(opts: { silent?: boolean } = {}): void {
    if (!this.exprViewActive) return;
    this.exprViewActive = false;
    this.origin = null;
    this.deps.view.syncLocateRaw();
    this.deps.bar.hide();
    const saved = this.suspended;
    this.suspended = null;
    if (saved) {
      this.deps.session.restore(saved);
      this.showResultRoot({ scrollTopPx: 0 });
    }
    this.deps.tree.setSelected(null);
    this.deps.view.select(null);
    this.deps.view.updateStatus();
    if (!opts.silent) this.deps.view.focusTree();
  }

  /* ---------------- 求值 ---------------- */

  /** 执行一次表达式（面板「执行」/ Enter / 结果条「重新执行」共用）。 */
  async run(textArg?: string, strictArg?: boolean): Promise<void> {
    if (this.running) return;
    const rootId = this.documentRootId();
    if (!rootId) {
      this.deps.toast(t('app.toast.needDocument'), 2500, 'error');
      return;
    }
    const text = (textArg ?? this.deps.panel.getText()).trim();
    const strict = strictArg ?? this.deps.panel.getStrict();
    if (!text) {
      this.clearInline();
      return;
    }
    const budget = this.deps.budget();
    const seq = ++this.seq;
    this.running = true;
    this.deps.panel.setRunning(true);
    this.errorState = null;
    this.statusState = null;
    this.deps.panel.setError(null);
    this.deps.panel.setStatus(EXPR_COPY.running);
    try {
      const reply = await this.evalWithWatchdog({ rootId, seq, text, strict, budget });
      if (seq !== this.seq) return; // 迟到回包（又执行了一次）
      if (!reply.ok) {
        this.showError(reply.error);
        // 保留上一份结果视图（错误只作用于输入，不清已经跑出来的结果）
        return;
      }
      this.lastText = text;
      this.deps.panel.addHistory(text);
      this.enter(reply, text, strict, budget);
    } catch (error) {
      // watchdog 触发时页面会重载；其余错误照常提示
      if (CoreError.from(error).code !== 'CLOSED') this.deps.error(error);
    } finally {
      if (seq === this.seq) {
        this.running = false;
        this.deps.panel.setRunning(false);
      }
    }
  }

  /** 「重新执行」：面板当前文本优先（被改过），否则最近一次成功文本。 */
  rerun(): Promise<void> {
    return this.run(this.deps.panel.getText() || this.lastText, this.deps.panel.getStrict());
  }

  /** 行内错误 / 状态行的重新本地化（locale 切换时由调用方重放）。 */
  applyInlineText(): void {
    if (this.errorState) {
      this.deps.panel.setError({
        message: exprErrorText(this.errorState),
        line: this.errorState.line,
        column: this.errorState.column,
      });
    }
    if (this.statusState) {
      this.deps.panel.setStatus(EXPR_COPY.status(this.statusState.count, this.statusState.ms));
    }
  }

  /** 切回标签后：先抹掉上一标签的行内反馈，再按本标签存档回填（面板是单实例）。 */
  renderAfterTabSwitch(): void {
    this.deps.panel.setError(null);
    this.deps.panel.setStatus('');
    this.applyInlineText();
  }

  /** 结果条文案/态（正常 / stale / 截断 + 跳过）。 */
  renderBar(stale = false): void {
    if (!this.exprView || !this.exprViewActive) {
      this.deps.bar.hide();
      return;
    }
    const view = this.exprView;
    this.deps.bar.show({
      rootId: view.rootId,
      count: view.count,
      ms: view.ms,
      truncated: view.truncated,
      skipped: view.skipped,
      maxResult: EXPR_BUDGETS[view.budget].maxResult,
      stale,
    });
  }

  /** 选中行的原路径缓存刷新（miss 时保留旧缓存；换根 / 离开表达式视图时由调用方清）。 */
  refreshOrigin(): void {
    const selected = this.deps.view.selected();
    if (!this.exprViewActive || !this.exprView || selected === null) {
      this.origin = null;
      return;
    }
    if (
      this.origin !== null &&
      (this.origin.path !== selected || this.origin.rootId !== this.exprView.rootId)
    ) {
      this.origin = null;
    }
    const row = this.deps.rows.snapshot().rows.find((item) => item.path === selected);
    if (row !== undefined && 'originPath' in row) {
      this.origin = { rootId: this.exprView.rootId, path: selected, origin: row.originPath ?? null };
    }
  }

  /** 表达式结果行 → 原文档节点（点结果行；ADR-0018 §1/§4.3）。 */
  async jumpFromRow(path: string): Promise<void> {
    if (!this.exprView || !this.exprViewActive) return;
    try {
      const reply = await this.deps.core.exprLocate({ rootId: this.exprView.rootId, path });
      if (reply.path === null) {
        this.deps.toast(EXPR_COPY.noSource, 2500, 'error');
        return;
      }
      this.back({ silent: true });
      this.deps.view.setDocPanel();
      await this.deps.view.jumpToPath(reply.path);
    } catch (error) {
      this.deps.error(error);
    }
  }

  /** 静态补全：worker 数据源；异常降级为空列表（补全不能打断输入）。 */
  async completions(text: string, pos: number): Promise<ExprCompletion[]> {
    const rootId = this.documentRootId();
    if (!rootId) return [];
    try {
      const reply = await this.deps.core.complete({ rootId, text, pos });
      return reply.items;
    } catch {
      return [];
    }
  }

  /** 结果行 → 原文档路径（dev hook / 跳转共用）。 */
  async locate(path: string | null): Promise<{ path: Path | null }> {
    if (!this.exprView) return { path: null };
    const target = path ?? this.deps.view.selected();
    if (!target) return { path: null };
    return this.deps.core.exprLocate({ rootId: this.exprView.rootId, path: target });
  }

  /** 示例（ADR-0018 §1）：文档顶层字段动态 3 条 + 通用 2 条；无文档只给通用 2 条。 */
  async examples(): Promise<string[]> {
    const generic = EXPR_EXAMPLES_GENERIC_LIST.slice(0, EXPR_EXAMPLES_GENERIC);
    const rootId = this.documentRootId();
    if (!rootId) return generic;
    try {
      const items = await this.completions('', 0);
      const fields = items.filter((item) => item.kind === 'field');
      const picks: string[] = [];
      // 多条件筛选引导（#47 #7 / ADR-0027）：第一个数组字段给一条 filter(...) 示例——
      // 多条件搜索不做自研 UI，表达式就是那条路。谓词取 `x !== null`：对标量数组也不会得到 0 项（可执行性优先）。
      let filterExampleAdded = false;
      for (const field of fields) {
        if (picks.length >= EXPR_EXAMPLES_DOC) break;
        const detail = field.detail;
        const isArray = detail !== undefined && 'kind' in detail && detail.kind === 'array';
        if (isArray && !filterExampleAdded) {
          filterExampleAdded = true;
          picks.push(`$.${field.label}.filter(x => x !== null)`);
          continue;
        }
        picks.push(isArray ? `$.${field.label}.slice(0, 5)` : `$.${field.label}`);
      }
      if (picks.length < EXPR_EXAMPLES_DOC) picks.push('$');
      return [...picks.slice(0, EXPR_EXAMPLES_DOC), ...generic];
    } catch {
      return generic;
    }
  }

  /** 刷新面板示例（打开面板 / 换文档时调用）。 */
  refreshExamples(): void {
    void this.examples().then((items) => this.deps.panel.setExamples(items));
  }

  /** watchdog 重载后的提示（`sessionStorage` 在重载后仍可读）。 */
  consumeWatchdogFlag(): void {
    try {
      if (sessionStorage.getItem(this.deps.watchdogFlag) !== '1') return;
      sessionStorage.removeItem(this.deps.watchdogFlag);
      this.deps.toast(EXPR_COPY.watchdog, 6000, 'error');
    } catch {
      /* 隐私模式 */
    }
  }

  /* ---------------- 内部 ---------------- */

  /** 结果成为树区当前视图根（复用 DocSession 的落地链路；文档根会话先存档）。 */
  private enter(
    reply: EvalSuccess,
    text: string,
    strict: boolean,
    budget: ExprBudgetLevel,
  ): void {
    // 结果视图只有树形态：当前在原文视图时先切回树视图（此时结果视图尚未激活，
    // 走不到「离开表达式 → 回文档树」的守卫，所以这里自己切）
    if (!this.exprViewActive) {
      if (this.deps.view.isRaw()) this.deps.view.setTreeMode();
      this.suspended = this.deps.session.snapshot;
    }
    this.exprView = {
      rootId: reply.rootId,
      docRevision: reply.docRevision,
      rowVersion: reply.rowVersion,
      totalRows: reply.totalRows,
      count: reply.count,
      kind: reply.kind,
      ms: reply.ms,
      steps: reply.steps,
      truncated: reply.truncated,
      skipped: reply.skipped,
      text,
      strict,
      budget,
      seq: this.seq,
    };
    this.exprViewActive = true;
    this.deps.view.syncLocateRaw();
    const plan = this.deps.session.land(reply, { kind: 'expression' });
    this.deps.view.land(plan);
    this.renderBar();
    this.statusState = { count: reply.count, ms: Math.round(reply.ms) };
    this.deps.panel.setStatus(EXPR_COPY.status(this.statusState.count, this.statusState.ms));
    this.deps.view.updateStatus();
  }

  /** 把行窗口切到结果根并重取一帧（进入结果视图 / 返回文档树共用）。 */
  private showResultRoot(opts: { scrollTopPx: number }): void {
    const state = this.deps.session.snapshot;
    if (!state.rootId) return;
    this.deps.rows.setRoot(
      { rootId: state.rootId, rowVersion: state.rowVersion, totalRows: state.totalRows },
      opts,
    );
    this.deps.tree.scrollToPx(opts.scrollTopPx);
    this.deps.rows.requestWindow();
  }

  private clearInline(): void {
    this.errorState = null;
    this.statusState = null;
    this.deps.panel.setError(null);
    this.deps.panel.setStatus('');
  }

  private showError(error: ExprError): void {
    this.errorState = error;
    this.statusState = null;
    this.deps.panel.setError({
      message: exprErrorText(error),
      line: error.line,
      column: error.column,
    });
    this.deps.panel.setStatus('');
  }

  /**
   * 求值 + 主线程硬看门狗（ADR-0018 §6）：`3 × maxTime` 仍无回包 → terminate + 页面重载。
   * 预算正常（引擎三刹车）时永不触发；这是「引擎自身 bug 导致真卡死」的最后兜底。
   */
  private evalWithWatchdog(req: {
    rootId: string;
    seq: number;
    text: string;
    strict: boolean;
    budget: ExprBudgetLevel;
  }): Promise<EvalReply> {
    const timeoutMs = exprWatchdogMs(req.budget);
    return new Promise<EvalReply>((resolve, reject) => {
      let settled = false;
      const timer = globalThis.setTimeout(() => {
        if (settled) return;
        settled = true;
        this.restartAfterWatchdog();
        reject(new Error('expression watchdog fired'));
      }, timeoutMs);
      this.deps.core.eval(req).then(
        (value) => {
          if (settled) return;
          settled = true;
          globalThis.clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          globalThis.clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  /** watchdog 触发：标记重载提示 → 终止 worker → 重载页面（文档必须重新导入；沿用 ReDoS 差距）。 */
  private restartAfterWatchdog(): void {
    try {
      sessionStorage.setItem(this.deps.watchdogFlag, '1');
    } catch {
      /* 隐私模式 */
    }
    this.deps.terminate();
    this.deps.reload();
  }
}

/** 通用语法示例（ADR-0018 §1）：永远可执行，不需要文档特定字段。 */
export const EXPR_EXAMPLES_GENERIC_LIST = [
  `$?.missing_field ?? 'fallback'`,
  `typeof $ === 'object' ? 'object' : typeof $`,
];
