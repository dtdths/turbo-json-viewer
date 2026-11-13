# 模块架构蓝图（#13）

> 状态：**Accepted**（2026-10-28）
> 决策记录：[ADR-0008](../adr/0008-module-layering-and-seams.md)；接口草案：[seams.md](seams.md)；工程与测试：[build-and-test.md](build-and-test.md)
> 依据：ADR-0001（Worker 常驻 + 行窗口）、ADR-0002（IR/行模型/身份）、ADR-0003/0004（保真/导入/修复）、ADR-0005（技术栈）、ADR-0006（编辑）、ADR-0007（JSON 地图）；规格 `docs/design/{ir-spec,edit-spec,json-map-spec,direction}.md`
> 前置：`prototype/p1`（真机基线）、`prototype/visual/c`（C 视觉定稿）

## 1. 一句话

**主线程只跑 DOM 与视图状态，Worker 常驻文档；两者之间只有一个 seam；渲染层可整体替换而不动逻辑。**

这句话同时给出三个约束：
1. 主线程不持有文档（ADR-0001）——所以核心层必须可脱离 DOM 单测；
2. 主线程与 Worker 之间只有**一个**消息 seam——所以协议必须是一份可判别的类型集合，而不是散落的 `postMessage`；
3. 渲染层与逻辑层之间只有**一个**行渲染 seam——所以「换渲染器 / 调主题 / 改行高」不碰行模型与状态机。

## 2. 分层与依赖方向

```
┌─────────────────────────────── 主线程 ───────────────────────────────┐
│  app        MV3 装配：manifest / page 入口 / worker 入口 / SW /        │
│             传输适配器 / 存储适配器 / 导入入口                          │
│    ↓                                                                 │
│  view       DOM：树视图 + 行渲染器 / 活动栏 / 工具栏 / 状态栏 /         │
│             左右面板 / JSON 地图 / 表达式抽屉 / 子树编辑器              │
│    ↓                                                                 │
│  viewmodel  视图状态：RowWindowSource / 选中 / 命中 / 面板 / 主题 / 编辑 │
└──────────────────────────────────────────────────────────────────────┘
                     ↓ protocol（消息 + 类型 + 版本常量，零依赖）
┌─────────────────────────────── Worker ──────────────────────────────┐
│  core       DocService 门面 / RootStore / RowModel / identity /       │
│             导入·修复·保真 / 搜索 / 表达式 / 编辑历史 / trail / 复制    │
└──────────────────────────────────────────────────────────────────────┘
                     ↑ shared（path、i18n、断言；纯函数，零依赖）
```

| 规则 | 内容 |
|---|---|
| 依赖只向下 | `app → view → viewmodel → protocol ← core`；`core` 只依赖 `protocol`/`shared` |
| view 不碰 core | 视图不知道 Worker 存在，只认 `RowWindowSource` 的 `WindowSnapshot` |
| core 不碰 DOM | Worker 内没有 `document`/`window`；所有渲染数据都是可结构化克隆的普通对象 |
| protocol 零依赖 | 只放类型与常量，任何一层 import 它都安全 |
| app 是唯一装配点 | 只有 app 层知道「用哪个适配器」（Worker 传输、chrome.storage、剪贴板） |

## 3. 模块清单

### 3.1 protocol（共享）

| module | 职责 | 接口（一句话） |
|---|---|---|
| `messages` | 主↔Worker 判别联合：`load/cancelLoad/closeRoot/window/toggle/toggleSubtree/expandTo/expandAll/collapseAll/search/cancelSearch/getNodeJson/copyNode/replaceNode/undo/redo/reset/exportDoc/getTrail/profile/stats/outline/rawOpen/rawWindow/rawLocate/rawSource/rawPathAt/rawOffsetOf/fidelity/eval/complete/exprLocate/setOrder/rowOfPath`（**34 条**）+ 回包/事件 | `type Command` / `type Reply` / `type Event` |
| `types` | `Row`、`RowWindow`、`RawMeta`、`RawWindow`、`OutlineChild`/`OutlineReply`、`MapTrail`、`NodeHandle`、`Path`、`DocumentProfile`、`RepairProvenance` | 纯类型 |
| `versions` | `docRevision` / `rowVersion` / `seq` 的语义与校验谓词；`RAW_CP_EVERY` / `RAW_MAX_LINE_LENGTH` / `RAW_LINE_DISPLAY_MAX` / `OUTLINE_PAGE` / `OUTLINE_PAGE_MAX` / `SORT_ORDER_OPTIONS`（#40 显示顺序三档单一来源） | `isStaleRow(a,b): boolean` |
| `errors` | 错误码：`STALE_ROW`/`STALE_ROOT`/`STALE_DOC`/`TOO_LARGE`/`TOO_MANY_ROWS`/`PARSE`/`TIMEOUT`/`WORKER_CRASH`/`CANCELLED` | 判别联合的 error variant |
| `shared/json-lex` | 零依赖单趟 JSON lexer 原语（`lexToken`/`skipWs`/`lexLine`）；core 的 pretty 行走器与 view 的行高亮共用 | `lexLine(line): Run[]`（0.2µs/行） |
| `shared/highlight` | 搜索命中**区间**计算（纯函数、无 DOM）：大小写不敏感、下标基于原串（ASCII 快路径 / 非 ASCII 走 `giu` 正则避免 `İ` 折叠长度漂移）；DOM 写入在 `view/highlight` | `hitRanges(text, term): HitRange[]` |

### 3.2 core（Worker 内，框架无关、纯 TS 可单测）

| module | 职责 | 接口（一句话） | 深度要点 |
|---|---|---|---|
| `DocService` | 唯一门面：持有 RootStore、路由命令、维护版本、广播事件 | `CoreApi`（见 seams S1） | 15+ 条协议、多根、LRU、编辑历史、取消语义都藏在门面后 |
| `RootStore` | 多根注册表：`doc` / `expr:N` / `repaired`，`docRevision`/`rowVersion`、表达式根 LRU 3 | 已实现 `get/require/ids/values/put/touch/delete/clear`；**`release`/`markStale` 仍是草案**（多文档需补 `close`，见 §12、ADR-0009） | 根坐标与生命周期 |
| `RowModel` | 可见行模型：per-open 容器 Fenwick、窗口下潜、toggle、**子树批量 toggle（#22）**、replaceNode 增量更新、path↔行号、**子键显示顺序（#40 / ADR-0024：`keysOf` 为显示 slot 序唯一来源，懒排序 + setOrder 重建 Fenwick）** | `window/toggle/toggleSubtree/replaceNode/rowOfPath/totalRows/setOrder/sortOrder` | 固定行高坐标、O(depth·log n)；子树操作单趟后序重建、原子预算；显示序是根级视图状态、值图与路径不变 |
| `identity` | 懒 id（容器）+ `(parent, slot)` 标量句柄；路径⇄句柄；不建全局 parentMap | `idOf/handleAt/pathOf` | 双格式（路径持久化、id 运行期） |
| `ImportPipeline` | `arrayBuffer`→`TextDecoder`→**无损 parser**（ADR-0020：整数超安全范围用 BigInt）；截断闭合+provenance；**源文本保留**（ADR-0003 修订） | `load(input): LoadResult { value, meta, text }` | 源文本留给原文视图/复制原文 |
| `RawText` | 原文行索引三模式（source/pretty/plain）+ 检查点 + `locate`；惰性构建、不物化全文 | `buildRawIndex(text,{damaged})` / `rawOpen` / `rawWindow` / `rawLocate` / `rawSource` | 每 2048 行一个检查点（50MB 19.5KiB）；窗口 p95 0.084ms |
| `Outline` | 大纲页枚举：按容器**分页**返回子项（键/类型/项数/路径），不建第二棵树、不缓存、不看树展开态；**键序跟随显示排序（#40 / ADR-0024）** | `outlinePage(node, path, start, count, order)` / `outline` 命令 | 每页 O(子项数)；10MB 样本 200 项页 <1ms（ADR-0013） |
| `Search` | 全文档键/值扫描 → 命中集合（不建根、不扫 DOM） | `search(root, q, opts): HitSet` | 可取消、渐进返回 |
| `Fidelity` | 源文本保真扫描（#23 / ADR-0020）：单趟线性、每 256KB **宏任务**让出、可取消；报上/下溢 + 整数键重排（**整数精度流失已退场**——无损 parser 保证；数字判定与 parser 共用 `analyzeNumberLiteral`） | `scanFidelity(text, opts): Promise<FidelityReport \| null>` / `fidelity` 命令 | 不碰值图/行模型；报告按根对象身份缓存（`WeakMap`，编辑不重扫）；只留源顺序前 100 条片段 |
| `Expr` | acorn AST + 白名单 walker + 时间/步数/结果预算 → 新根 | `eval(expr, root): ExprResult` | 无 eval/WASM |
| `EditHistory` | `replaceNode` 的 undo/redo/reset（深度 100，old/new 快照） | `apply/undo/redo/reset` | 与行模型增量更新同事务 |
| `Trail` | 选中节点 → `MapTrail`（O(depth)，兄弟 ±2） | `trail(root, path)` | 不遍历全文档 |
| `Copy` | 子树 JSON / 路径 / 原值 / 键名 | `copy(root, handle, fmt)` | 大子树预算 |
| `Measure` | 子树 JSON 体积的**字符数下界**预扫描（显式栈、分配无关、跨预算早停；BigInt 按十进制串长度计下界） | `jsonSizeLowerBoundChars(value, limit): number` | `getNodeJson` 5MB 守卫在 stringify 前拒绝超大子树（下界 ≤ 真实字节数 ⇒ 零误拒） |
| `NumberLiteral` | JSON 数字字面量的**无损判定**单一来源（ADR-0020）：整数超安全范围 → BigInt；整数展开位数 > 10000 → Infinity；小数仍 Number | `analyzeNumberLiteral(lit): NumberLiteralInfo` | parser 与 fidelity 共用，禁止两处规则漂移 |
| `LosslessJson` | 无损 JSON 解析/序列化/深相等（ADR-0020）：显式栈非递归、字符串自解码、`__proto__` 安全、与 `JSON.parse` 语法接受面逐例对拍；BigInt 序列化为裸十进制数字 | `parseLossless(text)` / `serializeLossless(value, indent?)` / `deepEqualJson(a,b)` | 替换 `JSON.parse` 作为导入唯一真相源；序列化器替代 5 处产品 `JSON.stringify` |
| `Profile` | Document Profile 采样（键/路径样本、类型计数） | `profile(root)` | 异步、不阻塞首帧 |

### 3.3 viewmodel（主线程，无 DOM）

| module | 职责 | 接口（一句话） |
|---|---|---|
| `WindowMachine` | 窗口状态机（ADR-0008 修订 2026-11-09）：几何（overscan / 方向预取 / 上限）+ 单飞 + 合并 + `epoch` + `seq` 丢弃 + stale 帧 + 锚点；过期重试统一（上限 3）；只此一份实现 | adapter 供 `fetchWindow/validate/toSnapshot/emptySnapshot`；快照由 adapter 决定（`WindowSnapshot` / `RawSnapshot`） |
| `RowWindowSource` | **树**的行窗口 adapter：组合 `WindowMachine`；开方向预取 / 3 屏上限 / `rowVersion` 校验 / 锚点 | `setMetrics/scrollTo/requestWindow/snapshot/subscribe/invalidate/anchor/restoreAnchor`；快照 `WindowSnapshot { rows, totalRows, start, rowVersion, stale }` |
| `RawWindowSource` | **原文**窗口 adapter（ADR-0003 修订）：组合 `WindowMachine`；关预取、无 `rowVersion`；`open()` 异步两拍 + `ready` 门、`alignTruncated` 留在自身 | `open(rootId)`/`setMetrics/scrollTo/requestWindow/snapshot/subscribe/clear`；快照 `RawSnapshot { mode, lines, start, totalLines, stale }` |
| `Selection` | 当前选中 `NodeHandle` + 键盘导航意图 | `select/handle/onChange` |
| `SearchState` | 命中集合（全部/过滤）、当前命中、`docRevision` 过期判定、结果列表虚拟窗口 | `begin/apply/markStale/next/prev/view/window` |
| `OutlineState` | 大纲面板状态机（ADR-0013）：按容器分页缓存 + 展开集合 + 扁平化 + epoch 丢弃 + 单飞；`open/refresh/setOpen/toggle/loadMore/setSelected/close/view` | `view(): OutlineView`；面板只读快照，数据源注入 `OutlineSource` |
| `PanelState` | C 布局：活动栏选中项、左面板开合、右工作区开合与模块可见性 | `setPanel/toggleRail` |
| `ThemeState` | 主题 + 视图状态持久化（经 `ViewStateStore`） | `get/set/subscribe` |
| `EditState` | 修改计数、undo/redo 可用性、stale banner | `onMutation/undo/redo/reset` |

### 3.4 view（DOM）

| module | 职责 | 接口（一句话） |
|---|---|---|
| `TreeView` | 树容器：行池、滚动、选中、命中、a11y activedescendant、锚定 | `render(snapshot)` + `events(TreeIntent)` |
| `RawView` | 原文视图容器（ADR-0003 修订）：固定行高虚拟化 + 行号 gutter + 横向滚动 + 屏内行高亮 | `render(rawSnapshot)` + `flashLine(line)` + `onScroll(px)` |
| `RowRenderer` | 单行渲染适配器（v1 = DOM 节点池 + textContent）；命中态走 `RowContext.hit` | `create/update/setSelected/destroy` |
| `highlight` | `<mark class="row__hit|result__hit">` 写入器（全走 textContent/createElement，禁 innerHTML）；树行与搜索结果**共用一份** | `writeMarkedText(el, text, term, markClass)` |
| `ActivityBar` / `Toolbar` / `StatusBar` | 外壳：模式切换、文档动作、只读信息 | 事件上抛给 app/viewmodel |
| `SearchPanel` / `OutlinePanel` / `SettingsPanel` | 左面板（C） | `setModel(model)` + 意图 |
| `SelectionPanel` / `ProfilePanel` / `EditsPanel` | 右工作区模块（C） | 同上 |
| `JsonMapView` | Canvas 层级塔（DPR/主题适配、文本兜底） | `draw(trail)` |
| `ExprDrawer` / `SubtreeEditor` | CM6 宿主（经 `CodeEditor` 适配器） | `open/close/apply` |
| `EmptyState` / `RepairBanner` | 空态、修复提示 | 静态 + 关闭意图 |
| `NoticeBar` | 常驻提示条公共行为（体积提示 / 保真提示共用）：显隐 + 文案 + 动作按钮 + 关闭 | `show(text)/hide()/setActionVisible()/onAction()` |

### 3.5 app（装配）

| module | 职责 |
|---|---|
| `page` | 创建 worker、实例化 `WorkerTransport`、`ChromeViewStateStore`、装配 viewmodel + view |
| `worker` | Worker 入口：实例化 `DocService` + 传输适配器（`onmessage` → `dispatch`）；事件只从 ctrl 通道单次派发 |
| `transport/worker-transport` | `CoreTransport` 生产适配器：ctrl/win 双通道、超时、`WORKER_CRASH`（`onerror`/`onmessageerror`）、`CLOSED` 幂等关闭 |
| `transport/in-process-core` | `InProcessCore`（ModelInProcess）：`commandCore` + 直接 `DocService.dispatch`，供 `tests/contract` 与 bench；不进生产 bundle |
| `sw` | 最小 Service Worker：`action.onClicked → tabs.create(page.html)`，不持文档状态 |
| `import` | paste / 文件选择+拖放 / 剪贴板；`arrayBuffer` transfer，文本永不进 DOM |

## 4. 四条关键数据流

**导入**（零 long task）
```
page: file.arrayBuffer() ──transfer──▶ worker: TextDecoder → parseLossless（ADR-0020）
                                        → Root(doc) + 首屏可见行（默认折叠）
page: 请求首窗口 ────────────────────▶ worker: RowModel.window(0, 40)
page: 提交行 DOM（双 rAF 后统计首帧）
异步：保真扫描 → 小报告；Profile 采样；源文本释放
```

**导入路由**（2026-10-30，ADR-0004 修订 / #11）：粘贴、拖放只在**初始空态或导入层内**生效；
文档已打开时由「导入」/`⌘O`/外部拖放打开**导入层**（显式替换层），层内获取路径解析成功即替换、
失败留在层内且原文档保留；层关闭时页面级 `⌘V` 不导入（输入控件内仍原生粘贴）。

**滚动 / 展开**
```
TreeView 滚动 → RowWindowSource（合并目标、单飞）→ WorkerTransport.request(window)
→ core.RowModel.window → Row[]（40 行 ≈3.1KB）→ RowWindowSource 校验 seq/rowVersion
→ RowRenderer 复用行节点 → 提交
toggle：view → RowWindowSource → core.toggle → rowVersion++ → 重取窗口 → 锚点换算
```

**搜索**
```
SearchPanel 输入 → SearchState → core.search → HitSet(docRevision)
→ 左面板虚拟列表；跳转 = 展开祖先链（core）→ rowOfPath → scrollTo → 选中高亮
文档修改后：HitSet.docRevision 不匹配 → 清空并提示重搜
```

