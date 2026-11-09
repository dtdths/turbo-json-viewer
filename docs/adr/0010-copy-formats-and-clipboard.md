# ADR-0010：复制四格式 —— core 侧统一生成文本、零权限剪贴板、行右键菜单入口

- 状态：Accepted（2026-11-02，实现随本 ADR 落地）
- 日期：2026-11-02
- 依据：#9 拍板（四种格式 / 零权限剪贴板 + 手动回退 / 右键菜单）；`CONTEXT.md`（复制 / 路径 / 字段）；`docs/design/direction.md` §6（选中节点「复制/编辑」）；ADR-0006（子树编辑：共用 5MB 守卫与 `RowModel.valueAt`）；`src/shared/path.ts`（规范路径）
- 相关票：#9（操作语义，复制项在此收口）、#16（编辑入口，与本菜单同一处）、#10（搜索，与复制无关）

## 背景

#9 在 2026-10-27 已拍板 v1 的复制 4 格式（子树 JSON / 路径 / 原值 / 键名）与剪贴板策略（零权限 + 手动回退，**不声明 `clipboardWrite`**），但直到 slice 5 落地的右键菜单里只有「编辑此节点 JSON」一项：`src/core/` 没有 copy 模块，行窗口协议也不传完整值。

两个结构约束决定了本 ADR 的形态：

1. **主线程看不到文档值**：行窗口只给单行 `preview`（ADR-0001/0002），子树 JSON 与原始值必须由 Worker 基于值图生成；若「路径」「键名」留在主线程拼，就会形成两套格式逻辑——路径格式一旦要处理非标识符键（`$['a.b']`）就会与 core 漂移。
2. **路径已是全仓库身份**：行窗口、搜索命中、编辑、持久化键都用 `shared/path.ts` 的规范路径字符串。复制的「路径」必须与内部身份逐字一致，否则复制出来的路径不能回填到搜索/表达式/编辑。

## 决策

### 1. 入口：树行右键菜单（v1 唯一入口）

菜单项固定顺序：**复制子树 JSON / 复制路径 / 复制原始值 / 复制键名 / ── 分隔 ── / 编辑此节点 JSON**。复制作用于「右键的那一行」（同时更新选中）。不新增工具栏入口；「选中节点」面板里的复制按钮随该面板（direction §6）后做，复用同一 `copyNode` seam。

启用规则（UI 禁用 + `title` 说明；core 侧仍做兜底校验，契约不依赖 UI 状态）：

| 菜单项 | 可用性 | 说明 |
|---|---|---|
| 复制子树 JSON | 所有节点 | 受 5MB 上限（见 §5） |
| 复制路径 | 所有节点（含根 `$`） | 规范路径（见 §2） |
| 复制原始值 | **仅标量** | 容器禁用：容器没有「原始值」，提示改用子树 JSON |
| 复制键名 | **非根** | 对象键 = 键名；数组元素 = 下标数字；根无键名 |
| 编辑此节点 JSON | 所有节点 | slice 5 既有行为 |

### 2. 路径格式定稿：`shared/path.ts` 的规范路径（不是 JSONPath）

- 形态：根 `$`；标识符键 `.key`；非标识符键 `['a.b']`（单引号，内部 `\\` / `\'` 转义）；数组元素 `[i]`。
- 例：`$.data.hotel_tags[3].tag_name`、`$['a b'].x`、`$`。
- **不采用 JSONPath**（`$..x`、`$[*]` 等）：v1 不需要查询语义，而规范路径已覆盖行窗口/搜索/编辑的身份；多一套语法只会让「复制出来的路径」与 UI 内部路径不一致。
- `CONTEXT.md`「路径」词条里「未定标准形态（点路径 vs JSONPath）」由本条关闭。

### 3. 原始值：标量的「文本值」

- `string` → 字符串内容本身（**不带引号、不保留 JSON 转义**，即用户看到的文本）；
- `number` / `boolean` / `null` → JSON 字面量（`JSON.stringify`，与预览/导出同口径；大整数精度受 JS double 限制，与导入/编辑一致）；
- **对象/数组不适用**（菜单禁用；core 抛 `BAD_COMMAND` 兜底）。
- 不设大小上限：复制超长字符串是用户显式意图，剪贴板本身可承载；若实测 50MB 级单字符串有传输问题再收紧（记为已知差距）。

