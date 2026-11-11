# ADR-0018：表达式视图（引擎 / 协议 / 结果根契约）

- 状态：Accepted（2026-11-10，实现随本 ADR 落地）
- 日期：2026-11-10
- 依据：**#12 定稿 spec**（票内第 4 条评论：9 节 + 17 条决策记录）；调研 `docs/research/expression-engine.md`（#3：acorn + 手写 walker / 四层防御 / 白名单）与 `docs/research/expression-runtime.md`（#14：维持 walker，步数改 `max(1e6, k×N)`，白名单是执行层）；#27 票面（范围/验收/不做项/已知差距）；`docs/design/ir-spec.md` §4.2（表达式结果根 `expr:N` / LRU 3 / 元素引用不复制 / 自有 expanded/model/rowVersion）
- 相关：ADR-0001（worker 常驻文档 / 行窗口）、ADR-0002 修订（根变更路径 / 版本语义）、ADR-0008（分层与 seam）、ADR-0010（复制格式）、ADR-0011（设置持久化）、ADR-0012（导出）、ADR-0013（预算修订先例）、ADR-0017（响应式断点）

> 本 ADR 只把 #12 的 17 条决策落成**可实现的契约**（协议形状、引擎语义、结果根生命周期、DOM/hook 契约），**不重新设计**。与 spec 冲突以 spec 为准并回 #12 记录。

## 背景

#12 已定稿：活动栏第 4 个模式「表达式」，左面板输入 + 示例 + 历史 + 严格模式 + 执行按钮；中间树区显示**新的视图根** `expr:N`；结果元素**引用**原文档节点不复制；点结果行跳回原文档；导出/复制结果 JSON；预算三刹车；错误行内；stale 不自动重跑。

落地要回答的是「哪一层负责什么」：

| 决策点 | 选择 | 理由 |
|---|---|---|
| 求值在哪 | **Worker**（文档常驻、acorn 只进 worker） | 零拷贝读取值图；页面永远不持文档；acorn 56.9KB gz 不进首屏 |
| 求值失败如何回包 | **正常回包** `{ok:false,error}`，不抛 CoreError | 用户可改表达式重试；CoreError 只表达协议/根级错误（`NO_ROOT` 等） |
| 结果如何成为视图 | 新根 `expr:N` + `RowModel`（复用 `RootStore` LRU 3） | ir-spec §4.2 已定；行窗口/展开/折叠/导出全部免费复用 |
| 跳回原文档 | worker 保留来源映射，按需 `exprLocate` | 页面侧 ~10MB 路径表不可接受（spec §4） |
| 补全 | worker 提供静态清单（白名单 + 根级字段 + 方法字典） | 「提示什么 == 允许调什么」同源；类型感知属 #28 |
| 看门狗 | 页面侧 `3 × maxTime` 无回包 → terminate + 惰性重建 worker | 预算漏算的最终兜底；已知差距：terminate ⇒ 文档需重新导入 |

## 决策

### 1. 界面与模式（#12 §1/§2）

- 活动栏按钮顺序：文档树 / 搜索 / 大纲 / **表达式** / 间隔 / 设置。表达式按钮 `data-panel-btn="expression"`；
  点已激活按钮 = 回文档视图（与搜索/大纲/设置一致）。`UiState.panel` 增加 `'expression'`（持久化恢复）。
- 左面板 320px（复用 `.side--left` / `.side__head`），标题「表达式」；面板 DOM 契约见 §7。
- **输入区**：CM6（`@codemirror/state|view|commands|language|autocomplete|lint`，**不引 `lang-javascript`**）；
  自写轻量上色（正则：字符串 / 数字 / 关键字 / 注释）+ 括号配对 + 错误行内标记（lint 诊断）。
  `Enter` 执行、`Shift+Enter` 换行、面板内「执行」按钮（执行中禁用）。
- **示例**：按当前文档**顶层字段动态 3 条**（无文档 / 根非对象时只给通用 2 条）+ 通用语法 2 条；点击填入输入框。
- **历史**：会话级 20 条（`ExprHistory`，内存，不持久化），`↑`/`↓` 调用；执行成功后入历史（去重相邻重复）。
- **严格模式**：面板内 checkbox，**会话级**（不进设置持久化）。
- **执行中反馈**：按钮禁用；结果栏常驻 `N 项 · X ms`；错误**行内**（行列 + caret，来自 `ExprError.line/column`）+ 面板内错误文案。
- **结果区**：树区顶部一条 `.noticebar`（`#exprBar`）：
  - 正常：`表达式结果 · expr:N` + 右侧「返回文档树」；
  - stale：同条变警告色 + 「重新执行」（**不自动重跑**）+「返回文档树」；
  - 截断：文案追加「已截断（上限 N）」；严格模式关闭且有跳过：追加「已跳过 K 项缺少该字段」。
