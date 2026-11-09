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
| `messages` | 主↔Worker 判别联合：`load/window/toggle/expandTo/replaceNode/getNodeJson/getTrail/search/cancelSearch/stats/eval/copy/rawOpen/rawWindow/rawLocate/rawSource/undo/redo/reset/profile/cancelLoad/expandAll/collapseAll/exportDoc/copyNode/outline` + 回包/事件 | `type Command` / `type Reply` / `type Event` |
| `types` | `Row`、`RowWindow`、`RawMeta`、`RawWindow`、`OutlineChild`/`OutlineReply`、`MapTrail`、`NodeHandle`、`Path`、`DocumentProfile`、`RepairProvenance` | 纯类型 |
| `versions` | `docRevision` / `rowVersion` / `seq` 的语义与校验谓词；`RAW_CP_EVERY` / `RAW_MAX_LINE_LENGTH` / `RAW_LINE_DISPLAY_MAX` / `OUTLINE_PAGE` / `OUTLINE_PAGE_MAX` | `isStaleRow(a,b): boolean` |
| `errors` | 错误码：`STALE_ROW`/`STALE_ROOT`/`STALE_DOC`/`TOO_LARGE`/`TOO_MANY_ROWS`/`PARSE`/`TIMEOUT`/`WORKER_CRASH`/`CANCELLED` | 判别联合的 error variant |
| `shared/json-lex` | 零依赖单趟 JSON lexer 原语（`lexToken`/`skipWs`/`lexLine`）；core 的 pretty 行走器与 view 的行高亮共用 | `lexLine(line): Run[]`（0.2µs/行） |

### 3.2 core（Worker 内，框架无关、纯 TS 可单测）

| module | 职责 | 接口（一句话） | 深度要点 |
|---|---|---|---|
| `DocService` | 唯一门面：持有 RootStore、路由命令、维护版本、广播事件 | `CoreApi`（见 seams S1） | 15+ 条协议、多根、LRU、编辑历史、取消语义都藏在门面后 |
| `RootStore` | 多根注册表：`doc` / `expr:N` / `repaired`，`docRevision`/`rowVersion`、表达式根 LRU 3 | 已实现 `get/require/ids/values/put/touch/delete/clear`；**`release`/`markStale` 仍是草案**（多文档需补 `close`，见 §12、ADR-0009） | 根坐标与生命周期 |
| `RowModel` | 可见行模型：per-open 容器 Fenwick、窗口下潜、toggle、replaceNode 增量更新、path↔行号 | `window/toggle/replaceNode/rowOfPath/totalRows` | 固定行高坐标、O(depth·log n) |
| `identity` | 懒 id（容器）+ `(parent, slot)` 标量句柄；路径⇄句柄；不建全局 parentMap | `idOf/handleAt/pathOf` | 双格式（路径持久化、id 运行期） |
| `ImportPipeline` | `arrayBuffer`→`TextDecoder`→`JSON.parse`；截断闭合+provenance；**源文本保留**（ADR-0003 修订） | `load(input): LoadResult { value, meta, text }` | 源文本留给原文视图/复制原文 |
| `RawText` | 原文行索引三模式（source/pretty/plain）+ 检查点 + `locate`；惰性构建、不物化全文 | `buildRawIndex(text,{damaged})` / `rawOpen` / `rawWindow` / `rawLocate` / `rawSource` | 每 2048 行一个检查点（50MB 19.5KiB）；窗口 p95 0.084ms |
| `Outline` | 大纲页枚举：按容器**分页**返回子项（键/类型/项数/路径），不建第二棵树、不缓存、不看树展开态 | `outlinePage(node, path, start, count)` / `outline` 命令 | 每页 O(子项数)；10MB 样本 200 项页 <1ms（ADR-0013） |
| `Search` | 全文档键/值扫描 → 命中集合（不建根、不扫 DOM） | `search(root, q, opts): HitSet` | 可取消、渐进返回 |
| `Expr` | acorn AST + 白名单 walker + 时间/步数/结果预算 → 新根 | `eval(expr, root): ExprResult` | 无 eval/WASM |
| `EditHistory` | `replaceNode` 的 undo/redo/reset（深度 100，old/new 快照） | `apply/undo/redo/reset` | 与行模型增量更新同事务 |
| `Trail` | 选中节点 → `MapTrail`（O(depth)，兄弟 ±2） | `trail(root, path)` | 不遍历全文档 |
| `Copy` | 子树 JSON / 路径 / 原值 / 键名 | `copy(root, handle, fmt)` | 大子树预算 |
| `Profile` | Document Profile 采样（键/路径样本、类型计数） | `profile(root)` | 异步、不阻塞首帧 |

