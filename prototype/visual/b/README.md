# 方向 B — Slate / VS Code

> Turbo JSON Viewer 视觉方向 B 的高保真静态原型（只做视觉，不含产品逻辑）。
> 冷蓝灰 IDE 骨架 + VS Code 语法色 + Canvas JSON 地图；深色默认、亮色完整。

## 文件

| 文件 | 说明 |
|---|---|
| `index.html` | 六屏原型（主界面 / 空态 / 编辑 / 表达式 / 搜索 / 修复态），`?screen=` + `?theme=` 切换 |
| `board.html` | 方向板：色板、字体、间距/圆角/阴影、行解剖、组件状态、JSON 地图、双主题、对比度 |
| `README.md` | 本文件 |

两个 HTML 都是**自包含单文件**（CSS/JS 内联、内联 SVG sprite）：无 CDN、无图片、无字体请求，可直接双击用 `file://` 打开，也不会产生任何网络请求。这个取舍是刻意的——原型要被截图/评审脚本任意搬运，不能依赖外部资源或 MIME 配置。

```bash
open prototype/visual/b/index.html
open 'prototype/visual/b/index.html?screen=search&theme=light'
open prototype/visual/b/board.html
```

## URL

| 状态 | URL |
|---|---|
| 主界面（默认） | `index.html?screen=main&theme=dark` |
| 空态 | `index.html?screen=empty&theme=dark` |
| 子树编辑弹层 | `index.html?screen=edit&theme=dark` |
| 表达式抽屉 | `index.html?screen=expr&theme=dark` |
| 搜索态 | `index.html?screen=search&theme=dark` |
| 修复态 | `index.html?screen=main&repair=1&theme=dark`（`?screen=repair` 等价） |
| 亮色 | 任意 URL 加 `&theme=light`（或 `?theme=light`） |
| 方向板 | `board.html?theme=dark` / `board.html?theme=light` |
| 评审导航（可选） | 任意页面加 `&review=1`，左下出现屏幕切换条（默认隐藏，不影响截图） |

交互可用：活动栏/工具栏/行内编辑按钮切屏、主题切换、地图折叠、命中上一个/下一个、`Esc` 关闭编辑弹层与表达式抽屉。行内操作图标默认 hover 出现；主界面 `name` 行用 `.is-demo-hover` 静态演示 hover 态。

## 设计理念

1. **IDE 骨架，不做“模板感”**。48px 活动栏 / 44px 工具栏 / 34px 标签条 / 26px 面包屑 / 24px 状态栏。静态平面一律 1px 冷灰分隔线，阴影只留给弹层、抽屉、地图这类浮层。
2. **蓝色只属于动作与焦点**。`--accent` 只出现在选中行左边条、焦点环、主按钮、地图当前位置、状态栏。数据本身完全交给 VS Code 语义色（key 浅蓝 / string 橙 / number 绿 / bool 蓝 / null 紫）。
3. **密度换速度**。26px 树行 + 12.5px 等宽，一屏约 29 行；类型列 66px 右对齐，便于竖扫；右侧预留 300px “地图走道”，JSON 地图浮在走道里，永远不会盖住值或类型。
4. **暖色只给命中**。搜索命中是全局唯一的暖黄，与蓝色动作色明确分工；修复/错误用琥珀与红，仅出现在提示条、错误行与状态栏。
5. **亮色是重新配色**，不是反相：画布 `#F3F6FB`、面板 `#FFFFFF`、边界 `#DCE3EE`，语法色换 VS Code light 家族并整体加深，阴影改成冷调低透明度。

## Design tokens（CSS 变量）

全部定义在 `index.html` / `board.html` 的 `:root`（暗色默认）与 `[data-theme='light']` 覆盖块中；页面通过 `document.documentElement.dataset.theme` 切换。方向板上的 hex 标签与对比度是运行时从这些变量算出来的。

### 颜色

