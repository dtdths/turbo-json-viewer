# ADR-0029：弹层入场动效（只入场、只动 opacity/transform、菜单定位后才播）

- 状态：**Implemented**（2026-11-18；实现票 #52）
- 日期：2026-11-18
- 依据：ADR-0016（视觉 token / 组件规格；`--ease-out` / `--dur` / `--dur-fast` 单一来源）、#47（需求批次拍板）
- 相关票：#47（批次）、#52（本 ADR 的实现票）、#48（面板开合动效，独立票，未做）

## 背景

1. 五类弹层（入口层 / 精简确认层、右键菜单、导出菜单、子树编辑弹层、toast）都是 `hidden` / `display:none` 瞬切，**出现得生硬**；用户 2026-11-18 在 #47 里要求统一做**入场**动效。
2. 仓库已有三处 `prefers-reduced-motion: reduce` 先例（`outline-panel.css` 的 caret、`raw-view.css` 的闪改、`tree.css` 的行浮条），token 里也有 `--ease-out` / `--dur` / `--dur-fast`——**不新造设计系统**。
3. 风险点有两个：其一，动效一旦碰 `width` / `height` / `top` / `left` 就会触发 layout，可能让既有冒烟的几何断言抖动；其二，右键/导出菜单的定位走 `getBoundingClientRect()` 量菜单尺寸，**`scale(.98)` 会改变量到的尺寸**，在动画期间测量会让菜单位置/`max-height` 偏移。

## 决策

### 1. 只做入场、只动 `opacity` 与 `transform`

| 弹层 | 动效 | 时长 / 曲线 |
| --- | --- | --- |
| 入口层 / 精简确认层（`#empty` + `.empty__inner`） | 遮罩淡入；卡片淡入 + 上浮 4px | `--dur`(160ms) + `--ease-out` |
| 右键菜单 / 导出菜单（`.ctxmenu`） | 淡入 + `scale(.98)` → `1`；`transform-origin` **朝锚点** | `--dur-fast`(110ms) + `--ease-out` |
| 子树编辑弹层（`.modal__backdrop` / `.modal__panel`） | 遮罩淡入；面板淡入 + 上浮 4px（同卡片） | `--dur` + `--ease-out` |
| toast（`.toast`） | 上滑 6px + 淡入 | `--dur` + `--ease-out` |

- **不出场**：关闭仍是原来的 `hidden` 瞬切。淡出会把「键盘/焦点归还 / 外部点击关闭」的时序拉长，且没有用户诉求。
- 卡片与面板的「上浮」用 **`translate` 长属性**（不是 `transform`）：`.empty__inner` 在左面板打开时带 `transform: translateX(calc(var(--left-panel-w)/2))`（ADR-0016 §2.6），长属性与 `transform` 叠加，不会把它覆盖掉。
- toast 基态是 `transform: translateX(-50%)`（水平居中），关键帧里显式带上 `translateX(-50%)`，避免入场把居中顶掉。

### 2. 菜单：定位之后才挂 `.is-entering`

`view/menu.ts` 的 `open()` 顺序是：`hidden = false` → `place()`（量尺寸 + 算坐标，**没有 transform**）→ 挂 `.is-entering` → 聚焦首项。动画只在类从无到有时启动；关闭时摘类，动画播完由 `animationend` 摘类。`transform-origin` 由 `shared/menu.menuTransformOrigin(anchor, placement, size)` 纯函数算：锚点在菜单盒内的位置（clamp 进矩形），翻转/贴边都自动成立。

### 3. `prefers-reduced-motion: reduce` 全部 0ms

在 `shell.css` 末尾一个 `@media` 块里对上述选择器统一 `animation: none`（与三个既有先例同口径）。不开新设置项、不做「动效强度」档位。

## 被否决的替代

| 方案 | 否决理由 |
| --- | --- |
| 用 `@starting-style` + `transition` 做入场 | 首次样式/布局时 `transform` 已经在跑，`getBoundingClientRect()` 会量到缩放后的尺寸，菜单定位与 `max-height` 都会被污染；`hidden` 属性切换的 `display:none → block` 在各浏览器上的起始帧行为也不一致 |
| 用 CSS transition 在 `.ctxmenu` 上做完善 | 同上（过渡从旧值到新值，首次显示没有旧值） |
| 动画 `.empty` 的 `background` / `backdrop-filter` | 不是 `opacity`/`transform`，会触发重绘甚至 layout；遮罩淡入直接给整层做 `opacity` 动画即可（卡片在自己的动画里再淡入上浮） |
| 做出场动效 / 面板开合（#48） | 关闭时序涉及焦点归还、外部点击；用户明确 #48「后续再考虑」 |

## 后果

- 五类弹层出现有统一的「淡入 + 轻微位移/缩放」节奏；关闭仍是瞬切，语义与既有测试不变。
- 新增两条静态约束（由冒烟守住）：动效只能来自一套 keyframes（`tjv-fade-in` / `tjv-rise-in` / `tjv-menu-in` / `tjv-toast-in`）；菜单的动画类必须在定位之后挂。
- 已知代价：入口层做整层 `opacity` 动画，`backdrop-filter` 的模糊也随透明度一起淡入（不是独立动画）；这是有意取舍，避免为遮罩再造一层 DOM。

## 实现结果（2026-11-18，本机实测）

- 单测 **1319 → 1327**（+8：`menuTransformOrigin` 锚点/翻转/贴边/右对齐/左对齐/NaN 尺寸）。
- 冒烟：`smoke-workspace` **59 → 61/61**（`entry:layer-motion` 断言遮罩 `tjv-fade-in` / 卡片 `tjv-rise-in` 且时长 0.16s；`entry:reduced-motion` 经 CDP `Emulation.setEmulatedMedia` 断言 reduce 下 `animation: none`）；`smoke-export` **34 → 35**（`menu:enter-motion`：`.is-entering` 在定位后出现、`tjv-menu-in` 0.11s、origin 朝锚点）；`smoke-edit` **17 → 18**（`editor:enter-motion`：遮罩淡入 + 面板上浮）；`smoke-copy` **44 → 45**（`toast:enter-motion`）。
- 体积：`page.css` 8.6 → **8.8KB gz**（无硬预算，按惯例记录）、`page.js` 52.1 → **52.3KB gz**（预算 54；`shared/menu` 纯函数 + `view/menu` 摘类逻辑），`worker.js` 65.6 / 语言包 6.3·7.1 / 懒加载 145.7 不变。
- 回归：全量 17 套冒烟串行全绿（`smoke-export` 的 `menu:select-restores-focus` 在本机为既有偶发，stash 基线同样复现，与本片无关）。
