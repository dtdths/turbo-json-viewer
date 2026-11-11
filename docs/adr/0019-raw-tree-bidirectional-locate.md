# ADR-0019：原文视图 ↔ 树视图双向定位（Raw ↔ Tree Sync）

- 状态：Accepted（2026-11-11；实现已落地：单测 929 全绿、`smoke-raw` 32/32、`smoke-fidelity` 29/29，见 §8 实现结果）
- 日期：2026-11-11
- 依据：**#30 拍板记录**（2026-11-11 三轮 grill：16 条决策 + 50MB 实测附录）；`CONTEXT.md` 原「双向联动 / 反向定位」条目（v1 不做，若要引入需重新评估反向定位索引成本——本 ADR 即这次重评）；ADR-0003 修订（原文视图只读 / 三模式 / 行索引）；ADR-0010 修订（hover 按钮 `tabIndex=-1` 口径）；ADR-0015（菜单交互契约）；ADR-0018 §2（协议写法先例）；`docs/design/reassess-fidelity.md:13`（全量逐节点索引 88.9MiB 的否决依据）
- 相关：ADR-0002 修订（版本语义）、ADR-0008（分层与 seam）、ADR-0009（每标签会话 / `rootId` 回包路由）、ADR-0011（视图状态持久化）、ADR-0013（预算修订先例）、ADR-0016（视觉 token）

> 本文把 #30 的 16 条拍板落成**可实现契约**（协议形状、映射模型、边界、DOM/hook、验收），**不重新设计**；与票面冲突以票面为准并回票记录。
> **实现名以协议为准**：两条命令、DOM 类名、dev hook 成员名允许在实现时微调，本 ADR 固定的是**语义、错误口径与验收行为**。
> **取代**：ADR-0003 修订里「不做树 ↔ 文本双向联动 / 反向定位索引」的 v1 结论由本 ADR 取代（历史记录保留在原 ADR，不删改）。

## 背景

用户 2026-11-11 原话：原文视图鼠标悬浮某条后应有「跳转到对应树视图」的按钮，树视图也要有反向按钮。痛点 = 保真提示「检测到 2 处失真：大整数精度 2 处」→ 点「查看原文」跳到原文行后，**无法方便地回到树里同一位置对照**。

现状的三条硬事实：

- 原文视图是**行级虚拟化**（`src/view/raw/raw-view.ts`）：行池只有 `data-line` + 行文本，**没有节点身份**；三种行模式 source / pretty / plain（`src/core/raw-text.ts`）。
- 保真跳转（`main.ts` 的 `fidelityJump` → `revealRepairOffset`）只有单向 `FidelityHit.offset` → `rawLocate` → 行 + flash，**没有反向链路**。
- 值图来自 `JSON.parse`（`src/core/import.ts`），**不保留源偏移**；path ↔ source offset 的双向映射必须由 Worker 扫描源文本或建索引。

`CONTEXT.md` 曾把「双向联动」列为 v1 不做，理由正是「需重新评估反向定位索引的成本」。本 ADR 用 50MB 实测把这个成本定下来（见 §2.1），并据此选择 **B-1 混合**方案。

| 决策点 | 选择 | 理由 |
|---|---|---|
| 映射在哪算 | **Worker** | 源文本 50MB ≈95MB 内存，永不进主线程（ADR-0003 §2 红线）；主线程零拷贝 |
| 原文→树（offset→path） | 检查点 + 祖先键栈**增量索引**，首次跳转懒建 | 50MB 索引 73–113KiB、建好后命中 0.16ms 级（实现复测 §8.1） |
| 树→原文（path→offset） | 按需**单趟扫描** + 每标签 LRU | 路径无单调性、检查点帮不上；50MB 首跳≈238ms（1MB≈5ms）、命中缓存 0ms |
| 全量 `path→offset` 表 | **否决** | 50MB ≈88.9MiB（`reassess-fidelity.md:13`），与「大文档不物化」冲突 |
| 分层采样双向索引 | **否决** | v1 收益/复杂度不划算；高频对照由 LRU 覆盖 |
| plain 模式（修复文档） | 两侧禁用 | 源文本与修复后值图不一一对应，映射不可靠 |
| 锚点记忆 | 每标签内存、不持久化 | 只为「来回弹」；不污染设置与跨会话状态 |

