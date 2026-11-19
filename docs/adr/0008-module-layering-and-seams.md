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

## 修订（2026-11-09）：app 的回包落地收成一个文档会话 + 单一执行器

> 决策来源：`improve-codebase-architecture` 走查（2026-11-09，候选 2）+ `grilling` 拍板（Q1–Q5）。
> 术语见 `CONTEXT.md`「回包落地（Reply Landing）」。

1. **一个新 module**：`src/app/doc-session.ts`（纯 TS、零 DOM）持有四个会话字段 `rootId` / `docRevision` /
   `rowVersion` / `totalRows`（唯一真相源），`land(reply, intent, ctx)` 更新它们并返回纯数据 `LandingPlan`。
   §1「app 是唯一装配点」不变——本修订只是把 app 内 6 个浅回包站点收成一个深 module + 一个执行器。
2. **意图只有 6 种**：`document`（load）、`toggle`、`subtree`、`expandAll`、`edit`（replaceNode / undo / redo /
   reset）、`jump`（expandTo）。handler 只回答「哪种落地」；重推命中、回顶、居中、锚点换算、大纲刷新、
   搜索 stale、选中与闪改全部由意图决定（矩阵与旧实现逐条一致）。
3. **纯 plan + 单一执行器**：`land()` 不做副作用；`main.ts` 的 `applyLanding(plan)` 是唯一副作用点
   （`setRoot` / 回顶 / 居中 / `restoreAnchor` / `requestWindow` / 重推命中 / 大纲刷新 / 搜索 stale / 选中 /
   闪改 / 状态栏）。否决「注入 8 个回调端口」：接口浅、测试要 mock 一片。
4. **字段归属**：只搬四个版本 / 根字段；`meta` / 选中 / 编辑目标 / 滚动锚点留在 app——锚点作为 `ctx.anchor`
   传入，plan 回算好的目标 px（`shift-anchor`）。
5. **no-op 检测统一**：`plan.changed`（`rowVersion` 是否真的推进）取代 toggleSubtree / expandAll 两处手抄的
   `rowVersionBefore`；toast 文案不变。
6. **onLoaded 边界**：换文档只把「换版本 → `setRoot` → 回顶 → `requestWindow` → 清选中 → 状态栏」交给
   landing；文档切换专属步骤（编辑态清空 / 保真重扫 / 原文索引丢弃 / 搜索重置 / 大纲开根 / 面板与焦点 /
   恢复视图模式）留在 handler——那是导入管线，不是回包落地。
7. **测试面**：`tests/unit/app/doc-session.test.ts`（6 意图矩阵 + no-op + 锚点换算 + 居中 + snapshot 副本），
   会话可脱 DOM 测；`main.ts` 只剩一个执行器，不再是 6 份手抄仪式。
8. **被否决**：(a) 放 `viewmodel/`（它是 app 编排与装配契约，不是 core→view 的派生状态）；(b) 继续留在
   `main.ts` 私有（不可测，等于没抽）；(c) 把 `onLoaded` 整段搬进 module（导入管线是另一件事）。
9. **净行为**：用户可见行为不变；唯一内部差异是 load 的回顶改走 `setRoot({ scrollTopPx: 0 })`（与
   expandAll 同款，少一次在途请求），由 13 套冒烟验收。

## 修订（2026-11-09）：测试钩子从 main.ts 移出为 dev-hook 模块

> 决策来源：`improve-codebase-architecture` 走查（2026-11-09，候选 3）+ `grilling` 拍板（Q1–Q5）。
> §6「工程与测试按层落地」不变——DOM / 长任务 / 滚动 / 布局仍归真机冒烟；本修订只移走 main.ts 里的测试 adapter。

1. **一个新 module**：`src/app/dev-hook.ts` 导出 `createDevHook(deps): DevHook`（纯工厂，import 期零副作用）
   + `installDevHook(deps)`；`main.ts` 尾部只剩装配表 `buildDevHookDeps()` 与
   `if (!isExtension) installDevHook(...)`。`main.ts` 2321 → 1979 行，hook 从「第二套 app」变成
   「转发 + 组装快照」。
