# ADR-0003：保真以 JSON.parse 为准；失真用 BigInt 精确检测；原始文本视图用检查点 pretty 行走器

- 状态：Accepted（**2026-11-11 起部分被 ADR-0020 取代**：见下方修订指针）
- 日期：2026-10-27
- 依据：`docs/design/reassess-fidelity.md`；`.mock/1.json` + 构造病态 fixture；CfT 156 / Node v24（同 V8）。
- 相关票：#7（IR/保真）、#11（原始文本/导入）

> **修订指针（2026-11-11，#32 / ADR-0020）**：本文档以下两条结论**已失效**，以 ADR-0020 为准——
> 1. 「维持 `JSON.parse` 为唯一真相源、不换成自研解析器」→ 改为**自研无损 parser**（整数超安全范围用 BigInt；`JSON.parse` 只保留给编辑器前端 lint）。
> 2. 「大整数精度流失（`precision`）检测」→ **退场**（整数由 parser 保证精确，不再失真）；保真报告保留 `overflow` / `underflow` / `key-order`，且数字判定与 parser 共用 `analyzeNumberLiteral`。
> 原文（含 §2 检测规则表、§3 `FidelityCounts` 形状）保留为历史记录；`app/main.ts` 保真条文案不再有「大整数精度」类别。

## 背景

#7 已定：真相源用 `JSON.parse`；导入后异步线性扫描检测失真（>15 位数字 / 整数键混排），
顶部提示 + 可切原始文本对照；不做逐节点解析/反向索引。
#11 已定：原始文本视图 = 自研行虚拟化 + 轻量 JSON tokenizer，不引 CodeMirror。
本次重评估用真实样本与病态文档验证这两条是否成立，并处理 50MB minified（单行）病态。

## 决策

### 保真

1. **维持 `JSON.parse` 为唯一真相源**，不做 raw-slice 显示层、不换成自研解析器。
2. **失真检测 = 候选 + 精确判定两级**：
   - 候选：数字字面量位数 >15；整数样式键与字符串键混排（去除「整数键在前且升序」这一无损情况）；
   - 精确：对候选数字用 **`BigInt(literal) !== BigInt(Number(literal))`** 判定；另查 `!isFinite`（`1e400`）与下溢（`1e-400`）。
   - 真实样本 `.mock/1.json` 实测：>15 位启发式报 57 个，真实失真只有 **2 个**（96.5% 误报）→ 必须精确判定；
     两处失真 `String(value)` 仍打印出源串（肉眼不可见），提示是唯一发现手段。
3. **提示文案必须给精确数量**（误报会让用户忽略提示）；提示条提供「切原始文本并按行定位到第一个失真字面量附近」的出口（行号由原始视图提供，成本 0）。
4. 重复键、孤立代理项、`-0` 等已知有损类别记入文档；v1 不做逐节点标记（与 #7 一致）。

### 原始文本视图

5. **源码行虚拟化只在「有可用行」时使用**：一次 pass 测 `maxLineLength ≤ 4096` → 行偏移检查点、按行显示源文本。
6. **minified / 超长行（>4096）→ 检查点 pretty 行走器**：
   - 单遍、零依赖、无递归（显式容器栈）tokenizer；行布局等价 `JSON.stringify(value, null, 2)`；
   - 每 2048 行存一个检查点 `{lineIndex, srcOffset, depth}`（`Int32Array`）；行文本在渲染窗口时从源文本 slice；
   - 实测（50MB / 3,328,372 行）：索引 **19.5KiB**、构建 116ms（Node）/297ms（Chrome Worker）、窗口 50 行 p95 **0.084ms**；
   - 预生成 pretty 全文（867ms + 157MiB 堆 + 78.6MiB 字符串）**否决**；
   - 正确性已验证：重建全文 `join('\n')` → `JSON.parse` 与源文档深度等价。
7. **兜底**：walker 遇非法 JSON（解析失败但用户仍要看原文）→ 按 `\n` 分块 + 每块硬切 4096 字符的纯文本模式（仍虚拟化），挂「文本非合法 JSON」提示。
8. **源文本**：原始视图需要源文本；50MB 文本约 95MB（UTF-16）。是否常驻 Worker、或切视图时丢弃/重读，**留给 #7/#11 定案**（粘贴来源无法重读，倾向保留 + 在大文档警告中计入内存）。

