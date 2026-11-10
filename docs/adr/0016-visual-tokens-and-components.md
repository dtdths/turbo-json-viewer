# ADR-0016：视觉口径与组件统一（#21 视觉走查）

- 状态：**Accepted**（2026-11-10）
- 票：**#21**（视觉调整清单，功能收尾后统一做）
- 前情：ADR-0015 只收口菜单**交互**，视觉观感明确留给 #21；`direction.md` §3/§4/§6 的部分规格（尺寸变量、字号表、菜单规格）与实现漂移。本 ADR 把「token / 字号 / 对比度 / 组件观感」收口成一份可验收契约。
- 影响面：`src/view/styles/tokens.css`、`src/app/styles/shell.css`、`src/view/**/*.css`、`src/app/page.html`、`docs/design/direction.md`、`docs/design/tokens.css`、`tests/unit/design/visual-contract.test.ts`（新建）、`scripts/smoke-expand.mjs`、README §11。
- 范围排除（本轮**不做**）：响应式断点（≤1320 → 面板 300 / 右栏 284 / 树 980，属布局行为，另开票）；右工作区真实内容（JSON 地图 / 文档概要 = v1.1）；最近文档列表（#11 功能）；`.ndjson` 的 `accept` 与严格 JSON 解析不一致（只记 README 已知差距）。

## 1. 背景与问题

审计（2026-11-10，深/亮两套实拍 + DOM 度量）发现 8 类问题：

1. **空态不随左面板居中**：1440 宽下卡片中心 x=744；左面板打开后可见区中心 x=904，偏左 160px。
2. **两套菜单观感不一致**：右键菜单无勾选列、导出菜单有 12px 勾选列；导出菜单 `min-width` 声明 208 被后面的 `.ctxmenu{176}` 覆盖成 176；行高 29.4px；菜单项焦点用全局 4px 环，偏重。
3. **三条提示条动作位不统一**：修复条「摘要」x=391（紧跟文案），保真条「查看原文」x=1348（右对齐）；修复条与 `.noticebar` 是两份几乎相同的 CSS。
4. **token 与实现脱节**：25 个 token 在 `src` 零引用（含 `--sp-1..10` 整组）；`--warn-soft`/`--danger-soft` 被引用但未定义；`direction.md` 声称的 `--activity-w`/`--left-panel-w`/`--rail-w`/`--tree-max` 不存在；17 处字号是 9/10.5/11.5px 编外值。
5. **同类控件两套实现**：分段控件（工具栏 `.segmented` vs 设置 `.settings-panel__seg`）、焦点环三种写法。
6. **亮色主题暗点**：菜单分隔线 `#edeff5` on `#fff` ≈1.1:1；警告/错误框用暗色 fallback；替换层/编辑弹层 backdrop 硬编码。
7. **尺寸口径散落**：`44px` 在 CSS/TS/冒烟三处；`--type-col-w` 零引用而 CSS 硬编码 72/88；活动栏/面板/右栏/树宽硬编码。
8. **对比度不足**：`--faint`/`--muted` 承担大量小字，实测 10 处低于 4.5:1（暗色 8、亮色 2），最差 3.61:1（暗色搜索结果 meta/类型标）；正文与次要文字层级靠低对比度区分，长会话易疲劳。
9. **展开时 2px 跳动**：`.tjv-tree.is-stale::before`（以及 `.tjv-raw` 同款）是 `position: sticky` 的 2px 块，**占流内高度**；窗口回包在途时 stale 帧被绘制，整树内容下移 2px，随后浏览器滚动锚定把 scrollTop 回补 2px。CPU 8× 节流下可稳定复现（`maxJump=2px`），与用户「点击展开轻微跳动」一致。

## 2. 决策

### 2.1 token 纪律（单一来源）

