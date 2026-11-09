# 模块 seam 草案（#13）

> 关联：#13、[架构蓝图](README.md)（分层/模块清单）、ADR-0001–0008、`docs/design/{ir,edit,json-map}-spec.md`、`prototype/visual/c/`。
> 本文只定义 **seam** 与跨 seam 契约；层内实现见蓝图与各 spec。术语按 codebase-design：module / interface / implementation / seam / adapter / depth / leverage / locality。

## 1. 总则

**seam** 是「不改动该处就能替换行为」的位置，也是 caller 与 test 共同穿越的 interface；**adapter** 是填进 seam 的实现。一个 adapter 只是假想 seam，两个以上才是真 seam。

只放 5 个，标准是「≥2 个真实 adapter，或一条不可绕过的进程/宿主边界」：线程（S1）、渲染宿主（S3）、样式宿主（S4）、存储/编辑器宿主（S5），外加行窗口来源（S2，真实 transport vs 脚本回放）。行模型、协议形状、状态机**不做可替换接口**——它们变一次要同时改三层，包成 seam 只是给复杂度改名。

**依赖方向**：`app → view → viewmodel → protocol`，`core → protocol`，`shared` 零依赖被所有层引用；`view` 不 import `core`，`core` 不碰 DOM，`app` 是唯一装配点。

| # | seam | interface | v1 adapter | 测试 adapter | 接口背后藏什么（depth） |
|---|---|---|---|---|---|
| S1 | 主线程 ↔ Worker | `CoreApi` + `CoreTransport` | `WorkerTransport`（MessageChannel） | `InProcessTransport`、`FakeTransport` | 24 条命令、4 类根、两套版本号、取消/超时/load 生命周期 |
| S2 | viewmodel → view | `RowWindowSource.snapshot()` / `RawWindowSource.snapshot()` | `TransportRowSource` + `RawWindowSource` | `ScriptedRowSource` | 单飞、合并、seq 丢弃、版本校验、overscan、预取、锚点换算 |
| S3 | TreeView → 单行 / RawView → 单行 | `RowRenderer` | `DomRowPool` + `RawView` 行池 | `RecordingRowRenderer` | 行池复用、textContent、选中/命中态、固定行高纪律 |
| S4 | 全局 → 样式 | `ThemeController` + `RowMetrics` | `tokens.css`（`data-theme`） | `FixedThemeController` | token 名与语义、双主题、Canvas palette 读取 |
| S5 | 全局 → 宿主 | `ViewStateStore`、`CodeEditor` | `ChromeViewStateStore`、`Cm6Editor` | `MemoryViewStateStore`、`TextareaEditor` | 容量/配额/降级、编辑器生命周期与诊断 |

## 2. S1 · Worker 边界

**位置**：`viewmodel` ↔ `core`。这条 seam 的主线程一侧一个字节的文档都没有。

