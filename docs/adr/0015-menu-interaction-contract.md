# ADR-0015：菜单交互契约——键盘 / 定位 / 失焦 / 焦点归还

- 状态：**Accepted**（2026-11-10）
- 票：无独立票（架构走查候选 6）；**#21 视觉统一走查仍挂起**——本 ADR 只做交互/结构，不碰视觉样式
- 前情：ADR-0010 §8（右键菜单键盘）、ADR-0012 §6（导出菜单 a11y/定位）各写了一份菜单契约；实现是 `app/main.ts` 里两段手写代码（约 200 行），已漂移出 6 处差异。本 ADR 把「键盘 / 定位 / 失焦 / 焦点归还」收口成一份跨菜单契约。
- 影响面：`src/shared/menu.ts`（新建，纯函数）、`src/view/menu.ts`（新建，DOM 控制器）、`src/app/main.ts`（两段菜单退化为装配）、`src/app/page.html`（`#ctxMenu` aria-label）、两份冒烟脚本。

## 1. 背景与问题

`#ctxMenu`（树行右键，7 项）与 `#exportMenu`（导出方式，2 项）共用 `.ctxmenu` 视觉 token，但交互逻辑各写一份，已经漂移：

| 维度 | 右键菜单（旧） | 导出菜单（旧） |
|---|---|---|
| 定位 | 光标右下 + 双轴 clamp（不翻转） | 锚箭头右对齐 + clamp（不翻转） |
| resize | 不关 | 关 |
| 滚动 | 不关 | 不关 |
| 键盘导航 | 只走**可用项** | 走全部（无 disabled） |
| 打开焦点 | 第一可用项 | 当前方式项 |
| Esc 焦点归还 | 回树 | 回箭头 |
| 选中项焦点归还 | 回树 | **不归还（掉 body）** |
| 失焦（focusout） | 不关 | 不关 |
| 单活 | 无显式约束（靠 pointerdown 顺序偶然互斥） | 同左 |
| 超高菜单 | 无 max-height，底部被裁 | 同左 |

测试面：导出菜单的键盘/焦点有冒烟；**右键菜单键盘/焦点零冒烟**；菜单几何/导航零单测。

## 2. 决策

### 2.1 模块与 seam

- **`src/shared/menu.ts`（纯函数，零 DOM、零依赖）**：`computeMenuPosition(anchor, menuSize, viewport, opts)`（point / rect 两种锚点；翻转 + clamp + 超高 `maxHeight`）与 `nextMenuIndex(length, current, key)`（可用项循环导航）。沿用 `shared/window.ts` 的「纯几何抽 shared、单测覆盖」先例。
- **`src/view/menu.ts`（DOM 控制器）**：`createMenu(config)` 收口 open/close、定位、键盘、外部 pointerdown、focusout、resize/scroll 关闭、单活 registry、`aria-expanded` 同步。两个调用点只声明差异：item 选择器、锚点、初始焦点、归还目标、`closeOnScroll`。
- **`app/main.ts` 退化为装配**（两段菜单约 -150 行）；`#ctxMenu` 补 `aria-label="行操作"`（role=menu 的 accessible name）。

### 2.2 键盘契约

- `↑↓` 只在**可用项**间循环（跳过 disabled）、`Home`/`End`、`Enter`/`Space` 原生激活、`Esc` 关闭并归还焦点；
- **`Tab` / `Shift+Tab`**：关闭菜单、焦点回 opener，然后让浏览器默认 Tab 从 opener 继续移动（不劫持 Tab 序列）；
- **焦点移出菜单**（`focusout` 到菜单外）→ 关闭（不归还，焦点已被接管）；
- 打开焦点：右键菜单 = 第一可用项；导出菜单 = 当前方式项；
- 不做：`Shift+F10` / `ContextMenu` 键触发右键菜单、typeahead、roving tabindex（另开票）。

### 2.3 定位契约