## 后果

- 树视图与原始文本视图对「键序/大整数原文」的呈现可以不同（前者 JS 语义，后者源文本），v1 不联动（已定）。
- 检测扫描 50MB ≈288ms，应放在首帧之后的异步任务（不与首帧竞争）。
- 原始视图构建 50MB ≈297ms（Chrome Worker），可与首帧并行/延后；窗口延迟远低于一帧。
- 仍需真实样本上的重复键检测成本、真实磁盘 I/O 与 headful 复核（见重评估 §5）。

## 被否决的替代

| 方案 | 否决理由 |
|---|---|
| raw-slice 显示层（树里显示源字面量、保留键序） | 50MB token 偏移索引 88.9MiB + 237ms，且需要已移出的「字符偏移↔节点」反向索引；收益仅在极少数失真字面量 |
| 自研无损解析器替代 JSON.parse | 失去 V8 93ms/50MB 快路径，且要自定义 `-0`/`1e400` 等语义 |
| 预生成 pretty 全文 | 867ms + 157MiB，比检查点方案慢 7.5×、内存大 8000× |
| >15 位启发式直接当失真数 | 96.5% 误报，用户会学会忽略提示 |


## 修订（2026-10-27）：v1 移除原始文本视图

- 用户确认：粘贴/导入后只需要 JSON 树；原始文本视图对 mock 工作流价值低。
- v1 **不做**原始文本视图，也不保留源文本全文：解析完成后释放源文本。
- 保真扫描保留：导入时在 Worker 内做一次扫描（BigInt 精确判定），只保存「异常字面量片段」的小报告，
  不保留全文/行索引/检查点（检查点 pretty 行走器降级为未来可选能力）。
- 影响：§5–§8 的原始文本视图决策在 v1 不生效；源文本内存从「50MB 文本 ≈95MB」降为 0；
  「回到原文/对照原文」v1 不做（保真报告只给数量与片段）。

## 修订（2026-11-03）：v1 恢复原始文本视图；源文本保留；索引惰性构建

- 状态：**Accepted**（用户 2026-11-03 拍板：纳入 v1，接受「解析后保留源文本」的内存代价）
- 推翻上一条修订里「v1 不做原始文本视图 / 不保留源文本」的部分；**保真决策（§1–§4）不变**。
  票：#11（原始文本 / 导入导出 / 最近文档）、#8（修复摘要 `at` 跳行依赖它）。

### 1. 为什么回来

- mock / 接口响应工作流里「对照原文」诉求回升：截断修复后必须能看原文被切在哪——
  #8 的修复摘要 `at` 只有偏移，没有原文视图就落不了地（README §11 早已把这个依赖记成缺口）。
- v1 已有导出两种方式（ADR-0012），原文视图补上「只读地看原始字节」的另一半：
  大整数原文、`\uXXXX` 转义、键序、被截断的尾部，都只有源文本能如实呈现。
- 成本已验证可接受（`reassess-fidelity.md` §4.2 / §5.4）：50MB 索引 **19.5KiB / 构建 ~297ms（Chrome Worker）**、
  窗口 p95 **0.084ms**；且索引可惰性构建，不占首帧。

### 2. 数据与生命周期（源文本保留）

- `load` 解码出源文本后**保留**在 Worker 内的 doc 根上（`Root.source.text`），直到文档被替换
  （v1 单文档：替换 = 旧根丢弃；#18 多文档时随标签关闭释放）。
