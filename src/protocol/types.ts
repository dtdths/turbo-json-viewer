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
  /** 正则模式：query 按 ECMAScript RegExp 解释；`Aa` 只决定 `i` flag（ADR-0014） */
  regex?: boolean;
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

/* ------------------------- 大纲面板（ADR-0013） ------------------------- */

/** 大纲行：容器的一个子项（键 + 类型 + 项数 + 完整规范路径）。 */
export interface OutlineChild {
  /** 对象键原文 / 数组下标（含方括号，如 `[12]`） */
  key: string;
  /** true = 数组下标样式（与 Row.idx 同口径） */
  idx: boolean;
  kind: JsonKind;
  /** 容器子项数；标量为 0 */
  count: number;
  path: Path;
}

/**
 * 大纲页回包（`outline` 命令）：按容器**分页**返回子项；只读、不推任何版本。
 * 语义：`start`/`count` 夹取；标量路径回 `total: 0`；路径不存在由 core 抛 `BAD_COMMAND`。
 */
export interface OutlineReply {
  rootId: RootId;
  /** 被查询容器自身 */
  path: Path;
  kind: JsonKind;
  /** 该容器子项总数（分页依据） */
  total: number;
  /** 实际生效的起始下标（夹取后） */
  start: number;
  children: OutlineChild[];
}

/* ------------------------- 原始文本视图（ADR-0003 修订） ------------------------- */

/**
 * 原文行布局模式：
 *   - `source`：源码行虚拟化（源文本已有可用行，保留用户原始格式）；
 *   - `pretty`：源文本是 minified / 超长行 → 检查点 pretty 行走器合成规范布局；
 *   - `plain`：源文本非法（截断修复后的文档）→ 按 `\n` 分行 + 每行硬切，纯文本。
 */
export type RawMode = 'source' | 'pretty' | 'plain';

/** 原文行索引元信息（`rawOpen` 回包；不含行文本） */
export interface RawMeta {
  mode: RawMode;
  /** 总行数（滚动条唯一需要的数量） */
  totalLines: number;
  /** 源文本字符数（UTF-16 code unit） */
  chars: number;
  /** 源文本最长行（字符；形状探测结果） */
  maxLineLength: number;
  /** 索引构建耗时（Worker 内 ms；惰性构建，诊断/验收用） */
  buildMs?: number;
  /** true = 源文本非法（修复后的文档），只能按纯文本展示 */
  damaged?: boolean;
}

/** 原文窗口：只回行文本，不物化全文 */
export interface RawWindow {
  rootId: RootId;
  seq: number;
  start: number;
  /** 每行显示文本（≤ RAW_LINE_DISPLAY_MAX 字符；超长行截断显示） */
  lines: string[];
  /** 与 lines 对齐：该行被截掉的字符数（0 / 缺省 = 完整） */
  truncated?: number[];
  totalLines: number;
  mode: RawMode;
}

/** 源文本偏移 → 1-based 源行号（修复摘要 `at` 跳行用） */
export interface RawLocateReply {
  /** 1-based 行号 */
  line: number;
  totalLines: number;
}

/** 整份源文本（原文视图「复制原文」用；超 maxBytes 由 core 抛 TOO_LARGE） */
export interface RawSourceReply {
  text: string;
  /** UTF-8 字节数 */
  bytes: number;
}

/* --------------------------- 保真提示（#23 / ADR-0003 修订 2026-11-09） --------------------------- */

/**
 * 一条失真命中（ADR-0003 修订 §3）。
 *
 * `offset` 是**源文本 UTF-16 偏移**，可直接喂 `rawLocate`（跳原文行）。
 * 命中顺序由 core 按源文本出现顺序排好（同源顺序，非字典序）。
 */
export interface FidelityHit {
  kind: 'number' | 'key-order';
  /** 源文本 UTF-16 偏移（数字字面量起点 / 对象 `{` 的位置） */
  offset: number;
  /** ≤48 字符的异常片段（超长截断 + 省略号） */
  snippet: string;
  /** kind==='number' 时的失真类别 */
  reason?: 'precision' | 'overflow' | 'underflow';
  /** 「原文 vs 解析后」对照（各自 ≤48 字符；kind==='number'） */
  literal?: string;
  parsed?: string;
}

/**
 * 保真统计（code review 收口）：`number` 是数字类总量，但**必须能按类别分别展示**——
 * 把上溢/下溢也标成「大整数精度」会让「精确数量」这句话失真（ADR-0003 §4）。
 */
export interface FidelityCounts {
  /** 数字类失真总量 = precision + overflow + underflow */
  number: number;
  /** 大整数精度流失（>15 位整数被 double 圆整，含带指数的整数尾数） */
  precision: number;
  /** 数字上溢（如 `1e400` → `Infinity`） */
  overflow: number;
  /** 数字下溢（如 `1e-400` → `0`） */
  underflow: number;
  /** 整数样式键重排（每对象最多 1 处） */
  keyOrder: number;
  /** = number + keyOrder */
  total: number;
}

/**
 * 保真报告（ADR-0003 修订 §3）：`hits` 只留**源文本顺序最靠前**的 `FIDELITY_MAX_HITS` 条片段，
 * `counts` 始终是**全量**统计（提示文案用精确数量，不能被截断误导）。
 *
 * 取消没有第三种状态：扫描中根被替换/关闭时命令回 `CANCELLED`，app 静默丢弃（ADR 修订 §6）。
 */
export interface FidelityReport {
  status: 'none' | 'found';
  counts: FidelityCounts;
  /** 源文本顺序最靠前的 ≤`FIDELITY_MAX_HITS` 条（截断时 `truncated=true`） */
  hits: FidelityHit[];
  /** true = 命中数超过 hits 长度（被截断） */
  truncated: boolean;
  /** 扫描耗时（Worker 内 ms，诊断/验收用；不进常驻 UI） */
  scanMs: number;
}