**编辑**
```
SubtreeEditor 打开：core.getNodeJson(path) → CodeEditor.setValue(pretty JSON)
Apply：core.replaceNode(path, jsonText) → parseLossless（≤5MB；ADR-0020）→ 替换值图
→ docRevision++ / rowVersion++ → RowModel 增量更新 → EditHistory.push
→ 视图重取窗口 + 选中替换节点 + 修改计数 + 搜索清空/表达式 stale
```

## 5. Seam 清单（细节见 [seams.md](seams.md)）

| # | 位置 | 接口 | v1 适配器 | 测试替身 |
|---|---|---|---|---|
| S1 | 主线程 ↔ Worker | `CoreApi` 门面 + `CoreTransport` | `WorkerTransport`（MessageChannel） | `InProcessTransport`、`FakeTransport` |
| S2 | viewmodel → view | `RowWindowSource.snapshot()` / `RawWindowSource.snapshot()` | `WindowMachine` + row/raw adapter | 伪 `CoreApi`（脚本化 seq / 版本 / 错误） |
| S3 | TreeView → 单行 | `RowRenderer` | DOM 行池 + textContent | 记录型 renderer |
| S4 | 全局 → CSS | `data-theme` + token 变量 + `RowMetrics` | `tokens.css` | 测试 fixture token 表 |
| S5 | 全局 → 持久化/编辑器 | `ViewStateStore`、`CodeEditor` | chrome.storage.local、CM6 | memory store、textarea |

## 6. 深度：这些模块为什么值得存在

- **`DocService`**：调用方只学一个 `CoreApi`，背后是 15+ 条协议、4 种根、两套版本号、LRU、取消与逐出。删掉它，这些复杂度会平移到传输层与视图层各一份。
- **`RowModel`**：4 个方法（`window/toggle/replaceNode/rowOfPath`）背后是 Fenwick、懒 id、句柄、路径、增量替换。删掉它，每个调用点都要自己算可见行。
- **`RowWindowSource`**：3 个方法背后是单飞、合并、`seq` 丢弃、版本校验、overscan、方向预取、滚动锚点。删掉它，每次滚动都可能出空白帧或错行。
- **`TreeView`**：`render(snapshot)` + 事件背后是行池复用、a11y、键盘、锚定。删掉它，视图逻辑会散进视图模型。
- **`RowRenderer`**：一行的方法表背后是可替换的渲染策略（DOM/canvas）；这是「逻辑不动调渲染」的唯一开关。

## 7. 渲染深度调优口（摘要）

| 想改 | 改哪里 | 动不动逻辑 |
|---|---|---|
| 主题 / 语法色 / 命中色 | `tokens.css`（`data-theme`） | 不动 |
| 行高（22–26）/ 缩进 / 字体 | CSS 变量 + `RowMetrics`（唯一进入逻辑层的数据） | 不动 |
| 类型列 / 面板宽度 / 地图尺寸 | CSS 变量（`--type-col-w` 等） | 不动 |
| 单行内容结构（key/value/count/actions） | `RowRenderer.update` | 不动 |
| 渲染器类型（DOM → canvas） | 实现新的 `RowRenderer` 适配器 | 不动 |
| **可变行高 / 换行** | 不可调——需改行模型与滚动映射（ADR-0001） | 破坏架构 |
| **协议形状 / 消息时序** | 不可调——core 与 viewmodel 同时改 | 破坏 seam |

## 8. 工程与测试（细节见 [build-and-test.md](build-and-test.md)）

- 构建：esbuild 三入口（page/worker/sw）+ code splitting，CM6 懒加载；首屏 ≤50KB gz（2026-11-12 用户拍板：48 → 50，归因见 ADR-0021「预算」；此前 47 → 48 见 ADR-0003 修订（#31）与 ADR-0019「预算」）、懒加载 chunk 合计 ≤146KB gz（2026-11-10 用户拍板：140 → 146，+5.4 全部来自 `@codemirror/autocomplete`，见 ADR-0018「预算修订」）；`worker.js` **无硬预算**（ADR-0020 起记录：无损 parser + BigInt 值模型实测 61.1 → 63.2KB gz，+2.1；2026-11-12 6.25 导出转义选项 63.3 → **63.5**，+0.2；6.26 搜索目标扩展 63.5 不变）。
- 测试三层：vitest 单测（core/viewmodel/protocol）→ `CoreTransport` 契约测试（InProcess vs Worker）→ 真机 harness（DOM/长任务/滚动/DPR）+ 性能基准 + 视觉基线。
- 文档不落盘、无网络、禁 eval、仅 `storage` 权限（红线复核见 ADR-0004/0005 与 build-and-test.md）。

## 9. 决策索引

| ADR | 与本文的关系 |
|---|---|
| 0001 | 行窗口协议与滚动映射 → S2/S3 的固定行高契约 |
| 0002 | 行模型/身份 → `RowModel`/`identity` 的实现约束 |
| 0003 | 保真与源文本释放 → `ImportPipeline` 边界 |
| 0004 | 导入 transfer + 修复 provenance → `app/import` 与 `ImportPipeline` |
| 0005 | 原生 TS/esbuild/CM6/DOM 行池 → S3/S5 与构建预算 |
| 0006 | 子树编辑 → `DocService.replaceNode` + `EditHistory` |
| 0007 | JSON 地图 → `Trail` + `JsonMapView` |
| **0008** | **本蓝图的分层与 seam 决策** |

## 10. 落地顺序（第一块可跑骨架）

| 步 | 内容 | 验收 |
|---|---|---|
| 1 | `protocol` + `CoreApi` + `InProcessTransport` + `DocService` 空壳 | 单测跑通 load/window/toggle 路由 |
| 2 | `RowModel` + `identity` + path | 184,913 行窗口 p95 ≤0.2ms、toggle 一次性 ≤10ms |
| 3 | page 外壳（活动栏/工具栏/状态栏）+ `TreeView` + `RowRenderer` + `RowWindowSource` + `WorkerTransport` | 10MB 首帧 <800ms、主线程无 >50ms 长任务 |
| 4 | 搜索面板 + 命中跳转 | `.mock/1.json` 搜索 <100ms、跳转 1 帧内 |
| 5 | 子树编辑器 + `replaceNode` + undo | Apply 后行窗口/复制/导出一致；S1 展开语义 |
| 6 | 表达式 + JSON 地图 + Profile（v1.1 项） | 表达式结果根 LRU 3；地图选中跟随 |

每步都以 `prototype/p1` 的 bench 脚本作为回归入口，不另造测量口径。

## 11. 实现进度（2026-10-29 slice 1–4；2026-11-02 展开/收起 + 复制；2026-11-03 行尾浮条 + 截断修复 + 设置 + 导出方式 + 原始文本视图 + 大纲面板；2026-11-09 搜索选项 Aa/正则 + 导入体积提示 + 树/展开小件 + 保真提示 + 技术债 T2 + 子树批量展开/收起 + 窗口状态机收口 + 一条根变更路径 + app 回包落地 + 测试钩子移出 + 展开态 path 口径；2026-11-10 搜索语义单一 oracle + 菜单交互收口（ADR-0015）；2026-11-10 视觉口径与组件统一（#21 / ADR-0016）；2026-11-10 响应式断点 ≤1320（#25 / ADR-0017）；2026-11-10 搜索结果双击复制（#26 / ADR-0010 + ADR-0011 修订）；2026-11-10 表达式视图（#27 / ADR-0018）；2026-11-11 多文档工作区标签（#18 / ADR-0009）；2026-11-11 原文视图 ↔ 树视图双向定位（#30 / ADR-0019）；2026-11-11 保真条多命中导航 + 精确对照（#23 修订 / #31））