- 内存口径：50MB 文本 ≈95MB（UTF-16），应计入导入时 >50MB 的预估内存提示——**该导入提示本身尚未实现**
  （#11 余项「导入 UX」的一部分；本 slice 没有新增 >50MB 拦截/弹窗，源文本内存目前是静默常驻，
  记入 README §11 已知差距）；**永不落盘**
  （`storage.local` 只存设置与视图状态，红线不变）；**不出 Worker**——原文窗口只回行文本，
  整份原文只有「复制原文」按阈值回包（§4）。
  - **修订（2026-11-09）**：导入体积提示**已实现**（#11 余项收口）。判定 = `LoadReply.meta.bytes > LARGE_DOC_WARN_BYTES`（**50 MB 十进制 = 50,000,000**，放 `protocol/versions.ts`），不新增协议字段、不阻断导入；UI = 工具栏下方 32px warn 提示条（`#docWarnBar`，与修复条同款样式、`role=status`/`aria-live=polite`、可关闭、只关条不释放源文本），文案给出「源文本常驻 ≈2× 文件大小（UTF-16）+ 值图另计」的估算。规格见 `docs/design/direction.md` §6「导入体积提示条」。
- 临时修改（#16）不改变源文本：原文视图永远显示**导入时的原文**；有临时修改时视图内标注
  「原始文件文本，不含临时修改」。
- 视图模式（树 / 原文）属于视图状态：`UiState.viewMode`，本地持久化（ADR-0011 §2 布局态口径）。

### 3. 行索引（三模式 + 惰性构建）

首次进入原文视图（或修复摘要跳行）时才构建索引，不占首帧、不阻塞导入。

| 条件（Worker 一次 pass 探测） | 模式 | 行为 |
|---|---|---|
| 源文本非法（截断修复后的文档） | `plain` | 按 `\n` 分行 + 每行硬切 4096 字符；纯文本、无语法高亮 |
| `maxLineLength ≤ 4096` | `source` | 源码行虚拟化：行文本 = 源切片，保留用户原始格式与换行 |
| 否则（minified / 超长行） | `pretty` | 检查点 pretty 行走器：行布局 = `JSON.stringify(value,null,2)` 等价，行文本仍是源切片 |

- 形状探测一次 pass（`indexOf('\n')` 扫描，50MB 7.1ms）得到行数与最长行。
- 检查点每 **2048** 行一个 `{lineIndex, srcOffset, depth}`（`Int32Array`）；取任意窗口时从最近检查点
  重走 ≤2048 行（`pretty` 的 walker 只依赖 `(pos, depth)`，可重放）。
- 单行显示上限 **4096** 字符（防 DOM 巨行；`pretty` 下的超长标量会超限）：超出部分截断显示并在
  `RawWindow.truncated` 里标记；**复制原文**不受此限（服务整份文本）。
- 空文档 / 尾换行 / CRLF 按源码行原样处理（行文本 `slice`，不做规范化）。

### 4. 协议 seam（S1 扩展，不新增进程边界，不新增 rowVersion）

| Command | Reply | 不变式 |
|---|---|---|
| `rawOpen { rootId }` | `RawMeta(mode,totalLines,chars,maxLineLength,buildMs?,damaged?)` | 幂等；首调构建索引；只读，不推任何版本 |
| `rawWindow { rootId, seq, start, count }` | `RawWindow(rootId,seq,start,lines,totalLines,mode,truncated?)` | 只回行文本（≤4096 字符/行）；不物化全文；seq 只用于丢弃迟到回包 |
| `rawLocate { rootId, offset }` | `RawLocateReply(line,totalLines)` | 源文本偏移 → 1-based 源行号（修复摘要 `at` 跳行） |
| `rawSource { rootId, maxBytes }` | `RawSourceReply(text,bytes)` | 整份原文；`> maxBytes` 抛 `TOO_LARGE`（20MB 剪贴板守卫，ADR-0012 同口径） |

- 原文不随展开/编辑变化（只在文档替换时消失），所以**不需要 `rowVersion`**；doc 根生命周期即版本。
- 视图侧新增：viewmodel `RawWindowSource`（单飞/合并/seq 丢弃/overscan，与 `RowWindowSource` 同纪律）+
  view `RawView`（固定行高虚拟化 + 行号 gutter + 横向滚动）；高亮只在主线程对屏幕内行做
  （`shared/json-lex` 的 `lexLine`，0.2µs/行），**token 偏移不进协议**。

### 5. 交互（v1）

- 工具栏 `[树 | 原文]` 分段控件切换视图；模式进 `UiState.viewMode`，刷新后恢复；不加快捷键
  （避免与浏览器 / 搜索快捷键冲突）。该控件是**功能件**，视觉走查归 #21。