### 3.3 viewmodel（主线程，无 DOM）

| module | 职责 | 接口（一句话） |
|---|---|---|
| `RowWindowSource` | 行窗口状态机：单飞+合并+`seq` 丢弃+`rowVersion` 校验+overscan 8+方向预取+锚点换算 | `setMetrics/scrollTo/request/snapshot/subscribe/invalidate`；快照 `WindowSnapshot { rows, totalRows, start, rowVersion, stale }` |
| `RawWindowSource` | **原文**窗口状态机（ADR-0003 修订）：单飞+合并+`seq` 丢弃+overscan；原文不需要 `rowVersion`（doc 生命周期即版本） | `open(rootId)`/`setMetrics/scrollTo/request/snapshot/subscribe`；快照 `RawSnapshot { mode, lines, start, totalLines, stale }` |
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
| `RowRenderer` | 单行渲染适配器（v1 = DOM 节点池 + textContent） | `create/update/setSelected/setHit/destroy` |
| `ActivityBar` / `Toolbar` / `StatusBar` | 外壳：模式切换、文档动作、只读信息 | 事件上抛给 app/viewmodel |
| `SearchPanel` / `OutlinePanel` / `SettingsPanel` | 左面板（C） | `setModel(model)` + 意图 |
| `SelectionPanel` / `ProfilePanel` / `EditsPanel` | 右工作区模块（C） | 同上 |
| `JsonMapView` | Canvas 层级塔（DPR/主题适配、文本兜底） | `draw(trail)` |
| `ExprDrawer` / `SubtreeEditor` | CM6 宿主（经 `CodeEditor` 适配器） | `open/close/apply` |
| `EmptyState` / `RepairBanner` | 空态、修复提示 | 静态 + 关闭意图 |

### 3.5 app（装配）

| module | 职责 |
|---|---|
| `page` | 创建 worker、实例化 `WorkerTransport`、`ChromeViewStateStore`、装配 viewmodel + view |
| `worker` | Worker 入口：实例化 `DocService` + 传输适配器（`onmessage` → `dispatch`） |
| `sw` | 最小 Service Worker：`action.onClicked → tabs.create(page.html)`，不持文档状态 |
| `import` | paste / 文件选择+拖放 / 剪贴板；`arrayBuffer` transfer，文本永不进 DOM |

## 4. 四条关键数据流

**导入**（零 long task）
```
page: file.arrayBuffer() ──transfer──▶ worker: TextDecoder → JSON.parse
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
Apply：core.replaceNode(path, jsonText) → JSON.parse（≤5MB）→ 替换值图
→ docRevision++ / rowVersion++ → RowModel 增量更新 → EditHistory.push
→ 视图重取窗口 + 选中替换节点 + 修改计数 + 搜索清空/表达式 stale
```

## 5. Seam 清单（细节见 [seams.md](seams.md)）

| # | 位置 | 接口 | v1 适配器 | 测试替身 |
|---|---|---|---|---|
| S1 | 主线程 ↔ Worker | `CoreApi` 门面 + `CoreTransport` | `WorkerTransport`（MessageChannel） | `InProcessTransport`、`FakeTransport` |
| S2 | viewmodel → view | `RowWindowSource.snapshot()` | 真实窗口状态机 | `ScriptedRowSource` |
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

- 构建：esbuild 三入口（page/worker/sw）+ code splitting，CM6 懒加载；首屏 ≤45KB gz、CM6 chunk ≤140KB gz。
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

## 11. 实现进度（2026-10-29 slice 1–4；2026-11-02 展开/收起 + 复制；2026-11-03 行尾浮条 + 截断修复 + 设置 + 导出方式 + 原始文本视图 + 大纲面板）

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
| 6 表达式 + JSON 地图 + Profile | ⏳ v1.1 | 右工作区占位已留 |

**产物体积**（`node build.mjs --analyze`，**`minify:true`**——体积预算一律按 minify 后的 gz 计）：`page.js` **28.7KB gz**（预算 45，slice 6.3 原文视图 +3.0、slice 6.4 大纲面板 +3.6）、`worker.js` **11.9KB gz**（原文索引 +2.3 / 大纲 +0.2）、`page.css` **7.2KB gz**；懒加载 chunk 合计 **132.1KB gz ≤140**（编辑器相关，仅首次打开 CM6 时加载；`page.js` 内不含 CM6）；构建 ~40ms。
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