| 步 | 状态 | 证据 / 备注 |
|---|---|---|
| 1 `protocol` + `CoreApi` + `DocService` 路由 | ✅ | `src/protocol/{types,messages,errors,versions,core-api}.ts`、`src/core/doc-service.ts`；InProcess 适配器 = `commandCore` + `DocService` |
| 2 `RowModel`(Fenwick)/identity/path | ✅ | `src/core/row-model.ts`（per-open Fenwick + lowerBound 下潜）、`src/shared/path.ts`；core 60 用例、viewmodel 15 用例全绿 |
| 3 page 外壳 + `TreeView`/`RowRenderer` + `RowWindowSource` + `WorkerTransport` | ✅ | 10MB 首帧（load→首行）**58ms**、50MB **246ms**；主线程长任务 **0**；滚动换窗 start 14,869 @ scrollTop 357k px |
| 4 搜索面板 + 命中跳转 | ✅ | `viewmodel/search-state.ts`（begin/apply + seq/docRevision 过期 + 过滤 + 虚拟窗口，36 用例）、`view/panels/search-panel.ts`（44px 两行虚拟结果列表 + C 样式）、`app/main.ts` 接线（上下条 / Enter / ⌘G / F3 / 树命中高亮 + `<mark>`）；`.mock/1.json` `hotel` 27.3ms/186 命中，10MB `hotel` 91.3ms/50,000 截断（raw 74,378），跳转 2.7ms，列表滚动渲染恒 22 行、0 长任务 |
| 4.5 全部展开 / 全部收起 + 小文档自适应展开（#9 / ADR-0002 修订） | ✅ | `RowModel.countAllExpandedRows/expandAll/expandIfAtMost/collapseAll` + `DocService` 的 `expandAll`/`collapseAll` 命令（changed 才 `rowVersion++`）+ `load` 自适应（≤500 节点全展开，带限计数早停 0.14ms）；顶部工具栏两个图标按钮（`#expandAllBtn`/`#collapseAllBtn`，无快捷键）；**单测 137**（新增 21） |
| 5 子树编辑 + undo + 导出（#16 / ADR-0006） | ✅ | `core/edit-history.ts`（深度 100、redo 截断、LIFO reset）+ `DocService` 的 `getNodeJson/replaceNode/undo/redo/reset/exportDoc`（5MB `TOO_LARGE`、`PARSE` 带行列、no-op 不推进版本、`STALE_DOC` 守卫、每根一份历史）；`viewmodel/edit-state.ts` + 树意图（dblclick / 右键菜单 / F2 / `setChangedPath`）；`view/panels/{code-editor,subtree-editor}.ts`（CM6 懒加载、lint 门控 Apply、720×520 弹层）；`main.ts` 接线（徽标 / ⌘Z ⇧⌘Z / 重置 / `-edited` 导出 / 未保存确认）；**单测 177** |
| 5.5 复制 4 格式（#9 / ADR-0010） | ✅ | `core/copy.ts`（四格式文本统一生成：子树 JSON 2 空格 / 规范路径 / 标量原值 / 键名）+ `DocService.copyNode`（**只读**，不推进 `docRevision`/`rowVersion`；子树 JSON 5MB `TOO_LARGE`）；行右键菜单 5 项（容器禁用「原始值」、根禁用「键名」，`title` 说明）+ ↑↓/Home/End 键盘 + 行尾操作浮条（复制子树 JSON 快路径 / 编辑弹层，鼠标专用 `tabindex="-1"`）；零权限剪贴板（`navigator.clipboard.writeText` → `execCommand` 回退 → toast 提示手动），**不声明 `clipboardWrite`**；**单测 199**（新增 22） |
| 6.0 截断修复（#8 / ADR-0004 修订） | ✅ | `core/repair.ts` 单趟状态机（§6.2 六条规则；**只语法闭合、不猜内容**；末尾自校验 `JSON.parse`；拒绝态 `not-eof`/`still-invalid`）→ `import.ts` **仅在 PARSE 失败时**调用并挂 `meta.repair`，`doc-service` 补发既有 `repair` 事件；`RepairProvenance` 按 §6.3（`status`/`counts`/`ops`/`summaryText`）；顶部修复条 **32px**（摘要逐条展开 + 关闭，`role=status`/`aria-live=polite`）+ 状态栏「已修复截断」角标 + 导出 `-truncated-repaired` 后缀；**单测 254**（+55：repair 51 / doc-service 4）；冒烟 `smoke-repair` **14/14** |
| 6.1 设置面板 + 视图状态持久化（ADR-0011 / S5 接线） | ✅ | `viewmodel/settings-state.ts`（**9 项设置** + 布局态；校验回落/写穿/订阅，`tjv.settings.v1`/`tjv.ui.v1`）+ `view/panels/settings-panel.ts`（**9 行**，segmented/checkbox，`data-setting`/`data-value`）+ `app/storage.ts` 接线（启动 `await load`）；行高 `RowMetricsSource`（`TreeView.setRowHeight` + `--row-h` + `setMetrics`）、缩进 `--row-indent`、类型列 `setTypeColumn`、默认复制格式/复制缩进（`copyNode.indent`）、修复与自适应开关（`load.opts`）；主题/右栏/左面板模式持久化；**修复**：空态遮罩（fixed z30）盖住左面板导致「初始视图点齿轮无效」→ 左面板 `z-index:31`、设置图标由「圆+射线（像太阳）」改竖排滑杆；**单测 273**（+19）；冒烟 `smoke-settings` **21/21**（含空态点齿轮回归 2 项 + 导出方式第 9 项） |
| 6.2 导出分体按钮：下载文件 / 复制到剪贴板（ADR-0012） | ✅ | `viewmodel/export-state.ts`（方式枚举/校验 + 20MB 剪贴板守卫 + 面板文案）+ `main.ts` 分体按钮（主=上次方式、箭头菜单两项、勾选、↑↓/Esc、外部点击关闭）；`exportMode` 是**设置项**（`Settings.exportMode`，`tjv.settings.v1`），设置面板第 9 行与分体按钮菜单**双向同步**（同一 `SettingsState`，ADR-0012 修订）；复制文本 = `core.exportDoc(rootId, 2)` 同一份（含临时修改/修复后值图），复用零权限剪贴板；超限 toast 引导文件导出；**单测 281**（+8）；冒烟 `smoke-export` **16/16**（含双向同步 2 项） |
| 6.3 原始文本视图（#11 / ADR-0003 修订 2026-11-03） | ✅ | `core/raw-text.ts`（`probeText` + `RawTextIndex`：**source/pretty/plain** 三模式、检查点 `Int32Array` 每 2048 行、惰性 build、`windowText` 单行 ≤4096 截断、`locate` 偏移→1-based 行）+ `import.ts` 返回源文本、`Root.source` 保留（文档替换即释放）；`DocService` 新增 **rawOpen/rawWindow/rawLocate/rawSource**（只读、不推版本，`rawSource` >maxBytes 抛 `TOO_LARGE`）；`viewmodel/raw-window-source.ts`（单飞/合并/seq 丢弃/epoch；无 rowVersion）+ `view/raw/raw-view.ts`（固定行高虚拟化 + 行号 gutter + 横向滚动 + `lexLine` 屏内高亮 + flash）；工具栏 `[树|原文]` 分段切换（`UiState.viewMode` 持久化）、视图内提示（plain/minified/不含临时修改）、修复摘要 `at` 可点击跳行、复制原文（20MB 守卫）；`shared/json-lex.ts` 一份 lexer 供 core 行走器与 view 高亮共用；**单测 354**（新增 73：raw-text 35 / raw-window-source 18 / doc-service 10 / json-lex 10）；冒烟 `smoke-raw` **25/25** |
| 6.4 大纲面板（ADR-0013 / #24，2026-11-03） | ✅ | `core/outline.ts`（`outlinePage` 纯函数：容器子项**按需分页**、clamp、标量回空、`appendKey/appendIndex` 路径；不建树/不缓存）+ `DocService.outline`（只读、不推版本，`rowModel.valueAt` 解析路径 → `BAD_COMMAND`）；`viewmodel/outline-state.ts`（每容器页缓存 + 展开集合 + 脏标记扁平化 + epoch 丢弃迟到回包 + 单飞 + `computeOutlineWindow`）；`view/panels/outline-panel.{ts,css}`（行池虚拟列表、行高跟随设置、overscan 6、caret/行点击/键盘 ↑↓←→/Enter/Home/End、`role=tree`/`treeitem`、分页哨兵、`#outlineEmpty`/`#outlineFoot`）；活动栏第 3 模式 + `UiState.panel` 持久化；`jumpToPath` 从 `gotoHit` 抽出（搜索/大纲共用跳转链路）；编辑（`docRevision` 变化）→ 回根展开；**单测 410**（+56：outline core 12 / doc-service 12 / outline-state 32）；冒烟 `smoke-outline` **53/53**（含 10MB 性能、键盘翻页、大文档 expandTo/居中、行高跟随、关闭重开、0 长任务） |
| 6.5 搜索选项 `Aa`/正则 + 导入体积提示 + `#9` 两小件（ADR-0014 / #10 #11 #9，2026-11-09） | ✅ | `core/search.ts`：`opts.regex` 模式（`new RegExp`、`Aa` → `i` flag）、`SEARCH_PATTERN_MAX=256` 长度守卫、灾难性回溯静态筛查（只拒**外层无界重复量词**，`(a+)+` 拒 / `(foo|bar)+` 放行）、`BAD_PATTERN` 错误码；子串路径零改动。`viewmodel/search-state.ts`：`begin(query, opts)` 快照 + `markPatternError(message)`（置错清结果回 idle）。`view/panels/search-panel.{ts,css}`：`#searchCase`/`#searchRegex` 两个 `aria-pressed` 切换（Tab 顺序在查询框后）、`#searchPatternError` 内联错误行（`role=alert`、输入框 `aria-invalid`）。`app/main.ts`：`searchOpts` 为唯一会话态（切换即重跑、**不持久化**）、`BAD_PATTERN` → 内联错误（不弹 toast）。**导入体积提示**：`LARGE_DOC_WARN_BYTES=50_000_000` + `#docWarnBar`（32px warn 条、`role=status`、可关闭只关条、换文档按新 `meta.bytes` 重新判定、十进制 MB 文案；**不阻断导入、不加协议字段**）。**#9 两小件**：树行项数标 `.row__count.is-clickable`（点击 = toggle、不改选中、不进 Tab 序列、双击不误触编辑）+ 「全部展开/收起」no-op → info toast 且不换版本。**单测 440**（+30：search core 32 / search-state 48）；冒烟 `smoke-search` **94/94**（+12）、`smoke-expand` **14/14**（+3） |
| 6.6 保真提示（#23 / ADR-0003 修订 2026-11-09） | ✅ | `core/fidelity.ts`（**新建**：单趟 charCode 扫描源文本，无递归/无逐字符正则；字符串整段跳过；对象键**先解 JSON 转义**再判下标样式；整数 >15 位用 `BigInt(lit) !== BigInt(Number(lit))` 精确判定，另报 `1e400` 上溢 / `1e-400` 下溢；每 256K 字符让出事件循环（宏任务）、可取消；只留前 100 条片段 + 全量 `counts`）+ `DocService.fidelity`（**只读**、不推版本；`WeakMap<Root, report>` 按根身份缓存 = 编辑不重扫；文档替换 → `CANCELLED`）+ 协议 `fidelity {rootId}` / `FidelityReply` / `FidelityHit|FidelityReport`；app 侧 `requestIdleCallback`（2s 兜底）首帧后拉取 + `fidelitySeq`+rootId 丢弃迟到回包 + 第三条 32px 保真条 `#fidelityBar`（精确数量文案、「查看原文」= 切原文 + `rawLocate(hits[0].offset)` + 行 flash，与修复 `at` 同一链路；`×` 只关条）；dev hooks `fidelityState/fidelityJump/fidelityClose`；**code review 收口（2026-11-09）**：`counts` 按类别拆 `precision/overflow/underflow`（文案不再把上溢/下溢标成「大整数精度」）、带指数尾数精度纳入检测（十进制规范化比对）、重复下标键不参与键序判定、截断改为「源顺序最靠前 100 条」（有序插入 + 淘汰最大 offset）、`now/roundMs` 抽 `shared/timing`、`FIDELITY_YIELD_CHARS` 改名、冒烟截图检查改为真断言；**第二轮技术债清理**：两条提示条抽 `view/panels/notice-bar.ts` + `.noticebar*` CSS、`Frame` 改判别联合、删掉永不产出的 `skipped` 字段、去掉 Middle Man；**单测 486**（fidelity 38 / doc-service 8 追加）；冒烟 `smoke-fidelity` **24/24**（新增；含与修复条并存层序、10MB 首帧/0 长任务） |
| 6.7 子树批量展开/收起（#22 / ADR-0002 修订 + ADR-0010 修订 2026-11-09） | ✅ | `RowModel.toggleSubtree`（**新建**：展开 = 本节点 + 子树内所有**非空**容器进 `expanded` 并建 Fenwick（与 `expandAll` 同口径），**单趟迭代后序只重建子树索引**、祖先链一次 `propagate`，子树外状态不动；收起 = **深度复位**（子树容器全出 `expanded`、释放索引，下次展开只剩一层）；dry-run `countAllExpandedRows(子树, rowBudget)` → 超 `ROW_BUDGET` 抛 `TOO_MANY_ROWS` **零部分修改**；根/空容器 no-op、标量 `BAD_COMMAND`；只有可见结果变化才 `changed`（不可见惰性复位不推版本）；2000 层不爆栈）+ `DocService.toggleSubtree`（changed 才推 `rowVersion`、`docRevision` 不变）+ 协议 `toggleSubtree {rootId,path,open}`（**26 条命令**）；右键菜单 5 → **7 项**（复制组 / ── / 展开整棵子树 / 收起整棵子树 / ── / 编辑），启用态按行窗口数据（`TreeView.onContextMenu` 改传整行 `Row`、新增 `rowInfo(path)` 给 dev hook 共用，不再从 DOM 反查 `data-kind`），`title` 写「含该节点自身；不含更上层」/禁用原因；app 接线 `toggleSubtree()`：**不滚回顶部**（保持锚点与选中，与「全部展开」的 Q7 回顶不同）、no-op 给 info toast、原文视图下先切回树；**单测 581**（row-model +17 / doc-service +3 / 契约 +1×2 适配器）；冒烟 `smoke-expand` **20/20**（新增 6 项：菜单契约 / 递归展开 / no-op / 深度复位 / 兄弟子树不受影响 / 50MB 子树预算原子拒绝）、`smoke-copy` **28/28**（菜单 7 项顺序 + 空容器·标量·根启用矩阵） |
| 6.8 窗口状态机收口（ADR-0008 修订 2026-11-09） | ✅ | `viewmodel/window-machine.ts`（**新建**：`WindowMachine<P>` 收口 S2 规则——几何（overscan / 方向预取 / 单屏上限，per-adapter 配置）、单飞 + 合并、`epoch`、`seq` 丢弃、stale 帧、空窗口帧、滚动锚点、统一过期重试上限 3；`RowWindowSource`/`RawWindowSource` 保留原 interface、退化为 adapter（`fetchWindow`/`validate`/`toSnapshot`/`frame`），raw 的两拍 `open`（rawOpen → 首窗）+ ready 门与 `alignTruncated` 留在自身；新增 `tests/unit/viewmodel/window-source.contract.ts` **一份共享契约 × 两个 adapter**；**单测 584**（row 16 / raw 21，删掉两套重复 describe；契约 11 条）| 纯 refactor，公开 interface / 用户可见行为不变（唯一内部变化：`STALE_DOC` 也自动重取、上限 3，row 不再永久 stale）；「S2 两份实现」已知差距清账 |
| 6.9 一条根变更路径（ADR-0002 修订 2026-11-09） | ✅ | `DocService` 私有 `mutateRoot(root, mutation)`：8 条 `EditReply` 命令（toggle / toggleSubtree / expandAll / collapseAll / replaceNode / undo / redo / reset）共用——应用变更 → 按意图（`view` / `value`）推版本 → 组装形状恒定的 `EditReply`；协议 **`EditReply.history` 升为必填**（4 条展开态回包不再另成方言，消除「展开把『已修改 N 处』清零」的契约缺陷）；`reset` = `value` 多步（N 步各推两版本，迟到窗口回包仍 stale）；`expandTo` 独立 `ExpandReply` 不在路径内；新增 `tests/unit/core/root-mutation.test.ts` **版本矩阵 + 形状契约 15 条**；**单测 601**（586 → 601，+15；13 套冒烟全绿）| 纯 refactor，用户可见行为不变（协议上 4 条展开态回包多一个 `history` 字段，app 当前不读）；剩余：app 侧回包落地 → **6.10 已收口** |
| 6.10 app 回包落地收成文档会话（ADR-0008 修订 2026-11-09） | ✅ | `src/app/doc-session.ts`（**新建**：纯 TS、零 DOM）持有 `rootId`/`docRevision`/`rowVersion`/`totalRows` 四个会话字段，`land(reply, intent, ctx)` 按 6 种意图（document/toggle/subtree/expandAll/edit/jump）返回纯数据 `LandingPlan`（滚动策略/重推命中/大纲刷新/搜索 stale/选中/闪改）；`main.ts` 只剩唯一执行器 `applyLanding(plan)`，6 个回包站点（onLoaded/toggleNode/toggleSubtree/applyExpandAll/applyModelReply/jumpToPath）退化为薄调用；no-op 判据统一为 `plan.changed`（删两处手抄 `rowVersionBefore`）；`onLoaded` 的文档切换专属步骤留在 handler；新增 `tests/unit/app/doc-session.test.ts` 14 条；**单测 619**（601 → 619：评审加固 4 + 会话 14）| 纯 refactor，用户可见行为不变（load 回顶改走 `setRoot({scrollTopPx:0})`，少一次在途请求）；13 套冒烟全绿 |
| 6.11 测试钩子移出 main.ts（ADR-0008 修订 2026-11-09） | ✅ | `src/app/dev-hook.ts`（**新建**：`createDevHook(deps)` 纯工厂 + `installDevHook`；`DevHook` interface 钉住 58 个成员）+ `main.ts` 只留 `buildDevHookDeps()` 装配表与 `if (!isExtension) installDevHook(...)`；`main.ts` **2321 → 1979 行**；hook 只做转发 + 组装快照，不再重写入口 / 直连 core / 从全局 DOM 反推；模块自报状态（`TreeView.currentRowRendered/typeColumnVisible/spacerHeight`、`SearchPanel.state()`、`RawView.renderedLines/flashedLine`、大纲开合走 `settings.uiState().panel`），保留 computed style 视觉探针；新增 `tests/unit/app/dev-hook.test.ts` 10 条（node env + fake deps）；**单测 629**（619 → 629）| 纯 refactor，用户可见行为不变；`window.__tjv` 58 成员逐字保持、13 套冒烟零改动（`setup:hook-contract` missing=[]、`smoke-extension` 仍断言 hook 不存在）；体积 `page.js` 31.9 → **33.0KB gz**（+1.1，预算 45 未动）|
| 6.12 展开态改 path 口径（ADR-0002 修订 2026-11-09） | ✅ | `RowModel.expanded` 转私有；新增 `isOpenAt(path)`（根恒 open / 标量·折叠容器 false / 非法路径 `BAD_COMMAND`，与 `valueAt` 同口径）+ `openPaths()`（全部展开容器路径，**含折叠祖先下的惰性标记**、确定性前序、O(值图节点数)）；删除 `Root.expanded`（只写不读的 aliasing）；测试 20 处对象身份断言改 path 断言、删本地 `openPaths` 辅助、新增 5 条接口测试；**单测 634**（629 → 634）| 纯 refactor，用户可见行为零变化；`worker.js` 15.2 → **15.3KB gz**（+0.1）|
| 6.13 搜索语义单一 oracle（ADR-0014 修订 2026-11-10） | ✅ | `tests/unit/core/search-parity.test.ts`（**新建**）+ 独立参考实现 `tests/unit/core/search-reference.ts`（前序**展平两段式**，与 core 单趟 DFS 边走边判结构不同）+ fixtures `tests/unit/core/search-fixtures.ts`；矩阵 = 4 格语义组合（默认 / `Aa` / 正则 / 正则+Aa）× `keysOnly` × `limit`（含**恰好等于命中数**）× 空 query × 无命中 × 根标量·数组·空对象 × Unicode·非标识符键·深层·长串，失败 message 带 case/query/opts；两份冒烟 `analyzeHits` **删除**，改读 checked-in 文档基线 `scripts/lib/search-expectations.mjs`（唯一常量源：`SEARCH_LIMIT` + capped/raw/key/value + 样本 bytes/sha256 指纹；`reference:uncapped-raw` → `reference:documented`）；**单测 686**（634 → 686，+52）| 纯测试/harness 收口，`src/**` 零改动、用户可见行为不变；13 套冒烟计数不变（`smoke-search` 94/94、`smoke-extension-search` 56/56）；raw 74,378 降为文档常量 + 样本指纹（UI 不可观测，只到 capped 50,000）；parity 不覆盖 ReDoS 静态筛查（既有 `search.test.ts` 兜底）；体积不变 |
| 6.14 菜单交互收口（ADR-0015 / 走查候选 6，2026-11-10） | ✅ | `src/shared/menu.ts`（**新建**：`computeMenuPosition` point/rect 锚点 + 翻转/clamp/超高 `maxHeight`、`nextMenuIndex` 可用项循环导航；纯函数零 DOM）+ `src/view/menu.ts`（**新建**：`createMenu` 控制器收口 open/close、键盘、外部 pointerdown、`focusout`、resize/scroll 关闭、单活、`aria-expanded`）；`main.ts` 两段菜单（约 200 行）退化为两次 `createMenu` 装配；`#ctxMenu` 补 `aria-label="行操作"`；**行为变化**（ADR-0015 §2.7）：导出菜单选中项后焦点回箭头（动作完成、按钮恢复可聚焦后）、Tab/失焦关闭、右键菜单 resize/滚动关闭、边界翻转 + 超高内部滚动、单活不变量；**单测 710**（686 → 710，+24 `shared/menu`）；冒烟 `smoke-copy` **38/38**（+10 菜单交互契约）、`smoke-export` **21/21**（+5）| 用户可见行为按 ADR-0015 §2.7 变化、其余不变；**视觉样式零改动**（两套菜单观感仍并入 #21）；`page.js` 33.0 → **33.7KB gz**（+0.7）|
| 6.15 视觉口径与组件统一（#21 / ADR-0016，2026-11-10） | ✅ | `src/view/styles/tokens.css` 收编：补齐 `--activity-w`/`--left-panel-w`/`--rail-w`/`--tree-max`/`--menu-item-h`/`--result-row-h`/`--backdrop`，删除 10 个死 token，修掉未定义的 `--warn-soft`/`--danger-soft`（改用 `--warn-bg`/`--danger-bg`）；**字号 +1 档**（八档 `--text-micro/caption/small/body/mono/title/display-sm/display`，CSS 零 raw px 字号；树行高仍 24）；**对比度温和提升**（弱中性色 + 亮色语法色重算，实测正文最低暗 4.75 / 亮 4.97，原最差 3.61）；**菜单一份规格**（两套同 176 宽 / 32px 行高 / 16px 前导列 / 文字起点同为 37px / 分隔线 `--border` / 项焦点 bg-selected+内描边）；**三条提示条一份基类**（动作统一靠右：修复条「摘要」与保真条「查看原文」右边缘同为 x=1394）；**空态**（左面板打开时卡片中心 744→904 = 可见区中心；dropzone 加文档图标、高 200；顺手修 `.file-chip[hidden]` 被 display:flex 覆盖的潜在 bug）；**亮色主题**（菜单分隔线改用 `--border`、替换/编辑弹层 backdrop 走 `--backdrop`）；**展开 2px 跳动修复**（stale 提示条加 `margin-bottom:-2px`，树 + 原文视图；`smoke-expand` 新增 `stale:no-layout-shift`）；**单测 710 → 722**（+12 `tests/unit/design/visual-contract.test.ts`：token 引用/字号表/对比度/stale 静态契约）；冒烟 `smoke-expand` **20 → 21**，其余 12 套计数不变 | 用户可见：字号变大、小字更清楚、菜单/提示条/空态观感统一、展开不再轻微跳动；**行为不变**（除 2px 跳动修复）；响应式断点 / 右工作区真实内容 / 最近文档**不在本轮**；`page.css` 7.3 → **7.2KB gz**、`page.js` 33.7 不变；**用户 2026-11-10 验收通过 → #21 关闭** |
| 6.16 响应式断点 ≤1320（#25 / ADR-0017，2026-11-10） | ✅ | `src/view/styles/tokens.css` 末尾加 `@media (max-width: 1320px) { :root { --left-panel-w: 300px; --rail-w: 284px; --tree-max: 980px } }`（**零 JS**：ADR-0016 已把三值 token 化并被 `.side--left`/`.rail`/`.tree` 引用；空态居中 `calc(var(--left-panel-w)/2)` 自动跟随，实测 1200px 卡片中心 784 → 774 = 可见区中心）；`docs/design/tokens.css` 同步；**收益实测很小**（如实记录）：面板关时树 +9（1319）/ +16（1200），面板+右栏都在时 **+36**；`--tree-max` 980 只在窗口 **1312–1320** 真正封顶（惰性，照规格保留）；**单测 722 → 724**（+2 `visual-contract` 静态断点契约：默认档 320/300/1280 + 断点档 300/284/980）；冒烟 `smoke-settings` **21 → 23**（新 phase：viewport 1200 断言 300/284/树 568，回 1440 断言 320/300），其余 12 套计数不变；1440 口径的 `sideWidth=320` 断言不变 | 用户可见：≤1320 窗口里树宽 +16~36px（**观感变化细微**，如实记录）；**无行为变化**；窄屏自动收起右栏**未做**（属行为变化，另议）；`page.css` 7.2 → **7.3KB gz**，`page.js` / `worker.js` 不变 |
| 6.17 搜索结果双击复制（#26 / ADR-0010 + ADR-0011 修订，2026-11-10） | ✅ | 搜索结果行**双击 = 复制该命中节点**（单击仍是跳转，语义不变）；新增**第 10 项设置** `searchCopyFormat`（标签「搜索结果双击复制」，4 格式 segmented、**默认路径**，与行尾浮条的 `defaultCopyFormat` 相互独立）；命中 `field=key/value` **不区分**，统一按 `hit.path` 复制「该节点」；`click` 处理里 `event.detail > 1` 吞掉双击第二击（依据真实 CDP 鼠标实测：双击幂等、末帧像素差 0.03%、0 长任务，但会多一次 `expandTo` + 一次 `window` 请求且「已渲染」行池 61 → 50；**不用时间窗去重**——人双击 150–300ms 会漏）；失败路径：`BAD_COMMAND`（容器无原始值 / 根无键名）→ 不复制 + toast「该节点不支持当前复制格式；可在设置里更换」，`TOO_LARGE` 沿用「引导用导出」；**本轮不做**发现性提示 / 右键菜单 / 键盘入口（用户 2026-11-10 拍板）；**单测 724 → 725**（+1 `settings-state` 默认/合法/非法回落）；冒烟 `smoke-search` **94 → 97**（默认路径剪贴板逐字读回 / 子树 JSON / 不适用格式 toast）、`smoke-settings` **23 → 24**（第 10 项设置三态 + 重启恢复同步 10 项），其余 11 套计数不变 | 用户可见：搜索结果行双击即复制（默认规范路径、toast 反馈），**单击/跳转不变**；设置面板 9 → 10 行；已知差距：无键盘复制入口（a11y）、无发现性提示（Q4=C）、「双击第二击被吞」只有实测证据未进冒烟；`page.js` 33.7 → **33.9KB gz**（+0.2） |
| 6.18 表达式视图（#27 / ADR-0018，2026-11-10） | ✅ | `src/core/expression/{whitelist,parse,validate,walk,engine,complete,locate}.ts`（**acorn 只进 worker**：单表达式子集 + default-deny 白名单 + 手写 walker；预算三刹车 时间/步数`max(base,k×N)`/结果上限；10 错误码 + 行列定位；缺失字段分级 + 拼写纠错；origins → 结果行回原路径）+ `doc-service` 的 `eval/complete/exprLocate`（结果根 `expr:N`、LRU 3、换文档丢弃）+ `protocol` 三命令/类型/`EXPR_BUDGETS` + 第 11 项设置 `advBudget`（宽松/标准/严格）+ `view/panels/expression-{panel,editor,bar}.ts`（CM6 懒加载、自写轻量上色、autocomplete source、Enter/Shift-Enter、示例/历史/严格模式/行内错误）+ `main.ts` 接线（模式切换、结果视图 = 树区换根、点结果行跳回、导出/复制结果、stale 条 + 重新执行、`3×maxTime` 看门狗）+ `dev-hook` 11 个表达式钩子；**单测 725 → 840**（+115：引擎/补全/locate 114 + 设置 1）；**冒烟 14 套全绿**（新增 `smoke-expression` **45/45**；`smoke-settings` 24 → 25）；**体积**：`page.js` 33.9 → **41.0KB gz**（预算 45）、`worker.js` 15.3 → **58.7KB**（acorn+walker）、`page.css` 7.3 → **7.8**、懒加载 132.1 → **145.4KB**（+13.2 来自 `@codemirror/autocomplete`；**预算 140 → 146 经用户 2026-11-10 拍板 A**，显式记录） | 用户可见：活动栏第 4 模式「表达式」；写 JS 子集过滤/投影 → 结果作为可展开树查看、点行跳回原文档、导出/复制结果 JSON；预算超限给确定错误码、结果超限截断带标记、文档改动后 stale 提示；**只读**（结果不可编辑、不改原文）；已知差距：看门狗触发后需重新导入（页面重载）、补全只到根级字段（类型感知 → #28）、截断只及最终结果根 |
| 6.19 多文档工作区标签（#18 / ADR-0009，2026-11-11） | ✅ | `protocol`：`closeRoot { rootId }`（**幂等**，未知根回 `closed:false`）+ `load` 回带 `doc:N` + `MAX_DOC_TABS=8`/`TAB_STRIP_HEIGHT=32`；`core`：`RootStore.close`、`DocService.load` **不覆盖**（doc 根 id 单调不复用）、`closeRoot` 连带丢弃 `parentRootId` 指向它的 expr 根并释放编辑历史/节点数缓存/搜索 seq、**搜索抢占 seq 改按根**（`Map<rootId,seq>`，多标签致命点）；`viewmodel`：新增 `workspace-state.ts`（`WorkspaceState`/`TabState`，runtime 工厂注入「行窗口/原文窗口/搜索/编辑」每标签一份，软上限 8 不淘汰、关活动标签右邻→左邻）；`view`：新增 `tab-strip.{ts,css}` + `#tabStrip`（32px = `TAB_STRIP_HEIGHT` 写 inline、**≥2 文档才显示**（单文档 hidden 零高度零视觉变化）、`role=tablist`/`aria-selected`、roving tabindex/←→/Home/End、重绘归还焦点、零新增颜色 token）；`app`：切标签 = 换 adapter + 重挂订阅 + 恢复会话/选中/滚动/搜索（含输入框）/大纲/提示条，**回包按 rootId 丢弃**（`isActiveDocRoot` 前置门）、入口层「替换 ⇄ 在新标签中打开」+ `⌘⇧O` + `＋`、拖到标签条空白 = 新标签、关标签先 `closeRoot`（有未导出修改先 confirm）、关最后回空态、第 2+ 份大文档内存提示、dev hook **69 → 75**；**单测 840 → 899**（+59：workspace-state 36 / root-store 9 / doc-service 7 / 契约 4 / dev-hook 3）；**冒烟 15 套全绿**（新增 `smoke-workspace` **50/50**；其余 14 套计数不变）；**同日用户反馈修订**：模态入口层抬到 `z-index:32`（修「弹层不遮左面板」，初始空态仍 30）、标签**拖拽排序**（`WorkspaceState.move` + HTML5 drag + 插入指示线 + 键盘 `Alt+←/→`）、拖放暂存文件后点「在新标签中打开」**立即导入**（不再二次确认）；体积 `page.js` 41.0 → **45.6KB gz**（预算 **45 → 46** 经用户 2026-11-11 拍板，+0.7 归因见 ADR-0009「预算修订」）、`page.css` 7.8 → **8.1**、懒加载 145.4 → **145.6**（预算 146）、`worker.js` 58.7 不变 | 用户可见：≥2 个文档时工具栏下方出现 32px 标签条（文件名 + × + ＋），切标签保留各自的展开/选中/滚动/搜索态；导入仍替换当前标签，`⌘⇧O`/入口层可开新标签；关标签释放 Worker 根、关最后一个回空态；满 8 个禁用 ＋；已知差距：文件拖放落点分流由冒烟合成事件覆盖（非真机拖拽）、标签重命名/自定义导出名另见 **#29**、watchdog 重载后工作区丢失（与单文档时代一致） |
| 6.20 原文视图 ↔ 树视图双向定位（#30 / ADR-0019，2026-11-11） | ✅ | `protocol`：新增两条只读命令 `rawPathAt { rootId, line }`（原文显示行 → 规范路径；锚点 = 行首 token 所属节点，结构行回 `null`）与 `rawOffsetOf { rootId, path }`（规范路径 → 源偏移 + 1-based 行；重复键取最后一个源位置）；均不推 `docRevision`/`rowVersion`、plain 模式回 `null`、`exact=false` 仅表示命中「成员值起点 / 容器开括号」，结构行回 `null`（不回退最近节点）；`core`：**B-1 混合**——原文→树 = 检查点 + 祖先键栈增量索引（检查点存帧链 `{isObj,closer,pos,idx}`（层数 = 下标）+ 键栈 `(kind,offset,len)`；键只存偏移、命中才拼路径；首次跳转懒建、`WeakMap<Root>`、随根关闭/换文档释放；50MB 索引 73–113KiB、命中 0.16ms 级、首次懒建 50MB≈0.2s）；树→原文 = 按需单趟扫描 + 每标签 LRU（1MB≈5ms / 10MB≈50ms / 50MB≈238ms；命中缓存或记忆锚点 0ms）；**否决**全量 `path→offset` 表（50MB≈88.9MiB，`docs/design/reassess-fidelity.md:13`）与分层采样索引；`view`：原文**行尾浮条**（`⇢`、`sticky right` 贴视口右缘、`tabIndex=-1`、结构行不渲染；2026-11-11 用户反馈由行号 gutter 改到右侧）+ 树行浮条第三钮（`⇠`）+ 两侧右键菜单项；`app`：树侧走 `expandTo` + 选中 + `.is-changed` 900ms、原文侧滚动 + `.is-flash` 900ms；每标签内存锚点记忆（不持久化）；busy + 状态栏「正在定位…」/ 失败 3s 文案；回包按 `rootId` 丢弃；**范围**：plain 两侧禁用、表达式根不涉及、多标签仅当前标签、不做分屏/连续联动、保真条保持单动作；**测试**：映射纯函数单测 + 两条新命令契约 + dev hook **75 → 82** 逐字钉住；锚点记忆由冒烟覆盖（`main.ts` 接线层无单测面）；**单测 899 → 929**；冒烟 `smoke-raw` **26 → 33/33**、`smoke-fidelity` **24 → 29/29**（#31 修订后 35/35）（不新增第 16 套）；体积 `page.js` 45.6 → **47.0KB gz**（预算 46 → **47** 经用户 2026-11-11 拍板）、`worker.js` **61.0**、`page.css` 8.1、懒加载 145.6 | 用户可见：原文行 hover 出「跳树」按钮、树行浮条/右键「跳原文」，保真痛点闭环（失真 → 查看原文 → 一键回树）；plain 修复文档两侧禁用；编辑新增节点点击后状态栏提示；已知差距：50MB 首跳≈0.2s 不可取消、原文侧 title 只到行号、重复键不区分、source 一行多值只锚首节点、原文无行级键盘导航（另开票） |
| 6.22 无损数字值模型（#32 / ADR-0020，2026-11-12） | ✅ | `core`：新建 `number-literal.ts`（数字字面量无损判定单一来源：整数超 2^53−1 → BigInt、整数展开位数 >10000 → Infinity、小数仍 Number）+ `lossless-json.ts`（显式栈非递归 parser、字符串自解码、`__proto__` 安全、与 `JSON.parse` 语法接受面逐例对拍 + 1000 例差分 fuzz；序列化器 BigInt → 裸十进制数字、无 BigInt 时与 `JSON.stringify` 逐字节等价；`deepEqualJson` 供编辑 no-op）；`import.ts`/`repair.ts`/`doc-service.ts`（getNodeJson/replaceNode/parseEditText/exportDoc）/`copy.ts` 全线换成无损 parser + serializer + 深比较；`row-model`/`measure`/`outline`/`search` 认 BigInt（归 `number` 类、预览十进制串、下界按位数）；`expression/*` BigInt 语义（字面量 `123n` 与十进制 raw 精确；同类型算术原生、混算 `EVAL_MIXED_NUMBER`、关系比较允许混合、`Math.*` 报错、`Number()/String()` 显式转换、表达式内 `JSON.parse/stringify` 同口径；步数预算不变）；`fidelity` 改口径（`precision` 退场、数字判定共用 `analyzeNumberLiteral`、保真条文案只剩上溢/下溢/键序）；`protocol` 删 `FidelityCounts.precision`；**单测 930 → 979**（number-literal 9 / lossless-json 17 / 值模型与表达式 BigInt / fidelity 口径重写，含 1,000,000 层深嵌套、孤立代理项、`1e400` 导出→再导入）；冒烟 `smoke-fidelity` 35 条重写（大整数不再报、超 cap 才报上溢）、`smoke-copy` 38→43、`smoke-export` 21→22、`smoke-edit` +3、`smoke-expression` 45→52；**体积**：`page.js` **47.6 不变（预算 48 未动）**、懒加载 **145.6 不变（预算 146 未动）**、`worker.js` 61.1 → **63.3KB gz**（+2.2：无损 parser/值模型 +2.1、搜索数字值 +0.1，无硬预算，ADR-0020 §9） | 用户可见：`297532588187238660` 等大整数在树/复制（子树 JSON、原始值）/导出/编辑弹层/表达式里都是**精确十进制、无引号**；高精度小数仍按 double（已知差距、不检测）；保真条不再误报「大整数精度」；已知差距：小数无损、字面量字节往返、整数键序无损、深嵌套导出 RangeError、`BigInt()` 构造器未进表达式白名单、Chrome worker 值图堆未直采（首帧/扫描/长任务已实测，见 ADR-0020 §11 缺口登记） |
| 6.23 数字值可搜索（用户反馈 / ADR-0014 修订，2026-11-12） | ✅ | `core/search.ts`：值命中范围从「字符串值」扩为「字符串内容 + 数字显示文本」——`number` 用 `JSON.stringify`（`1e+21`/`-0`→`0`）、`BigInt` 用十进制串（`297532588187238660`），与 `row-model.scalarPreview` 同源（搜到的 == 看到的）；布尔/null 仍不参与；键优先/keysOnly/正则/大小写/上限/截断语义不变。`tests/unit/core/search-reference.ts` 独立参考实现同步（kindOf 认 bigint），parity 矩阵 +7 条数字用例；`smoke-search` **97 → 101/101**（大整数可搜 / 普通数字 / bool-null 不命中 / 0 长任务）；单测 **971 → 979**；体积：`page.js` 47.6 不变（预算 48）、`worker.js` 63.2 → **63.3KB gz**（+0.1）、懒加载 145.6（146） | 用户可见：树里显示的数字串现在能搜到（大整数不再 0 命中）；纯数字查询会命中大量数字值（命中上限 50,000 截断），属「按显示文本搜索」的自然结果；布尔/null 值仍不可搜（另议；2026-11-12 由 #39 / ADR-0023 扩展为可搜） |
| 6.21 保真条多命中导航 + 精确对照（#23 修订 / #31，2026-11-11 晚） | ✅ | `core`：`FidelityHit.parsed` 对整数型失真改为**精确整数值**（`parsedExact`：`Number.isInteger(value)` → `BigInt(value).toString()`；Infinity/非整数保持 `String(value)`）——`297532588187238660` 的 double 实为 `...656`，最短往返打印仍是 `...660`，现在报告里能看出差异；检测规则/阈值/counts 不变。`view`：保真条命中 ≥2 条时显示「`‹` 1/N `›`」（`#fidelityPrev` / `#fidelityCount` / `#fidelityNext`），单条零视觉变化、**首尾循环**（末条下一条回第一条）；条文案常驻追加当前一处「原文 X → 实际 Y」；`app`：`jumpFidelityHit(index)` 统一「查看原文 / 上一处 / 下一处」→ 状态栏**常驻**解释「失真：原文 X → 实际 Y」（直到下次跳转/换文档/切标签）→ 切原文 + `revealRepairOffset` 高亮对应行；dev hook `fidelityState` 增加 index/hitCount/counterText/prevDisabled/nextDisabled/statusState；**单测 929 → 930**（+1「显示串相同但实际不同 → parsed 精确整数」）；`smoke-fidelity` **29 → 35/35**（nav 可见/计数、逐处跳转行号、末处禁用 next、prev 回跳、状态栏精确差异 + 截图）；体积 `page.js` 47.0 → **47.6KB gz**（预算 47 → **48** 经用户 2026-11-11 晚拍板，+0.6 归因：条内导航/循环 + 条内常驻对照 + 常驻状态栏）、`page.css` 8.1 → **8.2**（+0.1 导航按钮/计数）、`worker.js` 61.1（+0.1 精确值） | 用户可见：保真条出现「‹ 1/N ›」，可逐处查看并看到「原文 vs 实际」精确差异；单命中/无命中时条不变；已知差距：`literal` 仍是源文本片段（≤48 字符截断）、不做命中明细列表/弹层 |
| 6.24 文档显示名 ↔ 导出文件名（#29 / ADR-0021，2026-11-12） | ✅ | `shared`：**新建** `doc-name.ts`（`sanitizeDocName`：trim / 去控制字符 / 文件系统非法字符 → `-` / 去末尾 `.json` / 去末尾点空格 / 120 码点；`exportFileName` 后缀顺序与旧 `exportName` 逐字节等价；`baseNameFromExport` 按 flags 剥后缀；`renameFromExport` 最终名 = 预填名 → null；`displayTitle` 原名追溯；`DOC_NAME_MAX`）+ 单测 21；`viewmodel`：`TabView.originalName`（原名只读），改名走既有 `update(id,{name})`、零新方法；`view`：`TabStrip` 双击标题 / **F2** 就地改名（input 替换标题、Enter/失焦提交、Esc 取消、编辑期 `draggable=false`、空白提交 = 保持原名），只做 DOM、语义回调 app；`app`：文件导出改走 **`showSaveFilePicker`**（预填名含本次后缀、可改名/选保存位置、**取消零副作用**、无 FSA 或 API 被策略拒绝回落 `<a download>`、名字与目标标签 id 在 await 前定死），保存后 `applyExportName` 按最终文件名反推写回标签（表达式结果视图**一次性**、不回写文档名）；显示层（文件 chip / 导入层覆盖警示 / 导出默认名 / 悬停「原名：…」）改读活名字；**不新增协议、Worker 零改动、不加 `downloads` 权限**；**单测 979 → 1003**（doc-name 21 / workspace rename 3）；冒烟 `smoke-workspace` **50 → 56/56**（双击出输入框且全选/禁拖拽、Esc、F2、提交后标签+chip 同步且 title 带原名、空白保持原名、双击非活动标签也能进编辑）、`smoke-export` **22 → 27/27**（桩预填 / 写入逐字 / 改名联动 / 取消零副作用 / 策略拦截回落）；体积 `page.js` 47.6 → **48.8KB gz**（预算 48 → **50** 经用户 2026-11-12 拍板，+1.2：改名 DOM/焦点 + 系统框/回落 + 清洗反推 + 原名 title）、`page.css` **8.2**（+0.0）、`worker.js` **63.3** 不变、懒加载 **145.6**（146）不变；截图 `.spike/smoke/workspace-rename{,-light}.png` | 用户可见：多标签双击标题 / F2 改名（标签与文件 chip 同步、悬停显示原名）；文件导出弹系统「另存为」可改名字与位置，保存后标签名跟着变；取消导出零副作用；表达式结果导出改名不回写文档名；单文档只经导出改名；已知差距：后缀可被用户覆盖、无 FSA 回落无确认框、反推是启发式、改名不持久化（#35）；真机系统框 2026-11-12 用户实测正常 |
| 6.25 导出/复制的 JSON 格式化配置（#34 / #38 / ADR-0022，2026-11-12） | ✅ | `core`：`serializeLossless(value, indent?, opts?: { escapeUnicode?: boolean })`——默认档保持与 `JSON.stringify(v,null,indent)` 逐字节等价；escape 档字符串/对象键按 UTF-16 code unit 把非 ASCII（`charCode ≥ 0x80`）转小写 `\uXXXX`（非 BMP 按代理对各一个转义），控制字符/引号/反斜杠沿用 `JSON.stringify` 短转义，输出仍是合法 JSON、`parseLossless` 读回值不变、BigInt 仍裸十进制；`doc-service.exportDoc` 只在此处透传 `escapeUnicode`（`copyNode`/`getNodeJson` 不传）；`protocol`：`exportDoc` 命令 + `CoreApi.exportDoc(rootId, indent?, escapeUnicode?)`（InProcess / Worker 双适配器契约）；`viewmodel`：`copyIndent` → **`jsonIndent`**（0/2/4，导出 + 整份复制 + 子树复制共用；`normalizeSettings` 读 `jsonIndent ?? copyIndent`、只写新键、缺键回落），新增 **`escapeUnicode`**（默认关），存储键仍 `tjv.settings.v1`；`view`：设置面板 11 → **12 行**（第 6 行「JSON 缩进」，末尾「导出转义非 ASCII」勾选，过时注释同步 12）；`app`：文件导出两路径与整份复制传 `jsonIndent` + `escapeUnicode`，子树复制 `indent=jsonIndent`，编辑回填固定 pretty(2)、树/原文视图不动；**不做尾随逗号**（导出即标准 JSON；导入容错属 #20）；**单测 1003 → 1023**（lossless-json +6 / doc-service +2 / 契约 +2（1 用例 × 双适配器） / settings-state +8 / dev-hook +2）；冒烟 `smoke-settings` **25 → 26/26**、`smoke-export` **27 → 34/34**，其余 13 套计数不变；体积 `page.js` 48.8 → **48.9KB gz**（预算 50 未动）、`worker.js` 63.3 → **63.5**（无硬预算）、`page.css` 8.2 / 懒加载 145.6 不变；截图 `.spike/smoke/settings-{panel,applied}.png` | 用户可见：设置面板「JSON 缩进」（紧凑/2/4）+「导出转义非 ASCII」；文件导出/整份复制/子树复制跟随缩进，导出/复制可选把中文/emoji 转成 `\uXXXX`（默认关、仍合法 JSON，便于喂给只接受 ASCII 的下游工具）；编辑回填与查看侧不变；已知差距：不做尾随逗号/JSONC、不做每次导出的临时格式入口、非 ASCII 转义只有开/关、缩进仅 0/2/4 |
| 6.26 搜索目标扩展：布尔/null 值 + 路径后缀（#36 / #39 / ADR-0023，2026-11-12） | ✅ | `core/search`：bool/null 按树显示文本参与值命中（`true`/`false`/`null`）；**路径模式**（查询含 `.` / `[` / `$`）下对 walk 帧已有的规范路径做**后缀匹配**（字面量 `endsWith`、大小写按 `Aa`；正则模式对整条路径 `test()`，用户可 `$` 锚定）；一节点最多一条命中（key > value > path），`keysOnly` 不收路径；`protocol`：`Hit.field` 加 `'path'`；`viewmodel`：`SearchFilter`/`SearchCounts` 四档、counts 从 allHits 重算；`view`：过滤四档**常驻**（全部/键名/值/路径，各带计数）+ 结果行 field 文案「路径」+ 面包屑高亮命中后缀 + placeholder/空态文案「搜索键名、值或路径…」；**不变**：50,000 全局上限/截断、无索引、过滤会话态、Aa/.* 语义；**单测 1023 → 1070**（search.test +18 / parity 矩阵 52→76 / 契约 +2（1 用例 × 双适配器）/ search-state +3）；冒烟 `smoke-search` **101 → 118/118**、`smoke-extension-search` **56 → 63/63**，其余 13 套计数不变；体积 `page.js` 48.9 → **49.0KB gz**（预算 50 未动）、`worker.js` **63.5 不变**、`page.css` 8.2 / 懒加载 145.6 不变；截图 `.spike/smoke/search-targets{,-light}.png` | 用户可见：搜 `true`/`false`/`null` 能命中；输入路径尾部片段（`$.data`、`hotel_list[3]`、`[3]`、`$`）可定位节点并在「路径」档过滤；`data.` 不再命中整棵子树；正则模式路径命中按整条路径匹配（宽正则自负）；已知差距：路径只支持尾部片段（中段/前缀另开票）、无类型搜索/无搜索目标设置项、无路径命中优先排序 |
| 6.27 子键显示排序（#19 / #40 / ADR-0024，2026-11-12） | ✅ | `core`：**新建** `order.ts`（`SortOrder` + `normalizeSortOrder` 白名单 + **自研确定性自然序** `compareNaturalKeys`：数字段按数值（去前导零→长度→字典序，不经 `Number`）、非数字段折小写比较、同位置数字段优先、前缀短者先、全平局原码元序兜底 ⇒ 严格全序；不用 `Intl.Collator`）+ `orderedKeys`；`RowModel`：`RowModelOptions.order` / `setOrder(order)`（`keysOf` 成为显示 slot 序唯一来源、懒排序 + WeakMap 缓存；`setOrder` 重置键缓存并对 `expanded` 集合内每个对象容器独立重建 Fenwick——**子树可见行数与顺序无关**；迭代重建帧 `buildFrameOf` 同步走显示序；数组恒索引序）+ `doc-service`：服务级 `order`（`load` / `evalExpression` 建根时套用）、`setOrder` 对**全部活根**重排并各自 `rowVersion++`（同档 changed=false 版本不动但仍回全量 roots 快照；只推 rowVersion 不推 docRevision）、`rowOfPath` 只读（祖先折叠 −1 / 路径不存在 BAD_COMMAND）、`outline` 透传 order；`outlinePage(node,path,start,count,order)` 按显示序分页（total 不变）；`protocol`：两条命令 + 两个回包 + `CoreApi` 两方法 + 双适配器契约；`viewmodel`：第 13 项设置 `sortOrder`（默认 raw / 白名单回落 / `tjv.settings.v1`）；`view`：设置面板 **12 → 13 行**（「子键排序」原始 / 升序 / 降序 + hint「仅影响树、大纲与表达式结果树的显示顺序」）；`app`：`applySettings → syncSortOrder`（`appliedOrder` 去重、`sortSyncSeq` 丢弃迟到回包、抓顶端可见行规范路径 + 行内像素偏移、回填全部标签 / `exprView` / `docSessionBeforeExpr` 版本（唯一边界 `DocSession.syncRootVersion`）、`core.rowOfPath` 换算新行号还原视口（拿不到锚点显式回顶部）、大纲 `refreshOrder`（保留展开集合与已加载数量）、失败回滚 UI/持久化到上次成功档 + 状态栏中性提示）；**不变**：值图键序、路径、节点身份、复制、导出、编辑、搜索、保真；**单测 1070 → 1138**（+68：order 17 / row-model-order 18 / outline-order 11 / doc-service-order 12 / 契约 +2（1 用例 × 双适配器）/ settings-state +4 / doc-session +1 / outline-state +3）；冒烟新增 `smoke-order` **20/20**、`smoke-settings` **26/26**（13 行契约），其余 14 套计数不变；体积 `page.js` 49.0 → **49.9KB gz**（预算 50 未动）、`worker.js` 63.5 → **64.2KB gz**、`page.css` 8.2 / 懒加载 145.6 不变；截图 `.spike/smoke/order-{settings,anchor,outline,light}.png` | 用户可见：设置面板出现「子键排序」（原始 / 升序 / 降序）；树、大纲、表达式结果树的对象成员按规则显示（自然序 `item2 < item10`、忽略大小写、中文按码元序），**数组、复制、导出、路径、编辑、搜索完全不受影响**；切档按路径保持滚动位置；已知差距：中文按码元序（非拼音）、数组不排、无单节点覆盖 / 按类型排序（v1.1）、折叠行摘要预览仍值图序、大纲「加载更多」每页重排、大容器未设硬上限（已实测：20 万键单容器切档 ≈54ms、50MB 样本 ≈27ms / 0 长任务） |
| 6.28 单节点子键排序覆盖（#41 / ADR-0024 修订 v1.1，2026-11-13） | ✅ | `core`：`RowModel` 新增 `WeakMap<Container, SortOrder>` 覆盖表——`keysOf` 取 `覆盖 ?? 全局`（只影响该容器直接子键、**不向下继承**）；`setNodeOrder(path, order \| null)` 解析路径 → 必须对象容器（数组/标量/坏路径 `BAD_COMMAND`）→ 只失效该容器 keysCache + 已展开时重建其 Fenwick，覆盖变化始终推 `rowVersion`（折叠容器也算）；全局 `setOrder` 不清覆盖；`displayOrderAt(path)` 只读供大纲；编辑替换 / undo / redo 经 `releaseSubtree(node, true)` 清掉被替换子树的覆盖（回全局）；`doc-service`：命令 `setNodeOrder` 走既有 `mutateRoot`（intent=view，回包 `EditReply`）+ `outline` 按被查询容器的 `displayOrderAt` 分页（嵌套各用各的）；`protocol`：Command +1 + `CoreApi.setNodeOrder`（**不新增回包类型**）；`view`：右键菜单 7 → **10 项**（子键升序 / 子键降序 / 恢复全局排序，插在子树组与编辑之间）+ 启用矩阵 `对象容器 && 成员≥2`（数组/标量/单键对象禁用并 title 说明）+ 点击 toast；`app`：`setNodeOrder()`（锚点抓取 → `core.setNodeOrder` → `session.land({kind:'order'})` → `applyLanding`（keep）+ 大纲 `refreshOrder` → `rowOfPath` 按路径还原视口 / 拿不到回顶 → 成功/中性 toast）；`doc-session`：`LandingIntent` + `{kind:'order'}`（滚动 keep、附加动作全关）；**不变**：值图 / 路径 / 复制 / 导出 / 编辑 / 搜索 / 保真；**单测 1138 → 1165**（+27：row-model-node-order 13 / doc-service-node-order 10 / 契约 +2 / doc-session +2）；冒烟 `smoke-order` **20 → 33/33**、`smoke-copy` 菜单契约 7 → 10 项，其余 14 套计数不变；体积 `page.js` 49.9 → **50.3KB gz**（**预算 50 → 51 经用户 2026-11-13 批准**）、`worker.js` 64.2 → **64.4**、`page.css` 8.2 / 懒加载 145.6 不变；截图 `.spike/smoke/order-menu.png` / `order-node.png` | 用户可见：树行右键菜单出现「子键升序 / 子键降序 / 恢复全局排序」；点击后只改该节点**直接子键**的显示顺序（不向下继承、不改数据/复制/导出/编辑/搜索），覆盖优先于设置里的全局规则且是会话态（刷新/换文档丢弃），编辑替换后自动回全局；已知差距：不做子树继承 / 菜单勾选态 / 按路径持久化 / 编辑迁移、数组恒索引序 |
| 6 表达式 + JSON 地图 + Profile | ⏳ v1.1 | 右工作区占位已留 |