- 原文视图**只读**：行号 + 单行不换行（横向滚动）+ 语法高亮；不选中节点、不驱动树、不联动
  （CONTEXT「双向联动」v1 仍不做）。**2026-11-11 更新**：该 v1 结论已由 ADR-0019 取代——双向定位已实现，
  但入口是**显式按钮**（原文行 gutter / 树行浮条 + 右键菜单），仍不做自动联动 / 选中驱动。
- 视图头是 **30px 视图 chrome**（模式标签 / 条件提示 / 行数 /「复制原文」），不是文档内容区的提示条；
  提示只在有话说时非空（不占额外高度）；索引构建耗时只在 dev hook / 冒烟里暴露，不进常驻 UI。
- 视图内提示文案：
  `pretty` → 「源文本为单行（minified），按规范格式显示；行内容仍取自源文本」；
  `plain` → 「原始文本被截断（已修复），此处显示原始字节」；
  有临时修改 → 「原始文件文本，不含临时修改」。
- **复制原文**按钮：整份源文本；>20MB 拒绝并提示（与 ADR-0012 复制 JSON 同口径）。
- **修复摘要 `at` 变为可跳转**：点击 `@at` → 切原文视图 → `rawLocate` → 滚到行 + 短暂高亮
  （`plain` 模式下即截断位置所在行）。这是 #8「跳行随 #11」的落地。

### 6. 明确不做（v1）

- 不做树 ↔ 文本双向联动 / 反向定位索引（CONTEXT 已定 v1 不做；将来要做得重新评估 token 偏移索引成本）。
  **2026-11-11 更新**：已由 ADR-0019 取代——检查点 + 祖先键栈增量索引实测 50MB ≈73–113KiB、命中 0.16ms 级，
  未采用「全量 token 偏移索引」。
- 不做源文本编辑（ADR-0006：唯一编辑入口是子树 JSON；原文永远只读）。
- 不做「格式化」一次性 pretty 全文（867ms / +157MiB，且原文视图已给 pretty 布局）。
- 不做原文内查找（搜索仍是值图/路径语义，见 #10）。
- **解析失败的文本**（未产生值图）仍只在导入层报 `PARSE`，不能直接进原文视图；把它做成
  「报错也可看原文」的出口是后续 backlog（需要无值图的文档会话，超出本 slice）。

### 7. 验收口径

- 单测：三模式窗口逐字、检查点边界可重放（`cpEvery` 可注入）、`locate` 偏移→行、
  damaged/plain、超长行截断、空文档 / 尾换行；`DocService` 4 条命令 + `TOO_LARGE` 守卫 + 只读不推版本。
- 冒烟：`[树|原文]` 切换与持久化、`source`/`pretty` 两种模式行文本逐字、滚动虚拟化行数 ≤ 屏行+overscan、
  修复摘要 `at` 跳行、复制原文逐字、0 长任务 / 0 console error。
- 体积：`page.js` gz 预算 45 不变；原文索引与源文本都在 Worker（不进 page.js）。

## 修订（2026-11-09）：保真提示落地（#23）——扫描形态、报告形状、提示条与跳转

- 状态：**Accepted**（实现记录；§1–§4 的保真决策不变，本节只定「怎么落地」）
- 票：**#23**（本修订是其 Q1–Q7 的拍板落点，逐条按票内推荐执行）
- 触发：#11 原文视图复评的**触发条件**就是本条落地（#11 评论 6603943029）

### 1. 扫描时机与 seam（Q2 / Q5 / Q6）

- `load` 回包**完成后**，app 显式调新命令 **`fidelity { rootId }`**（不是事件、不是 `load` 内同步扫描）：
  首帧不等扫描，扫描失败/超时不影响已打开的文档。
- Worker 内**单趟线性扫描源文本**（不重解析值图），每 **256K 字符让出一次事件循环**（宏任务，`MessageChannel`），
  每段检查取消；换文档时 app 递增 `fidelitySeq` 丢弃迟到回包，Worker 侧按根对象身份校验。
