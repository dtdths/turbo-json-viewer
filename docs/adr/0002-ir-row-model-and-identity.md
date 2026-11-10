# ADR-0002：IR = JSON.parse 值图 + 展开集合；行模型用 per-open Fenwick；身份懒分配

- 状态：Accepted
- 日期：2026-10-27
- 依据：`docs/design/reassess-runtime.md` §3–§4；真机 CfT 156 测量。
- 相关票：#7（IR/Worker 管线）、#13（模块 seam）

## 背景

#7 已定：IR = `JSON.parse` 值图（真相源），节点身份按需分配，可见行模型由折叠集合派生，
不预建扁平节点表（避免对 2,958,550 个节点的额外遍历与内存）。但「派生」具体怎么算、
2.96M 节点下行窗口能否维持 60fps 未验证。

## 决策

1. **IR 形态**：
   - 值图 = `JSON.parse` 结果（唯一真相源）；
   - 展开集合 = `Set<容器节点>`（运行期），路径字符串用于持久化；
   - 不预建扁平行表、不预分配全量 node id、**不建全局 parentMap**。
2. **行模型**：对**每个已展开容器维护一份 Fenwick（子项前缀和）**，窗口请求按「下潜 O(depth·log n)」定位
   （depth ≤ ~5）；`totalRows` 由各 open 容器的可见子项数 O(1) 求和。collapse 时释放该容器索引。
   - 实测：展开 items（184,913 行）后窗口 p95 **0.1ms**、内存 **+0.73MB**（Fenwick Int32 736KB）、展开一次性 9.2ms；
   - 对照：全量 flatten 在 184k 行时 4.7ms/+7.2MB（可），全展开 135.6ms/+106MB（不可）；纯 skip-by-count 无索引
     在 184k 行窗口 p95 1.1ms、最坏 3.1ms，全展开最坏 **78.9ms/窗口**（不可）。
3. **节点身份**：
   - 运行期 **懒分配整数 id**：只给「被展开的容器 / 滚动锚点 / 选中 / 命中」分配（实测 2000 个节点 0.4ms、+0.06MB）；
   - 标量没有对象身份 → 用 **`(parent 容器, slot)`** 句柄（行窗口下潜时顺手带出），复制/选中/高亮按句柄定位；
   - **不建全局 parentMap**（369,821 条目 +131.6MB，等于第二棵树）；路径由下潜链在窗口内生成（~0.5µs），
     或只为已展开节点维护 `id → (parentId, slot)`。
4. **双格式**：路径字符串用于跨重解析持久化；运行期 id/句柄用于 O(1) 查找。实测 id 10ns vs 路径 ~0.5µs（50×），
   因此双格式必要，但不能把「解析期分配 id」理解为全量预分配。
5. **折叠行「共 N 项」**：取 `array.length` / `Object.keys(obj).length`（实测 0.32µs/容器，窗口内可忽略）；
   **不预计算子树总行数**（全量后序 206.4ms + 131.6MB 级 Map，不能放首帧）。
6. **多根**：IR 的根是 `{rootId, rootVersion, kind, value}`；行模型/窗口/复制/搜索都以根为坐标
   （表达式结果、修复文档、搜索子集为独立根，见 ADR-0001 §3）。

## 后果

- 首帧建模型近似 O(1)（默认折叠 3 行，0.1ms）；展开成本摊到 toggle（一次性建 Fenwick，9.2ms/184k 项，放 Worker）。
- 实现比 flatten 复杂（Fenwick/块前缀 + 按 open 容器惰性建索引），但内存与最坏窗口都受控。
- 折叠/展开、搜索跳转、复制路径共用同一套「根内行号 ↔ (parent,slot)」映射。
- 仍需在 headful 复核 toggle 的帧体验与滚动锚定；搜索/复制只做了接口级判断（见重评估 §5）。

## 被否决的替代

| 方案 | 否决理由 |
|---|---|
| 全量 flatten-on-change 行数组 | 全展开 135.6ms/+106MB，且每次 toggle 重建成 135ms 级 |
| 纯 skip-by-count（无索引） | 184k 行窗口 1.1ms（尚可）、全展开最坏 78.9ms/窗口（破坏 60fps） |
| 全量 eager `Map` / `WeakMap` 节点表 | 167.5ms/+28MB（Map）、24.2ms/+16MB（WeakMap 且不能吃标量）；只有容器能进 WeakMap |
| 全局 parentMap | 131.6MB、369,821 条目，等于第二棵树 |
| 每节点预计算子树行数 | 206.4ms + 大量 Map，不能在首帧做 |