2. **依赖形态**：结构化句柄分组（`session` / `core` / `tree` / `search` / `outline` / `edit` / `raw` /
   `settings` / `ui` + `entries` 真实入口）；`meta` / `editingPath` / `selected` / `exportLastAction` 这类
   app 可变状态用 getter/setter 暴露，避免第二真相源。否决「逐个注入 ~58 个散回调」：接口更浅、
   测试要 mock 一片。
3. **状态归属**：hook 不再从**全局 DOM 反推模块真值**——`TreeView` 自报 `currentRowRendered()` /
   `typeColumnVisible()` / `spacerHeight()`；`SearchPanel.state()` 报渲染数 / 滚动几何 / 计数与页脚文本；
   `RawView` 报 `renderedLines()` / `flashedLine()`；大纲面板开合问 `settings.uiState().panel`。
   保留真正的视觉/布局探针（`getComputedStyle` 的 `--row-h` / 行高 / `--row-indent`）在装配表里——
   那是浏览器 harness 的分工。
4. **API 兼容（硬约束）**：58 个成员名 / 参数 / 返回形状逐字保持；`DevHook` interface 把成员表钉进类型；
   13 套冒烟脚本零改动；安装条件仍 `!isExtension`（`smoke-extension` 断言 `window.__tjv` 不存在）。
   动态探测点已核对：`smoke-search` 的 required 函数清单、`smoke-fidelity` 的 hooks/missingHooks、
   `smoke-copy` 的 `ctxOpen` typeof 检查。
5. **测试面**：`tests/unit/app/dev-hook.test.ts`（node env、fake deps）：成员表逐字（`Object.keys`）、
   `state()` / `searchPanel()` / `repairState()` / `fidelityState()` / `settingsState()` 快照、
   `copyResolve` / `exportDocText` 错误路径、纯转发；不引入 jsdom（DOM/布局仍由冒烟兜底）。
   钩子从「不可测」变成「构造时注入依赖即可在 node 里测」。
6. **被否决**：(a) 按功能拆 5 个文件（过度，成员之间共享快照语境）；(b) 继续留在 `main.ts`（现状 =
   第二套 app）；(c) 给 hook 注入 58 个散回调（见 2）。
7. **净行为**：用户可见行为不变；唯一内部变化是 3 处「纯 DOM 反推」改为模块自报（值逐字一致，由 13 套
   冒烟验收）。体积：`page.js` 31.9 → **33.0KB gz**（+1.1：hook 工厂与依赖表；预算 45 未动）。
   **已知可优化**：hook 仍静态打进生产 `page.js`（运行时 `isExtension` 守卫），后续可用动态 import
   拆成仅 HTTP harness 加载的 chunk。

## 修订（2026-11-19）：导入入口层收成一个状态机 + 一个 adapter

> 决策来源：`improve-codebase-architecture` 走查（2026-11-19，候选 1）+ `grilling` 拍板（Q1–Q12）。
> §1「app 是唯一装配点」不变——本修订把 app 内的入口层从「16 个共享 DOM 常量的函数」收成一个
> 纯状态机 + 一个 adapter，外部输入路由（paste / 拖放 / 文件选择 / 快捷键）仍留在 app。

1. **一个纯状态机**：`src/app/import/layer-state.ts`——四形态（initial / replace / new-tab / pending）、
   落点解析（设置默认 / 显式覆盖 / 默认新标签满 8 自动降为替换 / 显式新标签满 8 拒绝）、替换前的
   「丢弃临时修改」确认、pending 两个落点、busy / error 生命周期、`close()` → `settle()` 两个时点。
   零 DOM、零 i18n：输出 `LayerView`（文案是 key）+ `OpenResult` / `ChooseResult`。
