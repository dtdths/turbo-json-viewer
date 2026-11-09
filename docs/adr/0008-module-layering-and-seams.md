# ADR-0008：分层与 seam —— core / viewmodel / view + 行渲染适配器

- 状态：Accepted
- 日期：2026-10-28
- 依据：`docs/architecture/README.md`（蓝图）、`seams.md`（接口草案）、`build-and-test.md`（工程/测试）；ADR-0001/0002/0005
- 相关票：#13（模块架构/seam）、#7（IR/Worker 管线）、#5（P-1 渲染基线）

## 背景

#13 要求给出「渲染/逻辑分离」的模块架构：核心层（IR、解析/搜索/求值、Worker 协议）→ 视图模型（展开/过滤/选区）→ 视图（树/表达式/原始文本），并明确**渲染深度调优口**、仓库布局与测试策略。前置票 #5（渲染基线）与 #7（IR spec）已完成，技术栈在 ADR-0005 定稿（原生 TS、esbuild、CM6 仅输入框、DOM 行池 + textContent）。

剩余的设计问题不是「用什么」，而是**边界画在哪**：

1. 主线程与 Worker 之间，除了消息协议，还需不需要一层门面？
2. 行窗口状态机（单飞/合并/seq/版本/预取/锚点）放 core、viewmodel 还是 view？
3. 「换渲染器 / 调主题 / 改行高」的承诺边界到哪里为止？
4. 逻辑层如何在没有 DOM、没有 Worker 的情况下被单测？

## 决策

### 1. 四层 + 一个共享协议层，依赖单向

`app → view → viewmodel → protocol ← core`，另有零依赖的 `shared`。`view` 不 import `core`；`core` 不 import DOM/viewmodel；`protocol` 不 import 任何层；`app` 是唯一装配点。落地时用 import 边界规则（eslint `no-restricted-imports` 或 dependency-cruiser）在 CI 强制。

### 2. Worker seam = `CoreApi` 门面 + `CoreTransport`，协议是判别联合

- `CoreApi`：领域方法门面（load/window/toggle/replaceNode/getNodeJson/getTrail/search/cancelSearch/eval/copy/undo/redo/reset/profile/cancelLoad），是**调用方与测试共同面对的 interface**。
- `CoreTransport`：`request<C extends Command>(cmd): Promise<ReplyOf<C>>` + `on(event)` + `close()`，是**线上唯一的跨线程 surface**。
- 适配器：`WorkerTransport`（MessageChannel，v1）、`InProcessCore`（`src/app/transport/in-process-core.ts`，直接调 `DocService.dispatch`）、`FakeWorker`（`tests/contract/fake-worker.ts`，跑真实 `DocService` 的假 worker，可 `hold` 复现超时/崩溃/关闭）。
- 契约测试已落地（2026-11-09）：`tests/contract/core-transport.cases.ts` 是**唯一一份**共享用例，分别打在 in-process 与 `createWorkerCore(FakeWorker)` 上，保证「线上一套、测试一套」不漂移。

### 3. 行窗口状态机放 viewmodel，不放 view、不放 core

`core` 只回答「第 start 行起 count 行是什么、当前版本号多少」；单飞/合并/`seq` 丢弃/`rowVersion` 校验/overscan 8/方向预取/滚动锚点换算属于**主线程视图状态**，由 `RowWindowSource` 承担（2026-11-09 修订：该职责收口为一个 `WindowMachine` module，`RowWindowSource` / `RawWindowSource` 退化为 adapter，见文末「修订（2026-11-09）」）。视图只消费 `WindowSnapshot { rows, totalRows, start, version, stale }`，不知道请求时序的存在。这样滚动策略可以独立单测，且换渲染器时协议不变。

### 4. 行渲染 = `RowRenderer` 适配器 + 固定行高契约

- `TreeView` 管容器（行池、滚动、选中、命中、a11y、锚定）；`RowRenderer` 管单行 DOM（`create/update/setSelected/destroy`；命中态走 `RowContext.hit`，2026-11-09 删掉从未调用的 `setHit`）。v1 适配器 = DOM 行节点池 + `textContent`（ADR-0005 实测：1000 帧 31.2ms）。
- **固定行高是不可调契约**：滚动映射 `contentPx = totalRows × rowH` 与行窗口坐标都建立在它上面（ADR-0001）。可调的是行高**取值**（22–26px），不是「可变行高」。
- 主题/字体/行高/缩进/类型列/面板宽度/地图尺寸一律走 CSS 变量（`tokens.css` + `--row-h` 等）；唯一进入逻辑层的视觉参数是 `RowMetrics { rowHeight, viewportRows }`。
- 结论：**换渲染器（DOM→canvas）只写一个 `RowRenderer` 适配器；调视觉只改 CSS；两者都不动行模型、状态机与协议。** 可变行高/换行明确排除（需改 ADR-0001 的行模型与滚动映射，属架构变更）。

### 5. 持久化与编辑器各自成 seam

- `ViewStateStore`（`get/set/remove`）：chrome.storage.local 适配器 + memory fake。只存视图状态、主题、面板开合、最近文件名/大小；**文档内容永不落盘**（红线）。
- `CodeEditor`（`setValue/getValue/focus/onChange/setDiagnostics/destroy`）：CM6 适配器 + textarea 兜底。CM6 走动态 `import()` 懒加载，不进首屏预算（ADR-0005 体积：最小集 99.4KB gz）。

