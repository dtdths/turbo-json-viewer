# ADR-0004：导入走二进制 transfer；截断修复只做语法闭合并保留 provenance

- 状态：Accepted
- 日期：2026-10-27
- 依据：`docs/design/reassess-fidelity.md` §5–§6；真机 CfT 156 Chrome 扩展页 + Node。
- 相关票：#11（导入/导出/原始视图）、#8（截断修复）

## 背景

#15/#11 已定：三条导入入口（paste / 从剪贴板导入 / 文件选择+拖放），零权限、**文档文本永不进 DOM 文本节点**；
#15 记录 10MB 文本进 textarea 阻塞约 40s。但「文件读取后如何把 50MB 交给 Worker」未定；
#8 要求截断修复只做保守语法闭合、修复标记与摘要。本次实测了导入各路径与修复原型。

## 决策

### 导入

1. **文件入口 = `file.arrayBuffer()` → `postMessage(buffer, [buffer])` transfer → Worker `TextDecoder` → `JSON.parse`**。
   - 实测 50MB：主线程 34.5ms、**0 long task**、堆增量 0；Worker decode 52.6ms + parse 88.1ms，到 paint 182.7ms；
   - `file.text()` 在主线程解码并产生 **50ms long task** + 48MB 堆 → **不采用**；
   - `file.stream()` + transferable stream 总时长更优（149.9ms）但 Worker 需拼块（+50MB 堆）且实现复杂 → 作为大文件后续优化。
2. **粘贴入口 = 监听 `paste` + 处理器内读 `e.clipboardData` + 立即 `preventDefault()`**，文本永不进 DOM；
   实测 10MB/50MB 处理器耗时 0ms。
3. **从剪贴板导入** = 点击回调内 `navigator.clipboard.readText()`（零权限实测可用），直接交给 Worker。
4. **红线**：任何路径都不得把整份文本写入 textarea/contenteditable/DOM 文本节点（实测 10MB 文本 + 强制布局 = **75,618ms**）。
   原始文本视图按 ADR-0003 逐行虚拟化。
5. 导入后 Worker 内保留源文本的策略见 ADR-0003 §8（待 #7/#11 定案）。

### 截断修复

6. **只做语法层闭合，不猜内容**：补未闭合的 `{`/`[`/字符串引号、去掉尾逗号、截断处按「已完整解析的最大前缀」收尾；
   所有补全点写入 `doc.repair = { truncated: true, applied: [{offset, kind, inserted}] }`，视图顶部提示 + 修复摘要；提供关闭修复只看错误的开关。
7. **导出保留修复标记**：文件名后缀 + 内容说明（修复只发生在语法层；数据不完整可能影响语义）。
8. 实测：18 个截断 fixture（半截字符串/未闭合括号/尾逗号/截断数字等）→ 16/16 检测、16/16 修复后 `JSON.parse` 通过、
   **0 处内容猜测**、总耗时 3.75ms；规则表见 `reassess-fidelity.md` §6。

## 后果

- 导入主线程保持零 long task；文件与粘贴两条路径都不创建 DOM 文本节点。
- 修复结果是「合法但可能不完整」的文档，必须靠 provenance/摘要让用户自行判断可信度（符合 CONTEXT 的修复标记/修复摘要）。
- 真实磁盘 I/O、真实系统剪贴板与 `File` 选择器交互仍需 headful/人工复核（harness 只用内存 Blob 构造 File）。

## 被否决的替代

| 方案 | 否决理由 |
|---|---|
| `file.text()` 直接进 Worker | 50ms 主线程 long task + 48MB 堆；违反「UI 不冻结」 |
| 全量 textarea / contenteditable 承载文本 | 10MB → 75.6s 布局阻塞，产品体验单点毁灭 |
| 修复时猜测缺失内容（补值/补键） | 会静默改变语义；违背「修复摘要让用户自行判断」 |
| 静默修复（不提示） | 用户无法知道数据不完整 |

## 修订（2026-10-30）：粘贴入口按「文档会话」路由，导入改为显式导入层

> 由 `grill-with-docs` 收口（决策记录见 #11 评论）。本修订**不改**上文 1–8 条的传输/修复/provenance 技术决策，
> 只改「paste 入口何时生效」这一交互契约。术语见 `CONTEXT.md`「文档会话 / 空态 / 导入层」。

- **文档会话是导入的语义边界**：初始空态 = 粘贴/拖放/文件即打开文档；文档已打开时，导入是**显式替换动作**。
- **导入层（Import Layer）**：未打开文档 = 初始空态；已打开文档时由工具栏「导入」、文件 chip 或 `⌘O` 唤起，
  复用空态卡 + 覆盖警示（「将替换当前文档 xxx（size）；原文件不受影响」）+ 取消；视觉为半透明遮罩，
  工具栏 / 文件 chip / 状态栏保持可见。
- **层内即确认**：导入层打开时，`⌘V` / 拖放 / 选择文件解析成功即替换（不再二次确认）；失败留在层内显示
  `PARSE` 等错误，层不关闭、原文档保留。