## 修订（2026-10-27）

- 源文本在解析/保真扫描/概要采样后释放；不保留原始文本视图。
- 编辑入口 = `replaceNode(path, jsonText)`（子树 JSON 编辑）；结构变化只更新受影响容器与祖先链。
- 版本号拆分为 `docRevision` / `rowVersion`；表达式结果根 LRU 3；搜索不建 root。
- 详见 `docs/design/ir-spec.md`、ADR-0006。

## 修订（2026-10-30）：默认折叠改为「小文档自适应」；「全部展开 / 全部收起」带预算护栏

> 决策来源：`grill-with-docs` Q2 / Q3 / Q7（2026-10-30）；交互记录见 #9，多文档标签见 ADR-0009。
> 术语见 `CONTEXT.md`（默认折叠 / 自适应展开 / 可见行预算）。

1. **默认折叠修订为「小文档自适应 + 大文档默认折叠」**：打开文档时不再一律「根展开 + 顶层字段可见」。
   若「全展开后的可见行数」≤ **N = 500**（默认阈值，设置面板可关），加载即全展开——简单 JSON 一眼看完；
   否则保持原默认折叠。
   - 判定用**带限计数**：从根 DFS 数「全展开可见行数」（全展开时每个节点正好是一行，所以等价于数节点），
     **超过 N 立即早停** → 判定成本恒为 O(≤N) 节点，大文档也只需看前 ~501 个节点，可在 `load` 内同步完成，
     不需要「先折叠再展开」的闪烁，也不增加首屏开销。
2. **全部展开（expand-all）= 两阶段、原子**：
   - **dry-run 计数**：同一 DFS，**超过 `ROW_BUDGET`(1,000,000) 立即早停**并抛 `TOO_MANY_ROWS`，
     **不产生任何部分修改**（沿用 `RowModel.toggle` / `expandPath` 的原子约定：先算尺寸再改状态，失败可回滚）。
   - **一次性重建**：预算内则把所有容器置为 open 并建索引（等价于从值图重建一个全 open 行模型），`rowVersion++`。
   - 否决「逐节点 toggle 到超预算再停」：会留下「一半展开」的中间态，回滚成本高于重算，且逐次建索引更慢。
3. **全部收起（collapse-all）直接复用 `RowModel.clear()`**：释放所有展开索引、`expanded` 清空并重新 mount 根
   （`src/core/row-model.ts` 的 `clear()`），不新增核心原语；「根永远展开」的不变量不变。
4. **执行后的视图动作**：滚回顶部 + 只保留选中路径（不强行滚动到选中，选中行可能已不可见）；窗口按新
   `rowVersion` 重取。
5. **未实测**：expand-all 的 dry-run 成本（受预算封顶，最坏约遍历 `ROW_BUDGET` 个节点）未单独测过；
   实现时按 `prototype/p1` 口径补测，并把 50MB 文档的 early-stop 行为纳入验收。

## 修订（2026-11-09）：子树批量展开 / 收起（#22）

> 决策来源：`grilling` 2026-11-09（Q1–Q16，用户逐项拍板）；交互入口归 ADR-0010 修订（右键菜单 5 → 7 项）。
> 术语见 `CONTEXT.md`「子树批量展开 / 收起」。

1. **新增一条核心原语：`toggleSubtree(path, open)`**，走新协议命令 `toggleSubtree { rootId, path, open }`
   → 既有 `EditReply`（与 `toggle` 同形）。**不在 `toggle` 上加可选参数**：`toggle` 有 4 个既有调用面
   （caret / Enter / 行点击 / `expandPath` 内部路径）且契约测试逐条断言，加可选参数会把「单节点」与「子树」
   两种原子性混在一个命令里；`expandAll` 是整根语义，也不适合塞 path。
2. **展开语义（open=true）**：把该容器（若当前折叠）与子树内**所有非空容器**加入 `expanded` 并建 Fenwick；
   空容器与 `expandAll` 同口径**不参与**（`rebuildAllOpen` 规则：没有可展开内容，`open=false` 才符合语义）。
   等价于「把 `expandAll` 的规则限制在这棵子树上」，但**不重建整模型**：只重建子树内的索引，
   祖先链只做一次 delta 传播（`propagate`），子树外的展开态与索引原样保留。