### 6. 工程与测试按层落地

esbuild 三入口（page/worker/sw）+ code splitting；vitest 单测覆盖 core/viewmodel/protocol/shared；`CoreTransport` 契约测试双适配器跑同一套；真机 harness（`prototype/p1`）负责 DOM/长任务/滚动/DPR 与性能基准；`prototype/visual/shots/c-*.png` 作为视觉基线。

## 后果

- **正面**：核心逻辑可脱离 DOM/Worker 单测；滚动状态机与渲染器可独立替换；「调渲染」的成本被压到 CSS 与单行渲染函数；协议集中在一处，版本语义可校验。
- **代价**：多一层 `CoreApi` 门面与传输适配器（约 200–300 行胶水）；必须用契约测试防止「InProcess 过了、Worker 挂了」；每加一条协议要同时改 `protocol`、`core`、`viewmodel` 三处（这是有意的摩擦，防止视图层绕过状态机）。
- **约束仍在**：固定行高、文档常驻 Worker、主线程零文档、源文本解析后释放（ADR-0001/0003）不因分层改变。
- **新增守则**：import 边界进 CI；`protocol` 变更需同时更新契约测试；`RowMetrics` 是唯一允许进入逻辑层的视觉参数，发现第二个就说明 seam 画错了。

## 被否决的替代

| 方案 | 否决理由 |
|---|---|
| 视图层直接 `postMessage`（无门面/无传输适配器） | 协议散落在 UI 事件里；无法单测、无法换传输；版本/取消语义会被复制到每个调用点 |
| 行窗口状态机放 `view`（跟着滚动事件走） | 无法脱离 DOM 单测；换渲染器即重写状态机 |
| 行窗口状态机放 `core`（Worker 内做单飞/预取） | 预取与锚点依赖主线程滚动意图；Worker 无法感知合成器时序 |
| 单一 monolith 包，不分层 | 依赖方向不可校验；渲染调优会牵动行模型 |
| 引入框架/虚拟滚动库替代自研行池 | ADR-0005 已否决：几十个行节点 + textContent 已 0.03–0.09ms/帧，框架 diff 无收益且增加体积 |
| 把 CM6 打进首屏 | 首屏预算从 ~45KB 涨到 ~190KB gz，与「极速首帧」定位冲突 |
| 用 Service Worker 承载文档状态 | SW 可被浏览器随时终止；文档必须在页面创建的 module worker 内（生命周期与页面一致） |
| 可变行高（用换行解决长值） | 破坏 `totalRows × rowH` 滚动映射与行窗口坐标（ADR-0001）；长值改在「选中节点」面板换行展示（C 定稿） |

## 修订（2026-11-09）：S2 收口为一台窗口状态机 + 两个 adapter

> 决策来源：`improve-codebase-architecture` 走查（2026-11-09，候选 1）+ `grilling` 拍板（Q1–Q11）。
> 术语见 `CONTEXT.md`「窗口状态机（Window Machine）」。

1. **一台深 module**：`WindowMachine<P>` 收口 S2 的窗口规则——几何（overscan、方向预取、单屏上限，per-adapter 配置）、单飞 + 合并、`epoch`、`seq` 丢弃、stale 帧、空窗口帧、滚动锚点、过期重试上限。`RowWindowSource` / `RawWindowSource` 保留现有类与 interface、内部组合它；调用方（`app` / `view`）不改。
2. **两个 adapter**：adapter 只供四个能力——`fetchWindow(target, ctx)` 发请求、`validate(reply, sent)` 判迟到/错根、`toSnapshot(reply)` 拼不可变快照、`emptySnapshot()` 给空窗口帧。差异用配置与映射表达，不是第二份状态机：row 开方向预取与 3 屏上限、有 `rowVersion` 校验与锚点；raw 全关、无 `rowVersion`，`open()` 的异步两拍 + `ready` 门与 `alignTruncated` 留在 raw adapter。
3. **统一过期策略（本修订唯一行为变更）**：`STALE_ROW` / `STALE_ROOT` / `STALE_DOC` 一律当作迟到竞争 → 自动重取，**上限 3 次**，成功后清零、换根/换 `epoch` 时重置；超限或普通错误 → 保留上一帧 + `stale: true` + `lastError`，不自动重试；`CANCELLED` / `CLOSED` 不标 stale。row 从「`STALE_DOC` 永久 stale」改为「3 次后 stale」。
4. **空窗口帧**：目标 `totalRows` / `totalLines = 0` 时统一为「当前帧是 stale 或带 payload → 发空且非 stale 的帧」，消除两处隐式差异。
5. **契约测试替两套**：一份共享用例打在 adapter interface 上、对 `RowWindowSource` / `RawWindowSource` 各跑一遍；旧的两套重复 describe（单飞 + 合并 / 过期回包 / 失败降级 / metrics）删除，adapter 专有行为（raw `open` / `ready` / `alignTruncated`；row 预取配置 / 锚点 / 闪帧回归）留在各自测试。
6. **范围**：只收 row + raw。`OutlineState`（按容器分页的缓存与单飞）与 `SearchState`（无几何 / 滚动）状态形状不同，不并入；它们与 S2 只共享词汇。
7. **被否决**：只抽共享策略函数、保留两个 class（interface 不变，重复只是搬家）；合并成一个 class + `mode` 分支（两套快照挤进一个 interface）；把 raw 也统一成 row 的几何 / 锚点（行为变化、无收益）。