**产物体积**（`node build.mjs --analyze`，**`minify:true`**——体积预算一律按 minify 后的 gz 计）：`page.js` **50.3KB gz**（预算 **51**，2026-11-13 由 50 修订；slice 6.3 原文视图 +3.0、slice 6.4 大纲面板 +3.6、slice 6.5 搜索选项/体积提示/树小件 +0.9、slice 6.6 保真条 +0.8（含 `NoticeBar` 抽取）、T2 技术债清理 +0.4（`view/highlight` 共用写入器 + `focusTree`/拖放区接线）、slice 6.7 子树菜单 +0.3、窗口状态机收口 +0.4、app 回包落地 +0.4、测试钩子移出 +1.1、搜索语义单一 oracle +0.0（`tests/`/`scripts/` 不进 bundle）、菜单交互收口 +0.7（抽 `view/menu` + `shared/menu`，两段菜单净减）、6.17 搜索结果双击复制 +0.2、**6.18 表达式视图 +7.1**、**6.19 多文档工作区 +3.9**（标签条 + 工作区状态 + 入口层两形态：预算 45 → 46 经用户 2026-11-11 拍板，见 ADR-0009「预算修订」）、**同日反馈修订 +0.7**（标签拖拽排序 / 模态层遮罩 / 拖放落点直达）、**6.20 双向定位 +1.4**（原文行尾浮条/树浮条第三钮/两侧菜单/锚点记忆/状态栏）、**6.21 保真条多命中导航 + 精确对照 +0.6**（预算 47 → 48 经用户 2026-11-11 晚拍板）、**6.24 显示名/导出文件名 +1.2**（预算 48 → 50 经用户 2026-11-12 拍板，见 ADR-0021「预算」）、**6.25 导出/复制格式化配置 +0.1**、**6.26 搜索目标扩展 +0.1**、**6.27 子键显示排序 +0.9**、**6.28 单节点覆盖 +0.4**）、`worker.js` **64.4KB gz**（原文索引 +2.3 / 大纲 +0.2 / 正则搜索 +0.5 / 保真扫描 +2.2（含指数精度、按类别计数）/ T2 `core/measure` 下界预扫 +0.3 / slice 6.7 `toggleSubtree` +0.3 / 展开态 path 口径 +0.1、**6.18 表达式引擎 acorn+walker +43.4**、**6.20 源文本映射索引 +2.3**、6.21 精确值 +0.1、**6.22 无损 parser + BigInt 值模型/表达式/保真改口径 +2.1**、**6.25 导出转义选项 +0.2**、**6.27 自然序比较器/显示序 keysOf/两条命令 +0.7**、**6.28 单节点覆盖表/setNodeOrder/displayOrderAt +0.2**）、`page.css` **8.2KB gz**（T2 +0.0、6.7 +0.0、6.15 视觉口径 -0.1、ADR-0017 响应式断点 +0.1、**6.18 表达式面板/结果条/上色器 +0.5**、6.19 标签条 +0.2、同日拖拽态/指示线 +0.1、6.21 导航按钮/计数 +0.1、6.24 改名输入框 +0.0、6.25 设置面板一行 +0.0、6.26 搜索面板四档 +0.0、6.27 设置面板一行 +0.0）；懒加载 chunk 合计 **145.6KB gz ≤146**（编辑器相关，仅首次打开 CM6/表达式编辑器时加载；`page.js` 内不含 CM6；6.18 +13.3 中 **13.2 来自 `@codemirror/autocomplete`**——预算 140 → 146 经用户 2026-11-10 拍板 A，见 ADR-0018「预算修订」）；构建 ~68ms。
**真实扩展验证**：`scripts/smoke-extension.mjs` 以 unpacked 扩展加载 `dist/`，`chrome.runtime.getURL('worker.js')` 创建 module worker，粘贴导入 10MB、展开至 37,205 行、滚动 312k px —— 0 长任务、0 console 错误。