- **不显示「检查中」进度**（<300ms 量级）；扫描超时不额外处理（沿用 5s 命令超时兜底）。
- 生命周期：报告只活在**当前文档会话内存**（`DocService` 内 `WeakMap<Root, report>`，按根对象身份缓存；
  根被替换/关闭即随对象回收），**不落盘**、不进 storage；
  编辑（临时修改）**不重扫**——失真针对源文本，源文本不变。

### 2. 检测范围（§2 的两级判定落地）

| 类别 | 候选 | 精确判定 | 报告 `kind` |
|---|---|---|---|
| 大整数精度流失 | 整数位数 > 15；**带指数**时看有效数字位数 > 15 | 整数：`BigInt(literal) !== BigInt(Number(literal))`；带指数：十进制规范化后与 `Number(lit).toExponential()` 的 `(digits, exp)` 比对（code review 收口：原实现漏了 `1234567890123456789e0`） | `number` / `reason:'precision'` |
| 上溢 | 带指数且 `Number(lit)` 非有限 | `!isFinite(Number(lit))`（如 `1e400`） | `number` / `reason:'overflow'` |
| 下溢 | 带指数且 `Number(lit)===0` 而有效数字非零 | 同上（如 `1e-400`） | `number` / `reason:'underflow'` |
| 整数样式键重排 | 对象内出现数组下标样式的键（规范整数串且 < 2^32−1） | 去掉「整数键全部在前且升序」的无损情况；**键先按 JSON 转义解码**；**重复下标键不参与顺序判定**（`{"1":a,"2":b,"1":c}` 的枚举顺序仍是 `1,2`，真损失是重复键吞并 → 不报 key-order） | `key-order` |

- **不检测（v1 已知差距）**：高精度**小数**（`0.1234567890123456789`）——ADR §2 的 BigInt 精确法不适用，
  用字符串往返比较会引入格式误报；重复键 / `-0` / 孤立代理项仍只记录不标记（§4 不变）。
- 命中顺序 = **源文本顺序最靠前**的 `FIDELITY_MAX_HITS`（100）条；`counts` 全量、`truncated` 标明截断。
  实现上按 offset 有序插入并淘汰最大 offset（code review 收口：原先「先按发现顺序截断、最后排序」会漏掉
  「对象 `{` 靠前、但直到 `}` 才产出」的键序命中）。

### 3. 报告形状

```ts
interface FidelityHit {
  kind: 'number' | 'key-order';
  offset: number;                                  // 源文本 UTF-16 偏移（rawLocate 直接可用）
  snippet: string;                                 // ≤48 字符的异常片段
  reason?: 'precision' | 'overflow' | 'underflow'; // kind==='number'
  literal?: string; parsed?: string;               // 「原文 vs 解析后」对照（截断）
}
interface FidelityCounts {
  number: number;      // = precision + overflow + underflow
  precision: number;   // 大整数精度流失
  overflow: number;    // 1e400 → Infinity
  underflow: number;   // 1e-400 → 0
  keyOrder: number;    // 整数样式键重排（每对象最多 1 条）
  total: number;       // = number + keyOrder
}
interface FidelityReport {
  status: 'none' | 'found';   // 取消 = 命令回 CANCELLED，没有第三种状态
  counts: FidelityCounts;
  hits: FidelityHit[];                             // 源文本顺序最靠前的 ≤100 条
  truncated: boolean;
  scanMs: number;
}
```

### 4. 提示条与跳转（Q1 / Q4 / Q7）

- **第三条 32px 常驻提示条** `#fidelityBar`（与修复条同款视觉、`role="status"`/`aria-live="polite"`、`×` 可关）。
  DOM 顺序：**修复条 → 导入体积提示条 → 保真条**（Q1：修复在前、保真在后；三条各自独立可关）。
- 文案给**精确数量**：「检测到 N 处失真（大整数 M 处 / 整数键顺序 K 处）—— 查看原文」。
- 主点击 / 「查看原文」按钮 = **切原文视图 + `rawLocate(第一个命中的 offset)` + 行 flash**（与修复摘要 `at`
  完全同一条链路 `revealRepairOffset`）；逐条列表跳转留 v1.1（Q4）。
- 无失真（`status:'none'`）→ 条不出现；`status:'skipped'`（被取消）→ 不出现、不留痕。
- 视觉细节归 **#21**，本 slice 只做最小可用形态（Q7）。