### 4. 键名：字段身份的文本

- 对象键 → 键名字符串原样（不加引号、不转义）；
- 数组元素 → 下标十进制数字（`3`，**不含方括号**；方括号是路径语法，不是键名）；
- 根 `$` 无键名（禁用）。

### 5. 子树 JSON：2 空格缩进；上限复用编辑守卫

- `JSON.stringify(value, null, 2)`——与 `exportDoc` 默认缩进一致。#9 写的「缩进/压缩跟随当前设置」**v1 不做**：设置面板与 `ViewStateStore` 尚未接线，没有「当前设置」可跟随；设置面板落地后改为读 `COPY_INDENT` 并接「默认复制格式」（direction §6）。此偏差记入本 ADR 与 #9 实现评论。
- 文本 > **5MB**（复用 `EDIT_MAX_BYTES` 语义，独立常量 `COPY_MAX_BYTES`）→ `TOO_LARGE`，toast 引导用「导出」（不静默截断）。`stringify` 先于大小判定，超大子树会先付出 stringify 成本（与 `getNodeJson` 同口径，已知差距见 README §11）。

### 6. 单一 seam：`copyNode` 命令 + `core/copy.ts` 纯函数

- `protocol`：新增命令 `copyNode { rootId, path, format }`（`format: 'subtree' | 'path' | 'value' | 'key'`），回包 `CopyReply { text, bytes, format }`。
- `core/copy.ts`：纯函数 `copyNodeText({ format, path, value, maxBytes })` → `{ text, bytes }`；四个格式的文本**全部在 core 侧生成**，主线程只负责写剪贴板与反馈。`DocService.copyNode` 只做「取根 → `valueAt` → 调纯函数」。
- 错误码复用：不适用格式 → `BAD_COMMAND`；子树超限 → `TOO_LARGE`；未知路径 → `RowModel.valueAt` 既有行为。不新增错误码。

### 7. 剪贴板：零权限 + 两级回退

1. 首选 `navigator.clipboard.writeText()`（扩展页已获得 focus + 用户手势）；
2. 失败 → 临时只读 `textarea` + `document.execCommand('copy')` 兜底（扩展页内可用）；
3. 再失败 → toast「复制失败：请手动选中后按 ⌘C」，不弹窗、不改选中。
**不声明 `clipboardWrite` 权限**（避免「修改你复制粘贴的数据」安装警告，#9 已定）。

### 8. 键盘与反馈

- 菜单键盘：`ArrowUp`/`ArrowDown` 在**可用项**间移动、`Home`/`End`、`Enter` 激活（原生）、`Esc` 关闭；打开时焦点落在第一个可用项（此前固定落「编辑」）。
- v1 **不新增复制快捷键**：⌘C 保留给浏览器原生文本选择，行选中不劫持（⌘C = 复制当前选中文本，符合直觉）。
- 成功 toast：「已复制：子树 JSON / 路径 / 原始值 / 键名」（2s，复用既有 `#toast`）。

### 9. 测试与验收

- 单测：`tests/copy.test.ts`（纯函数四格式 + 边界：非标识符键/数组下标/根/容器原值/超限）；`tests/doc-service.test.ts` 加 `copyNode` 命令用例（四格式、未知路径、超限、不推进版本——复制是**只读**操作，不改 `docRevision`/`rowVersion`）。
- 冒烟：`scripts/smoke-copy.mjs`（CfT headless，HTTP + `window.__tjv`）：菜单项顺序与禁用态、四格式逐字文本（含 `$['a.b']` 类键与数组下标）、剪贴板读回、容器原值/根键名禁用、超大子树 `TOO_LARGE` toast、复制不改变文档版本、0 console 错误。
- dev hook（仅 HTTP 模式，沿用既有 `__tjv`）：`ctxOpen(path)`（模拟右键 → 返回菜单项文案/禁用态）、`ctxClick(act)`、`copyResolve(path, format)`（走 core，不写剪贴板，返回文本）、`clipboardText()`（读回剪贴板，失败返回 `null`）、`toastText()`。

