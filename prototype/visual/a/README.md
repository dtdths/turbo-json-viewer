# 方向 A · Graphite / Indigo — Turbo JSON Viewer 视觉原型

> 静态高保真视觉原型，供人工评审。纯 HTML / CSS / JS，零依赖、零网络请求、系统字体、内联 SVG。
> 只做视觉，不含产品逻辑（不解析 JSON、不虚拟化、不接 Worker）。

---

## 1. 设计意图

**一句话**：把「本地、只读、极速」变成看得见的安静感——近黑石墨底色托住内容，冷灰层级划分结构，单一靛蓝只回答一个问题：*现在焦点在哪里*。

参考气质：Linear 的克制层级、Raycast 的紧凑密度、VS Code 的代码可读性；刻意避开「仪表盘模板感」：

- **少用大色块**。界面 95% 是石墨中性色，只有 JSON 语法与当前选中/命中出现颜色。
- **少用阴影，多用边框**。结构靠 1px 发丝线；只有真正浮起的层（JSON 地图、编辑弹层、补全）用 shadow。
- **不做全屏卡片化**。工具栏 / 树 / 状态栏是连续的工作台，不是多个 dashboard 卡片。
- **紧凑但不拥挤**。行高 24px、等宽 12.5px、两级缩进（16px/级）；信息密度按「开发者长时间盯着看」优化。
- **中文优先**。界面文案中文为主，等宽 JSON 与路径保持英文/数字原样；`aria-label` 与辅助信息给中英双语槽位。

为什么是 Indigo：靛蓝在近黑背景上既有足够对比度（约 6.4:1），又比纯蓝更中性、不抢语法色；亮色主题把同一强调色压深到 `#4F63E8`，保持品牌一致性。语法色只取四种有明确语义的颜色（青绿 / 琥珀 / 紫 / 灰），其余全部中性。

---

## 2. 如何打开

直接双击或 `file://` 打开即可，无需构建、无需服务器。

| 页面 | URL | 说明 |
| --- | --- | --- |
| 主界面 | `index.html?screen=main&theme=dark` | 默认；也可省略参数 |
| 空态 | `index.html?screen=empty&theme=dark` | 导入入口 + 最近文档 |
| 子树编辑 | `index.html?screen=edit&theme=dark` | 主界面 + 720×520 编辑弹层（含错误行） |
| 表达式 | `index.html?screen=expr&theme=dark` | 主界面 + 180px 底部抽屉 + 字段补全 |
| 搜索 | `index.html?screen=search&theme=dark` | 搜索工具栏 + 命中高亮 + 结果列表面板 |
| 方向板 | `board.html?theme=dark` | 色彩 / 字体 / 间距 / 形状 / 行解剖 / 组件 / JSON 地图 |

- `theme=light` 切换到亮色；默认 `dark`。
- 修复态不单独占一个 screen：`screen=main` 顶部即展示「已修复 3 处」提示条（含「查看摘要」与关闭）。
- 原型内可用的小交互：主题切换、JSON 地图折叠、搜索结果上一个/下一个、修复提示关闭；其余是静态视觉状态。

**验证**：所有 6 个 URL 在 1440×900 与 1280×720 下可打开；无外部请求、无控制台异常（已用 headless Chrome / CDP 检查）。

---

## 3. 文件

```
prototype/visual/a/
├── index.html   六屏原型（screen / theme 查询参数驱动）
├── board.html   方向板
├── app.css      应用外壳 + 六个屏幕的样式（复用 tokens）
├── board.css    方向板版式
├── tokens.css   全部设计 token（CSS 变量，双主题）
├── app.js       示例树数据渲染、搜索结果虚拟列表、主题/屏幕切换
├── map.js       JSON 地图 Canvas 绘制（DPR / 主题适配）
├── board.js     方向板主题切换 + 地图预览重绘
└── README.md    本文件
```

示例文档 `hotel_catalog.json`（50.0 MB / 2,958,550 节点 / 184,913 行）为硬编码演示数据；选中路径固定为 `data.hotel_list[1234].rooms[5].price`，数组计数 `hotel_list [5000]`、`rooms [12]`。

---

## 4. Tokens 清单

完整定义见 `tokens.css`。所有颜色、字号、行高、间距、圆角、阴影、动效均为 CSS 变量；主题通过 `<html data-theme="dark|light">` 切换（也支持任意子树的局部主题，方向板用于双主题对照）。

### 4.1 颜色

