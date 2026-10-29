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