**复跑**：`npm run build && npm run smoke && npm run smoke:ext && node scripts/smoke-search.mjs && node scripts/smoke-extension-search.mjs && node scripts/smoke-expand.mjs && node scripts/smoke-edit.mjs && node scripts/smoke-copy.mjs && node scripts/smoke-repair.mjs && node scripts/smoke-settings.mjs && node scripts/smoke-export.mjs && node scripts/smoke-raw.mjs && node scripts/smoke-outline.mjs`（样本在 `.spike/samples/`，可用 `.spike/gen-samples.js` 生成；冒烟**不能并发**，CDP 端口 9883）。

**已知差距 / code review 待收口**（2026-10-29 审查发现，均非 slice 4 回归，按优先级进 backlog）：

- ~~行高真值仍是常量 / `RowMetricsSource` 未实现~~ → **已实现**（ADR-0011 §6：`TreeView.setRowHeight` + `--row-h` + `RowWindowSource.setMetrics`，设置面板可选 20/22/24/26）。
- ~~`ThemeState` / `PanelState` / `ViewStateStore` 未接线~~ → **已接线**（ADR-0011：`SettingsState` 承担主题 + 8 项设置 + 布局态，经 `ViewStateStore` 持久化）；未单独建 `ThemeState`/`PanelState` 类。
- `RowRenderer.setHit` 与 seams §4 接口漂移（TreeView 实际走 `RowContext.hit`）；`DomRowPool` 双构造重载无第二个调用点。
- `CoreTransport` 契约测试（InProcess vs Worker 同一套用例）与 `WORKER_CRASH` 错误路径测试仍缺（`TIMEOUT`/`CLOSED` 已在 `WorkerTransport` 实现）。
- 搜索高亮 helper 在 `row-renderer` 与 `search-panel` 各一份；大小写折叠对 `İ/ẞ` 等字符会错位（罕见）；smoke 脚本的 reference walk 与 `core/search.ts` 是两份实现。
- `44px` / `SEARCH_LIMIT=50,000` 在常量、CSS、smoke 脚本多处重复；结果列表滚动直接重绘、未做 rAF 合并（实测 0 长任务）。
- 空态 dropzone 有 `role=button` 但无 click/键盘处理器；`#tree` 内外层重复 `role=tree/tabIndex`（骨架遗留）。
- 编辑：弹层未做 **focus trap**（Tab 可离开面板）；CM6 对「文档末尾」的 lint 诊断是空范围（只有 gutter marker，无行内下划线）；`getNodeJson` 先 stringify 再判 5MB（超大子树会先在 Worker 内付出 stringify 成本才拒绝，建议预计算子树大小）；50MB 文档导出（stringify + 50MB postMessage）未实测。
- 「替换文档」已有未保存确认；「关闭文档」功能本身尚未存在（随 #11 最近文档 / 多标签再做）。
- 「全部展开」在已全展开时仍可点（core `changed=false` no-op，无 UI 反馈）；~~「N=500 可关」待设置面板~~ → 已实现（设置「小文档自动全部展开」）。
- `expandAll` 不把**空容器**加入 `expanded`（`{a:{}}` 全展开返回 `changed=false`、`open=false`）；若要「空容器也显示展开态」需另定并改行模型语义。
- 复制（slice 5.5）：子树 JSON >5MB 只能走导出（`TOO_LARGE` toast 引导）；~~「缩进/压缩跟随当前设置」未做~~ → 已实现（设置「复制缩进」2/4/紧凑 + 「默认复制格式」，ADR-0011 §1）；**真实扩展页未实测剪贴板**（HTTP 模式验到 `navigator.clipboard` 逐字读回，扩展内无 `__tjv`，需真机向导补）；菜单未加复制快捷键（⌘C 保留给原生文本选择，见 ADR-0010 §8）。
- 截断修复（slice 6.0 / #8）：~~「关闭修复」开关待设置面板~~ → 已实现（设置「导入时自动修复截断 JSON」，关闭后截断直接 `PARSE`，ADR-0011 §1）；~~修复摘要 `at` 只展示偏移~~ → **已实现跳行**（slice 6.3：`@at` 可点击 → 切原文 + `rawLocate` + 高亮，ADR-0003 修订 §5）；修复耗时按「仅解析失败时才扫描」控制成本，50MB 级截断文本未实测。
- 原始文本视图（slice 6.3 / #11）：
  - **短 minified 仍是单行**：`maxLineLength ≤ 4096` 的源文本一律走 source 模式（ADR 有意如此，4096 是「有没有可用行」的判据），所以 300 字符的 minified JSON 在原文视图里就是 1 行——想要 pretty 布局得点「格式化」，v1 不做（ADR-0003 修订 §6）。
  - **>1.4M 行 spacer 封顶**：`min(totalLines×rowH, MAX_SCROLL_PX)` 与 TreeView 同源问题——50MB pretty ≈3.33M 行时滚动条封顶、底部行不可达（ADR-0001 §4 的缩放映射未实现）；本 slice 用 15k 行样本验收。
  - **解析失败的文本仍不能进原文视图**（导入层报 `PARSE`，无值图 → 无 doc 根）；「报错也可看原文」需无值图的文档会话，记 backlog（ADR-0003 修订 §6）。
  - **原文视图的产品定位与再评估时机**（用户 2026-11-03 拍板）：两个视图**维持现状**（常驻 `[树|原文]`、v1 不联动/不搜索/不编辑）；等**保真提示（失真检测）**落地后再评估其价值与形态（入口降级 / 只保留「复制原文 + at 跳行」）。注意：ADR-0003 §1–4 的保真扫描/提示**本身尚未实现**（`import.ts` 只有 parse/修复），已开票 **#23**——`#7` 已收口的是 IR/管线设计，不等于保真提示已做。
  - **>50MB 导入提示（含源文本 ≈1.9× 内存）仍未实现**：源文本现在静默常驻；该提示属 #11「导入 UX」余项，未在 slice 6.3 落地（ADR-0003 修订 §2 已注明）。
  - 原文内**查找/选中/跳转树**不做（v1 不联动）；切回树再进原文会回到顶部（`open()` 复位滚动；保留位置是小改进，未做）；行内高亮 run >512 时该行退回纯文本（保逐字，仅影响 4096 字符级超长标量行）；无方向预取，极快拖动滚动条可能 1 帧空白（overscan 8 覆盖平滑滚动）。
  - `RawWindowSource` 与 `RowWindowSource` 的窗口纪律是**两份实现**（单飞/合并/seq 丢弃/overscan 各自一份，raw 无 rowVersion/预取/锚点）；改 S2 语义要同时改两处，后续可抽公共窗口策略。
  - **50MB 原文端到端未实测**（UI 链路 smoke 用 3000 项/15k 行）；但 core 基准已跑 50MB：索引构建 **107.2ms**、窗口 p95 0.071ms（Node v24 同 V8；Chrome Worker 内会略高）。