- 结果视图复用树视图（`RowWindowSource.setRoot(exprRootId, …)`）：点结果行（非 caret）→ `exprLocate` → 回文档树 + `jumpToPath`；
  结果行**只读**：不提供编辑入口（F2/双击编辑在表达式根上提示「表达式结果只读」）。
- 结果根上「全部展开 / 全部收起」照常工作（`session` 切到 expr 根后复用既有链路）。

### 2. 协议（`protocol/types.ts` / `messages.ts` / `core-api.ts`）

三条命令，`Command` 判别联合 + `ReplyByKind` + `CoreApi` 三方法：

```ts
| { t: 'eval'; rootId: RootId; seq: number; text: string; strict: boolean; budget: ExprBudgetLevel }
| { t: 'complete'; rootId: RootId; text: string; pos: number }
| { t: 'exprLocate'; rootId: RootId; path: Path }
```

- `eval` 是**唯一**创建视图根的命令；成功回 `EvalSuccess`（`rootId` = `expr:N`，`docRevision`/`rowVersion`/`totalRows`/`count`/`kind`/`ms`/`steps`/`truncated`/`skipped`）；
  引擎级失败回 `{ok:false, error: ExprError}`。根不存在 → `NO_ROOT`；`rootId` 不是 doc 根 → `BAD_COMMAND`。
- `eval` 的 `seq` 只回显、由页面丢弃迟到回包（与 search 同口径）；eval 在 worker 内**同步执行**，文档不可能在执行中变化。
- `complete`：`pos` 夹到 `[0, text.length]`；回 `{items}`（`ExprCompletion`）。只读、不推版本、无状态。
- `exprLocate`：`path` 是 **expr 根内**的规范路径；回 `{path: 原文档路径 | null}`。只读、不推版本。
- `EvalReply` 是判别联合（`ok`），**不是** `CoreError`：错误码 10 个、文案参数在外层（`shared/expression-copy.ts`）。
- 预算档位与常量集中在 `protocol/versions.ts`（`EXPR_BUDGETS` / `exprBudget()` / `exprWatchdogMs()` / `EXPR_TEXT_MAX` /
  `EXPR_AST_DEPTH_MAX` / `EXPR_TIME_CHECK_EVERY` / `EXPR_HISTORY_MAX` / `EXPR_COMPLETE_DEBOUNCE` / `EXPR_EXAMPLES_*`）。

### 3. Worker 引擎（`src/core/expression/`，acorn 只进 worker）

模块划分（**纯函数，可单测；不碰 DOM、不碰 `chrome.*`**）：

| 文件 | 职责 |
|---|---|
| `whitelist.ts` | **单一来源**：节点类型白名单、数组 15 / 字符串 12 方法（`length` 是属性，补全时单列）/ `Math` 11 / 全局名、禁用运算符表。引擎与补全共用 |
| `parse.ts` | acorn 封装：长度/深度上限、`ecmaVersion:'latest'`、`locations:true`、错误 → `PARSE_ERR_*` |
| `validate.ts` | 静态白名单（default-deny）+ 调用点检查 + AST 深度 + 禁用运算符 |
| `walk.ts` | 手写 walker：own-property 读、白名单方法分派、箭头闭包、可选链、预算三刹车、来源映射 |
| `engine.ts` | 门面 `evaluateExpression(text, docRoot, opts): EvalOutcome`（= parse → validate → walk） |
| `complete.ts` | `getCompletions(text, pos, ctx): ExprCompletion[]`（纯函数） |
| `locate.ts` | `locateOriginalPath(resultRoot, origins, resultPath): string \| null`（纯函数） |
| `types.ts` | `EvalBudget` / `EvalOrigins` / `EvalOutcome` / `CompletionContext`（不含 DOM、无 impl） |

