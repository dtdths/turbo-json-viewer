# ADR-0011：设置面板 + 视图状态持久化（S5 接线）

- 状态：Accepted（2026-11-03，实现随本 ADR 落地）
- 日期：2026-11-03
- 依据：`docs/design/direction.md` §6（设置面板：主题、类型列、行高、缩进、地图显隐、默认复制格式；只本地保存）、§8（a11y）；
  `docs/architecture/README.md` §3.3（`ThemeState` / `PanelState` / `ViewStateStore` 规划）、seams §5（S5）；
  既有偏差记录：ADR-0010 §5（复制缩进/默认格式待设置）、ADR-0004 修订 §3（关闭修复开关待设置）、ADR-0002 修订（N=500 可关待设置）、#19（排序设置入口）
- 相关票：#19（节点排序——本 ADR 提供设置入口，但排序本身仍待拍板）、#9（复制默认格式）、#8（修复开关）

## 背景

v1 有 6 笔欠账写成同一条理由「待设置面板 / `ViewStateStore` 未接线」：

1. 复制「默认格式」「缩进/压缩」固定死（ADR-0010 §5）；
2. 截断修复「关闭、只看错误」无开关（ADR-0004 修订 §3）；
3. 小文档自适应展开 N=500 不可关（ADR-0002 修订 / #9）；
4. 主题、面板开合、行高、缩进**不持久化**——刷新即丢（`ThemeState`/`PanelState` 只有规划）；
5. 行高真值仍是 `protocol/versions.ts` 的 `ROW_HEIGHT` 常量，改 CSS 不改行高（`RowMetricsSource` 未做）；
6. #19 节点排序的「设置入口」不存在。

这些都集中在 **app 装配层**（少数需要给 `load` / `copyNode` 加可选参数），不触碰 IR / 行模型语义。本 ADR 一次性接线，并补一个真正的 `SettingsPanel`。

## 决策

### 1. 设置项（v1 固定 9 项，全部即时生效 + 持久化；第 9 项见 ADR-0012 修订）

| key | 值域 | 默认 | 作用点 |
|---|---|---|---|
| `theme` | `dark` \| `light` | `dark` | `documentElement.dataset.theme`（既有按钮同步） |
| `rowHeight` | `20` \| `22` \| `24` \| `26` | `24` | `RowMetricsSource`：CSS `--row-h` + `TreeView.setRowHeight` + `RowWindowSource.setMetrics` |
| `indent` | `12` \| `16` \| `20` | `16` | CSS `--row-indent`（树缩进引导线/内边距） |
| `typeColumn` | boolean | `false` | `TreeView.setTypeColumn` |
| `defaultCopyFormat` | `subtree` \| `path` \| `value` \| `key` | `subtree` | 行尾浮条「复制」按此格式（右键菜单仍是 4 项显式） |
| `copyIndent` | `2` \| `4` \| `0`（0=紧凑） | `2` | `copyNode` 的 `indent` 参数（子树 JSON 文本） |
| `repairTruncated` | boolean | `true` | `load` 的 `opts.repair`（关闭后截断文档直接 `PARSE`） |
| `adaptiveExpand` | boolean | `true` | `load` 的 `opts.adaptiveExpand`（关闭后小文档也走默认折叠） |
| `exportMode` | `file` \| `clipboard` | `file` | 分体按钮主操作 + 设置面板「导出方式」（ADR-0012 修订：原在 `UiState`，已迁入 `Settings`） |


不放进 v1 设置：地图显隐（#17 未实现）、搜索 Aa/正则（#10 未定）、行高以外的主题细分（direction 无此需求）。

### 2. 状态形状与持久化（`ViewStateStore` 首次真正接线）

- **设置**：`SettingsState`（`src/viewmodel/settings-state.ts`，无 DOM）：持有 8 项 + 默认值 + 校验（非法值回落默认），
  `load(store)` / `set(key, value)`（写穿 store，异步失败只记录不阻塞 UI）/ `subscribe` / `snapshot()`。
- **UI 状态**：`UiState`（纯布局态）——`panel`（`doc`/`search`/`settings`）与 `railCollapsed`；同样经 `ViewStateStore` 持久化。（`exportMode` 曾短暂放在这里，2026-11-03 已迁入 `Settings`，见 ADR-0012 修订。）
  展开集合/选中/滚动**不持久化**（ADR-0009 工作区语义：不跨会话恢复），保持「刷新 = 重新导入」的既有契约。