- 导出（slice 6.2）：**复制到剪贴板 >20MB 直接拒绝**（提示用文件导出），50MB 的实际剪贴板写入耗时未实测；复制固定 2 空格（不跟随「复制缩进」设置，见 ADR-0012 偏差）。
- 大纲面板（slice 6.4 / ADR-0013）：
  - 树里选中一个「大纲中不可见」的节点（祖先未展开 / 未翻页）时，大纲不高亮、不自动展开定位（v1.1 候选）。
  - **编辑后大纲回根展开**（不保留展开现场）；大纲展开状态**不持久化**（刷新 / 重开页面回到根展开）。
  - 分页为手动「加载更多」，无预取；50MB 的 `data.items`（184,909 项）需 925 次点击才到底，50MB 大纲未端到端实测（10MB 已验）。
  - 每个容器页请求都重新枚举该容器子项（`Object.keys` / 数组切片）；单容器页 200 项 <1ms，但**不做容器级缓存**（避免大纲持有「全文档形状」，ADR-0013 背景）。
  - 虚拟窗口 `spacer` 与树同源受 `MAX_SCROLL_PX` 封顶（>1.4M 行底部不可达，与 ADR-0001 §4 缩放映射一起未实现）；`childInfo` 判定展开行是 O(已加载子项) 扫描（大数组翻页后点 caret 有毫秒级成本）。
  - 非根容器的页请求失败**无内联错误提示**（`setOpen`/`loadMore` 返回 false、折叠再展开会重试；「加载失败，重试」哨兵留 v1.1）；虚拟窗口计算与搜索共用 `shared/window.computeVirtualWindow`（code review 收口，不再各写一份）。
