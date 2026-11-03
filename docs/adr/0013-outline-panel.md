# ADR-0013：大纲面板（结构导航器）

- 状态：Accepted（2026-11-03，实现随本 ADR 落地）
- 日期：2026-11-03
- 依据：`docs/design/direction.md` §1/§3/§6（活动栏第三个模式 = 大纲；320px 左面板；规格「键 → 类型 → 项数 的层级列表；当前节点高亮；点击跳转」）；本轮用户拍板「下一刀 = 大纲面板」；交接建议「数据源按需取某容器子项，不全文档建树」
- 相关：ADR-0001/0002（行窗口 / 行模型 —— 本 ADR 说明为何不复用行协议）、ADR-0008（分层与 seam）、ADR-0011（左面板模式持久化）、#11（大纲属其余项）、#23（保真提示；整数键键序失真不归本 slice）、#21（视觉走查）

## 背景

活动栏当前只有文档树 / 搜索 / 设置（表达式是 v1.1 占位），「大纲」只有视觉规格、从未实现。
大文档（10MB ≈ 595k 节点、50MB ≈ 2,958,550 节点）里导航只能靠搜索或拖滚动条；需要一个**结构导航器**：
一眼看到每层的键 / 类型 / 项数，点一下就跳到树里对应节点。

v1 剩余清单里这是价值最高的一件。唯一的真设计问题 = **数据源 seam**（交接文档点名）：

| 方案 | 做法 | 评价 |
|---|---|---|
| A | core 内建第二棵「大纲行模型」（只含部分节点 + Fenwick + 窗口协议） | 与 `RowModel` 重复一套展开/窗口/预算纪律；`RawWindowSource`/`RowWindowSource` 两份实现的漂移已是前车之鉴；50MB 多一份全量索引 |
| **B（采纳）** | 新增一条**只读** `outline` 命令：按容器**按需**返回子项（分页）；大纲的展开集合 / 扁平化 / 虚拟窗口留在主线程 viewmodel | core 只加一个纯函数 + 一个命令；没有第二份行模型；打开大纲不增加 50MB 文档的常驻内存 |

方案 B 的代价是「每页重新枚举该容器子项」（数组 `slice` / 对象 `Object.keys` 扫描）。
实测 200 项/页在 10MB 样本上 <1ms（见验收）；跨页重复扫描可接受，因此**不做容器级缓存**（避免大纲自己持有一份「全文档形状」）。

## 决策

### 1. 位置与形态

- 活动栏第 3 个模式按钮：文档树 / 搜索 / **大纲** / 设置（`data-panel-btn="outline"`）。
  点击已激活的大纲按钮 = 回到文档视图（与搜索/设置一致）。
- 左面板 320px（复用 `.side--left` / `.side__head`）；面板标题「大纲」；`UiState.panel` 增加 `'outline'`（持久化恢复，ADR-0011）。
- 行高 = **跟随设置 `rowHeight`**（20/22/24/26，默认 24），与树 / 原文视图一致；虚拟列表 overscan 6。

### 2. 内容：列容器 + 标量的全部子项

「只列容器」不可取：一个 12 个标量字段的 item 展开后是空的，用户会以为坏了；要修就得先扫全量子项判断
「是否含子容器」。全部子项则：

- 大纲是**紧凑结构导航器**：每行给 `键 → 类型 → 项数`，点击可跳到任意节点（含叶子）；
- 与树的「值即结构」心智能对齐，但**展开状态独立**、还多两个信息列（类型 / 项数）；
- 分页成本天然 O(page)：数组直接 `slice`，对象 `Object.keys` 后按页取，不需要「先扫全量过滤容器再分页」。

行内容：

| 行 | 显示 | 可展开 | 项数 |
|---|---|---|---|
| 根 | `$`（等宽）+ 类型 + `N 项` | 永远展开（不可折叠，与树一致） | 容器子项数 |
| 对象成员 | 键原文 + 类型 + 容器才有 `N 项` | 容器可展开 | 容器子项数；标量留空 |
| 数组元素 | `[i]` + 类型 + 容器才有 `N 项` | 容器可展开 | 同上 |

- 键序 = **值图顺序**（`JSON.parse` 真相），不做显示排序（#19 未拍板）；整数样式键被 `JSON.parse` 重排的失真见 #23。
- 标量行不可展开、无 caret；空容器行也无 caret（与树一致，已知差距）。

### 3. 协议：`outline` 命令（只读、不推任何版本）

```ts
// protocol/types.ts
export interface OutlineChild {
  key: string;   // 对象键原文 / 数组下标（含方括号，如 `[12]`）
  idx: boolean;  // true = 数组下标样式（与 Row.idx 同口径）
  kind: JsonKind;
  count: number; // 容器子项数；标量为 0
  path: Path;    // 完整规范路径
}

export interface OutlineReply {
  rootId: RootId;
  path: Path;    // 被查询容器自身
  kind: JsonKind;
  total: number; // 该容器子项总数（分页依据）
  start: number; // 实际生效的起始下标（夹取后）
  children: OutlineChild[];
}

// protocol/messages.ts
| { t: 'outline'; rootId: RootId; path: Path; start: number; count: number }
```