- **存储键**：`tjv.settings.v1` / `tjv.ui.v1`（版本化，便于以后迁移）；`ViewStateStore` 用既有 `chrome.storage.local` 适配器（HTTP 模式自动落 `localStorage`，冒烟可测持久化）。
- **不新增权限**：manifest 已只有 `storage`，不引入新权限。

### 3. 加载顺序（避免主题闪烁）

`main.ts` 在装配 view 之前 `await settings.load(store)`（ESM top-level await）：先拿设置再 `setTheme` / 设 CSS 变量 / 建 `TreeView`。
读盘失败（隐私模式/配额）→ 用默认值继续，并在 dev hook 暴露 `loadedFromStore:false`。

### 4. UI：设置面板（左面板第三种模式）

- 活动栏底部（主题按钮旁）新增**设置**齿轮按钮：`data-panel-btn="settings"`，与搜索同属「模式切换」；
- 左面板复用既有 `side` 骨架，新增 `SettingsPanel`（`src/view/panels/settings-panel.ts` + `.css`）：
  每行 = 标签 + 控件（segmented / checkbox / select），控件 `change` 后上抛 `onChange(key, value)`；
- 主题按钮与面板里的主题项**双向同步**（同一 `SettingsState` 订阅）；
- a11y：面板 `role="group"` + 每项 `<label>` 关联控件、键盘可达、`aria-checked`（checkbox）/原生控件即可；
- 设置面板打开时不劫持粘贴（`isEditableTarget` 已覆盖 select/input）。

### 5. 协议与 core 的最小改动（可控、向后兼容）

- `load` 命令加**可选** `opts?: { repair?: boolean; adaptiveExpand?: boolean }`（缺省 = 现在的行为：都开）；
  `LoadDocumentInput` 加 `repair?: boolean`（false → 不尝试修复，直接抛原 `PARSE`）；
  `DocService.load` 在 `adaptiveExpand === false` 时跳过 `expandIfAtMost(ADAPTIVE_EXPAND_ROWS)`。
- `copyNode` 命令加**可选** `indent?: number`（缺省 `COPY_INDENT`=2；0=紧凑），`core/copy.ts` 的 `copyNodeText` 接受 `indent`。
- **不改**行模型 / IR / 版本语义；设置变化不触发 `docRevision` / `rowVersion`。

### 6. 行高（`RowMetricsSource` 落地）

- `TreeView` 内部持有 `rowHeight`（构造参数初始化），新增 `setRowHeight(px)`：更新 CSS `--row-h`、spacer 高度、按当前快照重排（`refresh()`）；
- 设置变更：`tree.setRowHeight(h)` → `rowSource.setMetrics({ rowHeight: h, viewportRows: tree.viewportRows() })` → `rowSource.requestWindow()` → `updateStatus()`；
- 行高只影响**渲染与滚动几何**，行号/路径/选中不变；测试断言 `scrollHeight = totalRows × h`、视口行数反比变化。

### 7. 测试与验收

- 单测：`tests/unit/viewmodel/settings-state.test.ts`（默认值/校验/非法回落/写穿 store/订阅/未知值）、
  `tests/unit/core/doc-service.test.ts` 追加（`repair:false` → 截断抛 `PARSE`；`adaptiveExpand:false` → 600 节点文档保持折叠）、
  `tests/unit/core/copy.test.ts` 追加（`indent:4` / `indent:0` 的子树 JSON 文本）。
- 冒烟：`scripts/smoke-settings.mjs`（CfT headless + HTTP，`localStorage` 持久化）：
  打开面板 → 改 8 项 → 断言即时生效（主题 dataset / 行高 spacer 与 `--row-h` / 缩进 CSS 变量 / 类型列可见 / 浮条复制用默认格式 / 子树 JSON 缩进 / 关闭修复后截断报错 / 关闭自适应后小文档折叠）→ **刷新页面**后设置仍在 → 0 console error。
- 回归：既有 7 套冒烟 + 单测全绿；体积 `page.js` 预算 45KB gz。

## 后果

- v1 的 6 笔「待设置面板」欠账一次性收口（#8/#9/#19 的入口就位）；主题/布局刷新后保留。
- `page.js` 增加设置面板与状态机（预估 +2–3KB gz）；`RowMetricsSource` 从「未做」变「已做」。
- 设置只存本地、不联网、不存文档内容（沿用红线）。