**语法子集（按 #3 §7 + #12 §5 增补）**：字面量（数字/字符串/布尔/null/undefined/模板串/数组/对象，含展开符 `...`）、
own-property 读（任意合法 JSON 键；**不跟随原型链**）、括号下标、可选链 `?.` `?.[]` `?.()`、运算符
`+ - * / % < <= > >= === !== && || ! ?? typeof ? :`、一元 `-`/`!`/`typeof`、箭头函数（单表达式体）、
数组/字符串白名单方法、`Math.*`、`Array.isArray`、`Number/String/Boolean(...)`、`JSON.parse/stringify`。
**禁用**：赋值/自增、`==`/`!=`、`in`/`instanceof`、位运算、`**`、`new`/`function`/`class`、正则字面量、
多语句、块体箭头、`async`/`await`/`yield`、`delete`、`void` 之外的一元空值操作（`void` 也不支持）、
`forEach`/变异方法、原型链跟随、`$sel` 选中节点根。

**语义要点**：
1. 作用根 `$` = 整份文档根；顶层字段可裸引用（`data.x` ≡ `$.data.x`），**命名冲突时全局白名单优先**（`Math` 永远是 Math）。
2. 标识符解析：先查全局白名单，再查文档根 own property；都没有 → `EVAL_UNKNOWN_FIELD`（+ 拼写纠错候选 ≤3）。
3. 缺失字段分级（#12 §2）：**根级静态链**（不在任何箭头函数体内、从根标识符/`$` 起）缺字段 → 恒报 `EVAL_UNKNOWN_FIELD`；
   **元素内部**（箭头函数体内，或基值来自数组元素）缺字段 → 严格模式报错；非严格模式返回「缺失哨兵」，
   `filter/find/some/every` 按 falsy 跳过，`map` 丢弃该元素并 `skipped++`。`skipped` 只统计「缺失哨兵」导致的丢弃。
4. 结果必须是纯 JSON 值：`undefined` / 缺失哨兵不进最终结果（数组中省略；顶层结果 `undefined` → `null`，`count=0`）。
5. 确定性：同输入 + 同预算 + 同文档 ⇒ 同结果（时间预算导致的不确定性用步数优先、时间仅兜底；测试用假时钟跑确定性）。
6. `truncated`：任一产出的数组/对象元素数、或字符串长度超过 `maxResult` → 截断并置位（继续执行，不再追加；同输入可复现）。

**预算三刹车（`exprBudget(level, nodeCount)`）**：
- 时间 `maxTimeMs` 为主刹车（步数每 `EXPR_TIME_CHECK_EVERY` 步读一次时钟）；
- 步数 `max(stepBase, stepPerNode × 文档节点数)`（节点数 = 文档根值全量计数，**惰性一次 + 按根对象 WeakMap 缓存**；
  懒惰点在第一求值，不拖慢导入首帧）；
- 结果 `maxResult`（见上）。超时 → `EVAL_TIME_LIMIT`；超步 → `EVAL_STEP_LIMIT`（params 带预算数值）。

**看门狗（页面侧，§6）**：`3 × maxTimeMs` 仍无回包 → `WorkerCore.close()`（terminate）→ 惰性重建 worker →
清会话（对应用户必须重新导入文档）；toast 说明「已超时终止，文档需重新导入」（沿用既有 ReDoS 差距）。

### 4. 结果根（`expr:N`）与来源映射

- 每次 `eval` 成功创建**新根** `expr:N`（`RootKind='expression'`，`parentRootId='doc'`，N 单调递增）；
  `RootStore.put` 已有 LRU 3 淘汰（第 4 个创建时释放最久未用）。
- `Root.value` = 结果值；`Root.rowModel = new RowModel(result)`；`docRevision` = 求值时的文档版本；
  `rowVersion` 从 1 起；`createdAt/lastUsedAt` 供 LRU。结果根**没有** `source`（原文视图对 expr 根 `BAD_COMMAND`）。
- `Root.expr`（新增字段）保留：`text / strict / budget / truncated / skipped / ms / steps / seq / origins`
  （`EvalOrigins` 只在 worker 内；WeakMap 不跨线程）。
- **元素引用不复制**：walker 直接把原文档节点放进结果容器；`origins.objects` 记录「被引用的原文档容器 → 规范路径」，
  `origins.top` 记录结果顶层子项来源（标量靠它定位）。