2. **副作用出栈为意图**：满 8 的显式拒绝、替换前的确认都作为结果返回，由 app 执行
   （`showToast` / `window.confirm`）；状态机自己不调外部动作——这是它能被 node 单测的前提。
3. **一个 DOM adapter**：`src/app/import/layer.ts`——把 `LayerView` 写成 DOM（文案 key → 当前语言、
   可见性、禁用态、aria、待确认条目）、管 110ms 出场（`.is-leaving` + `inert` + 计时器 /
   `animationend` 兜底）与焦点（打开进卡片 / pending 进非破坏性按钮 / 关闭归还工具栏），
   并接线层内交互（关闭 / 遮罩点击 / 落点 radio / pending 两按钮）。外部输入路由不搬：它们还要管
   「初始空态直接导入」「标签条空白 = 新标签」这些不属于层的事。
4. **待确认载荷归状态机**：`File` / 粘贴文本是「待确认的导入」这个概念的一部分；留在 app 的会话态里
   会造出第二个「哪份 pending」真相源（与 §3「一个概念一个 module」冲突）。
5. **依赖形态**：adapter 的 deps 分三组——`dom`（元素引用）/ `env`（`t` / `formatBytes` /
   `formatError` / 打开时的环境快照 `context()`）/ `actions`（`onImport` / `confirmDiscard` /
   `onLimitDenied` / `onBeforeClose`）。否决「adapter 自己 `document.getElementById`」：
   违背 §2「accept dependencies, don't create them」，也让 iframe / 测试复用变脆。
6. **兼容（硬约束）**：`#empty` 的 id / class / `data-mode` / `aria-*` 一个不改；17 套冒烟断言零改动；
   `dev-hook` 的 `layer` 快照 5 个字段名与取值逐字不变（改读 `hookState()`）；出场 110ms 时序不变。
7. **测试面**：`tests/unit/app/import-layer-state.test.ts` 29 例（node env）——落点矩阵、满 8 降级与拒绝、
   丢弃确认、pending 两落点、busy 清载荷、关闭与收尾时点。DOM 形状 / 动效 / 焦点仍归真机冒烟。
   入口层的策略改动第一次不再只靠 17 套 HTTP 冒烟兜底。
8. **代价与预算**：`main.ts` 4197 → 3914 行；单测 1385 → 1414。**`page.js` 53.8 → 55.0KB gz（+1.2：
   状态机 seam +0.8、adapter 拆分 +0.4），预算 54 → 56，经用户 2026-11-19 拍板。**
   被否决的更便宜方案：只抽纯策略（`resolveTarget`）——60 行、省 1KB，但 7 个入口的规则仍散在 main.ts，
   且 DOM 与策略继续同函数（深度是假的）。
9. **已知可优化（未做）**：`app/dev-hook.ts` 仍静态打进生产 `page.js`（12.5KB raw，运行时
   `isExtension` 守卫）。改成动态 import 可回收数 KB，但它会落进**懒加载**预算（145.9 / 146，余 0.1），
   需要同时处理两个预算口径；本修订只记录，不并入。

## 修订（2026-11-19）：根级派生状态收成一个 module + 根死亡统一释放

> 决策来源：`improve-codebase-architecture` 走查（2026-11-19，候选 3）+ `grilling` 拍板（Q1–Q9）。
> §3「一个概念一个 module」与 §1 的分层不变——本修订把 core 内五种「由根派生」的数据收进一个
> module，并把「根死亡要清什么」从两处手工清单收成一条回调链。

1. **一个 module**：`src/core/root-derived.ts` 的 `RootDerived`。五种数据——保真报告、path↔offset
   索引、单路径偏移、节点数、文档概要——原来各写一套「查 → 校验 → 算 → 存」，并存三种失效方言。
   现在失效键由 `DERIVED_SLOTS` 一张表声明：`identity`（WeakMap 跟随根对象，文档替换 / 根被淘汰
   自动回收：源文本类）与 `docRevision`（版本推进即失效、必须显式释放：值图类）。
