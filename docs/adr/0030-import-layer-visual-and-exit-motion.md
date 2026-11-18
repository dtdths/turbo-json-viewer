# ADR-0030：导入层视觉收口（落点分段控件 / 对话框结构 / 关闭动效）

- 状态：**Implemented**（2026-11-18；用户反馈收口）
- 日期：2026-11-18
- 依据：ADR-0016（§2.6 空态视觉、§2.8 分段控件与工具栏同源）、ADR-0028（导入落点与精简确认层）、ADR-0029（弹层入场动效）、#47（需求批次）、#52（动效实现票）
- 相关票：#47、#51（ADR-0028 的实现票）、#52、#54（本 ADR 的实现票）

## 背景

2026-11-18 用户看到 #51 / #52 的实现截图后提了三条：

1. **完整导入层 / 精简确认层「UI 难看」**：卡片沿用空态卡（26/30 内边距、22px 标题、控件浮在正文里），没有编辑弹层那套「卡头 + 发丝线 + 卡身」的对话框语言。
2. **「说好的弹层打开/关闭动效」只有开**：ADR-0029 当时判定「不出场，关闭仍 `hidden` 瞬切，且没有用户诉求」——现在有了。
3. **完整层的落点切换和设置面板不统一**：设置面板「导入位置」是分段控件（`.settings-panel__seg`，与工具栏 `.segmented` 同一份 token），导入层却是两个居中夹在左对齐标题与 dropzone 之间的原生 radio，轴线混乱、观感两套。

具体到确认层（精简确认层），原来的灰盒把「待导入：名称（大小）」和两个按钮塞在一起、按钮居中，且**破坏性的「替换当前文档」是 accent 实心主按钮**，与 ADR-0028「焦点优先非破坏性动作」自相矛盾。

## 决策

### 1. 落点控件 = 全局 `.segmented`（radio 只做语义层）

- 视觉：`导入位置` 标签 + `.segmented` 分段控件 + 右侧微字「只对本次导入生效」（新增词条 `app.empty.target.hint`）；几何 / 颜色 / hover / active 全部来自 `.segmented__btn`（24px 高、`--bg-selected` + `--accent`、容器 `--bg-panel-2` + `--radius-sm`）；字号按设置面板的 12px 档（`.segmented__btn` 默认 13px），选中 / 焦点 / 禁用三态由 `:has()` 从原生 radio 映射——与设置面板**同源**，但不是逐像素同一份规则。
- 语义：每个分段是 `<label class="segmented__btn">` 包一个**原生 `<input type="radio">`**，radio 视觉隐藏（1px + clip），`name="emptyTargetMode"` / `id` / `value` / `checked` / `disabled` / `change` 契约**一个不变**——键盘方向键、读屏、`scripts/smoke-*.mjs` 里的 `.click()` / `.checked` 全部照旧。分段容器带 `role="radiogroup"` + `aria-labelledby` 指向可见标签。
- 切换 active 用 `:has(input:checked)`，焦点环用 `:has(input:focus-visible)` + `--focus-ring`（与 `.segmented__btn` 的全局焦点环同口径，不另造 `outline: 2px` 特例），禁用态用 `:has(input:disabled)`（Chromium 120 基线支持）。
- 「改动只对本次生效」的产品语义（ADR-0028 §1）不变，只是把这句话放到了控件旁边。

### 2. 卡片 = 对话框两段式（卡头 / 卡身）

- 完整层与精简确认层共用 `data-mode` 卡片形态：`.empty__head`（标题 `--text-title` 17px/600 + 副标题 `--text-small` + 底部 `--border-subtle` 发丝线；关闭按钮绝对定位在卡头右上）+ `.empty__body`（`display:flex; flex-direction:column; gap:14px; padding:16px 20px 18px`）。
- 卡片宽度收到 560px（对齐编辑弹层的对话框观感；初始空态仍是 620px 的居中英雄区），`.empty__inner` 内边距归零，由卡头 / 卡身分担。
- 标题从 `--text-display-sm`(22px) 降到 `--text-title`(17px)：22px 是空态主标题的档位，弹层标题用 17px 才和 `.modal__title` 同档次。
- `gap` 承担块间距（隐藏块不占位），不再用各块 `margin-bottom` 叠罗汉；落点切换时覆盖警示只淡入一次（`tjv-fade-in` + `--dur-fast`）。

### 3. 精简确认层 = 文件行 + 右对齐动作

- `空头`只留标题（无副标题、无 dropzone / 落点控件 / 覆盖警示，ADR-0028 §2 不变）。
- 文件行：文档图标 + 「待导入」+ **等宽文件名**（过长省略，`title` 存全名）+ 右缘大小（`--text-micro`、tabular-nums）。词条 `app.empty.pending.import` 从行内拼接的 `Import: `（中文「待导入：」）改为纯标签 `Import` / `待导入`——名称不再是同一段文本的续写，而是独立的 flex 子项。
- 动作右对齐：`替换当前文档`（次按钮）→ `在新标签打开`（accent 主按钮）。主按钮 = 非破坏性动作 = ADR-0028 的默认焦点，三者终于一致。

### 4. 出场动效：`.is-leaving` + 逻辑先关

