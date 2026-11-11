# ADR-0009：多文档标签 —— 一个 Worker、每标签一个 doc 根、`closeRoot` 显式释放

- 状态：**Implemented**（设计定稿 2026-10-30；实现 2026-11-11，见文末「实现结果」；同日按用户反馈修订：标签拖拽排序 / 模态层遮罩 / 拖放落点直达，见「修订（2026-11-11 下午）」）
- 日期：2026-10-30
- 依据：`docs/design/direction.md`（C 工作台；§11 标签条例外修订）、ADR-0001（Worker 常驻 / 行窗口 / 多视图根）、ADR-0002（行模型 / 身份）、`CONTEXT.md`（工作区 / 文档标签）
- 相关票：#18（多文档工作区与标签页，本 ADR 的票）、#11（导入层 / 最近文档）、#1（架构地图）、#9（查看器操作语义）
- 决策来源：`grill-with-docs` 逐轮拍板（Q4 / Q8–Q12，2026-10-30）

## 背景

需求 2：**像 VSCode 一样在一个页面里同时查看多份 JSON**。

当前是单文档实现，且「单文档」不是配置项而是写在结构里的：

- `DocService.load` 每回都用写死的 `DOC_ROOT_ID = 'doc'` 建根（`src/core/root-store.ts`、`src/core/doc-service.ts` 的 `load`），`RootStore.put` 在 `kind === 'doc'` 时直接 `roots.set(rootId, root)` 覆盖——第二次 `load` 是**原地替换**同一个 rootId，且 `docRevision`/`rowVersion` 从 1 重新起算；
- `RootStore` 只为表达式根维护 LRU(3)，doc 根不参与淘汰、也没有释放路径（`delete`/`clear` 存在但没有任何 doc 根会走到）；
- 主线程只有一份 `RowWindowSource`、一份 `SearchState`，以及一组模块级 `rootId/docRevision/rowVersion/selected/meta` 变量（`src/app/main.ts`）；导入成功即整体覆盖。
- 协议 15 条命令里没有任何「关闭根」命令（`src/protocol/messages.ts`）；`RootStore` 也没有 `release`/`close`（架构 README §3.2 写的 `create/get/release/markStale` 是接口草案，未实现）。

`RootStore` 的多根结构（`rootId` 坐标、每根独立 `docRevision/rowVersion/RowModel`）其实已经按多根写好，**doc 根是唯一没按多根走的部分**。

## 决策

### 1. 承载形态：一个 Worker + 每标签一个 doc 根 + 页内最简标签条

- **不为每个标签开独立 Worker**：多 Worker 会复制 worker 入口、传输 seam（MessageChannel ×2）与装配逻辑，且 50MB 文档每根 Worker 堆 ≈73MB（ADR-0001），而收益只有故障隔离——对一个纯本地只读查看器不成比例。
- **doc 根的 `rootId` 由 Worker 分配、单调不复用**：`doc:1`、`doc:2`……；`DOC_ROOT_ID = 'doc'` 降级为兼容别名（或直接废弃，实现时二选一）。
- **标签条 = 顶部工具栏下方 32px 最简条**（文件名 + ×），**仅 ≥2 个文档时显示**；单文档完全保持 C 形态。视觉依据与「direction 曾否决标签条」的解释见 `docs/design/direction.md` §11。

### 2. 协议：多根 `load` + 新增 `closeRoot`

- `load` 保持「解析并建根」语义，回包 `LoadReply.rootId` 回带 Worker 分配的 `doc:N`；页面把「标签 → rootId」绑定，不再依赖全局唯一的 `doc`。
- **新增 `closeRoot { rootId }`**：释放该根的行模型索引与展开集合、删除根、丢弃其 `value` 引用（让 GC 回收 73MB 级堆）；对未知根幂等返回；在途窗口/搜索回包由页面按 `rootId` 丢弃（不需要新错误码）。
- **不新增 `closeTab`/`switchTab` 这类 UI 语义命令**：Worker 只认根，标签是页面概念；`RootStore`/`DocService` 不感知「标签」「活动标签」。

### 3. 每标签独立视图状态，全局状态共享

