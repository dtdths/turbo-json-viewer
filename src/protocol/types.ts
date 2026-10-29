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

export interface RepairMark {
  offset: number;
  kind: 'open-brace' | 'open-bracket' | 'string-quote' | 'trailing-comma' | 'truncate';
  inserted: string;
}

export interface RepairProvenance {
  truncated: boolean;
  applied: RepairMark[];
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
