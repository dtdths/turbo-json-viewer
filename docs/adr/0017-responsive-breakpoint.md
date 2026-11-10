# ADR-0017：响应式断点（≤1320px）

- 状态：**Accepted**（2026-11-10）
- 票：**#25**（实现）；规格来源 `direction.md` §3。
- 前情：#21 视觉走查 / ADR-0016 **明确排除**响应式断点（属布局行为，不是视觉观感），另开本票。ADR-0016 的 token 收编是本次能纯 CSS 落地的前提。
- 影响面：`src/view/styles/tokens.css`、`docs/design/tokens.css`、`tests/unit/design/visual-contract.test.ts`、`scripts/smoke-settings.mjs`、README §11。

## 1. 背景

- `direction.md` §3 早有规格：**左面板宽度在 ≤1320px 收 300，右栏收 284，树宽上限 980**；实现端一直是写死的 320 / 300 / 1280。
- ADR-0016 §2.1 已把这三个值收成 `--left-panel-w` / `--rail-w` / `--tree-max` **并全部被引用**（`.side--left`、`.rail`、`.tree`，空态居中用 `calc(var(--left-panel-w)/2)`）。所以断点不需要动 JS，只需覆盖 token。
- 未做时的观感：1200px 窗口里固定宽度占掉 620px（面板 320 + 右栏 300 = 52%），树只剩 532px。

## 2. 决策

- `tokens.css` 末尾一个媒体查询，**只覆盖 3 个布局 token**（字号 / 颜色 / 其它 metrics 不动）：

```css
@media (max-width: 1320px) {
  :root { --left-panel-w: 300px; --rail-w: 284px; --tree-max: 980px; }
}
```

- **零 JS**：`.side--left`/`.rail` 的 `flex-basis`/`width` 与 `.tree` 的 `max-width` 都吃 token。
- **空态居中自动跟随**：`calc(var(--left-panel-w)/2)` 无需单独处理；实测 1200px 下卡片中心 784 → 774，仍是「可见区中心」（(vw + activity + panel)/2），几何正确。
- 断点值、三档宽度**照 `direction.md` §3 原样落地**，不发明新规格。

## 3. 实测收益（诚实记录：比直觉小）

`.spike/preview-breakpoint.mjs`（改前/改后对照）+ `.spike/audit-breakpoint.mjs`（最终代码复测）：

| 场景 | 窗口 | 树宽 改前 | 改后 | 差 |
|---|---|---|---|---|
| 面板关、右栏在 | 1440 | 1092 | 1092（断点不生效） | 0 |
| 面板关、右栏在 | 1319 | 971 | 980 | **+9** |
| 面板关、右栏在 | 1200 | 852 | 868 | **+16** |
| 面板开 + 右栏在（最挤） | 1200 | 532 | 568 | **+36** |

- 收益小是**规格本身的量级**（只动面板 −20、右栏 −16），不是实现打折。
- **`--tree-max: 980` 几乎惰性**：980 只有在窗口 ≥1312 时才可能成为约束，而断点只在 ≤1320 生效 → 真正被它封顶的窗口只有 **1312–1320** 这一段。照规格保留（无害），记录在此以免后人误以为它能救窄屏。

## 4. 验收锚点

- **静态契约**（`tests/unit/design/visual-contract.test.ts`，+2 条）：默认档 320/300/1280；`@media (max-width: 1320px)` 内 `:root` 为 300/284/980。
- **运行期**（`scripts/smoke-settings.mjs` 新 phase）：viewport 切 **1200** → `#leftPanel` 300 / `#rail` 284 / `#tree` 568（=1200−48−300−284）→ 切回 **1440** → 320/300。检查数 **21 → 23**。
- 原 `sideWidth === 320` 断言（1440 口径）**不变**，断点不破坏既有口径。
- 深/亮两套在 1440 / 1319 / 1200 复测：`--left-panel-w`/`--rail-w` 分别为 320/300、300/284、300/284，两主题一致。

## 5. 被否决

- **窄屏自动收起右栏（≤1100）**：树可多出 284px，是真正解决「挤」的手段；但属**行为变化**（与用户手动折叠、`UiState.railCollapsed` 持久化语义要定让位规则），用户 2026-11-10 拍板本轮只照规格，故不做。
- **多档断点（≤1024 等）**：规格只有一档，不发明。
- **用 JS resize 监听改宽度**：token 已能纯 CSS 表达，加 JS 只会引入抖动与状态同步问题。