### 5. 实现结果与偏差（2026-11-09）

- **实测对拍**：`.mock/1.json`（879,330 字符）上 >15 位候选 **57** → 精确判定后真失真 **2**（`offset 14871 / 339094`，均为 `precision`），key-order **0**；与 `prototype` 原型脚本逐条一致。另用 5,860 组混合键排列与真实 `Object.keys(JSON.parse(src))` 对拍，**0 不一致**（含 `\u0031` 转义键、`4294967294/4294967295` 边界、前导零 `01`）。
- **性能**：合成 50MB **≈330ms / 199 次让出**（ADR 估 288ms，同量级）；10MB 在 Chrome Worker 内 **scanMs ≈48ms**。
- **偏差 1（已收口）**：`status:'skipped'` 不再预留——取消语义是回包 `CANCELLED`（与 load/search 同口径），第二种状态从未产出；code review 后**删掉** `'skipped'` 与 `skippedReason`，避免读代码的人以为存在第三条路径。
- **偏差 2（已采纳）**：**超长纯整数**（如 400 位）按 `overflow` 报：`JSON.parse` 同样把它改写成 `Infinity`，不报会漏；ADR 表格里 overflow 的候选只写了「带指数」，实现按「结果非有限」判定。
- **偏差 3（已采纳，2026-11-09 二次收口）**：**重复的整数样式键不参与键序判定**（`{"1":a,"2":b,"1":c}` 的枚举顺序仍是 `1,2`）。
  首版只用了严格 `<`，仍会把 `1,2,1` 报成键序回退；code review 后改为「只让首次出现的下标键参与顺序判定」，
  重复键吞并留给 §4 的「只记录不标记」类。单对象已见下标键集合上限 `FIDELITY_KEY_TRACK_MAX=4096`——
  超过后放弃重复键追踪（超大数组样式对象的已知边界）。
- **回归修复（重要）**：让出必须用**宏任务**。最初默认 `await Promise.resolve()`（微任务）不会让 Worker 处理排队的命令，整段扫描期间窗口/大纲/搜索被卡住——实测 10MB 时大纲 expand 从 **1ms 退化到 34ms**（`smoke-outline` 52/53 红）。改为共享 `MessageChannel` 宏任务让出（`macroYield()`，避开 `setTimeout(0)` 连续调用 5 次后的 ~4ms 钳制）后回到 1ms 级，`smoke-outline` 复绿。
- **验收**：`smoke-fidelity` **24/24**（新增套件，`npm run smoke:fidelity`；截图检查改为真断言文件存在）；单测 **486/486**（`core/fidelity` 38 / `doc-service` 97）。

### 6. code review 收口（2026-11-09，Standards / Spec 双轴）

- **`DocumentMeta.fidelity` 是票的初估，未采纳**（显式登记为偏差）：报告改为 `fidelity {rootId}` 命令 + `DocService` 的
  `WeakMap<Root, report>` 缓存 + app 会话变量，`LoadReply.meta` 形状不动——理由是扫描在首帧之后，`meta` 里装不下
  「后到的报告」，而给 `load` 加事件/二次回包会把协议复杂化。§1 已按此写；本条是**与票内初估的显式偏离**。
- **文案按类别拆开**（用户可见的正确性修复）：`counts` 新增 `precision`/`overflow`/`underflow`，保真条不再把上溢/下溢
  标成「大整数精度」（原实现 `counts.number` 统一标「大整数精度 N 处」，与「精确数量」的本意冲突）。
- **带指数的尾数精度**纳入检测（`1234567890123456789e0`、`1.23456789012345678e18`）：用十进制规范化比对，
  仅对有效数字 >15 位的候选做，成本可忽略；**高精度小数仍不检测**（§2 差距不变）。
