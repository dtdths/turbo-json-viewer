# ADR-0012：导出分体按钮 —— 下载 JSON 文件 / 复制 JSON 到剪贴板

- 状态：Accepted（2026-11-03，实现随本 ADR 落地）
- 日期：2026-11-03
- 依据：用户需求「右上角导出按钮增加功能：可选导出 JSON 文件还是直接复制到剪贴板」；当轮拍板「**分体按钮：主 = 上次方式，箭头选另一种**」
- 相关：ADR-0004 §7（导出后缀/修复标记）、ADR-0006 §2（`-edited` 后缀）、ADR-0010 §7（零权限剪贴板 + 回退）、ADR-0011 §2（`UiState` 持久化）

## 背景

导出目前只有「下载 JSON 文件」一种形态（`core.exportDoc` → Blob → `<a download>`，文件名带 `-edited` / `-truncated-repaired` 后缀）。
真实使用中「把当前值图直接复制到剪贴板」同样常用（贴进 IM / 生成 mock / 喂给别的工具），而走文件要经过下载目录，多两步。

需求是「二选一」。用户拍板**分体按钮**：主按钮保持一键完成（执行上次用过的方式），右侧箭头展开另一种。

## 决策

### 1. 形态：分体按钮 `[导出 | ▾]`

- **主按钮**：执行**上次使用**的导出方式（默认 `file`）。按钮文字恒为「导出」（不随方式变，避免布局跳动）；
  `aria-label` / `title` 随方式变（「导出 JSON 文件」/「复制 JSON 到剪贴板」）。
- **右侧箭头**：打开两项菜单 —— **导出 JSON 文件** / **复制 JSON 到剪贴板**；当前项以 ✓ 标记
  （`role="menuitemradio"` + `aria-checked`）。
- **选择菜单项 = 立即执行 + 记住**：更新 `UiState.exportMode` 并持久化（`tjv.ui.v1`，与主题/面板同一状态键）。
- 加载文档前两个按钮都 disabled（与现状一致）。

### 2. 复制内容 = 导出文件同一份文本

- 直接复用 `core.exportDoc(rootId, 2)` 的返回值：**当前值图**、2 空格缩进、**包含临时修改**、
  **修复过则含修复后的值图**；不读源文本、不重排键、不重新序列化一遍。
- 这样「复制」与「导出文件」结果逐字一致，用户不需要记两套规则。
- 文件名/后缀逻辑（`-edited` / `-truncated-repaired`）只作用于文件导出，不进入剪贴板文本。

### 3. 剪贴板写入复用 ADR-0010 §7 的零权限路径

`navigator.clipboard.writeText` → 失败 `execCommand('copy')` 回退 → 再失败 toast 提示手动复制；
**不声明 `clipboardWrite`**。成功 toast「已复制：JSON」（success tone，2s），失败走 error tone 并建议改用文件导出。

### 4. 大文档守卫：`CLIPBOARD_MAX_BYTES = 20 MB`

- 整份文本要经 `postMessage` 回主线程再写剪贴板，成本高于下载（50MB 导出本身也未实测）；
  超限**不复制**，toast「文档较大（X MB），请用「导出 JSON 文件」」（error tone），不自动降级下载。
- 常量在 `viewmodel/export-state.ts`（与模式校验同模块，便于单测边界）。

### 5. 不新增协议 / core 命令

复用 `exportDoc`（ADR-0006 已定义为「不受编辑器 5MB 限制」）；无新权限、无网络、无新依赖。

### 6. a11y 与键盘

- 分体容器 `role="group"` + `aria-label="导出"`；主按钮 label 随方式；箭头 `aria-haspopup="menu"`、`aria-expanded`。
- 菜单 `role="menu"`；打开时焦点落**当前选中项**、↑/↓ 循环、Enter/Space 激活、Esc 关闭且焦点回箭头、外部 pointerdown 关闭。
- 菜单定位锚在箭头下方右对齐并 clamp 到视口（复用 `.ctxmenu` 视觉 token）。