**slice 4 搜索验收**（2026-10-29，CfT 156 / M4 / headless；`scripts/smoke-search.mjs` 66/66、`scripts/smoke-extension-search.mjs` 30/30）：

- **`.mock/1.json`（879KB）**：`hotel` 186 命中（键 140 / 值 46），`__tjv.search` **27.3ms**（端到端 31.2ms），0 长任务；结果列表渲染 22 行（spacer=186×44），树 `is-hit` + `<mark>` 高亮。
- **10MB `hotel`**：raw **74,378** 命中（键 37,189 / 值 37,189，Node 侧放开 50k 上限统计；接口回包 `total` 即截断后的 50,000）→ 截断 **50,000**（`truncated` + 计数 `50,000+`）；hook **91.3ms**（core 满量 walk 42.7ms），0 长任务。
- **跳转** `searchJump(0)` **2.7ms**（墙钟 3.3ms，含 worker `expandTo` + 窗口回包），树 `.row.is-current` 出现；prev/next 13 步（含环状）max 13.2ms。
- **结果列表滚动** 0/25/50/95%：渲染行恒 **22**（≤40），0 长任务；过滤 all/key/value = 186/140/46（key+value=total）。
- **真实扩展**：粘贴 10MB 首行 50ms → 真实输入 `hotel` 337ms 出 `50,000+` → Enter 23ms 后树 `.row.is-current`；清空 262ms；0 console 错误、扩展内无 `__tjv`。
- **stale**：`docRevision` 不匹配分支有单测；dev hook `searchMarkStale()` 验收 UI（清空 + 「文档已修改，请重新搜索」+ 树高亮清空），编辑（slice 5）接入后真实操作可达。
- **回归**：`npm run smoke`（首行 51ms）/ `npm run smoke:ext`（首行 72ms）不回归；截图 `.spike/smoke/{search-mock,search-10mb,extension-search,extension-search-cleared}.png`。