- **point（光标）**：优先右下展开；右侧放不下翻到光标左侧、下方放不下翻到光标上方；最终 clamp 进 8px margin；
- **rect（导出箭头）**：右对齐、下方 4px；下方放不下翻到锚点上方；最终 clamp；
- 菜单高于可用高度：`max-height = viewport.height - 2*margin` + `overflow-y:auto`（**内联样式，不改 CSS**）；
- `window resize` → 关闭两个菜单；内层滚动 → 关闭右键菜单（锚在光标，滚动后语义漂移），导出菜单不关（锚在固定工具栏）。

### 2.4 失焦与关闭原因 / 焦点归还

| 原因 | 触发 | 归还焦点 |
|---|---|---|
| `escape` | Esc | 是（右键 → 树容器；导出 → 箭头按钮） |
| `select` | 点击 / Enter / Space 选中项 | 是（导出在动作完成、按钮重新可聚焦后归还） |
| `outside` | document `pointerdown` 菜单外 | 右键菜单是（保持旧行为；可聚焦目标随后接管焦点），导出否 |
| `blur` | 焦点移出菜单 | 否 |
| `resize` / `scroll` | 窗口 / 内层滚动 | 否 |
| `programmatic` | 程序关闭 / 打开另一个菜单 | 否 |

关闭后 `aria-expanded=false`；外部关闭继续用 document `pointerdown` capture（菜单内 / trigger 例外）；Esc 处理时 `stopPropagation()`。

### 2.5 单活

打开一个菜单先关掉另一个（模块内 registry）——把原先「靠 pointerdown 顺序偶然互斥」变成不变量。

### 2.6 测试面

- 单测 `tests/unit/shared/menu.test.ts`（定位四边翻转 / clamp / 退化视口 / 超高 + 导航 wrap/Home/End/非法输入）；
- 冒烟新增：`smoke-copy` 右键菜单键盘 / 焦点归还 / 失焦关闭，`smoke-export` 选中归还 / Tab / 外部 pointerdown / resize / 定位不越界；**既有 DOM 断言零改动**；
- DOM 控制器不引 jsdom（仓库约定），由冒烟兜底。

### 2.7 行为变化清单（相对 2026-11-10 之前；候选 1–5 是零行为，这条不同）

1. 导出菜单**选中项后焦点回箭头按钮**（此前掉 body；动作完成、按钮重新可聚焦后归还）。
2. 两个菜单：`Tab` / `Shift+Tab` 与焦点移出会关闭（此前菜单留在屏幕上）。
3. 两个菜单：窗口 resize 关闭（此前只关导出菜单）；右键菜单内层滚动关闭（此前不关）。
4. 边界处菜单**翻转**到另一侧（此前只 clamp，可能盖住光标/触发按钮）；超高菜单内部滚动。
5. 单活不变量（键盘/程序路径不再可能同时打开两个菜单）。
6. `#ctxMenu` 补 `aria-label`。
7. 视觉样式零改动，观感仍归 #21。

### 2.8 被否决

- 只抽两个 helper 留在 `main.ts`：失焦 / 归还 / 单活仍是两份逻辑（不解决走查问题）。
- 单文件 `view/menu.ts` 导出纯函数 + 测试直接 import view：打破「tests 不 import view」现状，且纯几何放 `shared` 更符合分层。
- 引入 jsdom 测控制器：新增依赖，违反仓库红线；DOM 行为继续由冒烟兜底。
- `Shift+F10` 触发右键菜单：新增交互面，另开票（保持 #22「只做右键菜单」的裁定）。

### 2.9 净行为与体积

- `src/app/main.ts` 两段菜单收口；用户可见行为按 §2.7 变化，其余不变；
- 单测 **686 → 710**（+24：`shared/menu`）；13 套冒烟计数见 README §11 6.14；体积实测见 README §11（`page.js` 预算 45KB 未动）；
- #21 视觉统一走查仍挂起。

## 3. 验收

- `npm run check`（tsc + vitest + build）；
- 13 套冒烟串行（CDP 9883；不能并发）；
- `node build.mjs --analyze` 体积；
- 不推送。