```ts
// src/protocol/core-api.ts —— viewmodel 唯一依赖的核心 interface
export interface CoreApi {
  load(i: LoadInput): Promise<LoadedReply>;        cancelLoad(loadId: number): void;   // 新 load 抢占旧 load
  window(r: WindowRequest): Promise<WindowReply>;  toggle(r: ToggleRequest): Promise<EditReply>;  // rowVersion++
  expandTo(r: { rootId: RootId; path: Path }): Promise<ExpandReply>;  // 展开祖先链、返回行号（跳转）
  replaceNode(r: ReplaceRequest): Promise<EditReply>;  getNodeJson(r: NodeRef): Promise<NodeJsonReply>;  // ≤5MB
  getTrail(r: NodeRef): Promise<TrailReply>;       search(r: SearchRequest): Promise<SearchReply>;     // O(depth) / 不建 root
  cancelSearch(seq: number): void;                 eval(r: EvalRequest): Promise<EvalReply>;           // 新 expr root，LRU 3
  copy(r: CopyRequest): Promise<CopyReply>;        undo(rootId: RootId): Promise<EditReply>;
  rawOpen(r: { rootId: RootId }): Promise<RawMeta>;                    // 原文行索引（惰性构建，ADR-0003 修订）
  rawWindow(r: RawWindowRequest): Promise<RawWindow>;                   // 只回行文本（≤4096 字符/行）
  rawLocate(r: { rootId: RootId; offset: number }): Promise<RawLocateReply>;  // 源偏移 → 1-based 行
  rawSource(r: { rootId: RootId; maxBytes?: number }): Promise<RawSourceReply>; // 整份原文（20MB 守卫）
  outline(r: OutlineRequest): Promise<OutlineReply>;                    // 大纲页：按容器分页取子项（只读，ADR-0013）
  fidelity(r: { rootId: RootId }): Promise<FidelityReply>;             // 保真扫描：源文本线性扫描（只读，ADR-0003 修订）
  redo(rootId: RootId): Promise<EditReply>;        reset(rootId: RootId): Promise<EditReply>;          // 回到导入值
  profile(rootId: RootId): Promise<ProfileReply>;  stats(rootId: RootId): Promise<StatsReply>;         // 版本/行数只读快照
}
// src/protocol/messages.ts —— 线上形态（structured-clone-safe）
export type Command =
  | { t:'load'; loadId:number; source:'paste'|'file'|'clipboard'; bytes:ArrayBuffer|string }
  | { t:'cancelLoad'; loadId:number }
  | { t:'window'; rootId:RootId; rowVersion:Rev; seq:number; start:number; count:number }
  | { t:'toggle'; rootId:RootId; path:Path; open:boolean }
  | { t:'expandTo'; rootId:RootId; path:Path }
  | { t:'replaceNode'; rootId:RootId; path:Path; docRevision:Rev; jsonText:string }
  | { t:'getNodeJson'|'getTrail'; rootId:RootId; path:Path|null }
  | { t:'search'; rootId:RootId; seq:number; query:string; opts:SearchOpts } | { t:'cancelSearch'; seq:number }
  | { t:'eval'; rootId:RootId; seq:number; expr:string } | { t:'copy'; rootId:RootId; path:Path; format:CopyFormat }
  | { t:'undo'|'redo'|'reset'; rootId:RootId } | { t:'profile'; rootId:RootId }
  | { t:'rawOpen'; rootId:RootId } | { t:'rawWindow'; rootId:RootId; seq:number; start:number; count:number }
  | { t:'rawLocate'; rootId:RootId; offset:number } | { t:'rawSource'; rootId:RootId; maxBytes?:number }
  | { t:'outline'; rootId:RootId; path:Path; start:number; count:number }
  | { t:'fidelity'; rootId:RootId }
  | { t:'stats'; rootId:RootId };
export type ReplyOf<C extends Command> = ReplyByKind[C['t']];
// src/app/transport/worker-transport.ts —— 3 个方法；替换传输不改调用方
export interface CoreTransport {
  request<C extends Command>(cmd: C): Promise<ReplyOf<C>>;
  on(l: (e: CoreEvent) => void): () => void;   // progress / repair / fidelity / root / stale / error
  close(): void;
}
```