- **尺寸 token 补齐并真正引用**：`--activity-w: 48px`、`--left-panel-w: 320px`、`--rail-w: 300px`、`--tree-max: 1280px`、`--menu-item-h: 32px`、`--result-row-h: 44px`、`--backdrop`（深/亮各一套）。
- **删除死 token**：`--banner-h`、`--map-w`、`--radius-xl`、`--ease-in-out`、`--dur-slow`、`--shadow-accent`、`--overlay`、`--bg-pressed`、`--leading-tight/ui/code`。`--sp-*` 保留为间距系统并在本轮改动的规则里实际使用。
- **不再新增 `-soft` 语义 token**：警告/错误底一律复用已定义的 `--warn-bg` / `--danger-bg`（此前引用未定义的 `--warn-soft` / `--danger-soft`）。
- **`--type-col-w: 88px` 定义为右侧保留带**：`.row { padding-right: var(--type-col-w) }`、`.row__type { width: calc(var(--type-col-w) - 16px); right: 16px }`。
- **契约测试**（`tests/unit/design/visual-contract.test.ts`）静态校验：CSS 里引用的每个 `var(--x)` 必须在 tokens.css 定义；不得出现 raw `font-size: Npx` / `font: Npx` 简写；UI 文本 token 在 5 个 surface 上的对比度 ≥4.5:1（深/亮）；语法色在 `--bg-app` 上 ≥4.5:1；新尺寸 token 必须被引用。

### 2.2 字号表（+1 档，用户 2026-11-10 拍板）

| token | 旧值 | 新值 | 用途 |
|---|---|---|---|
| `--text-micro` | 10 | **11** | 微文本：类型标、kbd、foot、单位 |
| `--text-caption` | 11 | **12** | 状态栏、面板标题、meta、提示条 |
| `--text-small` | 12 | **13** | 次级 UI：菜单项、过滤按钮、说明 |
| `--text-body` | 13 | **14** | 默认 UI：工具栏、空态副标题、标签 |
| `--text-mono` | 12.5 | **13.5** | 树 / 原文 / 路径（等宽） |
| `--text-title` | 16 | **17** | 面板/弹层标题 |
| `--text-display-sm` | — | **22** | 替换层标题（原 20px 编外值） |
| `--text-display` | 22 | **24** | 空态主标题 |

- 编外值收编：9/10/10.5 → `--text-micro`(11)；11/11.5 → `--text-caption`(12)；12 → `--text-small`(13)；13 → `--text-body`(14)；12.5 → `--text-mono`(13.5)；20 → `--text-display-sm`(22)。
- **树行高保持 24px**（不随字号涨）：信息密度不变，50MB 场景不牺牲行数；`--row-h` 设置 20–26 的语义不变。搜索结果行高保持 44px。
- `font:` 简写里的字号改为 `font-family` + `font-size: var(--text-*)` + `line-height`。

### 2.3 对比度（温和提升，用户 2026-11-10 拍板）

只改承担小字的弱中性色与语法色，不动强调色纪律（`--accent` 仍只标焦点/选中/动作）：

| token | 暗色 | 亮色 |
|---|---|---|
| `--muted` | `#8b93a7` → **`#9aa3b8`** | `#626c84` → **`#4f5870`** |
| `--faint` | `#737c8e` → **`#8a93a6`** | `#667086` → **`#4e5769`** |
| `--syntax-key` | 不变 | `#4b5a7a` → **`#3d4a66`** |
| `--syntax-punct` | `#737c8e` → **`#8a93a6`** | `#667086` → **`#4e5769`** |
| `--syntax-index` | `#6f7a90` → **`#8790a3`** | `#8b93a5` → **`#5f687d`** |
| `--syntax-null` | `#7b8496` → **`#949cab`** | `#667086` → **`#4e5769`** |
| `--syntax-string` | 不变 | `#0c7b5a` → **`#0a6b4e`** |
| `--syntax-number` | 不变 | `#96610f` → **`#7d4f0b`** |
| `--syntax-boolean` | 不变 | `#6d4bd6` → **`#5a3ac6`** |

- 实测：所有正文最低 **4.91:1**（暗色）/ **4.97:1**（亮色）；最差样本从 3.61 → 4.91。活动栏图标 4.36 属 UI 元素（≥3:1）合格。
- 亮色分隔线/菜单分隔线改用 `--border`（不再用几乎不可见的 `--border-subtle`）；`--border-subtle` 仍用于树/面板内部分隔。

### 2.4 菜单观感（跨两套菜单一份规格）

- 两个菜单同 `padding: var(--sp-2)`(4px)、同行高 `var(--menu-item-h)`(32px)、同左右内边距 10px、同 `min-width: 176px`（删除失效的 208）。
- **16px 前导列**：两套菜单都保留 `16px` 前导列（`.ctxmenu__lead`）；右键菜单为空列，导出菜单放 ✓。文字起点统一（10+16+6=32px）。
- 分隔线：`height:1px; margin: var(--sp-2) var(--sp-4); background: var(--border)`。
- 菜单项键盘焦点：`background: var(--bg-selected)` + `inset 0 0 0 1px var(--accent-border)`，不用全局 4px 环；禁用态 `--faint` 不降透明度。
- ADR-0015 的交互契约（键盘/定位/失焦/单活）**不变**；`shared/menu.ts` 几何零改动。