2. **接口 6 个方法**：`get`（miss 算一次）/ `peek`（异步派生先查、`await` 后 `set`；对 docRevision
   槽同时做版本判定）/ `set`（一次采样喂两个槽——`profile` 回填 `nodeCount`）/ `getAt`（子键槽 +
   per-root LRU：命中挪队尾、超容量淘汰、`null` 也算命中）/ `release(rootId)` / `clear()`。
   新增一种派生数据 = `DERIVED_SLOTS` 加一行 + 调用点用槽名，接口不动。
3. **根死亡只有一个 owner**：`RootStore` 增 `onRelease(rootId)` 选项，`close` / LRU 淘汰 / `clear`
   三处根死亡都回调，同一根只触发一次；`DocService.releaseRootState`（派生缓存 / 编辑历史 /
   搜索抢占 seq）成为唯一调用方。`closeRoot` 不再显式释放。
4. **顺带修一个真漏洞**：表达式根被 LRU 淘汰时原来只 `emit(stale)`，不释放旁路状态——被淘汰的
   表达式根若曾跑过搜索，`latestSearchSeq` 条目会残留到服务关闭。现在淘汰也走 `onRelease`。
5. **不搬的东西**：`histories`（可变 undo 栈）与 `latestSearchSeq`（单调 seq）不是派生数据，
   留在 `DocService`，但和 `RootDerived` 一起由 `releaseRootState` 这一处释放——模块名因此不必
   扩张成「什么都装的根附属状态」。
6. **被否决**：(a) 每槽一个方法（`fidelityOf` / `nodeCountOf` …）——接口从 6 涨到 10，新增缓存
   要改接口；(b) `map(root, slot)` 返回受容量约束的 Map——把 LRU 纪律又交回调用点；
   (c) 只抽失效纪律、缓存本体留在 DocService——「查→算→存」的 5 份样板正是重复来源；
   (d) 让 `RootStore` 直接持有 `RootDerived`——容器只该认 `Root`，用回调保持解耦。
7. **测试面**：`tests/unit/core/root-derived.test.ts` 13 例（identity / docRevision 失效矩阵、
   `peek` 版本判定、`set` 落值、子键 LRU 与 `null` 命中、换根对象重算、纪律表）；
   `root-store` +4（`onRelease`：close 幂等 / LRU 淘汰 / clear 逐个 / 未注册时不变）；
   `doc-service` +1（表达式根被 LRU 淘汰后 `latestSearchSeq` 不残留）。旧的白盒用例
   （直读 `profileCache`）改为断言 `release` 被触发。单测 1414 → 1432。
8. **代价**：`worker.js` 65.9 → **66.2KB gz**（+0.3；worker 自 ADR-0020 起无硬预算、只记录）；
   `page.js` / 懒加载 / 语言包不受影响（core 只进 worker）。

## 修订（2026-11-19）：每标签视图态收成 `TabViewData` + 一个搬运模块

> 决策来源：`improve-codebase-architecture` 走查（2026-11-19，候选 2）+ `grilling` 两轮拍板（Q1–Q10），
> 实现票 **#58**。§1「app 是唯一装配点」、§2「accept dependencies, don't create them」、
> §3「一个概念一个 module」不变——本修订把「每标签视图态」从**四份表示**收成「一份存档 + 一份活动镜像」，
> 并把两者之间的搬运收成**一张表**。

1. **问题**：同一份 per-tab 状态有四种表示——`TabExtras`（7 字段，`main.ts` 里的第二张 `Map`）、
   模块级镜像 `let`（51 个）、`WorkspaceState.TabState`（10 字段）、`DocSession.SessionState`（活动会话
   镜像）。三张手写清单（`saveActiveSession` / `bindTab` / `restoreActiveTabView`）各抄一遍字段名，
   `resetTabStateForNewDoc` 再清一遍，`applyRootVersions` 把同一版本扇给 5 类持有者。**加一个 per-tab
   字段最少要改 6 处**（类型 / 默认值 / let / save / bind / reset），渲染型 7 处，版本型或 hook 暴露型 8–10 处。