## 决策

### 1. 交互与入口（#30 决策 1/2/3/6/7）

- **原文侧**：**行尾浮条**「⇢」（与树行浮条同款 chip；`position: sticky; right: 8px` 贴**原文视口右缘**，长行横向滚动时跟随；hover 整行任意位置出现；**行号保持可见、不被遮挡**）。*2026-11-11 用户反馈修订：初版放在行号 gutter 并覆盖行号，出现「箭头与行号重叠、行号消失、第一次找不到入口」，故改为右缘浮条。*锚点 = 行首第一个非空白 token 所属节点；`}`、`]`、纯逗号、空行等**结构行不显示按钮**；title/aria 给行号（「在树视图中定位（第 N 行）」——目标路径需 worker 反查，hover 不预取，见「已知差距」）。
- **树侧**：行尾浮条第三个动作（与复制 `⧉` / 编辑 `✎` 同款）+ 右键菜单项；根 / 容器 / 标量都可跳。
- **视觉**：20px 单字形图标（原文侧 `⇢`、树侧 `⇠`）+ title/aria（「在树视图中定位」/「在原文中定位」）；hover 按钮 `tabIndex=-1` 仅鼠标快路径，键盘走右键菜单（ADR-0010 修订 + ADR-0015）。
- **跳后反馈**复用现状：树侧展开祖先 + 选中 + 滚动 + `.is-changed` 900ms；原文侧滚动 + `.is-flash` 900ms。
- **锚点记忆**：每标签**内存**记住上次对照锚点，来回弹优先回记忆位置；不持久化、不额外提示。
- 不做双向预高亮 / hover 联动高亮。

### 2. 映射模型（B-1 混合；#30 决策 14）

**原文→树（显示行 / offset → path）**：懒建「检查点 + 祖先键栈」索引。

- 检查点需同时存**帧链** `{isObj, closer, depth, pos, idx}` + **键栈** `(kind, offset, len)`；现有行索引只存 `{lineIndex, srcOffset, depth}`，**不够**。
- 键只存 `(offset, len)`，**命中才拼规范路径字符串**（50MB：纯词法 127.7ms vs 边扫边拼 345ms）。
- pretty 布局可直接复用行行走者；source 模式懒建时多一次词法（50MB ≈130ms 一次性）。
- 索引**只依赖源文本**：`WeakMap<Root>` 持有，随 `closeRoot` / 换文档释放；**临时编辑不重建**。
- 建好后命中 0.06–0.2ms（原型）/ 0.16ms 级（实现复测）；50MB 索引 56–100KiB（原型）/ 73–113KiB（实现）。

**树→原文（path → offset / line）**：按需单趟扫描 + **每标签 LRU**。

- 路径无单调性，检查点帮不上；原型 1MB≈2.5ms / 10MB≈26ms / 50MB≈125ms，**实现复测** 1MB≈5ms / 10MB≈50ms / 50MB≈238ms（见 §8.1）；命中缓存 0ms。
- 用户痛点闭环（失真 → 原文 → 回树 → 再对照同一节点）靠缓存首尾秒开。
- **重复键**：`JSON.parse` 只留最后一个 → 树→原文落到**最后一个**源位置（与树里显示值一致）；反向重复键各行跳同一树行，v1 不额外区分。

**已考虑并否决**：全量 `path→offset` 表（50MB≈88.9MiB，`reassess-fidelity.md:13`）；分层采样双向索引（v1 复杂度不值）。