## 已知差距 / 后续

- 「地图显隐」「搜索 Aa/正则」「大纲/设置面板的更多子项」随各自 slice 追加；设置项 schema 版本化以便迁移。
- 面板宽度/侧栏布局仍是 CSS 常量（不随设置变）；行高可选档只列 4 档，不做任意像素输入。
- 主题首帧：依赖 `await settings.load` 的顺序，扩展页 `chrome.storage.local` 异步读取期间先按默认主题渲染（一次 flush 内完成，若无异常不会可见闪烁）。

## 实现备注（2026-11-03，落地后追记）

1. **`ThemeState` / `PanelState` 未单独建类**：主题与布局态都在 `SettingsState`（含 `UiState`）里，避免三套状态机各持一份存储。
2. **启动顺序**：`main.ts` 用 ESM top-level `await settings.load(viewStateStore)` 在装配 `TreeView`/`RowWindowSource` 之前读盘；
   恢复左面板模式放在活动栏监听之后（避免 `PANEL_TITLES` 的 TDZ）。
3. **`--row-h` 挂在树滚动容器**（`tree-view.mount` 写入）而不是 `:root`：`TreeView.setRowHeight` 同时更新容器变量、spacer 高度并按当前快照重排；`app` 再 `rowSource.setMetrics` 重算视口行数。
4. **左面板模式持久化的实际语义**：用户切换会持久化并在启动时恢复；**导入成功（`onLoaded`）仍按既有契约切回文档视图**（导入是文档动作），因此「刷新后恢复的面板」= 最后一次用户显式切换的模式（若期间导入过则回到 doc）。
5. `copyNode.indent` 在 core 侧再做一次守卫（非整数/负数回落 `COPY_INDENT`，上限夹到 8），不信任跨线程入参。
6. 单测合计 273（新增 19：`settings-state.test.ts` 12；doc-service +4、copy +3 属于本 ADR 的协议参数）。
7. **两处交互修复（用户验收反馈，2026-11-03）**：
   - **空态遮罩盖住左面板**：`.empty` 是 `position: fixed; inset: 0 0 0 48px; z-index: 30`，初始视图（无文档）点齿轮后 `body[data-panel]` 已切到 settings、但面板被遮罩整块盖住 → 视觉上「点击无效」。修法：`.side--left` 加 `position: relative; z-index: 31`（左面板始终在空态/替换层遮罩之上；模态层 z-index 更高，不受影响）。
   - **设置图标易误认为亮色模式**：原图标「圆 + 8 道射线」与主题按钮的太阳图标同形 → 改为**竖排滑杆**（三根竖线 + 圆点），与主题的太阳/月亮明确区分。
   - 冒烟 `smoke-settings.mjs` 增加 2 项空态回归断言（空态点齿轮：面板在遮罩之上、8 行、关闭回文档视图）。

## 修订（2026-11-10）：第 10 项设置「搜索结果双击复制」（#26）

- **schema +1**：`Settings.searchCopyFormat: CopyFormat`，默认 **`'path'`**；与 `defaultCopyFormat` 一样按 `COPY_FORMATS` 白名单校验、非法回落默认；随整包写入 `tjv.settings.v1`（无新存储键，旧数据缺该键 → 默认路径）。
- **语义**：只影响「搜索结果行双击」这一个入口；行尾浮条 / 右键菜单仍用 `defaultCopyFormat`（两者独立，避免一个设置同时改两处）。
- **面板**：9 行 → **10 行**，位置在「复制缩进」之后、标签「**搜索结果双击复制**」，复用 `COPY_FORMAT_ITEMS` 四选项 segmented（320px 内单行放得下，深/亮 + 1200 窄窗口截图已核）。
- **接线**：`main.ts` 的 `SearchPanel.onCopyResult` 读 `settings.get('searchCopyFormat')` 调既有 `copyNodeToClipboard`；面板本身不读设置（保持 viewmodel 无状态依赖）。
- **验收**：单测 724 → **725**（`searchCopyFormat` 默认/合法/非法回落）；冒烟 `smoke-settings` 23 → **24**（`set:searchCopyFormat` 默认路径 → 切子树 JSON → 切回；`DEFAULT_KEYS`/`DEFAULTS`/重启恢复对象同步 10 项）。
- **体积**：`page.js` 33.7 → **33.9KB gz**（+0.2），`worker.js` 15.3 / `page.css` 7.3 不变。