**语义（接口契约，core / viewmodel / 测试共同穿越）**：

- `start` / `count` 夹取到 `[0, total]` / `[0, OUTLINE_PAGE_MAX]`；回包 `start` = 实际起点，`children.length` 可少于 `count`（末页）。
- `path` 不存在或中间段穿越标量 → `rowModel.valueAt` 抛 `BAD_COMMAND`（与 `getNodeJson` 同口径）。
- **标量节点**是合法路径：回 `total: 0, children: []`（视图不会请求，但语义明确、便于测试）。
- **只读**：`docRevision` / `rowVersion` 都不推进；不改变树展开态；不依赖树是否展开（可查询折叠容器的子项）。
- 不缓存：每页重新枚举（见背景「代价」）。
- 常量（`protocol/versions.ts`）：`OUTLINE_PAGE = 200`（默认页）、`OUTLINE_PAGE_MAX = 500`（单次请求上限）。

**为什么不是复用 `window`**：行窗口是「可见行模型坐标」（受展开集合与行预算约束）；大纲要的是「某容器的全部子项，
与树展开态无关」。语义不同，且后者是 O(page) 的纯查询。

### 4. 交互

- **点击行（非 caret）** = 跳转：`expandTo` 展开树祖先链 → 树滚动居中 → 选中；原文视图下先切回树（与搜索跳转一致）。
  复用一条 `jumpToPath` 链路（从 `gotoHit` 抽出，搜索与大纲共用，避免两份跳转纪律）。
- **点击 caret / 键盘 ←→** = 仅展开/折叠大纲自己的行（不影响树）。
- **键盘 ↑/↓** = 移动大纲当前行（`.is-current`；同步树**选中**但不 `expandTo`/不滚动树）；**Enter** = 跳转当前行；**Home/End** = 首/末行；
  已加载末行再按 ↓ = 加载下一页（等价点击「加载更多」哨兵行，键盘可达分页）；
  面板 `role=tree`、行 `role=treeitem` + `aria-level` + 容器 `aria-expanded` + 当前行 `aria-selected`，
  scroller 用 `aria-activedescendant` 指向当前行（虚拟列表 a11y，与方向 §8 一致）。
- **当前节点高亮**：树选中变化 → 大纲 `setSelected(path)`；行已加载且可见时高亮并滚入视口；不可见时不高亮。
- **分页**：容器行展开后，若 `items.length < total` 显示哨兵行「加载更多（还有 N 项）」；点击加载下一页，加载完消失。
- 大纲展开状态**独立于树**，两者不联动。

### 5. 状态与生命周期（viewmodel，无 DOM）

`viewmodel/outline-state.ts`：

- 接口：`open(rootId)` / `refresh()` / `setOpen(path, open)` / `toggle(path)` / `loadMore(path)` / `setSelected(path)` / `close()` / `view()`。
- 内部：`containers: Map<Path, { kind; total; items: OutlineChild[]; loading: boolean }>`、`expanded: Set<Path>`、
  扁平化行缓存（脏标记）、`epoch`（换文档/刷新时递增，迟到回包丢弃）、每容器单飞（`loading`）。
- 根永远展开、不可折叠；折叠容器时丢弃**后代**的页缓存与展开项，**保留被折叠容器自身的页缓存**
  （重展开不重取，避免无谓往返；自身展开项即被清）。
- 换文档 → `open`（重置并加载根页）；编辑（`docRevision` 变化：replaceNode / undo / redo / reset）→ `refresh()`（回到根展开、丢弃子页）。
- 面板关闭不销毁状态（重开保留展开现场）；**不持久化**（刷新页面后为空）。
- 数据源注入 `OutlineSource`（`outline(req)` 子集），单测用 fake source，不碰真实 core 单例。

### 6. 明确不做

- 不做全文档大纲树/索引（方案 A）。
- 不做标量过滤、按类型筛选、大纲内搜索、拖拽排序、多选、展开状态持久化。
- 不做「选中节点自动展开祖先 + 自动翻页定位」（v1.1 候选，见已知差距）。
- 不新增树行模型语义；不动 `RowModel` / 行窗口协议。
- 视觉细节（图标、间距、颜色）归 #21，功能期只落最小形态（沿用现有 panel / tree token 与 24px 行节奏）。

## 接口契约（实现 / 冒烟共同依赖）

### DOM 契约（view 层，冒烟脚本依赖，不要改名）