### 2.1 实测附录（#30，2026-11-11，原样记录）

Apple M4 / Node v24.13.0 / 纯 node，ms，5 次中位：

| 文件 | 大小 / 显示行数 | 全量 offset→path | 全量 path→offset | 检查点内存 | 检查点续走 |
|---|---|---|---|---|---|
| 1MB minified | 1,048,622B / 1 行 | 7.6（中部 3.7） | 2.5 | 1.9 KiB | 0.09ms |
| 10MB minified | 10,485,864B / 1 行 | 69.6（34.7） | 25.9 | 17.9 KiB | 0.10ms |
| 50MB minified | 52,428,918B / 4,831,202 行 | 341.4（169.5） | 125.0 | 86 KiB | 0.06ms |
| 50MB pretty | 52,428,893B / 3,110,821 行 | 257.0（128.8） | 103.0 | 55.3 KiB | 0.09ms |
| 5MB pretty | 5,243,070B / 320,473 行 | 26.3（13.1） | 10.5 | 5.7 KiB | 0.17ms（首跑 2.62） |

- 扫描基线（纯词法不建路径）50MB≈127.7ms；边扫边拼路径字符串会涨到 345ms → 实现里键只存 `(offset,len)`、命中才拼路径。
- 检查点需同时存 **帧链** `{isObj,closer,depth,pos,idx}` + **键栈** `(kind,offset,len)`；只存 `{lineIndex,srcOffset,depth}`（现状）不够。
- 深度：原型递归 5000 层 OK、10000 层栈溢出；仓库 `walkPretty` 是迭代实现，10000 层实测无限制 → 新索引也走迭代。
- 随机 20 个 offset 落在「节点内部（含键区间）」比例：minified 14~17/20、pretty 10/20；其余落在空白/逗号。**实现口径**：只认节点起点 / 容器开括号（后者 `exact:false`），其余回 `null`、不回退最近节点。
- 映射索引只依赖**源文本**，临时编辑不影响；文档重载才重建。
- 以上是**设计期原型脚本**的数字；仓库实现（`src/core/path-index.ts`）落地后的复测见 §8（同量级，`path→offset` 略慢于原型）。

### 3. 协议（`protocol/messages.ts` / `core-api.ts` / `core/doc-service.ts`）

两条**只读**命令（实现名以协议为准，形状与语义如下）：

```ts
| { t: 'rawPathAt'; rootId: RootId; line: number }   // 1-based 显示行（与 rawLocate 同口径）
| { t: 'rawOffsetOf'; rootId: RootId; path: Path }   // 规范路径

export interface RawPathAtReply {
  rootId: RootId;
  /** 夹取到 [1, totalLines] 后的 1-based 行号回显 */
  line: number;
  /** 行首 token 所属节点；结构行/空行/无锚点 → null（不猜最近节点） */
  path: Path | null;
  /** false = 命中行首的「成员值起点 / 容器开括号」（键在上一行），path 仍是该节点 */
  exact: boolean;
}

export interface RawOffsetOfReply {
  rootId: RootId;
  path: Path;
  /** 节点锚点的源文本 UTF-16 偏移；源文本中无对应位置（编辑新增）→ null */
  offset: number | null;
  /** 由行索引反查的 1-based 显示行；offset 为 null 时同 null */
  line: number | null;
}
```