3. **收起语义（open=false）= 深度复位**：把子树内所有容器从 `expanded` 移除、释放其索引，本节点折叠。
   下次展开只剩一层（不是恢复上次的展开现场）——与「展开整棵子树」互为逆操作，可预测。
   子树外的展开态不动。若本节点已经折叠，后代可能仍留有惰性展开标记（不可见）；
   此时仍执行复位（保证语义一致），但**可见结果没变 → `changed:false`、不推 `rowVersion`**。
4. **原子性 / 预算（总量口径）**：
   - dry-run：`countAllExpandedRows(子树值, limit)` 得「子树全展开后的可见行数」；`delta = 目标 - 当前`；
     `totalRows + delta > ROW_BUDGET`(1,000,000) → 抛 `TOO_MANY_ROWS`、**零部分修改**（沿用既有原子约定）。
   - 预算内才写入；写入用「重建子树索引」的单趟后序（迭代，不递归），不做逐节点 `toggle`。
   - 否决「子树增量上限」：`ROW_BUDGET` 是 `totalRows` 的护栏，再加一条子树上限会形成两套预算口径。
5. **版本与 no-op**：只有**可见结果变化**（`changed`）才 `rowVersion++`（沿用 `toggle`/`expandAll` 纪律）；
   已经全展开 / 已经全收起 → `changed:false`、不推版本，UI 给 info toast（与 #9「已经全部展开了」同款）。
6. **根 / 标量 / 空容器**：`toggleSubtree('$', …)` 与 `toggle('$')` 同样 no-op（根永远 open；子树操作会把
   整个文档当子树，与工具栏「全部展开/全部收起」完全重复）——**UI 上直接禁用根**，core 侧不设额外拒绝分支：
   `locateChain('$')` 为空链时直接返回 `{ row: 0, changed: false }`（与 `toggle('$')` 同款）。
   标量 → `BAD_COMMAND`（与 `toggle` 一致）；空容器 → `changed:false`（没有可展开内容，UI 已禁用）。
7. **性能目标（待实测）**：O(子树节点数) 的干跑 + 单趟后序建索引；子树越小越快，`ROW_BUDGET` 已封顶最坏规模。
   「10MB（595,030 行）子树全展开与 `expandAll` 同量级（68ms 级）、0 长任务」只是**目标**、尚未实测——
   根子树在 core 层是 no-op、不能代表真实成本，大子树全展开的耗时基准待补（见 README §11 已知差距）。
8. **已知边界**：空容器无法通过菜单展开（禁用，与 `expandAll` 不把空容器置 open 一致，ADR-0013 同款口径）；
   与 `expandAll`/`collapseAll` 共用同一条 `ROW_BUDGET` 护栏。

## 修订（2026-11-09）：一条根变更路径（版本规则与回包形状收口）

> 架构走查候选 1（证据见 `$TMPDIR/architecture-review-20261109-202508.html`，Strong）。术语见 `CONTEXT.md`「根变更路径」。

背景：`EditReply` 家族 8 条命令（`toggle` / `toggleSubtree` / `expandAll` / `collapseAll` /
`replaceNode` / `undo` / `redo` / `reset`）各自拼回包、各自写版本规则。前 4 条手写一套（且**不带
`history`**），后 4 条走 `editReply()`（带 `history`）——同一契约两种方言，版本与 `changed` 规则被抄 8 遍。

1. **范围 = 8 条 `EditReply` 命令**。新增 `DocService` 私有根变更路径 `mutateRoot(root, mutation)`：
   应用变更 → 按意图推版本 → 组装形状恒定的 `EditReply`；命令体只描述「改什么、意图是什么」。
   `expandTo` **不在路径内**：它是跳转查询（回包 `ExpandReply(rootId, rowVersion, row, totalRows)`），
   与编辑历史/值图语义无关；并入需加一层 `EditReply → ExpandReply` 适配，扩协议无杠杆。
2. **意图模型 `view` / `value`**：
   - `view`（展开态：`toggle` / `toggleSubtree` / `expandAll` / `collapseAll`）：可见结果真的变了
     （`changed`）才 `rowVersion++`；`docRevision` 不动（no-op 不制造 `STALE_ROOT` 抖动）。
   - `value`（值图：`replaceNode` / `undo` / `redo` / `reset`）：每一步都推 `docRevision++` + `rowVersion++`。
   - 报字段规则不变：`toggle`/`toggleSubtree` 只在 `changed && row >= 0` 给 `changedRow`、不给
     `changedPath`；`expandAll`/`collapseAll`/`reset` 不给 `changedRow`；值图变更给 `changedPath`。