附注：旧基准 `58 / 37,189` 是旧口径（37,189 恰为 10MB 键名命中数），当前 `core/search.ts` 同时匹配键名与字符串值；`docs/design/qa-editing-and-search.md` §2.3 已加复核注记。

**slice 4.5 展开/收起验收**（2026-11-02，CfT headless 1440×900；`scripts/smoke-expand.mjs` **11/11**）：

- **自适应展开**：8 节点文档加载即全展开（`totalRows` 8）；`>500` 节点保持默认折叠（判定 = 带限计数、超阈值早停，实测 **0.14ms**）。
- **10MB（595,030 节点，预算内）**：load→首帧 **41ms**；点「全部展开」端到端 **68ms**（Worker 内计数+重建 **37.3ms**、heap +26.7MB），`totalRows` 595,030；渲染行 **51**、滚回顶部、**选中路径保留**（Q7）；0 长任务、0 console 错误；全开后窗口 p95 0.062ms。
- **50MB（2,958,550 节点，超 `ROW_BUDGET`）**：dry-run 早停 **11.7ms**、拒绝 **17.1ms**（Worker 内），回包 `totalRows`/`rowVersion` 不变（**零部分修改**）+ toast `TOO_MANY_ROWS`；「全部收起」回默认行数。
- **回归**：`npm run smoke` / `smoke:ext` / `smoke-search` **82/82** / `smoke-extension-search` **56/56** 全绿；截图 `.spike/smoke/expand-{adaptive,all,collapse,budget}.png`。
- **闪帧修复（2026-11-02）**：滚动后点「收起/展开」曾出现 1–2 帧空白+塌陷（旧 `start` 的保留帧被新 `totalRows` 裁掉、中间窗口按旧滚动位置算出 `start=2/count=1`）。改为 `RowWindowSource.setRoot(..., { scrollTopPx })` 把「回顶」与换版本原子化——保留帧一起锚到顶部、目标窗口一次算对；smoke 逐帧断言新 `rowVersion` 的每一帧 `start=0` 且无 0 行帧（`expand-no-flash-frame` / `collapse-no-flash-frame`）。
- **按钮闪动修复（2026-11-02）**：防重入原先把两按钮 `disabled`（全局 `button:disabled{opacity:.45}`）→ 用户看到「两个按钮一起灰一下」；改为内部锁 `expandAllBusy`，按钮禁用态只保留「未加载文档」一种；smoke 逐帧断言按钮全程不变灰（已用变异测试确认可红）。

**slice 5 编辑验收**（2026-11-02，CfT headless 1440×900；`scripts/smoke-edit.mjs` **14/14**）：

- **弹层 / Apply**：`getNodeJson` → CM6 弹层（路径 / 类型 / 大小 + 行号 / 高亮 / lint）；数组加元素 8→9 行、标量改值、对象改结构 9→10 行均即时反映；Apply 后弹层关闭 + 选中变更节点 + 900ms 高亮 + 徽标「已修改 N 处」。
- **undo/redo/reset**：undo 回原行数、redo 复现、reset 全部回原文档（`totalRows` 回 8、徽标隐藏、undo 变 no-op）。
- **守卫**：非法 JSON → Apply 禁用 + 行列错误；core `PARSE` 错误留层不关（不产生修改）；编辑后搜索命中 stale（「文档已修改，搜索结果已清空」）。
- **导出**：`exportDoc`（不受 5MB 限制）→ Blob 下载；无修改 `原名.json`、有修改 `原名-edited.json`；reset 后内容逐字节等于原始 pretty JSON。
- **性能**（10MB 样本，core 临时基准）：`getNodeJson` 中层 item **0.22ms**、同形状 Apply **0.24ms**、undo/redo **0.05/0.04ms**；展开态 item 12→2000 字段 Apply **0.85ms**（+1988 行）/ undo 0.15ms；首开编辑器（130.6KB gz）0 长任务。
- **回归**：`npm run smoke` / `smoke:ext` / `smoke-search` **82/82** / `smoke-extension-search` **56/56** / `smoke-expand` **11/11** 全绿；截图 `.spike/smoke/edit-{open,applied,reset}.png`。

**slice 5.5 复制验收**（2026-11-02，CfT headless 1440×900；`scripts/smoke-copy.mjs` **21/21**）：

- **菜单**：5 项固定顺序（复制子树 JSON / 复制路径 / 复制原始值 / 复制键名 / 分隔线 / 编辑此节点 JSON）；容器「原始值」禁用、根「键名」禁用（`title` 说明）、标量数组元素全启用；焦点落第一个可用项。
- **四格式逐字**：子树 JSON 2 空格（含非标识符键 `{"b.c": "x"}`）；根全文；规范路径 `$` / `$.a` / `$['b.c']` / `$.a['b.c']` / `$['it\'s']` / `$.arr[0]`；原始值（字符串去引号且**反转义**：`line\n"q" \ tail` → 真实换行/引号/反斜杠；`10` / `true` / `null`）；键名 `b.c`（非标识符键原样）/ `0`（数组下标无方括号）；容器原值与根键名 → `BAD_COMMAND`。
- **剪贴板**：CDP 授权 origin 后四格式**逐字读回**（`$.arr[1].k`、`{\n  "b.c": "x"\n}`、`10`、`b.c`）；真实菜单点击 → toast「已复制：<格式>」+ 菜单关闭；无读权限环境自动降级为只验 toast/菜单/状态。
- **守卫 / 只读**：6MB 标量子树 → `TOO_LARGE`，toast「子树过大（6.0 MB），超过 5 MB，请用「导出」」；复制前后 `docRevision`/`rowVersion`/`totalRows` 不变；0 page 异常 / 0 console error。
- **体积**：`page.js` 17.0→**18.1KB gz**（预算 45），worker 6.3→6.6；CM6 闭包不变。
- **回归**：`npm run smoke` / `smoke:ext` / `smoke-search` **82/82** / `smoke-extension-search` **56/56** / `smoke-expand` **11/11** / `smoke-edit` **14/14** 全绿；截图 `.spike/smoke/copy-{menu-container,menu-root,toast}.png`。

**slice 6.0 截断修复验收**（2026-11-03，CfT headless 1440×900；`scripts/smoke-repair.mjs` **14/14**；`tests/unit/core/repair.test.ts` 51）：

- **修复**：`{"a":1,"b":"hello wor` → 补 1 个结束引号 + 1 个 `}`，值图 `{a:1,b:"hello wor"}`；`meta.repair = {status:'repaired', truncatedAt:21, counts:{brackets:1,quotes:1,commas:0,deletedChars:0}, ops:[…]}`；修复条文案含「仅语法闭合，未修改任何已有值」。
- **拒绝修复**：`{"a":1}XYZ`（非 EOF 形态）→ 导入层 PARSE、零修复痕迹；合法 JSON / 尾部空白 → `status:'none'`、无修复条。
- **提示条**：32px / `role=status` / `aria-live=polite`；「摘要」展开逐条 ops（`@21 字符串未闭合 → 补结束引号`、`@21 补 1 个闭合符`}`（对应未闭合的 {@0）`）；**关闭只隐藏条**，状态栏角标与导出后缀保留；重新导入合法文档后清空。
- **导出**：`cut.json` → `cut-truncated-repaired.json`（不往 JSON 里塞注释）。
- **fixture 矩阵**：`reassess-fidelity.md` §6.1 的 18 个（16 截断逐字断言 + 2 无需修复）+ 7 个拒绝态 + counts/ops 不变量；不猜内容、任何输入不抛错。
- **性能**：修复只在 `JSON.parse` 失败时触发（合法文档零成本）；纯函数扫描 + 切片应用 O(n)，3.6MB 截断文本约 40ms。
- **回归**：`smoke` / `smoke:ext` / `smoke-search` 82/82 / `smoke-extension-search` 56/56 / `smoke-expand` 11/11 / `smoke-edit` 14/14 / `smoke-copy` 27/27 全绿；截图 `.spike/smoke/repair-{bar,summary,closed}.png`。

**slice 6.1 设置面板验收**（2026-11-03，CfT headless 1440×900；`scripts/smoke-settings.mjs` **20/20**）：

- **默认值**：8 项 = dark / 24 / 16 / false / subtree / 2 / true / true；主题生效、`--row-h` 24、`--row-indent` 16、spacer = 8×24。
- **面板**：活动栏齿轮 → 左面板「设置」；标题/`aria-label`/8 行顺序/焦点落面板；`aria-current` 同步。
- **即时生效**（真实点击控件）：主题 dataset + 状态栏「亮色」；行高 22 → `--row-h` 22px、首行 22px、spacer 8×22；缩进 20 → `--row-indent` 20px；类型列显示；默认复制格式=路径 → 行尾浮条复制得 `$.arr[1].k`；复制缩进=4 → 子树 JSON 4 空格；关闭修复 → 截断直接 `PARSE` 且当前文档不变；关闭自适应 → 小文档保持折叠（2 行、spacer 44px）。
- **导出方式（第 9 项，ADR-0012 修订）**：面板点「复制到剪贴板」→ 分体按钮主操作 label 同步为「复制 JSON 到剪贴板」。
- **持久化**：刷新页面后 9 项设置 + 主题 + 行高/缩进 CSS + 左面板模式全部恢复（`localStorage` 口径；扩展内为 `chrome.storage.local`）。
- **回归**：`smoke` / `smoke:ext` / `smoke-search` 82/82 / `smoke-extension-search` 56/56 / `smoke-expand` 11/11 / `smoke-edit` 14/14 / `smoke-copy` 27/27 / `smoke-repair` 14/14 全绿；截图 `.spike/smoke/settings-{panel,applied,reloaded}.png`。

**slice 6.2 导出分体按钮验收**（2026-11-03，CfT headless 1440×900；`scripts/smoke-export.mjs` **16/16**）：

- **形态**：`[导出 | ▾]`；加载后可用；主按钮文字恒「导出」、`aria-label` 随方式（导出 JSON 文件 / 复制 JSON 到剪贴板）。
- **菜单**：两项、当前方式带 ✓、`menuitemradio` + `aria-checked`；打开时焦点落当前项；↑↓ 移动；Esc 关闭且焦点回箭头。
- **复制**：剪贴板**逐字**等于导出文本（`{"a":{"b.c":"x"},"arr":[10,{"k":null}]}` 的 2 空格 pretty）；toast「已复制：JSON」success tone；菜单关闭；方式记住（主按钮 label 切换）。
- **记忆**：主按钮复用上次方式；切回「文件」→ 记录下载动作（`sample.json`，无修改/修复后缀）；**刷新页面**后方式持久化（`Settings.exportMode`，`tjv.settings.v1`）。
- **双向同步**：菜单选「复制」→ 设置面板第 9 行回显；设置面板改「复制到剪贴板」→ 主按钮 label 与菜单 ✓ 同步（同一个 `SettingsState`，无第二份状态）。
- **守卫**：20MB 阈值单测覆盖（19.9 / 20 / 20.1MB）；超限只提示不降级下载。
- **回归**：`smoke` / `smoke:ext` / `smoke-search` 82/82 / `smoke-extension-search` 56/56 / `smoke-expand` 11/11 / `smoke-edit` 14/14 / `smoke-copy` 27/27 / `smoke-repair` 14/14 / `smoke-settings` 20/20 全绿；截图 `.spike/smoke/export-{menu,toast}.png`。

**slice 6.3 原始文本视图验收**（2026-11-03，CfT headless 1440×900；`scripts/smoke-raw.mjs` **25/25**）：

- **source 模式**（多行源文本 404 行）：窗口 404 行逐字等于源文本；`data-line` 1-based 绝对行号（`start` 之后连续）；滚动到底 `start + rendered = totalLines`；渲染行数 ≤ 屏行+1+2×overscan。
- **pretty 模式**（minified 9.3KB 单行 / 1204 行）：行布局逐字等于 `JSON.stringify(value,null,2)`；视图内提示「源文本为单行（minified）…」。
- **检查点重放**（3000 项 minified / 15004 行）：在 `start = 0 / 2047 / 2048 / 2049 / 9002 / 15003` 取 3 行窗口，全部逐字等于参考 `JSON.stringify` 行；跨检查点边界不漂移。
- **plain 模式**（截断文档）：`mode=plain & damaged=true`，修复摘要 `@at` 点击 → 切原文 → `rawLocate` 行 = 高亮行（`flash` 命中）；提示「原始文本被截断（已修复），此处显示原始字节」。
- **复制原文**：剪贴板逐字等于源文本；`maxBytes=10` 走 `TOO_LARGE`（不静默截断）。
- **视图独立（v1 不联动）**：有临时修改时原文提示「不含临时修改」；「全部展开」与搜索跳转都会先切回树视图。
- **持久化**：刷新后 `UiState.viewMode='raw'` 恢复，导入文档后直接进原文视图（pretty 模式）。
- **性能**（Node v24 / 同 V8，`buildRawIndex` + `windowText` 直接基准）：10MB minified（9,965,133 字符）pretty 索引构建 **24.0ms** / 669,412 行；50MB（49,840,274 字符）**106.9ms** / 3,328,372 行；50 行窗口 p95 **0.07–0.21ms**、`locate` p95 **0.06ms**；索引**惰性构建**（首次进入原文才建，不占导入首帧），源文本保留在 Worker（50MB ≈95MB，ADR-0003 修订 §2）。
- **零异常 / 零长任务**：0 page exception、0 console error；`longtask` 观察器（切换 / 索引构建 / 滚动 / 刷新）全程 **0 条**（ADR-0003 修订 §7）。

**slice 6.4 大纲面板验收**（2026-11-03，CfT headless 1440×900；`scripts/smoke-outline.mjs` **37/37**）：

- **形态 / 持久化**：活动栏第 3 个模式按钮（`data-panel-btn="outline"`、`aria-label="大纲"`）→ 320px 左面板、标题「大纲」；无文档时空态「导入文档后显示结构大纲」；`UiState.panel='outline'` 刷新后恢复（空态）。
- **结构行**：根行 `$`（object / 3 项、`aria-level=1`、恒展开、无 caret）；行 = 键 → 类型 → 项数（容器 `N 项`、标量无 count/caret）；DFS 顺序（子行紧跟父行）；非标识符键路径 `$['a.b']` / `$['it\'s']` 在 `data-path` 与展开跳转上正确。
- **交互**：caret 点击只改大纲展开态（树行数/滚动/选中**均不变**，有逐项断言）；点击行 = 跳树（`expandTo` 展开祖先 → 居中 → 选中 `.row.is-selected` → 大纲 `.is-current` + `aria-activedescendant`）；键盘 ↑↓ 移动当前行（树选中同步、不跳不滚）、←→ 展开/折叠（`aria-expanded` true↔false 真翻转）、Enter 跳转、焦点留在面板；已加载末行再按 ↓ = 加载下一页（键盘可达分页）；不可见选中不高亮、展开祖先使其可见后自动滚入；原文视图下点行先切回树（`viewMode` 回 `tree`）；关闭面板再打开保留展开现场；点已激活的大纲按钮回文档视图。
- **行高跟随设置**：默认 24 → 改 22 → 恢复 24，行元素高度 / spacer（`行数×行高`）/ 窗口全部同步。
- **大文档跳转（真 expandTo）**：450 项数组（451 节点 > 自适应阈值，树默认折叠）下点行 `$.items[300]` / End+Enter → 树 `totalRows` **2 → 452**、`scrollTop > 0`（居中）、`.row.is-selected` 命中目标路径（小文档全展开时这两条是 no-op，因此单独用大文档验收）。
- **分页 / 虚拟化**（450 项数组）：展开首屏 **203 行**（200 + 哨兵）→ 键盘 ↓ 翻页 **403** → 真点「加载更多」哨兵 **452 行**（末行 `$.items[449]`，哨兵消失；到末页 hook 返回 `ok:false`）；spacer 精确 = `452 × 24 = 10848`；滚到底渲染 **38**（末窗 `min(屏行 31 + 2×overscan 6, size − start)` 截断），`#outlineFoot` = `已渲染 38 / 452 行`。
- **生命周期**：换文档 → 回根展开（rows `['$','$.x']`、expanded `['$']`）；编辑（`docRevision` 2）→ `refresh` 回根展开；大纲展开态独立于树。
- **10MB 性能**：导入→大纲根页 `ready` **63ms**（含导入总时长）；展开 `$.data` **1ms**、`$.data.items` **1ms**；行数 205（根+status+data+items+200 项+哨兵）；滚动/分页 0 长任务、0 异常、0 console error。
- **体积**：`page.js` 25.1→**28.7KB gz**（+3.6，**达标**——2026-11-09 用户拍板 A：目标 +2.5 修订为 +3.6 并注依据（虚拟列表 + 键盘 + 分页 + a11y 完整实现）；预算 45 未动、无新增依赖、余量 16.3KB；#21 仍可复查压缩空间，不作达标条件）、`worker.js` 11.7→11.9、`page.css` 6.8→7.2。