| Command | Reply（关键字段） | 不变式 |
|---|---|---|
| `load` | `LoadedReply(rootId, docRevision, rowVersion, totalRows, profile, repair?)` | 首帧不等待保真扫描/概要采样（ADR-0004） |
| `window` | `WindowReply(rootId, rowVersion, seq, start, rows, totalRows)` | 40 行 ≈3.1KB；p95 0.1ms |
| `toggle` / `replaceNode` / `undo·redo·reset` | `EditReply(totalRows, changedRow, rowVersion, docRevision?, changed)` | 不重解析；先 parse 后落值；空栈 no-op 不推版本 |
| `expandTo` | `ExpandReply(rootId, rowVersion, row, totalRows)` | 只展开祖先链（不 toggle 目标自身）；`row` 为展开后行号，跳转用 |
| `getNodeJson` / `getTrail` | `NodeJsonReply(text, bytes, nodes)` / `TrailReply(MapTrail)` | ≤5MB 否则 `TOO_LARGE`；O(depth)、兄弟 ±2（ADR-0007） |
| `search` | `SearchReply(seq, docRevision, hits, total, truncated)` | 不建 root、可取消；`total` = 回包命中数（截断时即 `SEARCH_LIMIT`，raw 需放开上限统计） |
| `fidelity` | `FidelityReply(rootId, docRevision, report)` | **只读**、不推版本；扫描 worker 内保留的源文本（单趟线性、每 256KB 让出、可取消）；报告按根对象身份缓存（编辑不重扫）；文档替换 → `CANCELLED`；报告只留 ≤100 条片段（ADR-0003 修订 2026-11-09 / #23） |
| `stats` | `StatsReply(rootId, docRevision, rowVersion, totalRows)` | 只读版本/行数快照，不推进任何版本 |
| `rawOpen` / `rawWindow` / `rawLocate` / `rawSource` | `RawMeta(mode,totalLines,chars,maxLineLength,buildMs?,damaged?)` / `RawWindow(seq,start,lines,totalLines,mode,truncated?)` / `RawLocateReply(line,totalLines)` / `RawSourceReply(text,bytes)` | 只读、不推版本；首调惰性建索引；行文本 ≤4096 字符；`rawSource` 超 `maxBytes` 抛 `TOO_LARGE`（ADR-0003 修订） |
| `outline` | `OutlineReply(rootId, path, kind, total, start, children[OutlineChild])` | 只读、不推版本；按容器**按需分页**（`OUTLINE_PAGE=200` / 上限 500），不建树、不缓存、不依赖树展开态；scalar 路径回 `total:0`（ADR-0013） |
| `eval` | `EvalReply(rootId, docRevision, totalRows, ms)` | 最多保留 3 个结果根 |
| `copy` / `profile` | `CopyReply(text, bytes)` / `ProfileReply(profile)` | 大子树 `truncated`；profile 可缺省 |

| Adapter | implementation | 用途 |
|---|---|---|
| `WorkerTransport` | `MessageChannel` 专供 `window` 回包、`postMessage` 走控制命令；`seq→resolver` 表 | 生产（v1） |
| `InProcessTransport` | 直接持有 `DocService`，方法调用转 Promise，无克隆 | `core`/`viewmodel` 单测、bench |
| `FakeTransport` | 脚本化 reply/event、记录调用、可注入延迟与错误 | view 测试、错误路径 |

**不变式（顺序与生命周期）**
1. 每个 `request` 的 reply **恰好一次**（resolve 或 reject）；`CoreEvent` 可多次、与 reply 无序。
2. `seq` 单调（`window`/`search`/`eval` 各自独立计数器）；迟到回包按 `seq` 丢弃，不 notify。
3. 一切读请求带 `rootId + 版本`；版本不匹配由 core 回 `STALE_ROOT`/`STALE_DOC`，不返回旧数据。
4. `load` 可被下一次 `load` 抢占：旧 pending 以 `CANCELLED` 结束、旧根释放，主线程按 `loadId` 丢弃。
5. 超时默认 5s（`window`/`getTrail` 2s）且 **不自动重试**；`close()` 后 pending reject `CLOSED`、不再派 event；崩溃走 `WORKER_CRASH`。
6. 同一 `rootId` 的结构变更（`toggle`/`replaceNode`/`undo`）由主线程串行化，读可并发；消息体必须 structured-clone-safe（`ArrayBuffer` 只在 `load` transfer）。

**失败模式**：`PARSE`（含 line/column）、`TIMEOUT`、`WORKER_CRASH`（文档丢失 → 提示重新导入，源文本已释放）。
**性能约束**：`window` 端到端 ~2ms；50MB 首帧 150ms、主线程堆 0.72MB。
**删除测试**：删掉 → 每个 view 各自 `postMessage` 并维护 `seq`/超时/取消；`InProcessTransport`/`FakeTransport` 消失，`core` 只能靠真浏览器测。