- `exprLocate` 算法（`locate.ts`）：解析 expr 根内路径 → 逐段下探结果值；**优先用最深的已知容器来源 + 剩余相对后缀**；
  顶层标量用 `origins.top`；都没有 → `null`（计算值不可跳转）。页面「计算值无来源」toast 提示，不跳。
- **stale**：`EvalSuccess.docRevision` ≠ 当前 docRevision ⇒ stale（banner 警告 + 「重新执行」，不自动重跑）。
  结果根保留到 LRU 淘汰或换文档；文档编辑不影响结果值（引用还指向旧值图对象——若被替换则显示旧值，banner 已提示）。
- 导出 / 复制：`exportDoc(exprRootId)` + `copyNode({rootId: exprRootId, path:'$', format:'subtree'})` 已支持任意根；
  沿用 5MB / 20MB 剪贴板守卫；截断结果在 toast / 文件名提示里带标记。

### 5. 错误码与文案（引擎不内嵌文案）

| code | 触发 | params 约定 |
|---|---|---|
| `PARSE_ERR_SYNTAX` | acorn 语法错误 | `[acorn message]`（+ line/column） |
| `PARSE_ERR_ROOT_SHAPE` | 不是「单个表达式语句」/ 文本 >4096 / AST 深度 >128 / 解析栈溢出 | `['root-shape' \| 'text-length' \| 'depth']` |
| `STATIC_ERR_NODE` | 节点类型不在白名单（赋值/循环/new/正则/多语句/块体箭头…） | `[nodeType]` |
| `STATIC_ERR_CALL` | 调用点非法（非白名单方法 / 非箭头 / 非白名单全局） | `[calleeName]` |
| `EVAL_SHAPE_ERROR` | 在错误类型上取属性 / 下标（如对 `null` 读字段、数组下标非整数） | `['base-kind' \| 'index']` |
| `EVAL_UNKNOWN_FIELD` | 根级静态链缺字段 | `[field]`（+ candidates） |
| `EVAL_STEP_LIMIT` | 超步数预算 | `[maxSteps]` |
| `EVAL_TIME_LIMIT` | 超时预算 | `[maxTimeMs]` |
| `EVAL_ILLEGAL_CALL` | 越界调用（如 `JSON.parse` 结果超上限 / 非字符串参数） | `[method]` |
| `RESULT_TRUNCATED` | 结果截断（用于文案；正常回包里以 `truncated:true` 表达） | `[maxResult]` |

文案（中文）+ 中英对照表在 `app/expression-copy.ts`（一处定义、两处消费：面板内联错误 + toast/结果栏）。

### 6. 看门狗与 worker 生命周期（app 层）

- `main.ts` 把 `workerCore` 从 `const` 改为可重建（`let`+`restartCore()`）；`eval` 调用包一层：
  `Promise.race([core.eval(req), watchdog])`，watchdog = `exprWatchdogMs(level)`。
- 触发时：`workerCore.close()`（terminate）→ 新建 `Worker` + `createWorkerCore` → 重置会话/树/面板到空态 →
  toast「表达式执行超时，已终止 Worker；请重新导入文档」。这是**最后兜底**（预算正常时不会触发）。
- 普通 `eval` 的 transport 超时 5s > 所有档位 watchdog（1.5s/3s/…），所以 watchdog 先到；不依赖 transport 超时。

### 7. 设置面板第 11 项「高级预算」（ADR-0011 扩展）

- `SettingsKey` + `Settings` 增加 `advBudget: 'loose' | 'standard' | 'strict'`，默认 `'standard'`；
  `DEFAULT_SETTINGS` / `normalizeSettings` / 面板第 11 行（三档单选）三处同步；`smoke-settings` 断言 11 行 + 默认值 + 持久化。
- 求值时页面读 `settings.get('advBudget')` 传 `budget`；不与其他设置联动。
- 档位数值是预设（不可自定义数值）；改数值需显式拍板并记录理由（ADR-0013 先例）。

### 8. DOM 契约（页面 / 冒烟共同依赖，不要改名）