| token | Dark | Light | 用途 |
|---|---|---|---|
| `--bg-app` | `#0F1115` | `#F3F6FB` | 编辑器画布 |
| `--bg-panel` | `#151922` | `#FFFFFF` | 工具栏 / 侧栏 / 面板 |
| `--bg-raised` | `#1B202B` | `#FFFFFF` | 浮层 / 输入框 |
| `--bg-inset` | `#0B0E13` | `#F7F9FD` | 代码编辑器底 |
| `--bg-hover` / `--bg-selected` | `#1A1F2B` / `#1C2738` | `#EEF3FA` / `#DCEBFC` | hover / 选中行 |
| `--border` / `--border-strong` / `--guide` | `#2A3140` / `#3A455B` / `#283040` | `#DCE3EE` / `#C2CDDD` / `#DDE5F1` | 分栏 / 可交互边界 / 缩进引导 |
| `--text` / `--text-strong` / `--text-muted` / `--text-faint` | `#D7DEEA` / `#F3F7FD` / `#8B97AB` / `#667183` | `#1E2533` / `#0A1220` / `#5C6A80` / `#7C8899` | 文本四档 |
| `--accent` / `-hover` / `-press` / `-soft` | `#4EA1FF` / `#74B6FF` / `#2C86E8` / `rgba(78,161,255,.13)` | `#0B6BCB` / `#0A5AAE` / `#084D96` / `rgba(11,107,203,.10)` | 动作与焦点 |
| `--statusbar-bg` / `--statusbar-fg` | `#0C4F87` / `#E9F3FF` | `#0B6BCB` / `#F4FAFF` | VS Code 式状态条 |
| `--syn-key` / `-string` / `-number` / `-boolean` / `-null` / `-punct` | `#9CDCFE` / `#CE9178` / `#B5CEA8` / `#569CD6` / `#C586C0` / `#7F8CA3` | `#0A5FA8` / `#A31515` / `#06693F` / `#0B5CBF` / `#8A2FA8` / `#6B7788` | 语法 |
| `--hit-bg` / `--hit-current-bg` | `#5C4811` / `#8A6A14` | `#FFE59A` / `#FFD04D` | 搜索命中 / 当前命中（唯一暖色） |
| `--warn` / `-bg` / `-border` | `#E3A94C` / `#251C0E` / `#4A3818` | `#9A6200` / `#FFF6E3` / `#EBD3A0` | 截断修复提示条 |
| `--danger` / `-bg` / `--success` | `#F27A7D` / `#2A1418` / `#6BD39A` | `#B3261E` / `#FDEEEC` / `#146B43` | JSON 错误 / 成功 |

### 字体与尺度

- `--font-ui`: `system-ui, -apple-system, "Segoe UI", "PingFang SC", …`；`--font-mono`: `ui-monospace, "SF Mono", Menlo, …`
- 字号：UI 13 / 12 / 11 / 10.5；树行 `--fs-code: 12.5px`；行高 `--lh-row: 26px`；编辑器 `--lh-code: 22px`。
- 层级尺寸：`--activity-w: 48px`、`--toolbar-h: 44px`、`--tabs-h: 34px`、`--crumb-h: 26px`、`--status-h: 24px`、`--row-indent: 16px`、`--tree-gutter: 300px`、地图 `260×200`、编辑弹层 `720×520`。
- `--tree-gutter` 在 ≤1360px 收到 286px、≤1240px 收到 276px，保证 1280×720 下类型列与地图不重叠。
- 间距 `--sp-1…9` = 2/4/6/8/12/16/20/24/32；圆角 3/4/6/8/10；阴影三档 `--shadow-1/2/3` 只用于浮层。

## 六个屏幕

1. **main**：活动栏（树/搜索/表达式 + 主题/设置）+ 工具栏（品牌 / `hotel.json` 50 MB / 导入 / 搜索 / 表达式 / 主题 / 设置）+ 标签条 + 面包屑 + 45 行树（祖先展开、数组折叠省略行、`[5000]`、`{12}`、选中 `data.hotel_list[1234].rooms[5].price`、hover 复制/编辑）+ 右下 JSON 地图 + 状态栏（首帧 150ms、本地不上传、2,958,550 节点、184,913 行、50.0 MB、JSON、UTF-8、主题）。
2. **empty**：居中导入区（拖放 / 粘贴 / 选择文件 / 剪贴板）+ 最近文档 3 条 + 性能脚注；未打开文档时工具栏搜索/表达式禁用、标签条收起。
3. **edit**：720×520 子树 JSON 编辑弹层。路径面包屑 `data › hotel_list[1234] › rooms › [5]`、object 徽标、348 B/10 键、行号、语法高亮、第 4 行 `"bed": double` 错误行（红底 + wavy + 错误条 + 定位）、Apply 禁用、恢复当前值/取消、`仅临时修改 · 不写回原文件`。背景树选中 `rooms[5]`，地图层级塔同步切换到该节点。
4. **expr**：180px 底部抽屉，输入 `data.hotel_list.filter(item => item.price > 1000)`，字段补全浮层（8 个字段、类型、值预览、↑↓/↵/esc 提示），运行状态 `12.4 ms · 4,281 / 5,000`，并注明“表达式结果为新视图根”。
5. **search**：左侧 304px 搜索视图（`price`、Aa 开启、37,189 结果、12 ms、10 条结果列表）+ 面包屑里的命中导航 `3 / 37,189` + 树内暖黄命中高亮。
6. **repair**：主界面顶部琥珀提示条「已修复 3 处 · 补全 2 个 `}`、1 个 `]` · 内容未做任何猜测」+ 查看摘要 + 关闭；标签页琥珀点与状态栏「已修复 3 处」。