### 2.5 提示条（三条一份基类）

- 修复条改为 `class="noticebar repairbar"`，与体积/保真条共用 `.noticebar` 基类：32px、`--text-caption`、gap 8、左右 padding 12/10、图标 `--warn`、文案 `--text-2`、关闭 `--muted`。
- **动作按钮统一靠右**：DOM 顺序 = 图标 / 文案 / spacer / 动作 / 关闭；修复条「摘要」从紧跟文案改为最右（与原型 C 的「查看摘要 >」一致）。
- `.repairbar__op` / `.repairbar__at` 保留（冒烟按这些类查询），只做尺寸/字号收编；修复条展开列表仍绝对定位盖树。

### 2.6 空态（居中 + 轻构图）

- 左面板打开时，空态卡在**可见区**居中：`body[data-panel=…] .empty { right: var(--left-panel-w) }`（遮罩仍铺满，面板本身 z-index 更高，不露底）；替换层同样处理。
- 构图补强（**纯视觉，不新增功能**）：dropzone 内加文档图标（inline SVG，`--faint`），标题字号用 `--text-display`，拖放区高度 180 → 200，提示行沿用既有真实文案。
- **不加**最近文档列表（#11）；**不写**「最大 200 MB」（程序无此上限，只有 50MB 提示）；`.ndjson` 只记已知差距。

### 2.7 展开 2px 跳动修复

- `.tjv-tree.is-stale::before` 与 `.tjv-raw.is-stale::before` 保留 `position: sticky; top: 0` 的可见性，但加 **`margin-bottom: -2px`** 抵消流内高度：stale 帧绘制时内容不再位移，滚动锚定也不会回补。
- 回归锚点：`smoke-expand` 新增断言——强制 `.is-stale` 后 `.tjv-tree__spacer` 相对滚动容器的 top 位移 = 0 且 `scrollHeight` 不变（现状 2px → 红）。

### 2.8 共享组件收口

- 分段控件：设置面板复用工具栏 `.segmented` 的视觉规则（CSS 分组，DOM/TS 类名不变，冒烟选择器不破）。
- 焦点环：默认外层环 `--focus-ring`；滚动容器用 inset 环（`--focus-ring-inset`）；删除 `outline: 2px` 的两处特例（`.repairbar__at`、`.segmented__btn`）。
- 滚动容器：`scrollbar-width: thin` + `scrollbar-color` 覆盖全部滚动区（设置面板/右栏此前缺 color）。

### 2.9 被否决

- 字号 +2 档（行高需 26、密度下降，用户选 +1）。
- 对比度「强提升」（次要文字接近正文，层级糊；实测温和档已全部 ≥4.5:1）。
- 响应式断点并入本轮（属布局行为，且会动冒烟 320px 断言）。
- 给右键菜单加图标（无图标库、会扩大范围；先留空前导列）。
- 用 `outline` 替代 stale 伪元素（会画出整圈边框，视觉语义不同；负 margin 更小）。

## 3. 验收

- `npm run check`（tsc + vitest + build）；
- **13 套冒烟串行**（CDP 9883；不能并发），报告真实计数；`smoke-expand` 新增 stale 不位移断言；
- `node build.mjs --analyze` 体积（预算 `page.js` 45KB gz 未动）；
- 深/亮两套截图对照（空态/主视图/菜单/提示条/搜索/设置/亮色）；
- README §11 新增 6.15 行 + 数字同步；`direction.md` §3/§4/§6 与 `docs/design/tokens.css` 同步；
- 不推送（push 前问用户）。

**验收结果（2026-11-10，用户拍板）**：用户查看按最终代码重新生成的深/亮两套截图（`.spike/audit/` 19 张）后**验收通过**，**#21 关闭**。
关票前复测：`npm run check` 29 文件 / **722 单测全绿**；**13 套冒烟串行全绿**（search 94 / extension-search 56 / expand 21 / edit 14 / copy 38 / repair 14 / settings 21 / export 21 / raw 26 / outline 53 / fidelity 24；`smoke` 与 `smoke:ext` 打 OK）；体积 `page.js` 33.7 / `worker.js` 15.3 / `page.css` 7.2 KB gz。
后续零散观感意见**另开票**（#21 作废）；本轮明确排除的响应式断点另开票跟进。