3. **`reset` = `value` 的多步形态**：N 个历史条目逐个反向应用，每步推两版本（终值 = +N）。
   保留原语义：reset 期间的任何迟到行窗口回包都 stale。中间版本号对迟到回包不可观测（worker 按序
   处理命令），因此「全部替换成功后统一推版本」与逐条推进在成功路径上等价；反向序列经过的都是
   曾经被接受的合法状态，不会触发 `TOO_MANY_ROWS`。
4. **`EditReply.history` 从可选升为必填**（协议不变量）：回包形状恒定，「已修改 N 处」的消费方不再
   按命令判空。此前展开态回包缺 `history`，一旦被统一回包落地消费（架构走查候选 2）就会把徽标清零——
   这是**契约缺陷**，今天不可达（4 条展开态 handler 不走 `applyModelReply`）。
5. **测试面**：新增 `tests/unit/core/root-mutation.test.ts`（版本矩阵 12 例 + 形状契约 3 例，走
   `DocService.dispatch` 公共 seam）；逐命令行为断言仍留在 `doc-service.test.ts`（不删——矩阵验不变量，
   行为测试验语义）。
6. **否决的替代**：(a) 抽独立 `core/root-mutation.ts`——只有一个调用方，且需要 `Root` 的
   `docRevision` / `rowVersion` / `rowModel` 与 `histories`，是「一个 adapter 的假 seam」；(b) 保持
   `history` 可选、只靠运行期约定——类型系统抓不住漏填，正是本修订要消除的方言；(c) 把 `expandTo`
   并入统一路径——见 1。
7. **净行为**：用户可见行为零变化；协议上 4 条展开态回包多一个 `history` 字段（app 目前不读）。

## 修订（2026-11-09）：展开态只用 path 口径回答

> 决策来源：`improve-codebase-architecture` 走查（2026-11-09，候选 4）+ `grilling` 拍板（Q1–Q5）。
> 与既有决策的关系：**per-container identity 不变**（见本 ADR 决策 2/3）——本修订只改「怎么问」，不改节点身份。

背景：`RowModel.expanded` 是公开的 `Set<Container>`，`Root.expanded` 又 alias 同一个 Set。图外只能拿值图
节点问「开没开」，于是测试只能断言 IR 对象身份（20 处 `expanded.has(node)` / `expanded.size`），实现一
重构就红；`Root` 还暴露了可变内部状态。

1. **展开集合转私有**：`expanded` 成为 `RowModel` 的实现细节（内部使用不动）。
2. **path 口径接口**：新增 `isOpenAt(path): boolean` 与 `openPaths(): Path[]`。
   - 根 `$` 恒 open；标量 / 折叠容器 → false；非法路径 → `BAD_COMMAND`（与 `valueAt` / `rowOfPath` 同口径）。
   - `openPaths()` 返回**全部**展开容器路径（**含折叠祖先下的惰性展开标记**），确定性前序；成本
     O(值图节点数)，仅供测试 / 低频持久化，不要每帧调用。
3. **Root 去 aliasing**：删除 `Root.expanded` 字段（构造时写入、无人读），`Root` 只持 `rootId` / `rowModel` /
   版本。`DocService` 构造同步。
4. **测试迁移**：20 处对象身份断言改为 path 断言；测试内本地 `openPaths(model)` 辅助函数删除，改用
   `model.openPaths()`；新增 5 条接口测试（根恒 open / 标量根 / 非法路径 / 前序与惰性标记 / collapseAll）。
5. **本次不做**：S5 持久化接线（`openPaths()` 正是其需要的口径，但按当前范围只做接口 + 测试）。
6. **否决**：(a) 保留公开 Set、只加方法（两种问法并存，身份断言继续扩散）；(b) 返回内部 Set 的只读副本
   （仍是对象身份口径）；(c) `openPaths()` 只遍历 open 子树（会漏掉折叠祖先下的惰性标记，语义不完整）。
7. **净行为**：用户可见行为零变化；`worker.js` 15.2 → **15.3KB gz**（+0.1）。