- **只读**：不推 `docRevision` / `rowVersion`、不动行模型/展开态、不发事件（与 `rawLocate` / `fidelity` 同口径）。
- 根不存在 → `NO_ROOT`；`rootId` 不是 doc 根（expression 根无 `source`）→ `BAD_COMMAND`。
- **plain 模式**：命令仍可回（防御式）`{path:null}` / `{offset:null, line:null}`，UI 不发请求（两侧禁用）。
- `line` 夹取到 `[1, totalLines]`（与 `rawLocate` 的夹取口径一致）；越界不抛错。
- **锚点规则**：行首第一个非空白 token；对象成员 = 键起点、数组元素/根 = 值起点。若该 token 是「成员的值起点 / 容器开括号」（源码行模式键在上一行），仍映射该节点并回 `exact:false`；其余（`}`/`]`/`,`/空白/空行）→ `path=null`，**不回退最近节点**（不假装精确）。
- `exact:false` 仅表示上述「值起点/开括号」情形；UI 行为不变（同样跳该节点）。
- 迟到回包：页面按**发起时的 `rootId` + 活动标签**丢弃（ADR-0009 `isActiveDocRoot` 同款前置门），不弹错。
- 常量（LRU 容量 / 检查点间隔 / 索引构建让出粒度）集中 `protocol/versions.ts`，**命名以实现为准**。

### 4. 边界与降级（#30 决策 5/8/9/15/16）

- **plain 模式（修复文档）两侧禁用**：源文本与修复后值图不一一对应；按钮禁用 + title 说明原因。
- **编辑态**：映射永远以**原始源文本**为准（临时编辑只改值图、不改源文本）。树行无原文位置（编辑新增的节点）→ 保留按钮、**点击后状态栏提示**（不做逐行预扫描禁用，见「已知差距」）；plain 模式整列入口关闭。原文→树目标路径已不存在（编辑删除/改名）→ 跳**最近仍存在的祖先** + 状态栏提示；记忆锚点失效 → 回退精确反推。
- **失败反馈**：状态栏约 3s 临时文案（映射失败 / 路径不存在），可重试；不新增提示条/对话框。
- **延迟 UX**：触发按钮进 busy + 状态栏「正在定位…」；**不提供取消**（最坏 ~300ms）；切标签/换文档按 `rootId` 丢弃迟到回包。
- **范围**：表达式结果视图不涉及（只有树形态、expr 行无源偏移）；多标签只在当前标签内；保真条保持单动作（闭环靠原文侧按钮）。

### 5. 锚点记忆（app 层，per-tab）

- `TabExtras.anchor: { path; line } | null`（仅内存；偏移不需要——回跳只要行号）。
- 树→原文成功后写 `{ path, line }`；再点同一树行的「⇠」时**直接用记忆行号**（0ms，不扫源文本）；原文→树成功后也写 `{ path, line }`。
- 关标签 / 换文档清空；刷新即丢；不进 `UiState` / settings。

### 6. DOM 契约（页面 / 冒烟共同依赖；类名以实现为准，语义固定）

| 选择器 / 属性 | 说明 |
|---|---|
| 原文行浮条 | `button.raw-row__locate`（行的直接子项、行尾）、`position:sticky; right:8px` 贴视口右缘（横滚跟随）、hover 整行显示、`tabIndex=-1`、图标 `⇢`、`aria-label="在树视图中定位（第 N 行）"`；结构行/plain 用 `hidden` 属性不渲染；行号 `.raw-row__num` 始终可见 |
| 树行浮条第三钮 | `button.row__action[data-action="raw"]`，图标 `⇠`，`aria-label="在原文中定位"`；表达式结果视图 / plain 由 app 关掉整列入口 |
| 右键菜单项 | 树行菜单 `[data-act="locate-raw"]`「在原文中定位」；原文行菜单 `#rawCtxMenu [data-raw-act="locate-tree"]`「在树视图中定位」 |
| busy / 失败 | 不阻塞按钮：状态栏行区显示「正在定位…」；失败/回退用状态栏 `statusState` 约 3s 临时文案 |

### 7. dev hook（`window.__tjv`，仅 HTTP 冒烟）

新增 7 个成员（75 → **82**，逐字钉住 `tests/unit/app/dev-hook.test.ts`）：