- **每标签（`TabState`）**：`rootId`、`RowWindowSource`（滚动 / 窗口 / `seq`）、`SearchState`（命中 / 当前 / `docRevision` 过期）、选中句柄、当次加载的 `meta`。
- **全局（工作区级）**：主题、侧栏 / 面板开合、面板模式、行高 / 缩进等设置。
- **切标签 = 改视图订阅目标**：把 `rowSource`/`searchState` 换成目标标签的实例，`rootId/rowVersion/totalRows` 换掉并重取窗口；**不重建 Worker 根、不重新解析**。

### 4. 生命周期

| 动作 | 行为 |
|---|---|
| `×` 关闭标签 | 先 `closeRoot` 释放根，再从工作区移除；若关的是活动标签，激活相邻标签 |
| 关掉最后一个标签 | 回**空态**（导入层初始形态），文件 chip / 导出 / 展开按钮禁用 |
| 新增标签 | 标签条 `＋`、`⌘O`（新标签模式）、拖到标签条空白、或空态导入 |
| 上限 | **软上限 8**：满 8 个后 `＋` 禁用并提示；**不自动淘汰**（静默关闭用户正开着的文档不可接受，且无会话恢复兜底） |
| 内存提示 | 打开第 2+ 份大文档时提示（50MB ≈ 73MB Worker 堆/根；8 × 50MB ≈ 584MB 上界） |
| 会话恢复 | **v1 不做**：文档内容不落盘（红线）；「恢复空标签」没有意义；最近文档另见 #11 |

### 5. 导入路由与标签的关系（ADR-0004 的导入层语义不变）

- 现有「导入 / 文件 chip / `⌘O`」仍**替换当前活动标签**（导入层 + 覆盖警示照旧）。
- 标签条 `＋` 打开**新标签导入层**：复用空态卡、**无覆盖警示**；解析成功即新增标签并激活；失败留在层内 `PARSE`、不产生空标签。
- **拖放按落点**：拖到标签条空白 → 新标签；拖到文档视图 → 替换当前标签（沿用现有「已拖入 xxx，确认替换？」暂存确认）。
- 「文档已打开且导入层关闭时页面级 `⌘V` 不导入」的契约不变（它属于导入层，不属于标签）。

### 6. 根不变量不变

行号仍是根内坐标；行窗口仍按 `{rootId, rowVersion}` 校验；根永远展开；折叠 / 展开 / 搜索 / 编辑都只作用在**活动标签的根**上。`ROW_BUDGET` 是**每根**预算，不是全局预算。

## 后果

- `DocService`/`RootStore` 需支持多 doc 根：`put` 按 rootId 写、`close` 释放；doc 根仍不参与 LRU（数量上限由页面软约束）。架构 README §3.2 的 `RootStore` 接口（`create/get/release/markStale`）与实现（`get/require/ids/values/put/touch/delete/clear`）在实现时一并收口。
- 主线程新增 `WorkspaceState`（标签列表 + 活动标签）与 `TabState`；`RowWindowSource`/`SearchState` 按标签实例化；`TreeView`/面板只订阅「活动标签」。
- **stale 判定从「单文档假设」里解放出来**：现状同一 `doc` rootId + `docRevision/rowVersion` 重置为 1，迟到回包只能靠 `seq`（`RowWindowSource`）与 `loadSeq`（`main.ts` 捕获）兜底——这些都是**单文档**的模块级守卫。多标签后必须由「rootId 不复用 + 每标签独立 seq + 回包按 rootId 路由/丢弃」承担，不能依赖版本号巧合。
- 内存按标签线性增长：这是软上限 8 与「大文档给提示」的直接原因；`closeRoot` 必须真丢引用，否则关闭标签不还内存。
- 32px 标签条只在 ≥2 文档时占位，单文档的树视口高度不变。

## 被否决的替代

| 方案 | 否决理由 |
|---|---|
| 每标签一个 Worker | 复制 worker 入口、传输 seam 与装配；50MB/根 ≈73MB 堆；故障隔离收益不成比例 |
| 主线程持有多个文档值图 | 直接违反 ADR-0001「主线程零文档」；50MB 首帧回到 321ms / 132ms 长任务 |
| 单根 + 切标签时重新 `load` | 每次切换重解析（50MB ≈150–250ms）且丢全部展开/选中态，等于没有多文档 |
| 标签持久化到 `chrome.storage`（会话恢复） | 文档内容不落盘是红线；`storage.local` 仅 10MB，装不下大文档 |
| 自动淘汰最久未用标签 | 静默关闭用户正开着的文档且不可恢复（无会话恢复）——风险不可接受 |
| 标签条常驻（含单文档） | 单文档是主场景，常驻条违反 `direction.md`「数据为主角、界面后退」 |
| 标签条放左侧活动栏 | 与「活动栏 = 模式切换、工具栏 = 文档动作」的归属规则冲突（`direction.md` §2） |

