# ADR-0009：多文档标签 —— 一个 Worker、每标签一个 doc 根、`closeRoot` 显式释放

- 状态：Accepted（设计定稿 2026-10-30，**未实现**）
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

## 待办（实现期）

1. 协议：`closeRoot`、`load` 多根回包；`protocol/versions.ts` 常量（标签上限 8、标签条高 32）。
2. 核心：`RootStore.close`（或补 `release`）、`DocService.load` 不覆盖、`closeRoot` 处理在途窗口/搜索。
3. 视图模型：`WorkspaceState`/`TabState`；`RowWindowSource`/`SearchState` 实例化位置从模块级挪进 `TabState`。
4. 视图：`TabStrip`（32px、≥2 显示、`role=tablist`/`aria-selected`）；工具栏「导入」在有活动标签时仍替换，`＋` 新标签。
5. 验收：8 标签切换窗口延迟（切回可能 stale → 1 帧重取）、`closeRoot` 后堆回落、标签条对树视口高度的影响；扩展 smoke 增补「开 2 标签 / 切标签保留各自展开态 / 关标签释放根」用例。