**slice 6.5 验收**（2026-11-09，CfT headless 1440×900；`smoke-search` **94/94**、`smoke-expand` **14/14**）：

- **Aa（区分大小写，真实点击 `#searchCase`）**：fixture `{"Hotel":1,"hotel":2,"HOTEL":3,"list":["HoTel","xhotelx"],"deep":{"Hotel":"v"}}` 上，默认子串 **6** 命中（键 4 + 值 2）→ 开 Aa **2**（键 `hotel` + 值 `xhotelx`）；`aria-pressed` 往返正确、输入框无 `aria-invalid`。
- **正则（`.*`）**：`/^hotel$/i` → **5**（键 4 + 值 `HoTel`；子串模式不可能有锚点语义，故与默认 6 不同，可证伪）；正则 + Aa → **1**（只有键 `hotel`）。
- **无效正则**：`(` → `#searchPatternError` 文案「正则语法错误：…」、输入框 `aria-invalid="true"`、结果列表 **0 行**、树 **0** 个 `is-hit`、**无 toast**、`phase=idle`（不是「无命中」态）；`(a+)+` → 「该正则可能触发灾难性回溯」被拒；改回合法模式 → 错误态清除、结果恢复 5；关开关/清空 → 统计归零。
- **导入体积提示（`#docWarnBar`）**：50MB 样本（`meta.bytes = 52,429,000` > 50,000,000）→ 条可见、`role=status`、文案含「源文本」、点 `#docWarnClose` 后隐藏；10MB 文档 → 不出现（换文档按新 `meta.bytes` 重新判定）；不阻断导入、无弹窗。
- **项数标点击（#9）**：小文档收起后点 `$.c` 行的「1 项」→ `totalRows` 4→5→4、选中行不变、`is-clickable` + `title`（展开/收起）就位；标量行无项数标。
- **全部展开 no-op（#9）**：已全展开时点「全部展开」→ 中性 info toast「已经全部展开了」，`rowVersion` 不变（不做无意义换版本/回顶）。
- **性能 / 零异常**：两个阶段 **0 长任务**、0 console error；单测 **440/440**。
- **体积**：`page.js` 28.7→**29.6KB gz**（+0.9，ADR-0014 目标 **≤ +1.5 达标**）、`worker.js` 11.9→12.4（正则 +0.5）、`page.css` 7.2→7.3。

**slice 6.6 验收**（2026-11-09，CfT headless 1440×900；`smoke-fidelity` **24/24**）：

- **精确数量（按类别，ADR-0020 口径）**：失真 fixture（大整数 `297532588187238660`、`1234567890123456789e0`、`1e400`、`1e-400`、`1e10001` 超 cap、字符串里的 19 位数字、高精度小数、重复整数键对象、整数键乱序对象、无损整数键对象）→ `counts{number:4, overflow:2, underflow:2, keyOrder:1, total:5}`、文案「检测到 5 处失真：数字上溢 2 处 · 数字下溢 2 处 · 整数键顺序 1 处」；**大整数 / `1e400` / 字符串内数字 / 高精度小数 / 重复整数键都未被计入**（可证伪）；`hits[0]` = `overflow`、`literal=1e10001`、`parsed=Infinity`。
- **跳原文**：点「查看原文」→ `mode:'raw'`、`flash` 行 = `rawLocate(hits[0].offset).line` = **2**（fixture 中 `big` 所在行），该行文本含 `1234567890123456789`；跳转后保真条仍在。
- **无失真**：`{"a":1,"b":[1,2,3],"c":{"d":true}}` → `status:'none'`、条不出现、jump 隐藏。
- **关闭只关条**：`×` 后 `barVisible=false`，但 `status:'found'`、`counts.total=5` 仍在（报告不丢）。
- **与修复条并存**：截断 + 大整数失真 → 两条都可见，几何 `repairTop=48 < fidelityTop=80`、两条高各 **32px**（修复在上）。
- **首帧不回归**：10MB 导入首行 **0ms 内出现**（load 81ms）、扫描在首帧后完成（`status:'none'`、scanMs ≈48ms）、**0 长任务**、0 console error。
- **回归 / 收口**：新增的保真扫描改变了 Worker 的让出语义 → 发现并修复「微任务让出把 Worker 卡住」的回归（10MB 时大纲 expand 1ms → **34ms**；改宏任务让出后回 1ms 级，`smoke-outline` 53/53 复绿）；另按双轴 code review 收口（见上）→ 单测 **486/486**。
- **体积**：`page.js` 29.6→**30.2KB gz**（+0.6：第三条提示条 + app 接线）、`worker.js` 12.4→**13.9KB gz**（+1.5：扫描器）、`page.css` 7.3（+0.0）；无新增依赖。

**slice 6.7 验收**（2026-11-09，CfT headless 1440×900；`smoke-expand` **20/20**、`smoke-copy` **28/28**）：

- **菜单契约**：7 项固定顺序（复制 4 / 分隔 / 展开整棵子树 / 收起整棵子树 / 分隔 / 编辑）；启用矩阵 = 有子节点的非根容器可用、标量 / 空容器 `{}` / 根禁用（`title` 分别写「只能展开容器节点」/「该容器没有子节点」/「根节点请用工具栏『全部展开 / 全部收起』」）；可用项的 `title` = 「含该节点自身；不含更上层」。
- **递归展开**（fixture 全展开 14 行）：折叠到 4 行 → 右键 `$.A` →「展开整棵子树」→ **12 行**、`rowVersion` +1、`$.A`/`$.A.a1`/`$.A.a2` 的 `aria-expanded` 全 `true`（空容器 `$.A.empty` 不参与）。
- **no-op**：已全展开再点 → info toast「整棵子树已经全部展开了」、`rowVersion` 不变（不制造无意义换版本）。
- **深度复位**：收起子树 → 回 4 行；再**单层** toggle `$.A` → **7 行**（不是 12 行，证明没有恢复上次展开现场）。
- **子树外不受影响**：展开 `$.B` 子树（6 行）→ 展开 `$.A`（14 行）→ 收起 `$.A` → **6 行**且 B 子树仍展开。
- **预算原子拒绝**：50MB 的 `$.data` 菜单可用 → 点击「展开整棵子树」→ `TOO_MANY_ROWS` toast；`totalRows`/`rowVersion` 与点击前一致（零部分修改）。
- **视口 / 选中**：不滚回顶部（与「全部展开」的 Q7 不同）；选中路径保留；0 长任务、0 console error。
- **体积**：`page.js` 30.8→**31.1KB gz**（+0.3）、`worker.js` 14.9→**15.2**（+0.3）、`page.css` 7.3（+0.0）；无新增依赖。

**复跑**：`npm run check`（tsc + vitest + build）+ 13 套冒烟：`npm run smoke && npm run smoke:ext && node scripts/smoke-search.mjs && node scripts/smoke-extension-search.mjs && node scripts/smoke-expand.mjs && node scripts/smoke-edit.mjs && node scripts/smoke-copy.mjs && node scripts/smoke-repair.mjs && node scripts/smoke-settings.mjs && node scripts/smoke-export.mjs && node scripts/smoke-raw.mjs && node scripts/smoke-outline.mjs && node scripts/smoke-fidelity.mjs`（样本在 `.spike/samples/`，可用 `.spike/gen-samples.js` 生成；冒烟**不能并发**，CDP 端口 9883）。当前口径：**29 个测试文件 / 725 单测**（含 `tests/contract` 契约套件 38 条 + `window-source.contract.ts` 共享契约 × 2 adapter + `search-parity` 52 条 + `menu` 24 条 + `visual-contract` 14 条）+ 13 套冒烟（`smoke-search` 97、`smoke-extension-search` 56、`smoke-expand` 21、`smoke-copy` 38、`smoke-export` 21、`smoke-raw` 26、`smoke-outline` 53、`smoke-fidelity` 24、`smoke-settings` 24、`smoke-repair` 14、`smoke-edit` 14）。

**技术债清理 T2（2026-11-09 第二批，纯 refactor/无新功能）**：① 搜索高亮两份实现合一 + Unicode 大小写折叠修正（`shared/highlight` + `view/highlight`）；② 删死 API `RowRenderer.setHit`、`DomRowPool` 单一构造；③ `CoreTransport` 契约测试落地（InProcessCore vs WorkerTransport+FakeWorker 共用一份用例）+ `WORKER_CRASH`/`CLOSED` 崩溃收口 + 修掉「事件 ctrl+win 双投递 ×2」（`worker.ts` 事件只走 ctrl）；④ `getNodeJson` 5MB 守卫改「下界预扫早停 → 再精确判据」（`core/measure`）；⑤ CM6 EOF 诊断非空范围；⑥ a11y 骨架清理（`#tree`/`#dropzone` 去掉假语义，`role=tree` 单一真相在内层 `.tjv-tree`，焦点路径统一走 `main.ts` 的 `focusTree()`）。

**已知差距 / code review 待收口**（2026-10-29 审查发现 + 2026-11-09 T2 清账，均非 slice 4 回归，按优先级进 backlog）：

- 子树批量展开/收起（slice 6.7 / #22）：入口**只有右键菜单**（无快捷键、无行尾浮条入口 —— Q3/Q14 拍板）；展开是**全深度**语义（与单层 `toggle` 不同，别在别处按「一层」复用）；`changed` 只看**可见结果**——祖先折叠时写入的内部状态不推 `rowVersion`（UI 不可达）；菜单新项与分隔线的观感并入 **#21** 统一走查（本 slice 只加最小必要样式）；50MB 的子树预算拒绝已验，但未做「50MB 全深度展开」的耗时基准（预算护栏使其不可达）。
- ~~行高真值仍是常量 / `RowMetricsSource` 未实现~~ → **已实现**（ADR-0011 §6：`TreeView.setRowHeight` + `--row-h` + `RowWindowSource.setMetrics`，设置面板可选 20/22/24/26）。
- ~~`ThemeState` / `PanelState` / `ViewStateStore` 未接线~~ → **已接线**（ADR-0011：`SettingsState` 承担主题 + 8 项设置 + 布局态，经 `ViewStateStore` 持久化）；未单独建 `ThemeState`/`PanelState` 类。
- ~~`RowRenderer.setHit` 与 seams §4 接口漂移（TreeView 实际走 `RowContext.hit`）；`DomRowPool` 双构造重载无第二个调用点~~ → **已清**（2026-11-09 T2：删死 API `setHit`，`DomRowPool` 收敛为 `(host, opts?)` 单一构造）。
- ~~`CoreTransport` 契约测试（InProcess vs Worker 同一套用例）与 `WORKER_CRASH` 错误路径测试仍缺~~ → **已补齐**（2026-11-09 T2：`tests/contract/` 一份共享用例 × `InProcessCore` / `createWorkerCore(FakeWorker)`；TIMEOUT/CLOSED/WORKER_CRASH 独立 describe；顺带修掉「事件被 ctrl+win 双投递 ×2」的潜伏缺陷）。
- ~~搜索高亮 helper 在 `row-renderer` 与 `search-panel` 各一份；大小写折叠对 `İ/ẞ` 等字符会错位（罕见）~~ → **已清**（2026-11-09 T2：区间计算抽 `shared/highlight.hitRanges`、DOM 写入抽 `view/highlight.writeMarkedText`；非 ASCII 走 `giu` 正则取原串下标，İ 不再错位）。~~**剩余**：smoke 脚本的 reference walk 与 `core/search.ts` 是两份实现~~ → **已清**（2026-11-10 / §11 6.13 + ADR-0014 修订：搜索语义单一 oracle 放 vitest，两份冒烟 walk 删除、改读 `scripts/lib/search-expectations.mjs` 文档基线 + 样本指纹）。
- 菜单交互（键盘 / 定位 / 失焦 / 焦点归还 / 单活）已按 **ADR-0015** 收口；**视觉观感**（两套菜单的间距 / 分隔线 / 勾选列一致性）已按 **ADR-0016 §2.4** 收口（2026-11-10 / #21：两套 176 宽、32px 行高、16px 前导列、文字起点一致、分隔线 `--border`、项焦点 bg-selected + 1px 内描边）。
- 搜索选项（slice 6.5 / ADR-0014）：正则的灾难性回溯防护是**启发式静态筛查**（只拒外层无界重复量词）——`(a|a)+` 这类「重叠分支 + 量词」会漏过，漏网病态正则可卡住 Worker 至 5s 命令超时（v1 无 Worker 自动恢复，需重新导入文档）；反向也会误杀 `(?:[.-][a-z]+)*` 这类常见「分组内含 `+` + 外层 `*`」写法。两个开关是会话态**不持久化**（刷新回默认，ADR-0011 的「不进 v1 设置」仍未变）。
- 搜索结果行高 44px 现有两份来源：CSS `--result-row-h` 与 `src/viewmodel/search-state.ts` 的 `SEARCH_RESULT_ROW_HEIGHT`（跨语言无法单 import；冒烟按渲染/几何断言兜底，漂移会红）。结果列表滚动直接重绘、未做 rAF 合并（实测 0 长任务）。`SEARCH_LIMIT=50,000` 在 `src/protocol/versions.ts` 与 `scripts/lib/search-expectations.mjs` 两处（同上，漂移会被冒烟 `big:search:hits==reference` / `trunc:hits==limit` 抓到）。
- ~~空态 dropzone 有 `role=button` 但无 click/键盘处理器；`#tree` 内外层重复 `role=tree/tabIndex`（骨架遗留）~~ → **已清**（2026-11-09 T2：`#tree`/`#dropzone` 去掉假的 button/tree 语义；`role=tree`/`tabindex` 只留内层 `.tjv-tree`，`main.ts` 统一走 `focusTree()`；dropzone 空白处点击 = 选择文件）。
- 编辑：~~CM6 对「文档末尾」的 lint 诊断是空范围~~ → **已修**（2026-11-09 T2：`diagAt` 在 EOF 给非空范围）；~~`getNodeJson` 先 stringify 再判 5MB~~ → **已修**（2026-11-09 T2：`core/measure.jsonSizeLowerBoundChars` 分配无关下界预扫 + 早停，超预算在 stringify 前拒绝）；**剩余**：弹层未做 **focus trap**（Tab 可离开面板）；50MB 文档导出（stringify + 50MB postMessage）未实测。
- 「替换文档」已有未保存确认；「关闭文档」功能本身尚未存在（随 #11 最近文档 / 多标签再做）。
- ~~「全部展开」在已全展开时仍可点（core `changed=false` no-op，无 UI 反馈）~~ → **已实现**（2026-11-09 slice 6.5：`rowVersion` 未变 → info toast「已经全部展开了」/「已经全部收起了」，且不做无意义的换版本/回顶）；~~「N=500 可关」待设置面板~~ → 已实现（设置「小文档自动全部展开」）。
- `expandAll` 不把**空容器**加入 `expanded`（`{a:{}}` 全展开返回 `changed=false`、`open=false`）；若要「空容器也显示展开态」需另定并改行模型语义。
- 复制（slice 5.5）：子树 JSON >5MB 只能走导出（`TOO_LARGE` toast 引导）；~~「缩进/压缩跟随当前设置」未做~~ → 已实现（设置「复制缩进」2/4/紧凑 + 「默认复制格式」，ADR-0011 §1）；**真实扩展页未实测剪贴板**（HTTP 模式验到 `navigator.clipboard` 逐字读回，扩展内无 `__tjv`，需真机向导补）；菜单未加复制快捷键（⌘C 保留给原生文本选择，见 ADR-0010 §8）。
- 截断修复（slice 6.0 / #8）：~~「关闭修复」开关待设置面板~~ → 已实现（设置「导入时自动修复截断 JSON」，关闭后截断直接 `PARSE`，ADR-0011 §1）；~~修复摘要 `at` 只展示偏移~~ → **已实现跳行**（slice 6.3：`@at` 可点击 → 切原文 + `rawLocate` + 高亮，ADR-0003 修订 §5）；修复耗时按「仅解析失败时才扫描」控制成本，50MB 级截断文本未实测。
- 原始文本视图（slice 6.3 / #11）：
  - **短 minified 仍是单行**：`maxLineLength ≤ 4096` 的源文本一律走 source 模式（ADR 有意如此，4096 是「有没有可用行」的判据），所以 300 字符的 minified JSON 在原文视图里就是 1 行——想要 pretty 布局得点「格式化」，v1 不做（ADR-0003 修订 §6）。
  - **>1.4M 行 spacer 封顶**：`min(totalLines×rowH, MAX_SCROLL_PX)` 与 TreeView 同源问题——50MB pretty ≈3.33M 行时滚动条封顶、底部行不可达（ADR-0001 §4 的缩放映射未实现）；本 slice 用 15k 行样本验收。
  - **解析失败的文本仍不能进原文视图**（导入层报 `PARSE`，无值图 → 无 doc 根）；「报错也可看原文」需无值图的文档会话，记 backlog（ADR-0003 修订 §6）。
  - **原文视图的产品定位与再评估**（用户 2026-11-03 拍板「等保真提示落地后再评估」）：保真提示已于 2026-11-09 落地（slice 6.6 / #23），触发条件满足。**用户 2026-11-09 复评结论 = 维持现状**（常驻 `[树|原文]`、v1 不联动/不搜索/不编辑；不复评入口降级、不收掉复制原文/`at` 跳行）——保真提示给了它「看真值」的明确入口价值。后续若要动形态，另开 effort（不在 #21 视觉走查里做功能增删）。
  - ~~**>50MB 导入提示（含源文本 ≈1.9× 内存）仍未实现**~~ → **已实现**（2026-11-09 slice 6.5 / #11 收口）：`meta.bytes > LARGE_DOC_WARN_BYTES`（50 MB 十进制 = 50,000,000）→ `#docWarnBar` 32px warn 条（`role=status`、可关闭、只关条不释放源文本、换文档重新判定），文案给出「源文本常驻 UTF-16 最多约 2× 文件大小 + 值图另计」，文件大小与估算都用十进制 MB 以与阈值同单位。剩余差距：内存数字是**估算**（不含实测堆水位），50MB+ 文档未做长时间会话的内存曲线。
  - 原文内**查找/选中/跳转树**不做（v1 不联动）；切回树再进原文会回到顶部（`open()` 复位滚动；保留位置是小改进，未做）；行内高亮 run >512 时该行退回纯文本（保逐字，仅影响 4096 字符级超长标量行）；无方向预取，极快拖动滚动条可能 1 帧空白（overscan 8 覆盖平滑滚动）。
  - ~~`RawWindowSource` 与 `RowWindowSource` 的窗口纪律是两份实现~~ → **已清**（2026-11-09 / ADR-0008 修订：收口为 `WindowMachine`，row/raw 退化为 adapter；`tests/unit/viewmodel/window-source.contract.ts` 一份契约 × 两个 adapter；改 S2 语义只改 machine 一处）。
  - **50MB 原文端到端未实测**（UI 链路 smoke 用 3000 项/15k 行）；但 core 基准已跑 50MB：索引构建 **107.2ms**、窗口 p95 0.071ms（Node v24 同 V8；Chrome Worker 内会略高）。