## 实现结果（2026-11-11）

原「待办」全部落地：协议 `closeRoot` + `load` 回带 `doc:N` + `MAX_DOC_TABS=8`/`TAB_STRIP_HEIGHT=32`；
core `RootStore.close` + `DocService.load` 不覆盖 + `closeRoot` 释放旁路状态；viewmodel `WorkspaceState`/`TabState`
（runtime 工厂注入）；view `TabStrip`（32px、≥2 显示、`role=tablist` + roving tabindex）；app 工作区接线与 `smoke-workspace`。

### 实现期拍板（设计没写死、由实现决定的部分）

1. **doc 根 id** = `doc:${++nextDocId}`（单调不复用）；`DOC_ROOT_ID` **直接删除**（不做兼容别名——全仓只有 core 与一处测试引用）。
2. **`closeRoot` 语义收口**：未知根回 `{closed:false}` 不抛；已知根先删 `parentRootId === 它` 的 expression 子根，
   再释放编辑历史 / 节点数缓存 / 搜索抢占 seq，最后 `RootStore.close`。在途窗口/搜索**不主动取消**，由页面按 rootId 丢弃。
3. **搜索抢占 seq 改成按根**（`Map<RootId, number>`）：每个标签的 `SearchState.seq` 都从 1 起，共用全局 number 会让
   B 标签的 seq=1 被 A 标签的 seq=5 当成过期（多标签致命 bug）。这是设计阶段没看到的实现期必改点。
4. **两套坐标**：标签 id `tab:N`（页面侧、单调不复用）≠ doc 根 `doc:N`（Worker 侧）。UI 动作用标签 id，回包路由/`closeRoot` 用 rootId。
5. **每标签独立状态的完整清单**（§3 只列了 rootId/runtime/selected/meta，实现时补全）：`DocSession` 版本字段（切走时存档）、
   行窗口 adapter、搜索状态机、**编辑状态机**（「已修改 N 处」/undo 可用性）、原文窗口 adapter + 原文索引元信息、
   保真报告、表达式结果视图（切走先回文档树、结果保留，重进左面板「表达式」时恢复）、树滚动位置。
6. **替换当前标签 = 先成功 `load` 新根，再对旧根发 `closeRoot`**：新文档解析失败时原标签不会被掏空。
7. **单文档下的「新标签」入口**（§4 写「⌘O 新标签模式」但没写具体形态）：标签条在 1 个文档时按 §1 隐藏，
   所以入口层（导入 / 文件 chip / ⌘O）里加**「在新标签中打开」切换链接**，并加 `⌘⇧O` 直达；拖到标签条空白
   因此只在 ≥2 标签时可达（如实记录）。「导入 / 文件 chip / ⌘O」的默认语义仍是**替换当前标签**（覆盖警示照旧）。
8. **关标签丢弃未导出修改**：弹浏览器 `confirm`（用户 2026-11-11 拍板）；标签条**不加**「已修改」小点（同拍板，守 §1「文件名 + ×」口径），
   活动标签的「已修改 N 处」徽标照旧。
9. **内存提示**：第 2+ 个标签、且单份 ≥50 MB 或工作区合计 ≥50 MB 时给一次性 toast（5s），不阻断导入。

### 验收结果（本机实测 2026-11-11）

- `npm run check`：tsc + **899 单测（34 文件）全绿** + build（#18 新增 59 条：workspace-state 36 / root-store 9 / doc-service 7 / 契约 4 / dev-hook 3，840 → 899）。
- **15 套真机冒烟串行全绿**（新增第 15 套 `smoke-workspace` **50/50**；其余 14 套计数不变：search 97、extension-search 56、outline 53、expression 45、copy 38、raw 26、settings 25、fidelity 24、expand 21、export 21、edit 14、repair 14 + `smoke`/`smoke:ext` 打 OK）。
  `smoke-workspace` 覆盖：单文档零视觉变化（标签条 hidden、布局高度 0、树视口不变）/ 入口层「替换 ⇄ 新标签」切换与 `＋` /
  32px 与 `role=tablist`/`aria-selected` / 每标签独立展开态·滚动·选中·搜索（含面板输入框回填）/ **表达式结果视图不跨标签串味、结果根上照常展开/全部展开（ADR-0018 §1）、在结果视图里导入不污染标签存档** / 替换标签后另一标签不受影响 /
  关活动标签相邻接管、关最后回空态 / 软上限 8（`＋` 禁用 + title）/ 第 2 份大文档内存提示（小文档不提示）/ 深亮两套截图。