### 7. 状态形状

`UiState`（ADR-0011 §2）增加 `exportMode: 'file' | 'clipboard'`，默认 `'file'`；`normalizeUiState` 对非法值回落默认。
其余 UI 状态（panel / railCollapsed）不变。

## 验收

- 单测：新增 `tests/unit/viewmodel/export-state.test.ts`（模式校验/默认值/20MB 守卫的 19.9 / 20 / 20.1MB 边界）；
  `settings-state.test.ts` 的 `normalizeUiState` 用例随字段扩展更新。
- 冒烟：新增 `scripts/smoke-export.mjs`（CfT headless，HTTP + `__tjv`）：
  分体 DOM 与 disabled 态 → 打开菜单（两项、勾选当前、焦点）→ 选「复制」→ 剪贴板**逐字**等于导出文本 + toast success + 方式持久化 →
  主按钮随后复用「复制」→ 选「文件」→ 记录到下载动作（文件名正确）→ **刷新后**方式恢复 + 主按钮 label 正确 → 0 异常 / 0 console error。
- 回归：既有 10 套冒烟 + 单测全绿；`page.js` 增量预期 <1KB gz（预算 45）。

## 偏差 / 后续

- 复制只针对「当前文档值图」；表达式结果 / 搜索命中集等其它内容的复制随各自 slice（slice 6 / #10）。
- 20MB 阈值是经验值，**未在 50MB 上实测剪贴板写入耗时**；超限只提示，不自动降级下载。
- 不提供复制格式切换（紧凑）：与文件导出一致固定 2 空格；若需要，后续可接设置里「复制缩进」。

## 修订（2026-11-03，用户追加需求）：导出方式升级为设置项，设置面板与分体按钮双向同步

> 依据：用户要求「导出方式持久化，并且在设置面板中增加配置，两侧同步」。

### 变更

1. **`exportMode` 从 `UiState` 移入 `Settings`**（`tjv.settings.v1`），成为**设置面板第 9 行**「导出方式」：
   segmented `导出文件`（file）/ `复制到剪贴板`（clipboard）；默认仍为 `file`。
2. **单一真相源 + 双向同步**：分体按钮菜单与设置面板都只读同一个 `SettingsState`：
   - 菜单选择 → `settings.set('exportMode', mode)` → 订阅 → `applySettings()` 重放 → **面板回显 + 主按钮 `aria-label` + 菜单 ✓** 同步；
   - 面板点击 → 同一个 `settings.set` 路径 → **主按钮 label 与菜单 ✓** 同步；
   - 任一侧修改都写穿 `tjv.settings.v1`，刷新后恢复（与其它 8 项一致的持久化语义）。
3. **`UiState` 回到两项**（`panel` / `railCollapsed`）：不再持有 `exportMode`（两者职责分开：布局态 vs 用户偏好）。
   本功能尚未发布，不做旧键迁移；`tjv.ui.v1` 里的历史 `exportMode` 字段会被 `normalizeUiState` 忽略。
4. 设置面板从 8 行变 9 行（顺序：… / 复制缩进 / **导出方式** / 导入时自动修复 / 小文档自动全部展开）；
   `SettingsPanel` 仍是「只回显、经 `onChange` 上抛」的同一套机制，无新增状态。

### 验收增量

- 单测：`settings-state` 的默认值/校验/UiState 用例随字段迁移更新；`export-state` 增加方式文案表用例。
- 冒烟：`smoke-settings` 覆盖第 9 行（点「复制到剪贴板」→ 分体按钮 label 变化 + 持久化）；
  `smoke-export` 覆盖「菜单选择 → 设置面板回显」「设置面板修改 → 主按钮 label / 菜单勾选同步」。

## 指针（2026-11-10）

导出菜单的键盘 / 定位 / 失焦 / 焦点归还已收口到 **ADR-0015**；本 ADR §6 的菜单 a11y 契约以 ADR-0015 为准（分体按钮形态 / 两项 / 勾选 / 持久化均不变）。