| 选择器 | 说明 |
|---|---|
| `.actbtn[data-panel-btn="outline"]` | 活动栏大纲按钮（`aria-label="大纲"`） |
| `#outlinePanel.panel.panel--outline` | 左面板挂载点（page.html 只留这个 div） |
| `#outlineScroll` | 虚拟滚动容器（`role="tree"`、`tabindex="0"`、`aria-label="文档大纲"`） |
| `.outline__spacer` | 撑高容器（`height = size × rowHeight`） |
| `.outline-row[data-path]` | 行（`role="treeitem"`，`data-depth` / `data-kind` / `data-count` / `aria-level` / `aria-expanded`） |
| `.outline-row.is-current` | 当前节点高亮（同时写 `aria-selected`；scroller 的 `aria-activedescendant` 指向当前行） |
| `.outline-row.is-open` | 容器展开态 |
| `.outline-row__caret` / `__key` / `__type` / `__count` | 行内元素；caret 点击优先于跳转 |
| `.outline-row--more[data-more="1"]` | 「加载更多」哨兵行（`data-path` = 所属容器） |
| `#outlineEmpty` | 空态 / 加载中 / 错误文案 |
| `#outlineFoot` | 底栏「已渲染 R / N 行」（虚拟化诊断） |

### dev hooks（仅 HTTP 模式，`window.__tjv`）

`outlineState()`（快照 + 诊断）、`outlineOpen()`（= `setPanel('outline')`）、`outlineToggle(path)`、
`outlineLoadMore(path)`、`outlineJump(path)`（返回 `{ ok, row }`）。

## 验收

- **单测**：`core/outline.ts`（分页边界 / clamp / 标量 / 空容器 / 非标识符键 / 数组与对象 / count 语义）；
  `doc-service`（只读不推版本、`NO_ROOT`、`BAD_COMMAND` 路径、标量路径回空）；`viewmodel/outline-state`（open / 展开 / 折叠丢弃子树 / 分页 / 迟到回包丢弃 / 换文档 / 编辑刷新 / view 快照 / 高亮）；`computeOutlineWindow`。
- **冒烟** `scripts/smoke-outline.mjs`：面板打开与空态 / 根行与三层展开 / caret 与行点击语义 / 键盘 / 当前高亮 / 分页「加载更多」 / 大数组虚拟化（渲染行 ≤ 屏行 + 2×overscan）/ 换文档重置 / 编辑后刷新 / 原文视图跳转切回树 / 持久化 / 0 长任务 0 console error。截图 `.spike/smoke/outline-*.png`。
- **性能**（10MB 样本）：打开面板到首屏 < 100ms；展开 `data` / `items` 页请求 < 20ms；滚动 0 长任务。
- **回归**：`npm run check` + 全部 12 套冒烟（含既有 11 套）全绿。
- **体积**：`page.js` minify 后 gz 增量 ≤ +2.5KB（预算 45）。

## 验收结果（2026-11-03 实测）

- **单测 410/410**（17 文件；+56：outline core 12 / doc-service 12 / outline-state 32；settings 断言 +3）。`tsc --noEmit` 0 error。
- **冒烟 12/12 全绿**：新增 `smoke-outline` **50/50**，既有 11 套全部通过（`smoke-search` 82/82、`smoke-extension-search` 56/56、`smoke-expand` 11/11、`smoke-edit` 14/14、`smoke-copy` 27/27、`smoke-repair` 14/14、`smoke-settings` 21/21、`smoke-export` 16/16、`smoke-raw` 25/25、`smoke`/`smoke:ext` OK）。
- **性能**：10MB 导入→大纲根页 `ready` **63ms**（含导入）；展开 `$.data` / `$.data.items` 各 **1ms**；450 项数组分页 203→403→452 行；滚到底渲染 **38 行**（末窗 = `min(屏行 31 + 2×overscan 6, size − start = 452 − 414)`，被尾部截断为 38）；全程 **0 长任务 / 0 异常 / 0 console error**。
- **体积**：`page.js` 25.1→**28.7KB gz**（+3.6，**超 +2.5 目标 1.1KB**，仍远低于预算 45）、`worker.js` 11.7→11.9、`page.css` 6.8→7.2（+0.4）。
  超目标来自虚拟列表 + 键盘 + 分页 + a11y 完整实现（含 `aria-activedescendant`/`aria-selected`、`shared/window` 抽公共窗口计算）；**登记豁免**（预算 45 未动、无新增依赖）；后续 #21 视觉走查时复查、可压。

## 已知差距（记录，不在本 slice 实现）

- 树里选中一个「大纲中不可见」的节点（祖先未展开或未翻页）时，大纲不高亮、不自动展开定位（v1.1 候选）。
- 编辑后大纲回到根展开，不保留展开现场。
- 50MB 文档大纲未端到端实测：`data.items` 184,909 项需 925 次「加载更多」才到底，v1 不做虚拟分页预取。
- 空容器行无 caret（与树一致）。
- 键序失真（整数样式键被 `JSON.parse` 重排）归 #23 保真提示，大纲如实反映值图顺序。
- 大纲展开状态不持久化（刷新 / 重开页面回到根展开）。
- 非根容器的**页请求失败**没有内联错误提示：失败返回 `ok:false`、`setOpen`/`loadMore` 不吞错，折叠后再展开会重试（不会死锁）；内联「加载失败，重试」哨兵留待 v1.1。