- `locateState()`：`{ busy, anchor }`；
- `rawPathAt(line)` / `rawOffsetOf(path)`：直连 core 的只读映射（不切视图）；
- `rawLocateClick(line)`：点真实 gutter 按钮（DOM click）→ 等 250ms 回 `{ clicked, path } & 会话快照`；
- `treeLocateClick(path)`：点真实树行浮条第三钮 → 等 250ms 回 `{ clicked, line } & 原文快照`；
- `rawCtxOpen(line, x?, y?)` / `rawCtxClick()`：原文右键菜单（键盘等价入口）打开/选中。

## 明确不做（本 slice）

- 连续滚动联动 / 左右分屏对照（另一个 effort）。
- 原文视图行级键盘导航（另开票）；保真条多命中 prev/next。
- 表达式结果行 → 原文（结果行无源偏移；已有 `exprLocate` → 原文档树）。
- 原文行内字符级锚点（只到「行首 token 所属节点」）。

## 已知差距（记录，不静默豁免）

- **大文件首跳延迟（仓库实现实测，见 §8.1）**：树→原文 50MB≈238ms（LRU 未命中，1MB≈5ms / 10MB≈50ms）；原文→树首次懒建索引 50MB≈191–222ms（1MB≈5ms / 10MB≈51ms）。无取消，只能等 busy（拍板时预算「最坏 ~300ms」）。
- **原文侧按钮 title 只到行号**（「在树视图中定位（第 N 行）」）：目标路径要 worker 反查，hover 不预取（避免 hover 触发扫描）；树侧按钮 `aria-label` 给动作名。
- **原文侧 a11y 差距**：行尾浮条按钮 `tabIndex=-1`（鼠标快路径，与树行浮条同款）；原文视图没有行级键盘导航，因此原文行右键菜单实际靠鼠标触发——键盘等价入口要等「原文行级键盘导航」另开票一起补。
- **编辑新增节点的树侧按钮不做逐行禁用**（逐行预扫描代价高）：保留按钮、点击后状态栏提示「该节点来自临时修改，原文中没有对应位置」；plain 模式整列入口关闭（`syncLocateRaw`，`meta.repair` 判定）。
- 原文→树映射为 `path=null` 的行（结构行 / 空行）**不回退最近节点**（拍板要求「结构行不显示按钮」，浏览器侧用行首字符启发式隐藏；真实点击仍以 null 兜底）。
- source 模式一行多值（如 `{"a":1,"b":2}`）只锚定行首第一个节点，其余值没有独立按钮。
- 偏移落在空白 / 逗号 / 节点内部 → `exact:false` 回退最近节点，可能不是用户心里的「那一个」。
- 重复键不区分（树→原文取最后一个；原文重复键行都跳同一树行）。
- 索引构建必须走迭代实现（原型递归 10000 层栈溢出；仓库 `walkPretty` 已迭代）。
- 临时编辑后源文本与值图不同步是设计使然——跳转永远对原文，不对编辑后的值。

## 预算

- 实测：`page.js` 45.6 → **47.0KB gz / 预算 46 → 47**（用户 2026-11-11 拍板；+1.4 归因：原文 gutter 按钮/样式、树行浮条第三钮、两侧右键菜单项、busy+状态栏提示、每标签锚点记忆、视图/编辑态接线；ADR-0013 先例）。
- `worker.js` 58.7 → **61.0KB gz**（+2.3：源文本索引 + offset→path/path→offset 扫描 + 两条命令）；`page.css` 8.1（+0.0）；懒加载 **145.6KB gz**（预算 146，不变）。

## 8. 实现结果（2026-11-11）

实现位置：`src/core/path-index.ts`（新增）、`src/core/raw-text.ts`（`tokenStartAt`）、`src/core/doc-service.ts`（两命令 + `WeakMap<Root>` 索引 + 每根 LRU）、`src/protocol/{types,messages,core-api,versions}.ts`、`src/view/raw/raw-view.{ts,css}`、`src/view/tree/{row-renderer,tree-view}.ts`、`src/app/{main.ts,page.html,dev-hook.ts}`、`tests/unit/core/path-index.test.ts`、`tests/contract/core-transport.cases.ts`、`scripts/smoke-{raw,fidelity}.mjs`。