| Token | 深色（默认） | 亮色 | 用途 |
| --- | --- | --- | --- |
| `--bg-app` | `#0B0D12` | `#F7F8FB` | 应用底色 / 树区 |
| `--bg-panel` | `#11141B` | `#FFFFFF` | 工具栏、状态栏、面板 |
| `--bg-panel-2` | `#161A23` | `#F1F3F8` | chips、次级面板、输入底 |
| `--bg-elevated` | `#1A1F2B` | `#FFFFFF` | 浮层、菜单、hover 操作条 |
| `--bg-input` | `#0D1016` | `#FFFFFF` | 编辑器 / 搜索 / 表达式输入 |
| `--border` | `#232937` | `#E3E7EF` | 主发丝线 |
| `--border-subtle` | `#1A1F29` | `#EDEFF5` | 缩进引导线、行分隔 |
| `--border-strong` | `#2E3648` | `#D2D8E4` | 浮层描边 |
| `--text` | `#E7EAF0` | `#1B2030` | 正文 / 键名高亮 |
| `--text-2` | `#C6CCD9` | `#3C445A` | 次要正文 |
| `--muted` | `#8B93A7` | `#626C84` | 说明文字（≈6.3:1） |
| `--faint` | `#737C8E` | `#667086` | 元信息（≈4.6:1） |
| `--accent` | `#7C8CFF` | `#4F63E8` | 焦点、主按钮、选中 |
| `--accent-text` | `#A9B4FF` | `#4053D6` | 强调文字 |
| `--bg-selected` | `rgba(124,140,255,.14)` | `rgba(79,99,232,.09)` | 选中行底 |
| `--hit-bg` | `rgba(240,196,96,.18)` | `rgba(245,194,60,.30)` | 搜索命中底 |
| `--danger` | `#FF7A85` | `#CF3040` | JSON 错误 / 危险操作 |
| `--warn` | `#E9BE7A` | `#9A6414` | 修复提示（非错误） |
| `--success` | `#6FD3B5` | `#0C7B5A` | 运行成功 / 字符串类型 |

**语法色**（唯一多色区域）

| Token | 深色 | 亮色 | 类型 |
| --- | --- | --- | --- |
| `--syntax-key` | `#A9B8D8` | `#4B5A7A` | key · 冷灰蓝 |
| `--syntax-string` | `#6FD3B5` | `#0C7B5A` | string · 青绿 |
| `--syntax-number` | `#E3B778` | `#96610F` | number · 琥珀 |
| `--syntax-boolean` | `#B49CFF` | `#6D4BD6` | boolean · 紫 |
| `--syntax-null` | `#7B8496` | `#667086` | null · 灰（斜体） |
| `--syntax-punct` | `#737C8E` | `#667086` | 标点 · 暗灰 |
| `--syntax-index` | `#6F7A90` | `#8B93A5` | 数组下标 |

### 4.2 字体 / 字号

| 层级 | 字体 | 字号 / 行高 | 用途 |
| --- | --- | --- | --- |
| Display | system-ui | 22 / 1.25 / 600 | 空态标题 |
| Title | system-ui | 16 / 1.3 / 600 | 面板标题 |
| Body | system-ui | 13 / 1.45 / 400 | 默认 UI |
| Small | system-ui | 12 / 1.4 / 500 | 徽标、状态 |
| Mono | ui-monospace（SF Mono…） | 12.5 / 24 / 400 | JSON 树、代码 |
| Micro | ui-monospace | 10 / 1.2 / 500 | 状态栏、kbd、刻度 |

字体栈：

```
UI:   system-ui, -apple-system, "SF Pro Text", "PingFang SC", "Segoe UI", "Microsoft YaHei", sans-serif
Mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, "JetBrains Mono", Consolas, monospace
```

### 4.3 布局 / 间距 / 圆角 / 阴影 / 动效

| 类别 | Tokens |
| --- | --- |
| 关键尺寸 | toolbar 48 / repair banner 32 / status bar 26 / tree row 24 / indent 16 / JSON map 264×204 |
| 间距 | `--sp-1…10` = 2 / 4 / 6 / 8 / 12 / 16 / 20 / 24 / 32 / 40 |
| 圆角 | `--radius-xs` 4 · `--radius-sm` 6 · `--radius-md` 8 · `--radius-lg` 10 · `--radius-xl` 14 · `--radius-pill` 999 |
| 阴影 | `--shadow-sm`（行操作条）· `--shadow-md`（补全/提示）· `--shadow-lg`（地图/弹层）· `--shadow-accent`（主按钮微光） |
| 焦点 | `--focus-ring`：2px 背景隔离 + 2px 靛蓝外环；`--focus-ring-inset` |
| 动效 | `--dur-fast` 110ms · `--dur` 160ms · `--dur-slow` 220ms · `--ease-out` |

---

## 5. 六个屏幕 / 状态

### 5.1 main · 主界面

