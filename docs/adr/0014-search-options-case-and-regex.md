# ADR-0014：搜索选项——`Aa`（区分大小写）与 `.*`（正则）

- 状态：**Accepted**（2026-11-09）
- 票：**#10**（搜索与定位语义，本 ADR 只解禁其中「Aa / 正则」两项；路径搜索 / 索引 / 渐进式返回等仍留在票内）
- 前情：slice 4 的范围裁定是「**不做** Aa / `.*` 开关」（`docs/design/slice4-search-contract.md` §1、`docs/design/direction.md` §6 注记延后）；ADR-0011 也明确「搜索 Aa/正则」**不进 v1 设置**。本 ADR 解除这两条中的「实现层」限制，但保留「不进设置」的结论。
- 相关：ADR-0001（Worker 常驻 + 行窗口）、ADR-0008（分层/seam）、ADR-0011（设置与持久化）、ADR-0013（面板交互先例）
- 影响面：`src/protocol/types.ts`（`SearchOpts.regex`）、`src/protocol/errors.ts`（`BAD_PATTERN`）、`src/core/search.ts`、`src/viewmodel/search-state.ts`、`src/view/panels/search-panel.{ts,css}`、`src/app/main.ts`（装配）

## 1. 背景

slice 4 落地了子串搜索（键名 + 字符串值，默认大小写不敏感，命中上限 50,000），当时刻意留下了两个开关没做：`Aa`（区分大小写）与 `.*`（正则）。搜索面板的查询行按 `direction.md` §6 本来就预留了「三开关」的位置，只是被裁定延后。

代码层面其实已经有一半：`core/search.ts` 的 `searchDocument` 从 slice 2 起就接受 `caseSensitive`，`protocol` 的 `SearchOpts` 也有该字段——**缺的只是 UI 与装配**。`keysOnly` 同理，但键名/值过滤已由结果侧 `all/key/value` 承担，`keysOnly` 继续不用。

正则则是真正的新能力：它把「固定子串」换成「用户提供的模式」，引入两个新问题——**语法错误怎么反馈**、以及**灾难性回溯（ReDoS）** 会卡住唯一的 Worker。

## 2. 决策

### 2.1 位置与形态

查询行内、查询框右侧两个 28×24 切换按钮：

| 按钮 | 文案 | `aria-label` | 默认 | `aria-pressed` |
|---|---|---|---|---|
| 大小写 | `Aa` | 区分大小写 | 关 | 是 |
| 正则 | `.*` | 使用正则表达式 | 关 | 是 |

都是真实 `<button type="button">`，键盘可达（查询框 → `Aa` → `.*` 的 Tab 顺序），`aria-pressed` 反映状态。切换任一开关 → **立即重跑当前查询**（复用现有 250ms debounce 之外的一次直跑，清空查询时只重置状态不发命令）。

### 2.2 语义矩阵

| `Aa` | `.*` | 匹配语义 | RegExp flags |
|---|---|---|---|
| 关 | 关 | 大小写不敏感**子串**（现状） | — |
| 开 | 关 | 大小写敏感**子串** | — |
| 关 | 开 | 正则匹配 | `i` |
| 开 | 开 | 正则匹配 | 无 |

- **匹配目标不变**：仍只匹配**键名 + 字符串值**（数字/布尔/null/路径不参与，与 slice 4 一致）。
- 正则模式下 `Aa` 只影响 `i` flag，不改变其它语义。
- 命中集合、`field`（key/value）、`truncated`、`SEARCH_LIMIT=50,000`、过滤（全部/键名/值）、结果列表虚拟化、跳转链路**全部不变**。
- `.*` 开时查询串按 **ECMAScript RegExp** 解释（`new RegExp(query, flags)`），不做 JSONPath / 通配符方言。

### 2.3 错误处理（无效正则）

- 语法错误、超长、被安全筛查拒绝 → core 抛 `CoreError({ code: 'BAD_PATTERN' })`（**新增错误码**），不产出命中。
- UI 表现：查询框 `aria-invalid="true"` + 查询行下方一行错误文案（`role="alert"`），**同时清空结果列表、命中计数、树上 `is-hit`/`is-current` 高亮**——避免屏幕上留着与当前查询不符的结果。
- 编辑查询/关闭 `.*`/切换 `Aa` 都会清除错误态；错误态下 `phase='idle'`，不显示「无命中」。
- 错误文案由 app 层按 `message` 映射，core 只给规则原因（与既有 `TOO_LARGE`/`TOO_MANY_ROWS` 的「core 说规则、app 说文案」分工一致）。

### 2.4 安全边界（正则模式）