### 8.1 仓库实现实测（Apple M4 / Node 24.13 / vite-node；非原型）

| 文件 | 节点数 | 检查点数 | 索引内存 | 建索引（首跳，一次性） | offset→path 命中 | path→offset |
|---|---|---|---|---|---|---|
| 1MB minified | 79,183 | 38 | 2.4 KiB | 5.4ms | 0.11ms | 5.2ms |
| 10MB minified | 754,093 | 368 | 23.5 KiB | 50.7ms | 0.07ms（中位） | 49.9ms |
| 50MB minified | 3,623,401 | 1,769 | 112.9 KiB | 222.3ms | 0.16ms | 238.2ms |
| 50MB pretty | 2,342,358 | 1,139 | 72.7 KiB | 191.4ms | 0.16ms | —（同算法） |

- 实现比原型慢约 1.9×（`path→offset` 50MB 125 → 238ms），仍落在拍板时「最坏 ~300ms」的 busy 预算内；`offset→path` 与原型同量级（0.1ms 级）；索引内存略高于原型（50MB 73–113KiB，键栈/帧链在 JS 侧多一层恢复成本）——同量级，不改变 B-1 方案。
- 首次跳转付一次建索引 / 扫描（上表）；之后树→原文靠 LRU 或记忆锚点 **0ms**，原文→树 **0.16ms**。

### 8.2 验收

- 单测 **899 → 929**：新增 `tests/unit/core/path-index.test.ts` 24 条（offset↔path、转义键/Unicode、深嵌套 300、重复键取最后一个、结构行 null、`cpEvery` 1/2/3/64/2048 结果一致、大文件内存 sanity、`tokenStartAt` source/pretty/plain）；契约新增 3 条 × 2 适配器 = 6 条（双向只读、plain 回 null、未知根 `NO_ROOT`、表达式根 `BAD_COMMAND`、容器开括号 `exact:false`、重复键最后一个）。
- 锚点记忆在 `app/main.ts` 接线层（每标签 `TabExtras.anchor`）：`main.ts` 无单测 harness（与既有接线一致），由 `smoke-raw` 的 `locate:anchor-remembered` + `smoke-fidelity` 的 `locate:tree-to-raw-anchor` 两条浏览器断言覆盖。
- dev hook **75 → 82**（`locateState / rawPathAt / rawOffsetOf / rawLocateClick / treeLocateClick / rawCtxOpen / rawCtxClick`），`tests/unit/app/dev-hook.test.ts` 逐字钉住。
- 冒烟：`smoke-raw` **26 → 33/33**（+7：行尾浮条与 aria/行号可见/不在 gutter、宽行横滚 sticky 贴右缘、原文→树选中、锚点记忆、树→原文回跳、结构行无按钮、右键菜单闭环）；`smoke-fidelity` **24 → 29/29**（+4 痛点闭环 + 1 截图存在性）；**不新增第 16 套**。深/亮截图：`.spike/smoke/raw-locate.png`、`.spike/smoke/fidelity-locate.png`。
- 0 page 异常 / 0 console error（两套冒烟断言）。
- 体积见「预算」节（`page.js` 47.0/47、`worker.js` 61.0、`page.css` 8.1、懒加载 145.6）。

## 验收（勾选）

- [x] 单测：映射纯函数 + 契约（新命令错误语义）+ dev hook 逐字钉住；锚点记忆由冒烟覆盖（接线层无单测面）。
- [x] 冒烟：扩 `smoke-raw` + `smoke-fidelity`（不新增第 16 套）；深/亮截图。
- [x] 体积：`node build.mjs --analyze`，`page.js` 47.0 ≤ 47。
- **验收结果待实现完成后补记在本 ADR**（数字必须本机实测 + 证据）。