- **顶部工具栏 48px**：品牌标（mini 柱状「turbo」+ BETA）、文件 chip（名称/大小/切换）、`已临时修改 1 处` 徽标、导入、搜索 ⌘K、表达式 ⌘E、主题、设置。
- **修复提示条 32px**（位于工具栏下）：琥珀色低透明底 + 2px 左条，文案区分「已修复」与「修复不猜测内容」，右侧「查看摘要」，可关闭。修复不是错误，所以用 warn 而非 danger。
- **树视图**：44 行演示数据围绕 `data.hotel_list[1234].rooms[5].price`；展开 root → data → hotel_list → [1234] → rooms → [5]；折叠容器给出 `{…}`/`[…]` + 计数 + 字段预览；超大数组用 `… 省略 1,231 项` 行；数组计数 `[5000]`、`[12]`；每级 16px 缩进引导线；选中行靛蓝低透明底 + 2px 左条；hover 出现复制/编辑浮条（选中行内联常显，避免被 JSON 地图遮挡）。
- **JSON 地图（右下）**：260×200 浮动面板，Canvas 层级塔 `root → data → hotel_list [1234/5000] → rooms [5/12] → price ◉`，当前层前后各 2 个兄弟 key 刻度；可折叠为 40×40。
- **底部状态栏 26px**：2,958,550 节点 · 184,913 行 · 50.0 MB · 只读；中间当前路径；右侧语言、主题、本地不联网。

### 5.2 empty · 空态

居中导入区：标题 + 说明 + 虚线拖放区（粘贴 ⌘V / 选择文件 / 格式与大小上限）+ 三张导入方式卡（粘贴 JSON / 选择文件 / 从剪贴板导入）+ 最近文档 3 条（文件名 / 大小 / 节点数 / 时间）+ 本地只读脚注。整页无文件 chip（未打开文档），只保留品牌与主题/设置。

### 5.3 edit · 子树 JSON 编辑

- 720×520 弹层：遮罩 rgba(5,7,11,.66) + blur(3px)，14px 圆角 + shadow-lg。
- 路径面包屑（`root › data › hotel_list[1234] › rooms[5]`）+ 类型 chip + 大小/行数；行号 + 语法高亮；**第 4 行错误**整行 danger 底 + 红色行号 + 波浪下划线；底部错误条给出「第 4 行 · 第 3 列」与原因；`Apply` 禁用。
- 底部：锁图标 +「仅临时修改，不写回原文件 · 关闭页面即丢弃」；`恢复当前值` / `取消` / `应用 ⌘↵`。
- 对齐 ADR-0006 / `docs/design/edit-spec.md`：唯一编辑入口、整段替换、错误不产生修改、临时语义。

### 5.4 expr · 表达式抽屉

- 180px 底部抽屉：标题 + `$` 语义提示 + 快捷键；表达式 `data.hotel_list.filter(item => item.price > 1000)`（按 token 着色，带闪烁光标）；右侧主按钮「运行 ⌘↵」。
- 运行状态：`运行完成 · 42 ms · 1,284 条结果 · 结果根 #2 · 只读`，右侧「已在 2,958,550 个节点上求值」。
- 最近表达式 chips；字段补全浮层（type/price/base_price/area/breakfast，含类型与值预览、当前项靛蓝高亮、Tab/Esc 提示、数据来源「文档概要采样」）。
- 补全浮层浮在抽屉上方，不遮挡输入行。

### 5.5 search · 搜索

- 顶部搜索框（query `price`、命中数 **37,189**、上一个/下一个、Aa / .* / 键 开关、关闭）。
- 树内命中高亮：暖黄底 + 内描边，叠加在类型色上；命中行底 `--hit-row` 极淡提示。
- 右侧 330px 结果栏：标题 + 命中数、全部/键名/值 过滤、虚拟滚动结果列表（路径、值、类型、匹配说明），选中项靛蓝底 + 2px 左条；底部「虚拟滚动 · 已渲染 / 总行数」。

### 5.6 修复态

由 `screen=main` 顶部提示条承载：文案「来源文本不完整，已修复 3 处」+ 明细「补全 2 个缺失括号 · 截断 1 个字符串 · 修复不猜测内容」+「查看摘要」+ 关闭。方向板「状态 / Feedback」中也有同款组件。

---

## 6. 方向板 `board.html`

单页长滚动，左侧章节编号 + 说明，右侧内容：

1. **色彩**：surfaces 6 色、accent/语义 6 色、语法色 + JSON 代码样例、状态底色（选中/命中/修复）、深色/亮色双主题对照（同一 token、局部 `data-theme`）。
2. **字体 / 字号**：6 级字号表 + UI/等宽字体栈。
3. **间距 / 布局**：2–40 间距刻度、关键尺寸（48/32/26/24/16/264×204）。
4. **圆角 / 阴影**：5 级圆角、3 级阴影、焦点环。
5. **行解剖**：带编号标注的真实树行（引导线、折叠箭头、键名、类型色、计数、预览、操作、搜索命中）+ 8 条图例。
6. **组件状态**：按钮（主/次/ghost/sm/disabled/icon）、输入（默认/聚焦/错误/表达式）、右键菜单、状态与反馈（chips/状态点/修复条）、开关/复选/分段、Tooltip、720×520 弹层缩略。
7. **JSON 地图**：完整面板 + 构成说明 + 折叠态 40×40。

