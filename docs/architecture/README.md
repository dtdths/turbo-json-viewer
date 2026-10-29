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
| `messages` | 主↔Worker 判别联合：`load/window/toggle/expandTo/replaceNode/getNodeJson/getTrail/search/cancelSearch/stats/eval/copy/undo/redo/reset/profile/cancelLoad` + 回包/事件 | `type Command` / `type Reply` / `type Event` |
| `types` | `Row`、`RowWindow`、`MapTrail`、`NodeHandle`、`Path`、`DocumentProfile`、`RepairProvenance` | 纯类型 |
| `versions` | `docRevision` / `rowVersion` / `seq` 的语义与校验谓词 | `isStaleRow(a,b): boolean` |
| `errors` | 错误码：`STALE_ROW`/`STALE_ROOT`/`STALE_DOC`/`TOO_LARGE`/`TOO_MANY_ROWS`/`PARSE`/`TIMEOUT`/`WORKER_CRASH`/`CANCELLED` | 判别联合的 error variant |

### 3.2 core（Worker 内，框架无关、纯 TS 可单测）

| module | 职责 | 接口（一句话） | 深度要点 |
|---|---|---|---|
| `DocService` | 唯一门面：持有 RootStore、路由命令、维护版本、广播事件 | `CoreApi`（见 seams S1） | 15+ 条协议、多根、LRU、编辑历史、取消语义都藏在门面后 |
| `RootStore` | 多根注册表：`doc` / `expr:N` / `repaired`，`docRevision`/`rowVersion`、表达式根 LRU 3 | `create/ get/ release/ markStale` | 根坐标与生命周期 |
| `RowModel` | 可见行模型：per-open 容器 Fenwick、窗口下潜、toggle、replaceNode 增量更新、path↔行号 | `window/toggle/replaceNode/rowOfPath/totalRows` | 固定行高坐标、O(depth·log n) |
| `identity` | 懒 id（容器）+ `(parent, slot)` 标量句柄；路径⇄句柄；不建全局 parentMap | `idOf/handleAt/pathOf` | 双格式（路径持久化、id 运行期） |
| `ImportPipeline` | `arrayBuffer`→`TextDecoder`→`JSON.parse`；截断闭合+provenance；保真扫描（BigInt 精确） | `load(input): LoadResult` | 源文本用完即释放 |
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
| `Selection` | 当前选中 `NodeHandle` + 键盘导航意图 | `select/handle/onChange` |
| `SearchState` | 命中集合（全部/过滤）、当前命中、`docRevision` 过期判定、结果列表虚拟窗口 | `begin/apply/markStale/next/prev/view/window` |
| `PanelState` | C 布局：活动栏选中项、左面板开合、右工作区开合与模块可见性 | `setPanel/toggleRail` |
| `ThemeState` | 主题 + 视图状态持久化（经 `ViewStateStore`） | `get/set/subscribe` |
| `EditState` | 修改计数、undo/redo 可用性、stale banner | `onMutation/undo/redo/reset` |

### 3.4 view（DOM）

| module | 职责 | 接口（一句话） |
|---|---|---|
| `TreeView` | 树容器：行池、滚动、选中、命中、a11y activedescendant、锚定 | `render(snapshot)` + `events(TreeIntent)` |
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

## 11. 实现进度（2026-10-29，slice 1–4）

| 步 | 状态 | 证据 / 备注 |
|---|---|---|
| 1 `protocol` + `CoreApi` + `DocService` 路由 | ✅ | `src/protocol/{types,messages,errors,versions,core-api}.ts`、`src/core/doc-service.ts`；InProcess 适配器 = `commandCore` + `DocService` |
| 2 `RowModel`(Fenwick)/identity/path | ✅ | `src/core/row-model.ts`（per-open Fenwick + lowerBound 下潜）、`src/shared/path.ts`；core 60 用例、viewmodel 15 用例全绿 |
| 3 page 外壳 + `TreeView`/`RowRenderer` + `RowWindowSource` + `WorkerTransport` | ✅ | 10MB 首帧（load→首行）**58ms**、50MB **246ms**；主线程长任务 **0**；滚动换窗 start 14,869 @ scrollTop 357k px |
| 4 搜索面板 + 命中跳转 | ✅ | `viewmodel/search-state.ts`（begin/apply + seq/docRevision 过期 + 过滤 + 虚拟窗口，36 用例）、`view/panels/search-panel.ts`（44px 两行虚拟结果列表 + C 样式）、`app/main.ts` 接线（上下条 / Enter / ⌘G / F3 / 树命中高亮 + `<mark>`）；`.mock/1.json` `hotel` 27.3ms/186 命中，10MB `hotel` 91.3ms/50,000 截断（raw 74,378），跳转 2.7ms，列表滚动渲染恒 22 行、0 长任务 |
| 5 子树编辑 + undo | ⏳ 命令已留 | `getNodeJson/replaceNode/undo/redo/reset` 在 DocService 抛 `BAD_COMMAND` |
| 6 表达式 + JSON 地图 + Profile | ⏳ v1.1 | 右工作区占位已留 |

**产物体积**（`node build.mjs --analyze`）：`page.js` **16.7KB gz**（预算 45）、`worker.js` **7.9KB gz**、`page.css` **5.0KB gz**；构建 17ms。
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

**复跑**：`npm run build && npm run smoke && npm run smoke:ext && node scripts/smoke-search.mjs && node scripts/smoke-extension-search.mjs`（样本在 `.spike/samples/`，可用 `.spike/gen-samples.js` 生成）。

**已知差距 / code review 待收口**（2026-10-29 审查发现，均非 slice 4 回归，按优先级进 backlog）：

- 行高真值仍是 `protocol/versions.ts` 的 `ROW_HEIGHT`，S4 承诺的 `RowMetricsSource`（从 CSS token 读）未实现；改 CSS 不会改行高。
- `ThemeState` / `PanelState` / `ViewStateStore`（S5）未接线：主题与面板状态直接写 DOM dataset，不持久化。
- `RowRenderer.setHit` 与 seams §4 接口漂移（TreeView 实际走 `RowContext.hit`）；`DomRowPool` 双构造重载无第二个调用点。
- `CoreTransport` 契约测试（InProcess vs Worker 同一套用例）与 `WORKER_CRASH` 错误路径测试仍缺（`TIMEOUT`/`CLOSED` 已在 `WorkerTransport` 实现）。
- 搜索高亮 helper 在 `row-renderer` 与 `search-panel` 各一份；大小写折叠对 `İ/ẞ` 等字符会错位（罕见）；smoke 脚本的 reference walk 与 `core/search.ts` 是两份实现。
- `44px` / `SEARCH_LIMIT=50,000` 在常量、CSS、smoke 脚本多处重复；结果列表滚动直接重绘、未做 rAF 合并（实测 0 长任务）。
- 空态 dropzone 有 `role=button` 但无 click/键盘处理器；`#tree` 内外层重复 `role=tree/tabIndex`（骨架遗留）。