2. **存档只留一份**：`TabViewData`（`src/viewmodel/tab-view-data.ts`，**新建**）装 12 个字段（原 7 个
   extras + 本轮补的 5 个串味字段），住在 `WorkspaceState.TabState.view`——它**随标签一起生灭**：
   `add` 建默认、`replace` 换文档就地复位、`remove` 随标签丢弃。`tabExtras` 这张以 tabId 为键的
   第二张 `Map` 被删除。版本字段 / `selected` / `meta` **不进** `view`：它们本来就住在 `TabState` 顶层，
   存一份就够，`capture` 走 `workspace.update` 写。
3. **镜像留在 app**：51 个模块级 `let` 继续当活动标签的实时镜像，**读点零改动**（这是与「句柄式全量迁移」
   的关键取舍，见第 9 条）。镜像由 `app/tab-view-state.ts` 的 `TabViewState` 管理，**四个方法**：
   `capture()`（切走：镜像→存档）/ `restore(tab)`（切回：存档→镜像，顺带表达式视图瞬时复位）/
   `clear()`（回空态：没有标签可存档，但镜像必须复位）+ `syncVersions(roots)`。
   **换文档的存档复位不归它**：`WorkspaceState.replace` 就地写默认值，单一 owner（曾写过一个
   `reset(tab)` 薄包装，与 `replace` 重复，双轴审查时删掉）。
4. **一张 accessor 表**：`VIEW_FIELD_KEYS` + `TabViewAccessors`（`get`/`set` 闭包由 `main.ts` 注入，
   因为 `scrollTopPx` 要读 DOM）。`capture`/`restore`/`clear` 全循环这张表。加一个 per-tab 字段 =
   `TabViewData` 1 行 + `defaultTabViewData()` 1 行 + `VIEW_FIELD_KEYS` 1 行 + 表 1 行 + 镜像 `let` 1 行
   ——**4–5 处，但都在两个文件的相邻块里**（对照：改前是 6–7 处、散在 4 个函数 + 类型 + 默认值）。
   编译期守卫 `VIEW_FIELDS_ALL_CLASSIFIED: UnclassifiedViewField extends never ? true : false = true`：
   新增字段忘了归类时该类型不再是 `never`，这行就赋不过去 → **构建直接红**（实测：加一个探针字段，
   `tsc` 报 `Type 'true' is not assignable to type 'false'`）。这是本轮唯一「类型能替人守纪律」的地方。
5. **两个滚动位置没有镜像**：`scrollTopPx` / `rawScrollTopPx` 只存在于存档里，`restoreActiveTabView`
   从 `tab.view` 直读。给它们造镜像会多两个 `let` 且没有第二个读者；accessor 表里把它们归为
   `DirectReadViewField`，并由同一个守卫检查。
6. **版本扇出的归属**：活状态问 `DocSession`（`syncRootVersion`），存档问 `TabViewState.syncVersions`。
   `applyRootVersions` 从「一个循环喂 5 类持有者」缩成两处调用，与 §7 的「根死亡只有一个 owner」同构。
7. **顺带修 5 个串味**（行为变化，独立成一提交，可单独回滚）：`exprErrorState` / `exprStatusState`
   （切换后行内错误与状态行残留）、`searchPatternCore`（正则解析错误贴到新标签的 `SearchState`）、
   `fidelityIndex`（两标签都 ≥2 命中时 `1/N` 下标串）、`rawTreeAnchor`（关掉最后一个标签后空态仍能读到
   旧锚点——由 `clear()` 收口）、`exprLastText`（「重新执行」的回退文本）。前两者在
   `restoreActiveTabView` 里追加一次「先清后填」（面板是单实例，光恢复镜像不会重画那一行）。
   **`exprLastText` 只是部分修复**：文本本身按标签存档了，但表达式面板的**草稿文本**仍是单实例、
   切标签不清空，而 `rerun` 用的是 `panelText || exprLastText`——草稿非空时仍会跑上一个标签留在框里的
   文本。草稿文本归 `ExpressionPanel`（见「未做」），不在本修订范围，别把这条读成「rerun 已完全隔离」。