## 3. S2 · 行窗口源

**位置**：`viewmodel` 内，向 `view` 只暴露一个不可变快照；`view` 不知道行窗口从哪来。

```ts
// src/viewmodel/row-window.ts
export interface RowMetrics { rowHeight: number; viewportRows: number }   // 唯一进入逻辑层的视觉参数
export const WINDOW_POLICY = { overscan: 8, prefetchScreens: 1 } as const; // S2 的策略参数（低端机 overscan 可提到 16）
export interface WindowSnapshot { rootId: RootId; rows: readonly Row[]; totalRows: number; start: number; rowVersion: Rev; stale: boolean; scrollTopPx: number }
export interface RowWindowSource {
  setMetrics(m: RowMetrics): void;                   // 行高/视口变化后必须重取
  setRoot(rootId: RootId, rowVersion: Rev, totalRows: number): void;
  scrollTo(startPx: number): void;                   // 只吃像素；scrollTop↔行号换算在内部
  requestWindow(): void;                             // 幂等，可每帧调用
  snapshot(): WindowSnapshot;
  subscribe(fn: (s: WindowSnapshot) => void): () => void;
  invalidate(reason: 'toggle' | 'replace' | 'stale'): void;
  anchor(): { row: number; offsetPx: number } | null;
}
```

**原文窗口（同纪律，ADR-0003 修订）**：`RawWindowSource` 与 `RowWindowSource` 守同一套纪律（单飞/合并/`seq` 丢弃/overscan），但是**独立实现**——原文没有 rowVersion、没有方向预取、没有锚点换算，状态机更小；改 S2 语义要同时看两处（已知重复，见 README §11 已知差距）。快照是 `RawSnapshot { mode, lines, start, totalLines, stale }`。

**契约**
- **单飞 + 合并**：同一时刻最多 1 个 in-flight；新目标覆盖排队目标，不取消 in-flight（回包后按 `seq` 丢弃）。连续拖动最多 1 个在途请求。
- **`seq` 丢弃**：发号单调；`reply.seq < 已发最大 seq` 或 `reply.rowVersion ≠ snapshot.rowVersion` → 丢弃、不 notify。
- **窗口范围与预取**：`start = floor(scrollTop / rowHeight) - overscan`（夹到 `[0, totalRows)`），`count = viewportRows + 1 + 2 × overscan`；`|ΔscrollTop| > overscan × rowHeight` 时按方向扩一屏（合并为更宽请求，最多 3 屏）。
- **滚动锚点**：`toggle`/`replaceNode` 前记 `(row, offsetPx)`；模型更新后 `scrollTo(row × rowHeight + offsetPx)` 并重取窗口，视口不跳。
- **滚动条映射**：`contentPx = min(totalRows × rowHeight, 33_554_428)`；展开触及 1,000,000 行软预算时由 `core` 回 `TOO_MANY_ROWS`，view 显示护栏提示；映射与窗口协议不变（ADR-0001）。
- **超时/断连**：`stale = true` 保留上一帧，view 显示细的「加载中」，**不出现空白列表**。

| Adapter | implementation | 用途 |
|---|---|---|
| `TransportRowSource` | 经 `CoreApi.window` 取真实窗口 | v1 生产 |
| `ScriptedRowSource` | 回放脚本化 `Row` 序列（可注入 seq 乱序、版本过期、超时） | viewmodel/view 单测 |
| `CachedRowSource` | 主线程缓存 2–3 屏（ADR-0001 的 H 形态降级预案） | 低端机，v1 不启用 |

**失败模式**：`STALE_ROW` 内部消化不冒泡；连续超时 → `stale` 常驻 + 提示「数据未就绪」。
**性能约束**：单行窗口 p95 0.1ms；端到端含 rAF ≈2ms；overscan 8 下平滑滚动空白率 0。
**删除测试**：删掉 → `TreeView` 自己维护 seq/合并/版本/锚点，滚动空白与错行出现在 DOM 层，且只能靠浏览器测。