- 导出（slice 6.2）：**复制到剪贴板 >20MB 直接拒绝**（提示用文件导出），50MB 的实际剪贴板写入耗时未实测；复制缩进跟随设置「JSON 缩进」（2026-11-12 #38 / ADR-0022：默认 2 空格，与文件导出/子树复制共用；>20MB 仍拒绝）——ADR-0012 该条偏差关闭。
- 大纲面板（slice 6.4 / ADR-0013）：
  - 树里选中一个「大纲中不可见」的节点（祖先未展开 / 未翻页）时，大纲不高亮、不自动展开定位（v1.1 候选）。
  - **编辑后大纲回根展开**（不保留展开现场）；大纲展开状态**不持久化**（刷新 / 重开页面回到根展开）。
  - 分页为手动「加载更多」，无预取；50MB 的 `data.items`（184,909 项）需 925 次点击才到底，50MB 大纲未端到端实测（10MB 已验）。
  - 每个容器页请求都重新枚举该容器子项（`Object.keys` / 数组切片）；单容器页 200 项 <1ms，但**不做容器级缓存**（避免大纲持有「全文档形状」，ADR-0013 背景）。
  - 虚拟窗口 `spacer` 与树同源受 `MAX_SCROLL_PX` 封顶（>1.4M 行底部不可达，与 ADR-0001 §4 缩放映射一起未实现）；`childInfo` 判定展开行是 O(已加载子项) 扫描（大数组翻页后点 caret 有毫秒级成本）。
  - 非根容器的页请求失败**无内联错误提示**（`setOpen`/`loadMore` 返回 false、折叠再展开会重试；「加载失败，重试」哨兵留 v1.1）；虚拟窗口计算与搜索共用 `shared/window.computeVirtualWindow`（code review 收口，不再各写一份）。
- ~~**保真提示（#23）**：实现从未做~~ → **已实现**（2026-11-09 slice 6.6 / ADR-0003 修订）。落地形态：`core/fidelity.ts` 单趟线性扫描 + `fidelity {rootId}` 只读命令（首帧后 app 主动拉取、每 256KB 让出、可取消、报告按根对象身份缓存）+ 第三条 32px 保真条（精确数量 +「查看原文」跳第一个失真行）。`.mock/1.json` 上**与原型逐条对拍一致**：>15 位候选 57 → 精确后真失真 **2**（`offset 14871 / 339094`），key-order 0。剩余差距：
  - **高精度小数不检测**（`0.1234567890123456789`）：ADR-0020 起小数仍按 `number` 丢精度、不检测（整数已无损，不再有 precision 类别）；这是 ADR-0020 §8 的已知差距。
  - **重复键 / `-0` / 孤立代理项**仍只记录不标记（ADR §4 不变）；**重复的下标键不参与键序判定**（`{"1":a,"2":b,"1":c}` 不报 key-order，真损失是重复键吞并）。单对象已见下标键追踪上限 `FIDELITY_KEY_TRACK_MAX=4096`，超过后放弃重复键追踪（超大数组样式对象的已知边界）。
  - `LoadReply.meta` **不挂** `FidelityReport`（票内初估的 `DocumentMeta.fidelity` 未采纳）：报告走 `fidelity {rootId}` 命令 + `WeakMap<Root, report>` + app 会话变量——扫描发生在首帧之后，`meta` 装不下「后到的报告」（ADR 修订 §6 已登记为显式偏差）。
  - `57 → 2` 的**真实样本口径没有自动化回归**（`.mock/1.json` 未入 git）；现有替代是单测「57 个 >15 位数字里 55 个可精确表示、2 个不可 → `counts.number=2`」+ ADR 里的手写对拍记录。
  - 报告只留**前 100 条**片段（`counts` 是全量），逐条列表跳转留 v1.1；不做逐节点标记。
  - 50MB 扫描实测：Node 同 V8 合成 50MB **≈330ms / 199 次让出**（ADR 估 288ms，同量级）；**Chrome Worker 内 50MB 端到端未跑**（10MB 实测 scanMs ≈48ms）。
  - `status:'skipped'` 只在类型里预留，core 取消语义是回包 `CANCELLED`（app 静默丢弃），不会产出 `skipped`。
- ~~`DocService` 的 8 条 `EditReply` 命令各自拼回包与版本规则、toggle 系回包缺 `history`~~ → **已收口**（2026-11-09 / ADR-0002 修订：私有根变更路径 `mutateRoot`，意图 `view`/`value`；`EditReply.history` 必填、回包形状恒定；`tests/unit/core/root-mutation.test.ts` 版本矩阵 + 形状契约）。app 侧「回包落地」已于 **6.10** 收口（`DocSession` + 单一 `applyLanding`）。
- ~~换文档后旧编辑历史残留（`⌘Z` / reset 把上一份文档的条目应用到新文档，路径存在时静默改写值图）~~ → **已修**（2026-11-09：`load` 成功即丢弃被替换根的历史；`doc-service.test.ts` 回归「重新 load → undo = NO_HISTORY」）。
- ~~`reset` 中途失败不回推版本~~ → **已修**（2026-11-09 评审加固：reset 逐条走根变更路径，每个条目应用后立即推两版本——中途失败时已落地步骤的版本已 stale，与旧实现同口径；同时修掉 value 意图下 `changedRow` 被 `changed` 门控的隐性类型洞）。
- **测试钩子仍静态打进生产 `page.js`**（`isExtension` 只是运行期守卫，esbuild 不做 tree-shake）：33.0KB 里约 1KB 是测试 adapter；可后续用动态 import 拆成仅 HTTP harness 加载的 chunk（须保证 `load` 事件前安装，避免冒烟竞态）。
- - ~~**响应式断点未实现**（2026-11-10 / #21 明确排除，属布局行为）~~ → **已实现**（2026-11-10 / #25 + ADR-0017：`direction.md` §3 的「≤1320px 左面板 300 / 右栏 284 / 树 980」落成纯 CSS token 覆盖；`smoke-settings` 新增窄窗口断言，1440 口径 `sideWidth=320` 不变。**注意**：① 收益实测只有树 +16~36px；② `--tree-max` 980 仅在窗口 1312–1320 真正封顶（惰性）；③ **窄屏自动收起右栏仍未做**，属行为变化，与 `UiState.railCollapsed` 持久化语义有关，另议）。**最近文档**仍归 #11（空态只做构图，不列历史）。**`.ndjson` 接受但不解析**：`#fileInput` 的 `accept` 含 `.ndjson`，解析器是严格 JSON（必 `PARSE` 失败）——只记差距，未在视觉 slice 改代码。
- **严格 JSON only**（边界，非 bug）：完整 JSON 只是多了尾逗号（`{"a":{"b":1,}}`）或用了单引号/裸键/注释时仍报 `PARSE`——截断修复只处理 EOF 形态、不擅自删原文符号；是否支持 JSON5 子集/尾逗号容错见 **#20**（待拍板）。

## 12. 多文档工作区标签（#18，已实现 2026-11-11）

> 设计定稿 2026-10-30（ADR-0009），实现 2026-11-11；验收数字见 §11 的 **6.19** 行与 ADR-0009「实现结果」。
> 术语：`CONTEXT.md`（工作区 / 文档标签 / 标签条）。ADR-0009 §1 的标签条视觉例外（32px、≥2 才显示）已按 `direction.md` §11 落地。

| 层 | 落地 |
|---|---|
| `protocol` | 新增 `closeRoot { rootId }`（**幂等**，回 `{rootId, closed}`）；`load` 回包 `rootId` = `doc:N`；`versions.ts` 加 `MAX_DOC_TABS=8` / `TAB_STRIP_HEIGHT=32` |
| `core` | `RootStore.close`；`DocService.load` **不覆盖**（每次 load 一个新 doc 根，id 单调不复用）；`closeRoot` 连带丢弃 `parentRootId` 指向它的 expression 根，并释放该根的编辑历史 / 节点数缓存 / 搜索抢占 seq；**搜索抢占 seq 改按根**（`Map<rootId, seq>`） |
| `viewmodel` | 新增 `src/viewmodel/workspace-state.ts`：`WorkspaceState` / `TabState`，runtime 工厂注入（`rowSource` / `rawSource` / `searchState` / `editState` 每标签一份）；标签 id `tab:N` 单调不复用；软上限 8、满则 `add` 返回 null 不淘汰；关活动标签右邻→左邻→空态；纯 TS 零 DOM、30 单测 |
| `view` | 新增 `src/view/tab-strip.{ts,css}` + `page.html` 的 `#tabStrip` 容器：32px（高度单一真相 = `TAB_STRIP_HEIGHT` 写 inline）、**≥2 文档才显示**（单文档 hidden 零高度零视觉变化）、`role=tablist` + `aria-selected`、roving tabindex、←/→/Home/End、重绘后归还焦点；CSS 全用既有 token、零新增颜色/阴影 |
| `app` | 工作区接线：切标签 = 换 adapter 引用 + 重挂三份订阅 + 恢复会话/选中/滚动/搜索（含面板输入框）/大纲/提示条；**所有回包按 `rootId` 路由丢弃**（`isActiveDocRoot`）；入口层「替换 ⇄ 在新标签中打开」+ `⌘⇧O` 直达 + 标签条 `＋`；拖到标签条空白 = 新标签、拖到文档视图 = 替换（暂存确认）；关标签先 `closeRoot`（有未导出修改先 `confirm`）、关最后回空态；第 2+ 份大文档内存提示 toast；dev hook **69 → 75** 成员、新增第 15 套冒烟 `smoke-workspace` **45/45** |

**关键不变式（改这块必看）**：doc 根 id **单调不复用** + 页面按 `rootId` 丢弃迟到回包 + **每标签独立 seq**——三者合起来取代了单文档时代「靠 rootId/版本号巧合」的 stale 判定；
`isActiveDocRoot(reply.rootId)` 是所有回包落地的前置门。切标签**不关根、不重解析**（只换订阅目标）；关标签**必须**发 `closeRoot`，否则 73MB 级 Worker 堆不还。

**看门狗 / 重载**：watchdog 仍走页面重载（惰性重建 core，见 ADR-0018 §6），重载后工作区丢失——与单文档时代一致，会话恢复不在 v1（ADR-0009 §4）。

**已知差距**：文件拖放落点分流由 `smoke-workspace` 用合成 `DataTransfer` 覆盖（非真机拖拽）；标签**重命名 / 自定义导出文件名**已由 ADR-0021 落地（#29 / #37 已关，2026-11-12）；满 8 只有按钮 `title` 提示；`loadId` 抢占仍是全局的（页面用入口层 busy 拒绝并发 paste/drop，并 closeRoot 释放被作废的 load 回包）；`closeRoot` 后堆回落只有单测层面证据。

**视觉调整（#21，已收口 2026-11-10）**：用户要求「后续功能实现后再统一做视觉调整」。功能 slice 期间不掺视觉改动；
功能冻结后按 #21 的清单集中成一个视觉 slice 做（设置面板 / 导出分体按钮 / 修复条 / toast tone / 行尾浮条 / 活动栏图标 /
空态+左面板 / 两套菜单一致性 / 亮色主题走查），已按 **ADR-0016** 落地并经用户 **2026-11-10 验收通过**，#21 **已关闭**。
后续若再有零散观感意见，**另开票**，流程 = 预览 → 拍板 → ADR 修订 → 实现 → 全套验收（`npm run check` + 13 套冒烟 + 体积 + 深/亮截图）。

**其它想法（仅记录、未拍板）**：**节点子键按规则排序**（痛点：一个节点下很多 key，想按规则排以快速定位；方向：只改「显示顺序」、不改数据顺序，见 #19）。
约束与待拍板问题已记在 #19（键序是产品承诺 → 排序只能是视图状态；`RowModel.keysOf` 需要容器级顺序覆盖 + 缓存失效；
设置入口**已就绪**（ADR-0011 的 `SettingsPanel` 可直接加排序项）。后续用 grilling 从该票的「待拍板问题」续，拍板后再落 ADR / 实现。

**其它想法（仅记录、未拍板）**：**树行右键菜单增加「展开/收起子节点」切换**（#22；现状菜单只有复制 4 项 + 编辑，展开/收起只能靠 caret/Enter/工具栏）。
核心待拍板 = 「其下子节点」语义：切**该容器本身**的展开态（复用 `toggle`，无需新协议）还是**递归展开/收起整棵子树**（需 core 新能力 + `ROW_BUDGET` 护栏）；
其余问题（菜单顺序/启用态/空容器/根/锚点/快捷键）已记在 #22。用户要求**做的时候先 grill**，未拍板前不实现；新增项归 #21 视觉走查。

**无损数字（#32 / ADR-0020，2026-11-12）**：导入真相源从 `JSON.parse` 换成**无损 parser**（`parseLossless`）；值图数字载体是 `number | bigint`，但对外 `JsonKind` 仍是 `number`。四条不变式（改这块必看）：

- **parser 与 `JSON.parse` 语法接受面逐例一致**（重复键最后赢、`__proto__` 不污染原型、BOM/尾逗号/前导零拒绝、深嵌套显式栈）——差异只允许在「数字值」上（整数无损）。
- **整数无损、小数有损**：整数超安全范围 → BigInt；整数展开位数 > `BIGINT_DIGIT_CAP(10000)` → Infinity + 保真报 overflow；高精度小数仍 Number（已知差距，不报）。`-0` 保留。
- **序列化单一入口**：导出/复制/编辑回填都走 `serializeLossless`（BigInt → 裸十进制数字，无 BigInt 时与 `JSON.stringify` 逐字节等价）；禁止对值图直接 `JSON.stringify`（BigInt 会抛 TypeError）。
- **保真判定单一来源**：`fidelity` 与 parser 共用 `analyzeNumberLiteral`；`precision` 类别已退场，只剩 overflow/underflow/key-order。

**双向定位（#30 / ADR-0019，2026-11-11）**：原文视图 ↔ 树视图按 **B-1 混合**映射互相跳转（原文→树 = 检查点 + 祖先键栈增量索引，首次跳转懒建；树→原文 = 按需单趟扫描 + 每标签 LRU）。四条不变式（改这块必看）：

- 映射索引**只依赖源文本**：临时编辑不重建、换文档/关根才释放；跳转永远对原文，不对编辑后的值。
- **回包按 `rootId` 丢弃**：切标签/换文档后的迟到映射回包不得回填到新文档（与切标签同一前置门）。
- **plain 模式（修复文档）两侧禁用**：源文本与修复后值图不一一对应，不做映射（按钮禁用 + title 说明）。
- 重复键取**最后一个**源位置（与 `JSON.parse` 保留值一致）；结构行（`}`/`]`/`,`/空行）回 `null`、**不回退最近节点**；容器开括号 / 成员值起点命中标 `exact:false`，不假装精确。