8. **被否决**：(a) **把 `let` 全删、读点改 `view.xxx`**（真·单份表示）——`session.` 104 处 + 读点数百处
   全要动，等于把一次可回滚的重构变成全文件迁移，「冒烟断言零改动」几乎不可能同时成立；
   (b) **新建第二张以 tabId 为键的 map**（`app/tab-view-state.ts` 自己存）——`TabState.docRevision` 与
   新 map 的存档值仍会分叉，等于把要消灭的第二份表示换个位置；(c) **双写过渡**（`view` 与 `tabExtras`
   同时维护再删旧）——双写期本身就是新的两份表示；(d) **只用一次性 plan（仿 `DocSession.land()`）**——
   不持有存档，解决不了四份表示；(e) **`let` 数强压到 ≤30**——与 (a) 同义，读点迁移换来的只是数字好看。
9. **兼容（硬约束）**：`h.state()` 仍取活动实时会话（`bindTab` 后更新）；`workspaceHookState()` 的
   `live ? session.docRevision : tab.docRevision` / `totalRows` 口径与 `TabHookState` 8 个字段名**逐字不变**；
   `exprViewActive` 仍让 `live=false`；**`smoke-workspace` 62/62 断言零改动**，17 套冒烟全绿。
   **本轮没有新增冒烟断言**：5 个修复的「存档语义」由 binder 单测覆盖（每类一条「A 有 / B 没有」矩阵），
   但 `restoreActiveTabView` 的面板重画与 `enterEmptyState` 的 `clear()` 调用属于 DOM 路径，
   要断言就得改 `smoke-workspace` 的阶段驱动（加一个锚点/错误状态的前置动作）；先记为测试缺口。
10. **测试面**：`tests/unit/app/tab-view-state.test.ts` **21 例**（node env，假 workspace + 假 accessor）：
    字段归类守卫、capture/restore 往返、滚动位置由注入读法决定、版本扇出、换文档复位、回空态全复位、
    以及 5 个串味字段各自「A 有 / B 没有」的矩阵。DOM 形状 / 焦点 / 动效仍归真机冒烟。
11. **代价**：单测 1432 → **1453**（+21）；`page.js` 54.9 → **55.3KB gz**（+0.5：存档类型与默认值 +0.1、
    访问器表与绑定器 +0.4；预算仍 56 未动）；懒加载 145.9 / 语言包 / `worker.js` 不变；`main.ts`
    3914 → **3850 行**（管道区净减，但 accessor 表 + ③ 的行内反馈重画又把数字抬回去——
   **比 Q9 定的 ≤3830 多 20 行**；验收口径以「加字段 4–5 处且相邻、漏了编译不过」为主，行数只是旁证）；
   `^let ` 仍 **51**。

## 修订（2026-11-19）：搜索结果与大纲共用 `view/virtual-list`；树与原文判定不值得合

> 决策来源：`improve-codebase-architecture` 走查（2026-11-19，候选 5）+ `grilling` 两轮（Q1–Q10），
> 实现票 **#61**。§3「一个概念一个 module」不变；本修订把**两份几乎逐行相同**的虚拟列表收成一份，
> 并**否决**了「四份都合」的原始设想——理由在下面第 5、6 条，都是逐行拆开后才看见的。