## 4. S3 · 行渲染器

**位置**：`view` 内，`TreeView` 与「一行 DOM」之间——**这是「逻辑不动调渲染」的唯一开关**。

```ts
// src/view/row-renderer.ts
export interface RowHandle { readonly key: number }          // DOM 适配器里是行池索引
export interface RowContext {
  selected: boolean; hit: boolean; current: boolean; searchTerm?: string;   // current = 搜索当前命中
  typeColumn: boolean; showActions: boolean;
}
export interface RowRenderer {
  readonly rowHeight: number;                                // 固定；来源 RowMetrics，不自行测量
  create(): void;                                            // 预建视口 + overscan 行池
  update(handle: RowHandle | null, row: Row, ctx: RowContext): RowHandle;
  setSelected(handle: RowHandle | null): void;
  setHit(handle: RowHandle, hit: boolean): void;
  destroy(): void;
}
```

**固定行高契约（硬）**
- `rowHeight` 恒定、唯一来源 `RowMetrics.rowHeight`；行内容必须单行（`nowrap` + ellipsis），不得 wrap、不得由内容撑高，缩进用 `padding-left` 不用嵌套容器。
- 原因在 ADR-0001：滚动映射 `row = round(scrollTop / rowHeight)` 是 O(1) 线性；可变行高要逐行测量 + 高度前缀和，且 C 布局面板开合会改树宽 → 每次重算 2,958,550 行，50MB 首帧 150ms 预算失效。换行不是 CSS 取舍，是架构决定。
- 行高 24 → 22/26 走 `RowMetrics` → S2 `setMetrics` → 重取窗口，renderer 不自行感知；单行 DOM 结构（guides/caret/key/value/count/preview/type/actions）可改，只要输入仍是 `Row + RowContext`。

| Adapter | implementation | 依据 |
|---|---|---|
| `DomRowPool` | 行节点池 + `textContent` 复用（不用 innerHTML） | ADR-0005：1000 帧 31.2ms（innerHTML 86.2ms）；0.03–0.09ms/帧 |
| `RecordingRowRenderer` | 无 DOM，记录 `update` 序列与 `RowContext` | 树视图逻辑单测 |
| `CanvasRowRenderer` | 同一 interface 的未来实现 | 无文本层 → 选择/复制/a11y 自造，ADR-0001 已否决 v1 |

**失败模式**：`handle` 已被回收 → 创建新行，不 assert；未知 `kind` → `?` 占位，不抛。
**性能约束**：40 行/帧 0.03–0.09ms；池大小 = `viewportRows + 2 × overscan`。
**删除测试**：删掉 → `TreeView` 自己拼 innerHTML，行复用/主题重绘/命中态散落；canvas 实验要重写整棵树。

## 5. S4 · 主题与 token 注入

**位置**：`view` 与样式之间。主题不是组件，是一条 token 契约：`<html data-theme="dark|light">` + `docs/design/tokens.css` 的 CSS 变量。

```ts
// src/view/theme.ts
export interface ThemeController { set(theme: 'dark' | 'light'): void; current(): 'dark' | 'light' }
export interface RowMetricsSource { read(): RowMetrics }   // 读 --row-h 与树容器高度（ResizeObserver 重算）
```

| 只改 CSS 就能调（不动逻辑） | 逻辑敏感（必须走 interface） |
|---|---|
| 语法/命中/选中色、圆角、阴影、动效、双主题 | `rowHeight` → `RowMetrics` → S2 `setMetrics` + 重取窗口 |
| 行高 22–26、缩进 12/16、字体/字号 | 视口行数（容器高度变化）→ `RowMetrics` |
| 类型列 88、左面板 320、右工作区 300、活动栏 48、状态栏 26、地图 260×220、面板开合（`data-panel`/`rail-collapsed`） | 树最大宽度 1280 居中（改 CSS 即触发 ResizeObserver） |