## 影响

- `protocol` 17 → 18 条命令；`CoreApi` 加 `copyNode`；`page.html` 菜单 1 → 5 项 + 分隔线；`main.ts` 加剪贴板写入、菜单禁用态与键盘导航。`page.js` 体积增量预期 <1KB gz。
- 复制是只读操作：**不推进 `docRevision` / `rowVersion`**，不触发搜索 stale、不清空命中、不改行模型。
- 剩余缺口（不在本 ADR）：`clipboardWrite` 之外的读取权限不涉及；「默认复制格式」设置项待设置面板；选中节点面板的复制按钮待该面板实现。

## 已知差距 / 后续

- 「缩进/压缩跟随当前设置」待设置面板（`ViewStateStore` 未接线）——当前固定 2 空格。
- 子树 JSON >5MB 只能走导出；若未来要支持「复制整份 10MB 文档」，需把上限与 `EDIT_MAX_BYTES` 拆开并实测 postMessage/剪贴板成本。
- 菜单无复制快捷键；若用户要求，按「行选中 + ⌘C = 复制子树 JSON」另议（与「原生复制文本」冲突，需拍板）。

## 修订（2026-11-03）：行尾操作浮条接线

> 依据：用户当轮拍板（复制 = 子树 JSON 快路径、编辑 = 开弹层）；原型 A 本来就是两个 `<button tabindex="-1" aria-label>`（`prototype/visual/a/app.js` 的 `ACTIONS`）。

### 背景

slice 3 骨架在每行末尾渲染了 ⧉/✎ 两个 `<span class="row__action">`（容器 `aria-hidden="true"`、无事件），`TreeView` 的 click 处理遇到 `.row__actions` 直接 `return`（注释「行操作由 app 层接管」），但 app 层从未接线。结果：hover/选中时浮条出现、`cursor: pointer` 却点了没反应——**dead UI**，且对 AT 不可见。

### 决策

1. **入口从 1 个变 2 个**（修订上文 §1「v1 唯一入口 = 右键菜单」）：**右键菜单**（全 4 格式 + 编辑，键盘可达）+ **行尾浮条**（鼠标快路径，2 个按钮）。
2. **浮条「复制」= 直接复制子树 JSON**（2 空格，复用 `copyNode` 的 `format: 'subtree'`）+ toast「已复制：子树 JSON」，**不弹菜单**。理由：原型 `aria-label` 就是「复制子树 JSON」；快路径应一步完成；格式选择仍在右键菜单。「默认复制格式」设置项落地后浮条跟随该设置（当前固定 subtree）。
3. **浮条「编辑」= 与双击/F2 完全同一 `openEditor` 流程**（`getNodeJson` → CM6 弹层），不新增编辑路径。
4. **鼠标专用，不污染行虚拟化的 Tab 序列**：真实 `<button type="button" tabindex="-1" aria-label="复制子树 JSON|编辑此节点 JSON">`；键盘用户走 F2（编辑）与右键菜单。去掉容器的 `aria-hidden`，改为按钮自带 `aria-label`（此前 `aria-hidden` 让浮条对 AT 完全不可见）。
5. **选中联动**：点浮条按钮先选中该行（与右键菜单一致），再执行动作；不改变行点击/双击语义。
6. **不新增 protocol/core 改动**：浮条复用既有 `copyNode` 与 `openEditor`；`setShowActions` 仍恒开（未接设置面板，记入已知差距）。

### 影响与验收

- `view/tree/row-renderer.ts`：`createAction` 由 `<span>` 改 `<button>`（保留 `data-action`、加 `aria-label`）；容器去掉 `aria-hidden`。
- `view/tree/tree-view.ts`：`TreeViewOptions` 新增 `onRowAction?(path, action: 'copy' | 'edit')`；click 委托命中 `.row__action` 时先 `onSelect` 再回调，不再直接丢弃。
- `app/main.ts`：接线 → copy 走 `copyNodeFromMenu(path, 'subtree')`（同一剪贴板/错误处理），edit 走 `openEditor(path)`。
- 冒烟：`scripts/smoke-copy.mjs` 追加「行尾浮条」段（2 个 `<button>` + `aria-label` + `tabindex="-1"`、hover 显示、点复制 → 剪贴板 = 该行子树 JSON + toast、点编辑 → 弹层打开、容器行与标量行均验）。