- **文档已打开且导入层关闭时**：页面级 `⌘V` **不处理、不 `preventDefault`、不导入**（输入控件内仍走浏览器原生粘贴，
  见同日早先的 editable-target guard）。
- **外部拖放**（文档视图内）：打开导入层并把文件暂存为「待替换」，用户点「替换当前文档」才导入；
  导入层内拖放则直接导入。
- 取消：`Esc` / 关闭按钮 / 点遮罩 → 关闭导入层，原文档与视图状态不变；在途导入回包按 `loadSeq` 丢弃。
- **从剪贴板导入**按钮（上文决策 3）仍待 #11 实现，本次不新增；`navigator.clipboard.readText()` 路径不变。
- 安全边界不变：导入仍只走 `core.load` → Worker 解析，文本不进 DOM；替换不影响磁盘原文件。

## 修订（2026-11-03）：截断修复实现方案（#8 / slice 6.0）

> 依据：上文 6–8 条与 `docs/design/reassess-fidelity.md` §6.2 的精确规则表；用户拍板「下一刀 = #8」。

上文已定「只做语法层闭合、保留 provenance、导出带标记」；本节把**实现形状**定下来，不改产品语义。

### 1. 模块 seam：`core/repair.ts` 纯函数（不抛错、不碰 Node/DOM）

```ts
repairTruncatedJson(source: string): RepairAttempt
// RepairAttempt = { status: 'none' | 'repaired' | 'unrepairable',
//                   text?, truncatedAt?, counts?, ops?, summaryText?, unrepairableReason? }
```

- **扫描器驱动**（不是拿 V8 错误串做字符串手术）：单趟走状态机（容器栈 / 字符串 / 数字 / 字面量 / 成员状态），
  在 EOF 处按 §6.2 的 6 条规则决定「删多少、补多少」；产出 `ops` 的 `at` 一律指向**原文本**偏移。
- **自校验**：修复结果必须 `JSON.parse` 通过才算 `repaired`；否则 `unrepairable`（reason = `not-eof` / `still-invalid`）。
- **非 EOF 形态**（`{"a":1}XYZ`、`{a:1}`、`[1,2]garbage` 等）→ `unrepairable`，**不猜内容、不静默截断**。
- `status: 'none'` 只在原文本本来可解析时返回（两个「无需修复」fixture）；导入管线只在 `JSON.parse` 失败时才调用本模块。

### 2. provenance 形状：按 §6.3 落 `RepairProvenance`（替代原 `{truncated, applied[]}` 占位）

```ts
RepairProvenance = { status, truncatedAt?, parseError?, summaryText?, counts?, ops? }
RepairCounts = { brackets, quotes, commas, deletedChars }
RepairOp = { at, op: 'insert' | 'delete', text, scope: 'container'|'string'|'token'|'member'|'comma', note }
```

- `meta.repair` **只在 `repaired` 时挂上**；`unrepairable` 仍抛原 `PARSE` 错误（带行列），不产生值图。
- `summaryText` 由 core 生成（中文、零计数项省略），UI 直接展示；`ops[].note` 供摘要列表逐条展示。
- `doc-service.load` 在 `meta.repair` 存在时补发既有 `CoreEvent { t: 'repair' }`（事件类型早已定义，此前无人发）。

### 3. UI：顶部修复条 32px + 摘要 + 关闭（v1）

- **修复条**（direction §4 的 32px 修复条）：`toolbar` 下方、常驻到用户关闭或重新导入；
  文案 = `summaryText`；右侧「摘要」展开/收起 ops 列表（每条一行 `note`）、`×` 关闭；`aria-live="polite"`、`role="status"`。
- **状态栏**加「已修复截断」角标（与「只读 · 原文件不变」并列），关闭修复条后角标保留（数据仍不完整）。
- 「关闭修复、只看错误」的**偏好开关延后到设置面板**（`ViewStateStore` 未接线）：v1 总是尝试修复；
  这是与上文第 6 条的唯一偏差，记入 README §11 已知差距。

### 4. 导出：文件名后缀（不往 JSON 里塞注释）

`base` + `-truncated-repaired` +（有临时修改时 `-edited`）+ `.json`；内容 = 修复后的值图。

### 5. 验收

- 单测：`tests/unit/core/repair.test.ts` 覆盖 `reassess-fidelity.md` §6.1 的 **18 个 fixture**（16 截断 + 2 无需修复）
  + 4 个 `unrepairable` 反例；断言修复文本逐字、`counts`、`ops` 偏移、`summaryText`、自校验。
- 管线：`doc-service` 单测断言「截断 → 值图 + `meta.repair.status='repaired'` + repair 事件」「非 EOF → 原 `PARSE`」。
- 冒烟：`scripts/smoke-repair.mjs`（CF headless）——截断粘贴 → 修复条文案/摘要展开/状态栏角标/关闭；
  非截断错误仍报错；合法 JSON 无修复条；导出文件名带后缀；0 异常 / 0 console error。