- `tokens.css` 是唯一真相源；`view` 不 import 颜色常量。双主题是同一组变量两套值，不是反色。
- 仅有的非 CSS 消费者：Canvas 地图（`draw()` 时 `getComputedStyle` 读 palette）与 `ThemeController`（只写 `data-theme` + 把选择交给 S5，不遍历组件重绘）。

| Adapter | implementation | 用途 |
|---|---|---|
| `CssThemeController` | `data-theme` + `ViewStateStore` | v1 |
| `FixedThemeController` | 固定 palette / fixture token 表，覆盖 CSS 变量 | 截图基线与 theme 单测 |

**删除测试**：删掉 → 各组件自行 `matchMedia`/写死颜色，切主题要遍历重绘；Canvas 调色与主题脱节；`RowMetrics` 失去唯一来源。

## 6. S5 · 持久化与编辑器适配

**位置**：`app` 装配层；消费者是 `viewmodel`（主题/面板/展开）与 `view`（编辑器宿主）。

```ts
// src/app/view-state-store.ts
export interface ViewStateStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>; remove(key: string): Promise<void>;
}
// src/view/editor.ts
export interface CodeEditor {
  setValue(text: string): void;   getValue(): string;   focus(): void;
  onChange(fn: (text: string) => void): () => void;
  setDiagnostics(items: Diagnostic[]): void;   // {line, column, message, severity}
  destroy(): void;
}
```

**不变式**
- `ViewStateStore` 只存**视图状态**：主题、面板开合、展开路径集合、滚动锚点、类型列开关；**永不存文档内容/源文本/编辑值**（ADR-0003/0006 红线）。
- key 命名 `view.<docFingerprint>.<name>`；写入 debounce 200ms；容量护栏（展开路径 ≤10,000 条 / ≤512KB，超出丢最旧）；读失败/配额失败/无权限 → `undefined`/no-op、**不阻塞启动**（持久化 best-effort）。
- `CodeEditor` 文本上限 5MB（edit-spec §7）；超限由 core 回 `TOO_LARGE`，编辑器只读并提示「请选择更小的子树」。
- `onChange` 只更新「Apply 可用/脏标记」**不自动 Apply**；`setDiagnostics` 用 `PARSE` 的 line/column，非法时 Apply 禁用；`destroy()` 解绑事件并释放 CM6 view。

| Adapter | implementation | 用途 |
|---|---|---|
| `ChromeViewStateStore` | `chrome.storage.local`（MV3 唯一 pending 权限 `storage`） | v1 |
| `MemoryViewStateStore` | Map + 可注入失败 | 单测、隐私模式 |
| `Cm6Editor` | CM6 最小集 + `@codemirror/lang-json`（99.4KB gz / 含 lang 142.8KB gz） | v1 表达式 + 子树编辑 |
| `TextareaEditor` | 自研补全/高亮降级（≈1.0KB gz） | 体积预算 <80KB 时的兜底 |

**删除测试**：删掉 → 每个组件自己 `chrome.storage`/`textarea`，容量/配额/降级散落；CM6 与逻辑耦合、体积预算无人守。

## 7. 删除测试汇总

- **S1 Worker 边界**：删掉 → 复杂度平移到每个 view + Worker 生命周期，`core` 只能靠真浏览器测。
- **S2 行窗口源**：删掉 → seq/合并/锚点/版本校验进入 DOM 层，滚动空白与错行只能浏览器测。
- **S3 行渲染器**：删掉 → 行复用与命中/选中态散在 `TreeView`，canvas 替换要重写整棵树。
- **S4 主题/token**：删掉 → 颜色/尺寸硬编码进组件，双主题与 Canvas 调色脱节。
- **S5 持久化/编辑器**：删掉 → 存储与编辑器直接耦合进组件，降级路径不可测。

## 8. 「逻辑不动调渲染」承诺边界

