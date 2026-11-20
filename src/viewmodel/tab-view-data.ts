/**
 * viewmodel/tab-view-data — 每标签视图态（`TabViewData`）：切走时存回去的**纯数据**。
 *
 * 归属（候选 2 / ADR-0008 修订 2026-11-19）：本文件只回答「这个标签当时看到的样子」，
 * 一个字段都不碰 DOM / adapter / i18n。活动标签的实时值仍是 `app/main.ts` 的模块级镜像；
 * 存档 ↔ 镜像的唯一搬运点是 `app/tab-view-state.ts` 的一张 accessor 表（`VIEW_FIELD_KEYS`）。
 *
 * 分层：只 import `protocol/*` 的 **type**（依赖方向 app → view → viewmodel → protocol）。
 */
import type { CoreError } from '../protocol/errors';
import type { ExprBudgetLevel, ExprError, FidelityReport, JsonKind, RawMeta } from '../protocol/types';

/**
 * 表达式结果视图态。`exprView` = **最近一次成功结果**的元信息（会话内保留，换文档即清）；
 * 树上当前是否显示该结果根由 `app/expression-workspace` 单独持有（切标签一律复位，
 * 「切文档树模式即回」后仍保留，重进表达式模式可恢复）。
 * 结果根本体在 worker 的 RootStore 里（LRU 3），页面只持坐标，不持文档。
 */
export interface ExprViewState {
  rootId: string;
  docRevision: number;
  rowVersion: number;
  totalRows: number;
  count: number;
  kind: JsonKind;
  ms: number;
  steps: number;
  truncated: boolean;
  skipped: number;
  text: string;
  strict: boolean;
  budget: ExprBudgetLevel;
  seq: number;
}

/** 表达式状态行（命中数 / 耗时 ms）；切标签不串味，切换语言时按新语言重新格式化。 */
export interface ExprStatusLine {
  count: number;
  ms: number;
}

/** 双向定位的对照锚点（#30 / ADR-0019 §5）：内存、per-tab、不持久化。 */
export interface ViewAnchor {
  /** 树侧节点路径 */
  path: string;
  /** 原文侧 1-based 行号 */
  line: number;
}

/** 搜索三个开关（Aa / `.*` / 全字）：与每标签 `SearchState` 的选项快照同源（ADR-0014 §2.5）。 */
export interface TabSearchOpts {
  caseSensitive: boolean;
  regex: boolean;
  wholeWord: boolean;
}

/**
 * 一个标签的视图存档。前 7 个字段的顺序与已被删除的 `TabExtras`（原 `app/main.ts`）一致，
 * 便于对照；后 5 个是 2026-11-19 修串味时补进来的。
 * 版本字段（`docRevision` / `rowVersion` / `totalRows`）与 `selected` 不在这里：
 * 它们本来就住在 `TabState` 顶层，`capture` 走 `workspace.update` 写，别再存一份。
 */
export interface TabViewData {
  /** 原文索引元信息（打开过原文才有） */
  rawMetaInfo: RawMeta | null;
  /** 最近一次保真报告 */
  fidelity: FidelityReport | null;
  /** 最近一次成功的表达式结果（会话内保留；换文档即清） */
  exprView: ExprViewState | null;
  /** 树的滚动位置（切回来时恢复，ADR-0009 §3「滚动锚点」） */
  scrollTopPx: number;
  /** 搜索开关快照：切标签不串味（ADR-0014 §2.5） */
  searchOpts: TabSearchOpts;
  /** 原文视图的滚动位置（切回来时恢复） */
  rawScrollTopPx: number;
  /** 双向定位的上次对照锚点（#30 / ADR-0019 §5） */
  anchor: ViewAnchor | null;
  /** 最近一次成功执行的表达式文本（「重新执行」用；面板被改过则以面板当前文本为准） */
  exprLastText: string;
  /** 表达式行内错误（结构化；切语言按新语言重新格式化） */
  exprErrorState: ExprError | null;
  /** 表达式状态行（count / ms） */
  exprStatusState: ExprStatusLine | null;
  /** 搜索正则的引擎侧解析错误：切标签不串到另一个标签的 `SearchState`（ADR-0014 §2.3） */
  searchPatternCore: CoreError | null;
  /** 保真报告里的当前命中下标（`1/N` 的 N 按标签各算各的） */
  fidelityIndex: number;
}

/**
 * 新标签 / 换文档后的默认视图态。每次返回**新对象**（含新的 `searchOpts`），
 * 避免两个标签共享同一个可变对象（历史上 `searchOpts` 是唯一被就地改过的嵌套字段）。
 */
export function defaultTabViewData(): TabViewData {
  return {
    rawMetaInfo: null,
    fidelity: null,
    exprView: null,
    scrollTopPx: 0,
    rawScrollTopPx: 0,
    searchOpts: { caseSensitive: false, regex: false, wholeWord: false },
    anchor: null,
    exprLastText: '',
    exprErrorState: null,
    exprStatusState: null,
    searchPatternCore: null,
    fidelityIndex: 0,
  };
}