- **保真提示（#23）**：ADR-0003 §1–4 已定（导入后 BigInt 精确判定 >15 位整数 / 整数键混排，提示条给**精确数量**，点击跳原文对应行），但**实现从未做**——`import.ts` 只有 parse + 截断修复。它是原文视图产品复评的触发条件（#11 评论 6603943029）。候选/精确两级判定与「57 候选 → 2 失真」实测口径见 ADR-0003 §2。
- **严格 JSON only**（边界，非 bug）：完整 JSON 只是多了尾逗号（`{"a":{"b":1,}}`）或用了单引号/裸键/注释时仍报 `PARSE`——截断修复只处理 EOF 形态、不擅自删原文符号；是否支持 JSON5 子集/尾逗号容错见 **#20**（待拍板）。

## 12. 未实现设计（多文档工作区标签，#18）

> 设计已定、**尚未实现**。两项后续需求中「全部展开 / 收起 + 自适应展开」**已于 2026-11-02 实现**（见 §11 slice 4.5）；
> 本节只剩「多文档标签」。决策记录：#18；术语：`CONTEXT.md`（工作区 / 文档标签）；决策：ADR-0009。

| 层 | 计划改动 | 现状 |
|---|---|---|
| `protocol` | 新增 `closeRoot { rootId }`；`load` 回带 `doc:N`；`versions.ts` 加标签上限（8）与标签条高（32）常量 | 18 条命令（15 + `expandAll`/`collapseAll`/`copyNode`），无关闭根；`load` 写死 `DOC_ROOT_ID` |
| `core` | `RootStore` doc 根释放（`release`/`close` 收口）；`DocService.load` 不覆盖已有根 | `load` 写死 `DOC_ROOT_ID`；doc 根无释放路径 |
| `viewmodel` | 新增 `WorkspaceState` / `TabState`；`RowWindowSource` / `SearchState` 按标签实例化 | 各一份模块级实例（`main.ts`） |
| `view` | 新增 `TabStrip`（32px、≥2 文档才显示、`role=tablist`） | 无 |
| `app` | 导入层区分「替换当前标签 / 新标签」；拖放按落点分流；关闭标签 → `closeRoot` | 导入层已实现（在 `main.ts`） |

**实现期重点风险**：同一 `doc` rootId + 版本重置为 1 时，迟到回包只靠 `seq`/`loadSeq` 兜底（单文档的模块级守卫）——多标签必须改成「rootId 不复用 + 按 rootId 路由/丢弃回包」；
8 × 50MB 标签 ≈ 584MB Worker 堆（软上限 8 与内存提示的来源）；切回旧标签的窗口可能 stale → 1 帧重取。

**视觉调整待办（#21）**：用户要求「后续功能实现后再统一做视觉调整」。功能 slice 期间不掺视觉改动；
功能冻结后按 #21 的清单逐项验收（设置面板 / 导出分体按钮 / 修复条 / toast tone / 行尾浮条 / 活动栏图标 /
空态+左面板 / 两套菜单一致性 / 亮色主题走查），集中成一个视觉 slice。

**其它想法（仅记录、未拍板）**：**节点子键按规则排序**（痛点：一个节点下很多 key，想按规则排以快速定位；方向：只改「显示顺序」、不改数据顺序，见 #19）。
约束与待拍板问题已记在 #19（键序是产品承诺 → 排序只能是视图状态；`RowModel.keysOf` 需要容器级顺序覆盖 + 缓存失效；
设置入口**已就绪**（ADR-0011 的 `SettingsPanel` 可直接加排序项）。后续用 grilling 从该票的「待拍板问题」续，拍板后再落 ADR / 实现。

**其它想法（仅记录、未拍板）**：**树行右键菜单增加「展开/收起子节点」切换**（#22；现状菜单只有复制 4 项 + 编辑，展开/收起只能靠 caret/Enter/工具栏）。
核心待拍板 = 「其下子节点」语义：切**该容器本身**的展开态（复用 `toggle`，无需新协议）还是**递归展开/收起整棵子树**（需 core 新能力 + `ROW_BUDGET` 护栏）；
其余问题（菜单顺序/启用态/空容器/根/锚点/快捷键）已记在 #22。用户要求**做的时候先 grill**，未拍板前不实现；新增项归 #21 视觉走查。