- **截断改为「源顺序最靠前」**：按 offset 有序插入 + 淘汰最大 offset，内存恒为 100 条；修掉「键序命中晚产出被挤掉」。
- **57→2 口径自动化**：新增单测「57 个 >15 位数字里 55 个可精确表示、2 个不可 → counts.number=2」（不依赖未跟踪的 `.mock` 样本）。
- **文档/常量同步**：README §3 模块清单补 `fidelity`/`FidelityCounts`/`shared/timing`；`build-and-test` 目录树把
  `fidelity.ts` 从 `import/` 挪出；`seams` 的 `CANCELLED` 行补 fidelity 来源；`FIDELITY_YIELD_CHARS` 改名（原 `_BYTES` 名不副实）；
  `now`/`roundMs` 抽到 `shared/timing`。
- **技术债清理（第二轮）**：体积提示条与保真提示条的「显隐 + 文案 + 关闭」抽成 `view/panels/notice-bar.ts`
  （标记约定 `[data-notice-text]`/`[data-notice-close]`/`[data-notice-action]`，CSS 统一 `.noticebar*`，两条各留 id 供测试）；
  `Frame` 改判别联合（数组帧不再分配对象专属字段）；删掉永不产出的 `'skipped'`/`skippedReason`；
  去掉 `revealFirstFidelityHit` 这层 Middle Man；`indexKeyValue`/`keyIndexValue` 注明是「规范实现 + 零分配快速路径」，
  不是待合并的重复代码。

## 修订（2026-11-11 晚）：多命中导航 + 精确对照（#31，ADR 原决定 §4 的 v1.1 项提前落地）

用户反馈两件事：① 保真条「查看原文」只跳第一处，无法定位第二处；② 对比原文与树，显示值一模一样，
困惑「为何说失真」。第 ② 条的事实：`297532588187238660` 不是该量级 double 步长（64）的倍数，
`JSON.parse` 实际得到 `...656`（差 4）；但 JS 打印 double 用**最短往返十进制**，恰好仍是 `...660`，
所以原文/树/导出串都看不出差异。检测器用 BigInt 精确判定，不是误报——缺口在**呈现层**。

**决策**

1. **`FidelityHit.parsed` 改为精确整数值**（`core/fidelity.ts` 的 `parsedExact`）：`Number.isInteger(value)`
   时用 `BigInt(value).toString()`（如 `...660` 的 `parsed` 是 `...656`），Infinity / 非整数保持 `String(value)`。
   检测规则、候选阈值、counts 全部不变——只改「解析后」的呈现口径，让显示串相同也能看出差异。
2. **保真条多命中导航**（`#fidelityBar` 内）：命中 ≥2 条时显示「`‹` 1/N `›`」；`查看原文` / 上一处 / 下一处
   都走 `jumpFidelityHit(index)`：更新计数 → **条文案追加当前一处对照**（「· 第 i/N 处：原文 X → 实际 Y」）
   → 切原文 + `revealRepairOffset` 高亮对应行（与修复摘要 `at` 同一条链路）。
   **首尾循环**（2026-11-11 晚用户补充）：末条再点「下一处」回到第一条、第一条点「上一处」回到末条，两端按钮不禁用。
   单条命中零视觉变化；多条才出现导航。
3. **精确差异提示**：跳任一处时状态栏给「失真：原文 X → 实际 Y」（上溢/下溢/键序有各自人话文案）。
   状态栏**常驻**（2026-11-11 晚用户反馈「右下角太不明显」）：不再 3s 自动消失，直到下一次跳转 / 换文档 / 切标签。
4. **预算**：`page.js` **47 → 48KB gz**（用户 2026-11-11 晚拍板；本次 +0.6：条内导航/循环 + 条内常驻对照 + 常驻状态栏）。

**验收**：单测新增「显示串相同但实际不同 → parsed 精确整数」回归（`tests/unit/core/fidelity.test.ts`）；
`smoke-fidelity` **29 → 35/35**（nav 可见/计数与条内对照、逐处跳转行号、首尾循环、状态栏常驻、精确差异 5 条
+ 截图 `fidelity-nav.png`）；`page.js` 47.6/48、`page.css` 8.2、`worker.js` 61.1；深/亮截图
`.spike/smoke/fidelity-nav-light.png`、`.spike/smoke/fidelity-hint-light.png`。

**范围外（仍不做）**：命中明细列表/弹层；扫描检测规则与阈值；`literal` 仍是源文本片段（≤48 字符截断）。