| 选择器 | 说明 |
|---|---|
| `.actbtn[data-panel-btn="expression"]` | 活动栏表达式按钮（`aria-label="表达式"`） |
| `#expressionPanel.panel.panel--expression` | 左面板挂载点（page.html 只留这个 div） |
| `#exprEditor` | CM6 挂载点（惰性加载；加载前显示占位） |
| `#exprRun` | 「执行」按钮（执行中 disabled + `aria-busy`） |
| `#exprStrict` | 严格模式 checkbox（会话级） |
| `#exprStatus` | 状态行：`N 项 · X ms` / 「执行中…」/ 空 |
| `#exprError` | 行内错误文案（`role=alert`，含「第 L 行第 C 列」） |
| `#exprExamples` | 示例容器（`.expr-example[data-example-index]`，点击填入） |
| `#exprHistory` | 历史容器（`.expr-history-item[data-history-index]`） |
| `#exprBar` | 结果区常驻条（`.noticebar`）：`#exprBarText` / `#exprBarBack`（返回文档树）/ `#exprBarRerun`（重新执行，仅 stale）/ `#exprBarClose` |
| `#exprBar[data-stale="1"]` | stale 态（警告色） |
| `#exprBar[data-truncated="1"]` | 截断态 |

- 表达式面板在 `body[data-panel="expression"]` 时显示（与既有 `.side` 面板同一机制）。
- 结果视图激活时树区仍为 `data-view="tree"`；`#exprBar` 显示、树根切到 expr 根；「返回文档树」清空视图态（结果根保留在 worker LRU）。

### 9. dev hook（`window.__tjv`，仅 HTTP 冒烟）

`expressionState()`（面板 + 视图 + 指标快照）、`expressionOpen()`（= `setPanel('expression')`）、
`expressionSetText(text)`、`expressionRun()`（走真实「执行」按钮，等回包）、`expressionRunText(text)`、
`expressionComplete()`（返回补全项）、`expressionExamples()`、`expressionHistory()`、`expressionSetStrict(v)`、
`expressionBack()`、`expressionRerun()`、`expressionLocate(rowPath)`（返回原文档路径）、
`expressionSetBudget(level)`（改设置）。

## 明确不做（本 slice）

- 类型感知补全（文档概要采样）→ **#28**；右栏「文档概要」占位符保持原样。
- 模式快捷键（`⌘E` 是否被 Chrome 占用需先实测）；自定义预算数值；i18n；「以选中节点为根」（`$sel`）。
- 结果根的持久化 / 收藏 / 命名；表达式自动保存到磁盘。
- 编辑表达式结果（结果只读）。

## 已知差距（记录，不静默豁免）

- 看门狗 terminate ⇒ 文档需重新导入（沿用 ReDoS 差距；预算正常时不触发）。**实现方式**：terminate 后 `sessionStorage` 标记 + 页面重载（用「重载」代替就地惰性重建全部 core 适配器，避免把 RowWindowSource / RawWindowSource / OutlineState / SearchState 的 api 引用做成可重建的第二套状态机；重载后页面空态 + toast 提示，等价效果）。
- 补全只到根级字段 + 方法字典（元素内部字段 → #28）。
- `Math` 白名单条目数以执行表单源为准（11 项：`abs/ceil/floor/round/trunc/max/min/pow/sqrt/sign/log`）。
- 结果行跳转多一次 round-trip（≈1–2ms，可接受）。
- 时间预算导致的边界不确定性：步数优先、时间兜底；确定性由「同输入同预算」保证（时间档位在极慢机器上可能先触发）。
- 文档节点全量计数在**首次求值**时惰性计算（50MB 约 3M 节点，估 30–60ms），之后按根对象缓存。
- **截断只作用于最终结果根**：`maxResult` 超限时对结果容器做 `slice` / 前 N 键重建（元素仍引用原节点、`origins.top` 逐项补齐）；结果内部原样引用的嵌套文档容器不主动扩容/截断（保持零拷贝，避免遍历整棵引用树）。
- 表达式 UI（面板 / 结果条 / 上色器）随 `main.ts` 静态 import 进首屏（`page.js` 41.0 / 45），**没有**按 ADR 预估进懒加载；实测首屏仍达标，懒加载增量全部来自 `@codemirror/autocomplete`（见「预算修订」）。

## 预算修订（2026-11-10，用户拍板 A）

- 实测懒加载 chunk 合计 **145.4KB gz**，超原预算 140 **+5.4KB**；归因 = `@codemirror/autocomplete`（#12 spec 指定的 CM6 标准包）单独 chunk **13.2KB gz**，基线本来余量 7.9KB。
- **拍板：懒加载预算 140 → 146KB gz**（首屏 45 不动；`page.js` 实测 41.0 达标）。理由：autocomplete 只在首次打开表达式编辑器时加载、首屏零影响；换自写补全弹层会偏离 spec 且自担键盘/a11y/排序质量，不划算。**显式记录，不是静默豁免**（ADR-0013 先例）。
- 同步位置：`docs/architecture/README.md` §8（预算行）与 §11（体积行）、本 ADR 验收结果。