## 修订（2026-11-09）：右键菜单新增「展开 / 收起整棵子树」（#22）

> 文案再修订（2026-11-09 用户复核）：两项原名「展开/收起所有子孙节点」，但实现语义是**含该节点自身**的
> 深度复位（收起后本节点折叠、下次展开只剩一层）。用户指出「所有子孙节点」字面不含自身 → 改名
> 「展开整棵子树 / 收起整棵子树」（子树以该节点为根，含自身；行为与启用态**不变**）。

> 决策来源：`grilling` 2026-11-09（Q1–Q16）；core 语义与预算口径见 ADR-0002 修订（2026-11-09 子树批量展开/收起）。
> 本修订只改**菜单契约**（项数 / 顺序 / 启用态 / 键盘 / 反馈），**不掺视觉改动**（菜单观感并入 #21 统一走查）。

### 菜单契约（5 → 7 项）

固定顺序变为：**复制子树 JSON / 复制路径 / 复制原始值 / 复制键名 / ── 分隔 ── / 展开整棵子树 /
收起整棵子树 / ── 分隔 ── / 编辑此节点 JSON**。

- 两项**固定存在**（不按状态翻转文案）：避免「子节点是否已全展开」的探活与中间态歧义；
  `title` 说明作用域「含该节点自身；不含更上层」。
- 不新增键盘快捷键（`Enter` 仍 = 切该行展开/折叠；递归能力只走菜单，`#22` 明确「只做右键菜单」）；
  菜单内键盘契约不变（`↑↓` 只走可用项、`Home`/`End`、`Enter` 原生、`Esc`；打开时焦点落第一个可用项）。

### 启用规则（UI 禁用 + `title` 说明；core 侧兜底校验，契约不依赖 UI 状态）

| 菜单项 | 可用性 | 说明 |
|---|---|---|
| 展开整棵子树 | **容器且 `count > 0` 且非根** | 根禁用（请用工具栏「全部展开」）；标量禁用（无子孙）；空容器禁用（没有子节点） |
| 收起整棵子树 | 同上 | 同上；收起 = 深度复位（本节点也折叠，ADR-0002 修订 §3） |

### 反馈

- 有变化：行模型按新 `rowVersion` 重取窗口，**保持锚点与选中、不滚回顶部**（与 `expandAll` 的「回顶」不同）；
- no-op：info toast「整棵子树已经全部展开了 / 已经全部收起了」；
- 超预算：`TOO_MANY_ROWS` 走既有 error toast（零部分修改）。

### 接线与验收

- `protocol`：命令 +1（`toggleSubtree`）；`CoreApi` +1；`page.html` 菜单 5 → 7 项 + 第二条分隔线；
  `main.ts` 菜单回调载荷补 `open`/`count`/`hasChildren`（原只有 `kind`），并按上表判定禁用态；
  dev hook `ctxOpen` 通过 `TreeView.rowInfo(path)` 取同一份行数据（菜单与 hook 不各算一套）。
- 单测：`row-model.test.ts`（展开整子树 / 深度复位 / 空容器不参与 / 已全开·已全收 no-op / 预算原子拒绝 /
  根 no-op / 标量 `BAD_COMMAND` / 子树外状态不受影响）；`doc-service.test.ts`（changed 才推 `rowVersion`）。
- 冒烟：`smoke-copy.mjs` 菜单顺序/禁用态断言 5 → 7 项；`smoke-expand.mjs` 新增菜单驱动段
  （右键容器 → 展开整棵子树 → 行数/版本/选中、再收起 → 行数回退且下次展开只剩一层、标量/根/空容器禁用、
  已全展开 no-op toast、50MB 级子树 `TOO_MANY_ROWS` 零部分修改）。