| 想改 | 可调？ | 改它要动哪一层 |
|---|---|---|
| 主题、语法色、命中色、圆角、动效 | ✅ | 只改 `tokens.css` |
| 行高 22–26 | ✅ | CSS + `RowMetrics`（S2 重取窗口） |
| 缩进 12/16、字体/字号、类型列 88、面板/地图尺寸、树阅读宽度（max 1280 居中） | ✅ | CSS/token；容器变化自动触发 `RowMetrics` |
| 单行 DOM 结构 / 渲染器实现（DOM→canvas） | ✅（新 adapter） | `view`（S3）；`viewmodel`/`core` 不动 |
| 存储后端（chrome.storage→memory）/ 编辑器（CM6→textarea） | ✅ | `app`（S5） |
| **可变行高 / 行内换行** | ❌ | 要改协议 `window(start,count)`+`RowModel`+滚动映射+overscan → `core`+`protocol`+`viewmodel` |
| **行模型（flatten 替代 Fenwick）** | ❌ | `core`（`RowModel` + `Row` 形状） |
| **协议形状（命令/回包字段）** | ❌ | `protocol`+`core`+`viewmodel` 同时改 |
| **消息时序（单飞/seq 语义）** | ❌（参数可调，语义不可换） | `viewmodel`（S2） |
| **文档常驻位置（A 换 B 整树）** | ❌ | `app`+`core`+`protocol`+`viewmodel` |

一句话：**「调渲染」= 改 CSS / 换 S3 adapter / 改单行结构**；可变行高、行模型、协议形状都不是调渲染，是改架构。

## 9. 错误模式归属层

| 错误码 | 产生层 | 传播 | 消费与展示 |
|---|---|---|---|
| `STALE_ROW` | `viewmodel`（S2） | 内部丢弃，不冒泡 | 保留上一帧快照、`stale=true`；不弹错 |
| `STALE_ROOT` | `core` 回包 | reply error | `viewmodel` 触发 `invalidate` 重取；用户无感 |
| `STALE_DOC` | `core`（`docRevision` 不匹配） | reply error | 表达式 stale banner「文档已修改，请重新执行」；搜索命中清空 |
| `TOO_LARGE` | `core`（`getNodeJson` >5MB / 文档上限） | reply error | 编辑器只读 +「请选择更小的子树」 |
| `TOO_MANY_ROWS` | `core`（`toggle` 触及 1,000,000 行软预算） | reply error（携带 `totalRows`） | `view` 拒绝展开 + 护栏提示「仅展开前 10 万项 / 先在表达式里过滤」 |
| `PARSE` | `core`（`load`/`replaceNode` 的 parse） | reply error（line/column/message） | 编辑器错误行 + Apply 禁用；`load` 时提示无法解析 |
| `TIMEOUT` / `WORKER_CRASH` | `app`（S1 `CoreTransport`/`onerror`） | 单请求 reject / 全部 pending reject | 超时：`window`/`getTrail` → S2 降级 stale，其余 toast；崩溃：重建 worker 并提示「查看器已恢复，请重新导入」 |
| `CANCELLED` | `core`/`app`（被新 `load` 抢占） | reply error | 按 `loadId` 静默丢弃，无 UI |
| `BAD_PATTERN` | `core`（`search` 的正则模式：语法错 / 超 `SEARCH_PATTERN_MAX` / 灾难性回溯筛查，ADR-0014） | reply error（`message` 已是面向用户的中文） | 搜索面板**内联错误行**（`role=alert` + 输入框 `aria-invalid`）+ 结果/树高亮清空；**不弹 toast**、不算「无命中」 |

原则：**错误在离真相最近的一层产生、在离用户最近的一层展示**——`core` 只说哪条规则不满足，`viewmodel` 决定丢弃还是降级，`view` 决定文案与可操作项；`window`/`getTrail` 超时降级为 stale 等下一次滚动，其余重试一律由用户显式触发（重搜/重跑/重新导入）。