## 验收

- `npm run check`：单测覆盖 walker 语义矩阵 / 白名单（含误杀 `Math.max` 回归）/ 预算三刹车 / 缺失字段分级 + 拼写纠错 /
  结果根 LRU 3 / stale / 截断 / 确定性 / 补全 / locate。
- `scripts/smoke-expression.mjs`（第 14 套）：执行 / 补全 / 严格模式 / 跳回 / 导出 / 复制 / 超限 / stale / 0 长任务。
- 体积：首屏 `page.js` 45 **不动**、懒加载 140 **不动**（表达式 UI + 上色器 ≈+3KB 进懒加载）；`worker.js` 15.3 → ≈72KB gz 如实记录。
- 深/亮截图：左面板 / 结果视图 / stale banner / 错误行内 / 补全列表 / 示例。
- **验收结果**：实现完成后补记在本 ADR（数字必须本机实测 + 证据）。

## 验收结果（2026-11-10 实测）

- **单测 840/840 全绿**（32 文件；725 → 840，**+115**）：`core/expression` 三套 **114**（engine 77 / complete 20 / locate 17：语法子集、白名单拒绝含 `Math.max` 回归、三刹车（假时钟）、缺失字段分级 + 纠错候选、`$.` 补全特例、origins + locate（含截断结果 `$.big[49999]`）、确定性、`countDocumentNodes`）+ `settings-state` **+1**（`advBudget` 默认/合法/非法回落）。`tsc --noEmit` 0 error。
- **冒烟 14 套串行全绿**（CDP 9883，先 `node build.mjs`）：`smoke` OK、`smoke:ext` OK、`smoke-search` **97/97**、`smoke-extension-search` **56/56**、`smoke-expand` OK、`smoke-edit` OK、`smoke-copy` **38/38**、`smoke-repair` **14/14**、`smoke-settings` **25/25**（第 11 行 + `set:advBudget` + 重启恢复 11 项）、`smoke-export` **21/21**、`smoke-raw` **26/26**、`smoke-outline` **53/53**、`smoke-fidelity` **24/24**、**`smoke-expression` 45/45（新增，第 14 套）**。
- **smoke-expression 实测覆盖**：空态 2 条通用示例 → 导入后 5 条示例（3 动态 + 2 通用，点击填入）；`filter+map` 执行 → `expr:1`、结果条「表达式结果 · expr:1 · 29 项 · 4 ms」、条高 32px 且树让位、状态栏「表达式结果 expr:1 · 只读」；补全（根字段 / `Math.` 11 项 / 数组方法并集）；非严格 `map(x => x.nope)` → `skipped=40` + 条文案「已跳过 40 项缺少该字段」、严格 → 行内错误、根级 `$.data.itemz` → 恒报错 + 「你是不是想找 items？」；语法错误 → 「语法错误（第 1 行第 21 列）」且保留上一份结果；点结果行 `$[0]` → 回文档树 + 选中 `$.data.items[11]`（`exprLocate` 三连：容器 / 嵌套 / 标量）；结果导出/复制 = 结果 JSON；严格预算 + `$.big`（60k）→ `count=50000` + 「已截断（上限 50,000）」+ `data-truncated="1"`；编辑后重进 → stale 条 + 「重新执行」→ 新根 `expr:8`；**0 长任务 / 0 page 异常 / 0 console error**；深/亮截图 8 张（`.spike/smoke/expression-*.png`）。
- **体积**（`node build.mjs --analyze`，minify gz）：`page.js` 33.9 → **41.0KB**（预算 45，+7.1：表达式面板/结果条/上色器/接线；CM6 仍不在首屏）、`worker.js` 15.3 → **58.7KB**（acorn + walker + complete/locate；ADR 预估 ≈72，实测更低）、`page.css` 7.3 → **7.8KB**（+0.5）、懒加载 chunk 合计 132.1 → **145.4KB**（**预算 140 → 146 经用户拍板**，+13.3 中 13.2 来自 `@codemirror/autocomplete`）。构建 ~68ms。