1. **问题**：`search-panel.ts`（915 行）与 `outline-panel.ts`（626 行）各自手写 scroller + spacer、
   槽位池的增删、越界槽位隐藏、复用时的清理纪律、ResizeObserver、`rendered` 计数；`ensurePool` /
   `hideSlotsFrom` / `drawWindow` 三对函数几乎逐行同构。唯一共用的只有 `shared/window.ts` 的 33 行窗口数学。
2. **一个模块**：`src/view/virtual-list.ts` 的 `VirtualList`——只收**纯几何 + 池化**（滚动容器、spacer、
   槽位池、隐藏、复用清理、RO、计数）。行内容、锚点、gutter、隐藏过滤、load more 一概不进。
3. **接口窄、DOM 归属清**：模块**只碰槽位的 `style.top` 与 `hidden`**；槽位元素由面板 `createSlot()`
   造，内容由 `paint(ctx)` 填，被淘汰时模块调 `clearSlot(el)`——**清理的时机**归模块、**清什么**归面板。
   冒烟读的是 class / 子节点 / `top` / `hidden` 这些形状，模块不该有意见。
4. **模块只认 `size`（个数）与 `paint(index)`**，`index → 数据` 的映射归面板，模块永不读数据数组。
   注：今天 `search-state` 的 `size` 恒等于 `hits.length`（过滤与隐藏已经体现在数组里），
   这条边界是为「显示条数 ≠ 数组长度」的将来留的，不是现状——初稿把它当成现状写过，已更正。
5. **树不接（否决）**：拆开后才看清——树**不在 view 里算窗口**，窗口来自 `WindowMachine`
   （`viewportRows + 1 + 2×overscan` + 预取 + 3 屏上限），与 `computeVirtualWindow` 不是同一个公式；
   树的槽位是 `RowRenderer`/`DomRowPool` 的句柄（`setTop`/`setVisible`），**已经有自己的 seam**（S3）。
   硬合要给模块加一层槽位适配器，而树恰恰是几何断言最密的地方（`smoke-settings` 的 `spacerHeight`、
   `smoke-expand` 的 `scrollHeight`、`smoke-order` 的内联 `top`）。
6. **原文接了一次又回退（实测负收益）**：原文的窗口同样由 viewmodel 给（`smoke-raw` 断言了那个 `+1`），
   池化只有约 90 行且形状不同（gutter / 行号 / locate chip / flash）。为它给模块加
   `windowMode: 'external'` + `renderWindow` 后：`raw-view.ts` 461 → **477 行**、`page.js` 55.8 → **56.0**
   （顶到预算）。已回退，模块回到只服务自算窗口的两个面板。
7. **被否决**：(a) 四份全合（第 5、6 条的实测）；(b) 让模块持 `items` 数组、`size` 从长度来
   （搜索的隐藏过滤要造平行数组，等于把视图语义搬进模块）；(c) 把 `reveal()` 这类「定位到第 N 条」收进模块
   （四者定位后的选中 / 展开 / 高亮语义各不相同）；(d) 把 dev hook 探针改成读模块实例
   （探针继续读 DOM，是「冒烟验真 DOM」的前提）。
8. **代价**：单测 1515 → **1532**（+17，`tests/unit/view/virtual-list.test.ts`，仓库自带的 fake-dom，
   **没有引 jsdom**——Q6 的「jsdom 单测」前提不成立）；`search-panel.ts` 915 → 893、`outline-panel.ts`
   626 → 607；**`page.js` 55.3 → 55.8KB gz（+0.5，余 0.2）**——这次重构**没有**省字节：
   ~150 行同构骨架被删掉，但 options / 回调分发 / 池管理搬进模块后净增；懒加载 145.9 / css 9.2 / 语言包不变。
   17 套冒烟断言零改动。
9. **口径修正**：走查报告说「四份 ensurePool/hideSlotsFrom 同构」只对 search + outline 成立；
   树与原文的「虚拟列表」其实早已分家（几何在 viewmodel、渲染在 `RowRenderer` / 自己的槽位形状）。