## JSON 地图（Canvas 层级塔）

- 层级塔按 `root › data › hotel_list[1234/5000] › rooms[5/12] › price` 绘制：祖先层 19px 行距、类型色点、右侧 `[i/N]`/`{N}`；当前行 accent 底 + 2px 左条 + ◉ + 值预览。
- 同级区域：当前层前后各 2 个兄弟 key（等距排布并做防重叠），下方位置轨道按 `index/count` 画刻度与蓝点，右侧 `4 / 10`。这是对 spec「按 index/count 定位」的视觉折中：大 count 下刻度会挤在一起，改用“兄弟刻度 + 全局轨道”双读数保证可读，评审可定夺。
- 面板可折叠为 40×40；Canvas 依赖 `devicePixelRatio` 缩放；主题切换后按需重绘。`aria-hidden` + 下方两行文本 breadcrumb + `aria-live` 路径播报。

## 无障碍

- 全站可见 `:focus-visible` 焦点环（2px `--accent`，offset 1px）；行操作、图标按钮均有中文 aria-label（附英文括注）。
- 方向板用脚本实时计算 6 组对比度：正文 13.97:1、标题 16.36:1、次要 6.40:1、数值 11.12:1、选中 13.99:1、状态栏 7.54:1（暗色；亮色同样全部 ≥ 4.5:1）。
- 类型信息不单靠颜色：类型列有文本、地图有类型点 + 数值/位置文本、命中同时有底色与文字反差。
- `prefers-reduced-motion` 下关闭光标的闪烁与过渡。

## 评审要点

1. 深色是否像专业 IDE，而不是“黑色仪表盘”（大面积纯黑 + 霓虹色）？
2. 26px 行高 + 12.5px 等宽的密度是否合适；类型列右对齐是否帮助竖扫？
3. 蓝色是否只在动作/选中/焦点上？暖黄命中是否足够醒目但不刺眼？
4. 260×200 地图：层级塔 + 兄弟刻度 + 全局轨道是否一眼可读？还是该更“迷你地图”一些？
5. 亮色是否真的重新调过对比与阴影（面板纯白 + 画布浅蓝灰 + 冷调阴影）？
6. 编辑弹层/抽屉/提示条的整体分量是否克制、不打断阅读？

## 已知取舍 / 待确认

- 地图兄弟刻度为了可读性牺牲了严格的 `index/count` 横向定位（见上），当前用“双读数”表达位置；若要严格按比例，可只保留刻度、把标签交给 hover。
- 树右侧预留 300px 地图走道，数据列变窄；好处是地图永不遮挡内容，代价是 1440 下右侧留白偏多。
- 主界面 `name` 行的 hover 态是静态演示（`.is-demo-hover`），真实实现中只在指针悬停时出现。
- 亮色下 `--text-faint`（`#7C8899`）用于计数等三级信息，未追求 4.5:1；若评审要求全部正文级对比，可整体加深。
- 原型不含真实解析/虚拟化/编辑逻辑；所有数据为硬编码示例（50 MB / 2,958,550 节点为产品验收样本的示意值）。

## 截图

Lead 的统一截图脚本注意两点：

1. 静态服务器需要按扩展名返回正确的 MIME（`.html → text/html`）。当前 `prototype/p1/lib/http.mjs` 对所有非 json 文件返回 `text/plain`，浏览器会把页面当纯文本渲染，所有方向都会受影响。
2. 方向板是长页（暗色约 5220px），`board.html` 建议 full-page 截图或按 900px 分段；`repair` 状态需在 screens 列表加入 `repair`（或手动抓 `?screen=main&repair=1`）。