- 体积（minify gz）：`page.js` **41.0 → 45.6KB**（预算 46，2026-11-11 由 45 修订 +0.7，见「预算修订」）、`worker.js` **58.7** 不变、
  `page.css` 7.8 → **8.1**、懒加载 chunk 合计 145.4 → **145.6KB**（预算 146）。标签条与工作区代码在首屏 `page.js`，未进懒加载。
- 截图：`.spike/smoke/workspace-{two-tabs,light,empty}.png`。

### 已知差距 / 本轮不做

- **拖放按落点分流**（标签条空白 vs 文档视图）只有代码与手测，**没有自动化覆盖**（headless 里造 DataTransfer 不可靠）。
- **watchdog 重载后工作区丢失**（`restartAfterWatchdog` 走页面重载；会话恢复本就不在 v1，ADR §4 明确不做）。
- **标签顺序拖拽排序**已于同日实现（见「修订（2026-11-11 下午）」）；满 8 提示用按钮 `title`，无额外弹窗。
- **标签重命名 / 自定义导出文件名**已由 **ADR-0021**（2026-11-12）落地：多标签双击标题 / F2 就地改名；文件导出走系统「另存为」并按最终文件名反推联动；单文档没有标签入口、只经导出改名。
- `loadId` 抢占仍是**全局**的（不是按标签）：页面用入口层 busy 拒绝并发 paste/drop，并把被作废的 load 回包
  用 `closeRoot` 释放（不留孤儿根）；真要做并发导入需按标签排队，另行设计。
- **closeRoot 后堆回落**只有单测层面的「真丢引用」，没有 `performance.memory` 级实测（Worker 堆不在主线程 API 可见范围）。
- 表达式结果视图切标签不自动重进（切走回文档树、结果按标签保留；再点左面板「表达式」即恢复）。

## 修订（2026-11-11 下午，按用户反馈）

用户实测反馈三件事，全部落地（提交见 dev 分支同日后续提交）：

1. **模态入口层没遮住左面板**（bug）：`.side--left` 是 `z-index:31`（保留给「初始空态里点设置/切面板」，见 ADR-0016 §2.6 与 bug #2 的修复），而入口层遮罩是 `z-index:30` → 替换 / 新标签模态层下左面板仍是亮的、还能点。修法：只把**模态形态**（`replace` / `new-tab`）抬到 `z-index:32`，初始空态仍是 30。回归：`smoke-workspace` 新增 `tab-add:layer-covers-left-panel`（左面板中心点命中的不是左面板 + 层 z-index=32）。
2. **标签拖拽排序**（用户明确要求做）：`WorkspaceState.move(id, toIndex)`（夹取越界、顺序真的变了才通知、活动标签不变）+ `TabStrip` 的 HTML5 drag 交互（标签 `draggable`、插入指示线 2px 靛蓝绝对定位、拖到条外 = 取消）+ **键盘等价入口 `Alt+←/→`**。回归：单测 +6（36 条）、`smoke-workspace` 新增 `drag:indicator` / `drag:reorder`。
3. **拖文件到文档视图后点「在新标签中打开」要二次确认**（体验 bug）：入口层里已暂存拖放文件时，切到「新标签」形态现在**立即以新标签导入**（此前只是切换形态，还得再点一次「替换当前文档」）。回归：`smoke-workspace` 新增 `drag:pending-layer` / `drag:pending-new-tab-immediate`（合成 `DataTransfer` + `drop` 覆盖真实链路）。

**预算修订（2026-11-11 下午，用户拍板）**：`page.js` 首屏 gz 预算 **45 → 46KB**。归因：拖拽排序 + 模态层遮罩 + 拖放落点直达 共 **+0.7KB**（44.9 → 45.6）。按 ADR-0013 / ADR-0018 先例**显式改动 + 记录归因**，不是静默豁免；`page.css` 8.0 → 8.1、懒加载 145.6（预算 146）不变。