---

## 7. 无障碍

- 所有可交互元素有 `:focus-visible` 焦点环（2px 背景色 + 2px 靛蓝，对比度可见）；未使用 `outline: none` 裸奔。
- 图标按钮带 `aria-label`；主题按钮带 `aria-pressed` 和状态化 label；地图折叠按钮带 `aria-expanded`。
- 树：`role="tree"` / `treeitem` / `level` / `aria-expanded` / `aria-selected`，选中行可获得键盘焦点。
- JSON 地图 Canvas `aria-hidden="true"`，面板内提供等价文本面包屑并 `aria-live="polite"` 播报当前路径。
- 搜索结果使用 `role="listbox"` + `role="option"` + `aria-selected`。
- 颜色不单独承载信息：类型同时有色 + 文本值形态（引号/数字/true/null 斜体），命中用底色 + 内描边。
- 文本对比度：正文/次要文字 ≥ 4.5:1（`--muted` ≈ 6.3:1，`--faint` ≈ 4.6:1，语法色均 ≥ 4.6:1）；亮色主题同样满足。
- 修复条为 `role="status"`，编辑器错误为 `role="alert"`。

---

## 8. 评审要点（请重点看）

1. **气质**：是否达到了「专业工具 / 克制」而不是「后台模板」？重点看 main 与 board 首屏。
2. **密度**：24px 行高 + 12.5px 等宽在你日常查看 JSON 时是否舒适？会不会太紧或太松？
3. **靛蓝用量**：当前靛蓝只出现在选中、主按钮、焦点、地图当前层、补全当前项。是否仍然过多/过少？
4. **语法色**：青绿/琥珀/紫在深色下是否足够区分？亮色下是否可读？null 的斜体处理是否合适？
5. **JSON 地图**：右下 264×204 是否遮挡工作区？层级塔 + 兄弟刻度的信息密度是否够用？折叠态是否容易被发现？
6. **搜索态**：暖黄命中底与靛蓝选中叠加时是否清晰？结果栏 330px 是否够宽？
7. **编辑态**：错误行的红色 + 底部错误条是否足够醒目但不刺眼？「仅临时修改」的说明是否会被忽略？
8. **亮色主题**：是否只是「反色」还是同样的 Graphite 气质？边框/阴影/语法色是否需要再调？
9. **1280×720**：main 会滚动到选中行，是否可接受？编辑弹层是否完整？

已知取舍：本原型不实现虚拟滚动、Worker、真实解析与编辑；搜索结果条数、性能数字均为演示值；未做原始文本视图与 AI 功能（产品已移除）。

---

## 9. 与设计文档的对应

- 树 / 选中 / hover 操作遵循 `docs/design/tech-reassessment.md` §3.2 的行高 22–24px、DOM 行虚拟化方向；本原型取 **24px**。
- 临时子树编辑弹层对应 ADR-0006 与 `docs/design/edit-spec.md` §2（路径、CM6 风格语法高亮、行号、非法 JSON 禁止 Apply、临时语义文案）。
- JSON 地图对应 ADR-0007 与 `docs/design/json-map-spec.md` §2（260×220、22px 行高、`◉` 当前节点、兄弟 ±2、可折叠 40×40、Canvas `aria-hidden` + 文本 breadcrumb）。本原型面板 264×204、Canvas 行高 20px，以适配 12.5px 字体与更紧凑的视觉。
- 双主题默认深色、中英双语槽位、纯本地专业工具定位对应 issue #6 的视觉票要求。

---

## 10. 实现建议（给后续实现 session）

- `tokens.css` 可直接作为 token 草案；命名按用途（surface / text / accent / syntax / state / metric / radius / shadow / motion）分组。
- 树行建议 DOM 节点池 + `textContent`；本原型的行 DOM 结构可直接映射（guides / caret / key / value / count / preview / actions）。
- 行 hover 操作条与选中行内联操作条是同一组 DOM，仅 CSS 定位不同；实现时注意行 `padding-right` 预留，避免长值被操作条遮挡。
- JSON 地图 Canvas 绘制在 `map.js`，坐标与主题变量读取方式可直接迁移；DPR 上限 3。
- 视觉回归：用 `?screen=…&theme=…` 固定状态截图；方向板用于 token 评审，不进入产品包。

---

_方向 A · Graphite / Indigo · v0.1 · 2026-10-27_
