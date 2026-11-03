/**
 * protocol/types — 跨线程共享的数据形状。
 * 零依赖；只放 structured-clone-safe 的普通对象类型。
 */

export type RootId = string;
/** docRevision / rowVersion / seq 都是单调整数 */
export type Rev = number;
/** 规范路径：根 `$`；对象 `.key` 或 `['non ident']`；数组 `[i]` */
export type Path = string;

export type JsonKind = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';

/**
 * 复制格式（ADR-0010 §2–§5）：子树 JSON / 规范路径 / 标量原始值 / 键名。
 * 四值即协议值，UI 菜单项 `data-act` 与 dev hook 也用它。
 */
export type CopyFormat = 'subtree' | 'path' | 'value' | 'key';

/** 一行可见数据。行窗口协议的最小载荷（40 行 ≈3.1KB）。 */
export interface Row {
  /** 该行的完整规范路径（根为 `$`） */
  path: Path;
  /** 缩进层级，根 = 0 */
  depth: number;
  /** 显示用键：对象键名，或数组下标（含方括号） */
  key: string;
  /** true = 数组下标样式（用 --syntax-index 着色） */
  idx: boolean;
  kind: JsonKind;
  /** 标量原文 / 折叠容器预览（单行、已截断） */
  preview: string;
  /** 容器子项数；标量为 0 */
  count: number;
  /** 容器是否展开 */
  open: boolean;
  hasChildren: boolean;
}

export interface RowWindow {
  rootId: RootId;
  rowVersion: Rev;
  seq: number;
  start: number;
  count: number;
  rows: Row[];
  totalRows: number;
}

export interface Hit {
  path: Path;
  key: string;
  kind: JsonKind;
  preview: string;
  field: 'key' | 'value';
  /** 行号提示：命中已知可见行时给出（可选） */
  row?: number;
}

export interface SearchOpts {
  caseSensitive?: boolean;
  keysOnly?: boolean;
  /** 命中上限，默认 50,000（超过则 truncated） */
  limit?: number;
}

export interface SearchResult {
  docRevision: Rev;
  hits: Hit[];
  total: number;
  truncated: boolean;
}

export interface DocumentProfile {
  /** 顶层键 + 采样字段名（供表达式补全） */
  sampleKeys: string[];
  maxDepth: number;
  nodeCount: number;
}

/** 修复状态（ADR-0004 §6 / 修订 2026-11-03）：none=原文本可解析、repaired=已语法闭合、unrepairable=非 EOF 形态 */
export type RepairStatus = 'none' | 'repaired' | 'unrepairable';

/** 修复计数（摘要用；零项省略） */
export interface RepairCounts {
  /** 补的 `}` / `]` 个数 */
  brackets: number;
  /** 补的结束引号个数 */
  quotes: number;
  /** 删掉的尾逗号个数 */
  commas: number;
  /** 删掉的字符总数（含尾逗号；即所有 delete op 的 text.length 之和） */
  deletedChars: number;
}

/** 一条修复操作；`at` 指向**原文本**偏移（insert 的 at = 原文本长度） */
export interface RepairOp {
  at: number;
  op: 'insert' | 'delete';
  text: string;
  scope: 'container' | 'string' | 'token' | 'member' | 'comma';
  /** 摘要列表逐条展示的中文说明 */
  note: string;
}

/** 修复 provenance（ADR-0004 §6.3）：挂在 DocumentMeta 上，不随视图切换丢失 */
export interface RepairProvenance {
  status: RepairStatus;
  /** 触发修复的 EOF 位置（= 原文本长度） */
  truncatedAt?: number;
  /** 原 JSON.parse 错误信息 */
  parseError?: string;
  /** 一行中文摘要（UI 直接展示） */
  summaryText?: string;
  counts?: RepairCounts;
  ops?: RepairOp[];
  /** unrepairable 的原因：not-eof=错误不在末尾 / still-invalid=修复后仍不可解析 */
  unrepairableReason?: 'not-eof' | 'still-invalid';
}

export interface DocumentMeta {
  name: string;
  bytes: number;
  source: 'paste' | 'file' | 'clipboard';
  repair?: RepairProvenance;
}

/** JSON 地图 trail（v1.1） */
export interface MapLevel {
  key: string;
  kind: JsonKind;
  index: number;
  count: number;
  siblings: { key: string; index: number; kind: JsonKind }[];
}

export interface MapTrail {
  rootKind: JsonKind;
  levels: MapLevel[];
  current: { key: string | null; kind: JsonKind; preview: string; path: Path };
  depth: number;
}

export interface NodeStats {
  totalRows: number;
  docRevision: Rev;
  rowVersion: Rev;
}