- CSS：`.empty.is-leaving` 淡出 `--dur-fast`(110ms)，`.empty.is-leaving .empty__inner` 下沉 3px + `scale(.985)`（`translate` / `scale` 长属性，与左面板居中用的 `transform: translateX(...)` 叠加不覆盖）。出场选择器并入文件末尾那**一个** `@media (prefers-reduced-motion: reduce)` 块（ADR-0029 §3）。
- JS（`app/main.ts`）：`hideEmptyLayer()` 先主动 blur 层内焦点（reduce 分支也还焦点），再挂 `.is-leaving` + `aria-hidden="true"` + `inert` + `pointer-events:none`（CSS）——`inert` 让淡出的 110ms 里 Tab 不会走进 `aria-hidden` 的子树；**同一帧**把层按「已关闭」处理：`importLayerOpen()` 返回 false，⌘V / Esc / 拖放 / 边界判断看到的都是关闭后的世界。
- 110ms 后 `settleEmptyHidden()`：落 `is-hidden` + 摘 `inert` / `aria-hidden` + `resetImportLayerView()`。`animationend` 优先收尾（只认 `#empty` 自身且 `animationName === 'tjv-fade-out'`，入场的 `animationend` 不能误收），计时器兜底（后台标签页节流 / `animation: none`）。
- **重开优先**：`showEmptyLayer()` 先 `cancelEmptyExit()` 再显示；动画名从 `tjv-fade-out` 切回 `tjv-fade-in`，入场从头重播，不会出现「退场计时器把新层藏掉」。
- `prefers-reduced-motion: reduce`：JS 侧直接 `settleEmptyHidden()`（不等 110ms），CSS 侧同一 `@media` 块把出场 keyframes 置 `none`。

### 5. 层内 dropzone 收紧

层内 `min-height` 150 → 128px、底色 `--bg-panel-2`、圆角 `lg` → `md`，只在 `[data-mode=replace|new-tab]` 下生效；**初始空态仍是 200px / `--bg-panel` / `radius-lg` / 28px 图标 / 13px 提示**，视觉惯性不变。拖放区仍是「整块可点 = 选择文件」，键盘入口仍是内层 `#pickBtn`。

## 被否决的替代

| 方案 | 否决理由 |
| --- | --- |
| 新造一个 switch / 第二套分段控件 | 用户诉求就是「和设置面板统一」；`.segmented` 已是工具栏 + 设置面板的单一来源 |
| 换成 `<button role="radio">` 实现分段 | 丢掉原生 radio 的方向键语义，且既有冒烟 / Hook 依赖 `targetReplace.click()` / `.checked` |
| 保留原生 radio，只调间距/对齐 | 观感仍与设置面板两套；居中还是左对齐都得再发明一条轴线 |
| 关闭时等动画播完再复位状态 | 键盘 / 拖放 / ⌘V 会看到「半关的层」：`importLayerOpen()` 还 true，导入语义被拖进动画时序 |
| 动画 `height` / 整卡收合 | 触发 layout，且与虚拟滚动的几何断言相冲；只动 `opacity` / `translate` / `scale` |
| 确认层继续让「替换当前文档」当主按钮 | 破坏性动作不该是 accent 实心；与默认焦点（非破坏性）也矛盾 |

## 后果

- **ADR-0029 的「不出场」被本 ADR 修订**：入口层 / 精简确认层现在有 110ms 出场；右键菜单 / 导出菜单 / 子树编辑弹层 / toast 仍是只入场（它们的关闭时序与焦点归还另有耦合，不在本次范围）。
- **ADR-0028 的「两个 radio」保留为语义层**，视觉层改为分段控件；默认值 / 本次生效 / 满 8 自动降级 / 焦点顺序等决策全部不变。ADR-0028 §2 里「待导入：名称（大小）」的行内文案与按钮序属于展示层，由本 ADR 修订（文件名 / 大小分列，动作右对齐且主按钮为非破坏性动作）。
- 新增冒烟约束（`smoke-workspace` 的 `close:layer-motion`）：`.is-leaving` 期间 `pointer-events:none`、遮罩 `tjv-fade-out` + 卡片 `tjv-sink-out`，收尾后 `is-hidden`、`mode=initial`、`aria-hidden` 已摘除。
- 关闭动效带来 ~110ms 的**视觉**延迟，但状态 / 快捷键 / 导入落点判定立即生效，既有测试的等待口径不变（`waitUntil(!visible)` 仍然在 110ms 后成立）。

## 实现结果（2026-11-18，本机实测）

- 冒烟：`smoke-workspace` **61 → 62/62**（新增 `close:layer-motion`；`entry:layer-motion` / `entry:reduced-motion` 保持绿）；`smoke-extension-search` 63/63、`smoke-settings` 26/26、`smoke-i18n` 22/22、`smoke-order` 33/33 全绿。
- 单测：`npm run check` **1385 / 60 文件全绿**（无新增单测；新增词条 `app.empty.target.hint` 中英各一条，由 `tests/unit/i18n/messages.test.ts` 遍历守护；`page.html` 默认英文文案与 en 词条逐字一致由既有守护测试校验）。
- 体积（以 HEAD=#52/#53 落地后的构建为基线实测）：`page.css` **8.9 → 9.2KB gz**（+0.3：卡片两段式 + 分段控件的 radio 变体 + 出场 keyframes）；`page.js` **53.6 → 53.8KB gz**（+0.2：`.is-leaving` 状态机），总预算 54 内。`worker.js` 65.9 / 语言包 6.4·7.2 / 懒加载 145.9 均不变。
- 视觉：深 / 亮两套各自截图核对完整层（新标签 / 替换）、精简确认层、初始空态与「左面板打开时按可见区居中」（ADR-0016 §2.6，转入 `.empty__head` / `.empty__body` 后不回归）。