| 守卫 | 值 | 行为 |
|---|---|---|
| 模式长度 | `SEARCH_PATTERN_MAX = 256` 字符 | 超出 → `BAD_PATTERN`「正则过长」 |
| 灾难性回溯静态筛查 | 量词作用于**含量词的分组**（`(a+)+`、`(a*)+`、`(a+)*`、`(?:a{1,})+` 等） | 拒绝 → `BAD_PATTERN`「该正则可能触发灾难性回溯」 |
| 单次扫描中断 | 沿用每 4096 节点 `shouldCancel`（新搜索抢占 / 取消） | 不变 |
| 命中上限 | `SEARCH_LIMIT = 50,000` | 不变（`truncated`） |

静态筛查是**启发式**，不是完备的 ReDoS 判定：`(a|a)+` 这类「重叠分支 + 量词」也指数级，但为控制误杀（`(foo|bar)+` 是常见合法写法）**不拦**。因此：

> **已知差距（显式接受）**：漏网的病态正则可以卡住 Worker，直到 `COMMAND_TIMEOUT_MS = 5000` 命令超时；v1 **没有** Worker 自动恢复（重启会丢掉已导入的文档），到时用户需重新导入。不做子进程沙箱 / 超时中继 / 线性时间正则引擎——代价与收益不成比例，且正则只在本地对用户自己的数据执行。

### 2.5 状态与持久化

- 两个开关是**面板会话态**，**不持久化**（刷新 / 重开页面回到「大小写不敏感 + 子串」）。
- 依据：ADR-0011 已定「搜索 Aa/正则不进 v1 设置」；`UiState` 不扩字段，避免为两个局部开关升 `tjv.ui.v1` 的语义。
- 唯一的状态真相在 app 层的 `searchOpts`（`{ caseSensitive, regex }`），viewmodel 只持有本轮 `begin()` 的快照用于渲染。

### 2.6 分层与实现缝

```
view/panels/search-panel.ts   只做 DOM：两个 toggle + 错误行；发出 onOptionsChange，不发命令
viewmodel/search-state.ts     持有本轮 opts 快照 + patternError；begin(query, opts) / markPatternError()
core/search.ts                唯一匹配实现：编译 matcher（子串或 RegExp）+ 安全筛查；抛 BAD_PATTERN
app/main.ts                   唯一装配点：searchOpts → core.search(opts) → 错误映射 → 面板/树
```

- **不新增 shared 模块**：正则编译与安全筛查只被 core 使用，view 通过 `BAD_PATTERN` 回包获知错误，不需要本地预校验（回包延迟 <5ms，用户无感）。
- **不改 `LoadReply`/`SearchReply` 形状**：`SearchOpts.regex` 是既有可选透传字段的扩展；`SearchReply` 不变。
- 行模型 / 行窗口 / 树渲染**零改动**。

## 3. 备选方案

| 方案 | 结论 |
|---|---|
| 继续不做正则（v1 原裁定） | 否决：用户明确要求本 slice 落地 Aa/正则 |
| 把正则交给表达式视图（#12） | 否决：表达式是「过滤视图」的入口，搜索框输入即得结果的心智不同；且 #12 未排期 |
| 正则跑在独立 Worker / 子进程（可 terminate 沙箱） | 否决：要跨线程搬全部字符串（50MB 文档代价远超收益）；且 v1 单 Worker 模型会因此分裂 |
| 引入线性时间正则引擎（RE2 类） | 否决：体积/依赖代价（ADR-0005 的栈约束），v1 不值得 |
| 用「重叠分支 + 量词」也纳入静态筛查 | 否决：会误杀 `(foo|bar)+` 等常见合法模式；改为显式已知差距 |

## 4. 验收（实现期填写）

- **单测**：`core/search` 的 4 组语义矩阵、无效正则 / 超长 / 嵌套量词 → `BAD_PATTERN`、大小写敏感差异、正则 + 取消；`viewmodel/search-state` 的 opts 快照 / `markPatternError` / 清空与重跑；面板 toggle 的 `aria-pressed` 往返。
- **冒烟** `scripts/smoke-search.mjs` 增补：`Aa` 真实点击改变命中数、`.*` 真实点击命中正则结果、无效正则内联错误 + 结果与树高亮清空、开关点击 → 查询重跑、刷新后开关回到默认。
- **回归**：`npm run check` + 全部冒烟（串行，CDP 9883）。
- **体积**：`page.js` gz 增量目标 ≤ **+1.5KB**（预算 45，现 28.7；只加两个 toggle + 错误行 + viewmodel 字段）。
