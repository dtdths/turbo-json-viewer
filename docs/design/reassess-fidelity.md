# 重评估：JSON 保真 / 原始文本视图 / 导入管线 / 截断修复

> 任务：共享任务 `task-3`（重评估小组 fidelity-text）。对应 issue 决策上下文 [#7](https://github.com/dtdths/turbo-json-viewer/issues/7)（保真）、[#11](https://github.com/dtdths/turbo-json-viewer/issues/11)（原始文本视图 / 修复 / 导入 UX）、[#8](https://github.com/dtdths/turbo-json-viewer/issues/8)。
> 交付物：本文 + `prototype/p1/bench/fidelity/**`（可复跑脚本）+ `prototype/p1/fixtures/fidelity/**`（fixtures 扩展）。
> 结论标注：**确认** = 原决策被实测支持；**修正** = 方向对但细节要改；**推翻** = 原决策不成立。

## 0. 结论速览

| # | 决策点 | 结论 | 一句话证据 |
|---|---|---|---|
| 1 | 真相源 = Worker 内 `JSON.parse` | **确认** | 50MB/2.96M 节点解析 93.2ms（#15），失真只在有损类别上出现，`.mock/1.json` 全部真实失真仅 **2 处**（见 §2） |
| 2 | 异步线性扫描检测「>15 位数字 / 整数样式键混排」 | **修正** | 扫描本身可行（50MB **288ms**，178MB/s），但**必须用 BigInt 精确判定**：`.mock/1.json` 上「>15 位」启发式报 57 个、真实失真只有 **2 个**（57 报里 55 个是误报）；整数键规则也要收紧（「整数键后跟字符串键」不算失真） |
| 3 | 「检测 + 顶部提示 + 切原始文本」不做逐节点定位 | **确认** | raw-slice 显示层要保留 token 起止偏移，50MB 实测 **88.9MiB 索引 + 237ms**，且需要 #7/#11 明确移出的「反向定位索引」；收益仅在 2/2,000,000 量级的字面量上 |
| 4 | 原始文本视图 = 自研行虚拟化 + 轻量 tokenizer | **确认（且找到更便宜的架构）** | minified 50MB = 单行 → 源码行虚拟化不可用；**检查点 pretty 行走器**：3.33M 行的视图索引仅 **19.5KiB**、构建 **116ms**、任意窗口 p95 **0.084ms**；预生成 pretty 文本要 **867ms + 157MiB 堆 + 78.6MiB 字符串**（大 8000×） |
| 5 | 导入三入口，文档文本永不进 DOM | **确认（附精确归因 + 路径排序修正）** | **10MB 文本进 DOM 文本节点后强制布局 = 75,618ms（75 秒）**，比 #15 记录的 40s 更极端；`paste` 事件处理器读 `clipboardData` **0ms**；**50MB 上 `file.text()` 产生 50ms 主线程 long task，`arrayBuffer`/`stream` 路径 0 long task** → 文件入口必须走 bytes+transfer，不能走 `file.text()`（见 §5.5） |
| 6 | 截断修复 = 保守语法闭合 + 摘要 + 开关 | **确认（并给出可实现的精确规则表）** | 18 个截断 fixture：**16/16 检测、16/16 修复后 `JSON.parse` 通过、0 处内容猜测**，总耗时 3.75ms（见 §6） |

---

## 1. 方法与环境

| 项 | 值 |
|---|---|
| 机器 | Apple M4 / 32GB（与 #15 同一台） |
| Chrome | **Chrome for Testing 156**（品牌版 ≥137 忽略 `--load-extension`），`--headless=new --no-sandbox`，由 `prototype/p1/lib/chrome.mjs` 启动 |
| Node | v24.13.0（**与 Chrome 同 V8**：`JSON.parse`、字符串/正则/tokenizer 的数字可直接对照；主线程阻塞与内存必须在 Chrome 里测，见 §5） |
| 样本 | `.mock/1.json`（879,330 字符，真实形态）、`.spike/samples/{2mb,10mb,50mb}.json`（**全部 minified 单行**，50MB = 49,840,274 字符 / 2.96M 节点） |
| 负载 | 测量期间其他小组成员在跑重负载 Chrome，`loadavg` 4.3–5.3（脚本每次打印 `env.loadavg`）；每项 ≥3 次取中位数 + p95，变体交错执行 |

口径：
- Node 侧全部是 `performance.now()` / `hrtime` 包住目标调用，中位数 + p95 + 全样本都打出来（脚本输出 JSON，便于 Lead 安静环境复测）。
- Chrome 侧用页面内 `PerformanceObserver('longtask')` 统计主线程阻塞，`performance.memory.usedJSHeapSize`（脚本带 `--enable-precise-memory-info`）取堆增量，`double-rAF` 取 paint 时刻。
- 未测项在 §8 明说；本文所有数字都能用 §9 的命令重跑。

## 2. Q1 保真量化：`JSON.parse` 到底丢什么

### 2.1 失真矩阵（`fixtures/fidelity/data/pathological.json`，逐项 sizeof 验证）

| 源字面量 | `JSON.parse` 值 | `String(value)` / 序列化 | 失真类别 | 后果 |
|---|---|---|---|---|
| `1234567890123456789` | number | `1234567890123456800` | **精度丢失** | 值变；树显示与原文不同 |
| `9007199254740993`（2^53+1） | number | `9007199254740992` | **精度丢失** | 经典边界 |
| `9007199254740992`（2^53） | number | 同 | 无损（可精确表示） | — |
| `18446744073709551616`（2^64） | number | `18446744073709552000` | **值精确但文本不同** | 值可往返，显示串≠源串 |
| `1234567890123456789012` | number | `1.2345678901234568e+21` | **精度 + 表示法双丢** | 显示变成科学计数法 |
| `-0` | number | `0` | **负零丢失** | `JSON.stringify` 写出 `0` |
| `1e400` | number | `Infinity` → 序列化 `null` | **非有限值** | 树里显示 Infinity，导出变 `null` |
| `1e-400` | number | `0` | **下溢** | 值变 0 |
| `{"a":1,"a":2}` | `{a:2}` | `{"a":2}` | **重复键** | 前者静默消失，`JSON.parse` **无 reviver 钩子**可观察 |
| `"\ud800"`（孤立高位代理） | JS 字符串（1 码元） | `"\ud800"` 可往返 | **编码时丢失** | 走 UTF-8（剪贴板 / Blob / 下载 / `TextEncoder`）→ **U+FFFD**（实测 3 字节 EF BF BD） |
| `"caf\u00e9 \uD83D\uDE00"` | 正常字符串 | `"café 😀"` | 值无损、**源文本≠值文本** | 转义被规范化；复制「原始值」会改变字节 |
| `"a\/b"` | `a/b` | `"a/b"` | 同上（`\/` 规范化） | — |

键序（`fixtures/fidelity/data/key-order.json`，源文本刻意写成混排）：

| 对象（源键序） | parse 后键序 | 是否保序 |
|---|---|---|
| `{"msg","2","1","z","0"}` | `0,1,2,msg,z` | **丢失** |
| `{"3","2","1"}` | `1,2,3` | **丢失** |
| `{"4294967295","1"}`（2^32−1 不是数组下标） | `1,4294967295` | **丢失** |
| `{"-1","0"}` | `0,-1` | **丢失** |
| `{"01","1"}`（前导零不是数组下标） | `1,01` | **丢失** |
| `[{"msg","2","1"}]` | `1,2,msg` | **丢失** |
| `{"1","2","10"}` | `1,2,10` | 保序 |
| `{"0","1","10","tag"}`（整数键全在字符串键前且升序） | 同 | 保序 |
| `{"1","2","msg"}` | 同 | 保序 |

→ **9 个构造对象里 6 个键序丢失**。注意最后三行：整数键在前且升序时**不丢**，这是把误报压下去的关键（见 2.3）。

### 2.2 真实样本 `.mock/1.json` 实测（**修正 #7 的结论**）

`scanFidelity('.mock/1.json')`（20–21ms，一次线性扫描）：

| 指标 | 实测 | issue #7 的原判断 | 判定 |
|---|---|---|---|
| 数字字面量 | 20,091 | — | — |
| >15 位整数字面量 | **57** | 12 个（16–18 位） | **#7 少算**（它只看了 16–18 位） |
| 其中可被 double 精确表示 | 55 | — | — |
| **真实精度丢失** | **2** | 「12 个全部精确往返」 | **修正：有 2 处真实失真** |
| 整数样式键 | 309（分布在 94 个对象里） | 94 个 | 口径一致（对象数=94） |
| 键序混排/乱序风险对象 | **0** | 0 | **确认** |
| 重复键 | 0 | 0 | **确认** |
| `\uXXXX` 转义 | 0（82 处其它转义） | 0 | **确认** |
| 孤立代理项 | 0 | 未提 | 确认无 |
| `-0` / `1e400` / 下溢 | 0 / 0 / 0 | 未提 | 确认无 |

两处真实失真（源 → 存进 double 后）：

```
297532588187238660  (offset 14871)   →  BigInt(Number(lit)) ≠ 297532588187238660n
18296148431257610   (offset 339094)  →  同
```

**最阴的一点**：这两个数 `String(value)` 打印出来**仍是源的 18 位数字**（`"297532588187238660"`），只是存的 double 并不等于那个整数。也就是说：

- 树里**看不出来**（显示和原文一模一样）；
- 但表达式求值里 `item.id === 297532588187238660` 之类的比较是在近似值上做的，导出时也会写出近似值（`JSON.stringify` 得到同一串是巧合，不保证）；
- 所以「检测 + 提示」不是锦上添花，是**唯一能让用户知道的方法**（不逐节点定位的前提下）。

另外 `JSON.stringify(parse(text))` 与源文本的差异：`.mock/1.json` 唯一差异是**末尾换行**（长度 −1，位置 879329），即该样本除那 2 个数字外**字节级可往返**；病态 fixture 的整本文本往返差异首处出现在 offset 35（就是大整数）。

### 2.3 检测器的精度：为什么不能用「>15 位」启发式

| 方案 | `.mock/1.json` 命中 | 真实失真 | 误报率 |
|---|---|---|---|
| 「位数 >15」 | 57 | 2 | **96.5%** |
| 「位数 >15 且 `BigInt(lit) !== BigInt(Number(lit))`」 | **2** | 2 | **0%** |

代价可忽略：BigInt 只在「>15 位」候选上做（.mock 上 57 次），整本扫描仍 20ms。**这是必须写进设计的细节**：检测器按「候选 → 精确判定」两级过滤，顶部提示的 N 必须等于精确失真的数量，否则用户会学会忽略提示。

> 数字精确判定规则（实现见 `lib/json-lex.mjs:classifyNumberLiteral`）：纯整数字面量且有效位数 ≤15 → 必然精确（<10^15 < 2^53）；否则 BigInt 比较。带小数/指数的不做精度判定（JSON 的双精度语义本来就以 double 为准），只查 `!isFinite`（`1e400`）与下溢（`1e-400`）。

### 2.4 「检测 + 提示 + 切原始文本」够不够？

**够（v1），并且明确不该做 raw-slice 显示层**，理由是按实测成本算的：

| 方案 | 成本（50MB / 10.35M token） | 能给出的 |
|---|---|---|
| A. 检测 + 提示 + 原始文本视图（**推荐**） | 扫描 **288ms**（Worker，不影响首帧）+ 原始文本视图索引 **19.5KiB / 116ms**（§4） | 知道「有 N 处可能失真」；原始文本里能按原文看到每个字面量（自带查找） |
| B. raw-slice 显示层（树里显示源文本切片 / 保留键序） | token 偏移索引 **88.9MiB + 237ms**，且要再加 node→token 的映射（= #7/#11 已明确移出的「字符偏移↔节点」反向索引） | 逐节点看到源字面量；键序也能按源序显示 |
| C. 无损解析（不用 `JSON.parse`） | 需完整自研解析器 + 自己建值图，丢掉 V8 `JSON.parse` 的 93ms/50MB 快路径；解析器还要处理 1e400→? / -0→? 等自定义语义 | 全保真，但把 #7 的核心决策整个推翻 |

推荐 A，并把「原始文本视图」做成检测提示的**落地出口**（提示条上的「对照原文」直接切视图 + 定位到第一个失真字面量附近的**行**——不是节点定位，行号由原始视图提供，成本 0）。B 只在将来真要做「树↔文本联动」时重开（那时该索引正好复用）。

## 3. Q2 无损 tokenizer / pretty-printer

### 3.1 算法

单遍、零依赖、无递归（显式容器栈），只做「结构」不建值图（`lib/json-lex.mjs` + `lib/raw-view.mjs`）：

```
lexToken(s, i) -> end,type     // 一次 charCodeAt 扫描，字符串跳过 \-转义（\" \\ \uXXXX 都安全）
walkPretty(text, pos, depth, cb)  // 从 (pos,depth) 起把源文本按 JSON.stringify(x,null,2) 的行布局逐行吐出
                                 // 每行一个 record：{start,end,depth,kind}，kind ∈ OPEN/CLOSE/KEY/KEY_OPEN/SCALAR
renderPrettyLine(text, rec)    // 只对窗口内的 ~50 行做：slice + 补缩进/冒号/逗号
```

关键性质（这些性质决定了 §4 的架构）：

1. **walker 是无状态的**：只依赖 `(pos, depth)`，可以从任意行边界恢复 → 支持检查点 + 随机访问，不需要存全量行数组。
2. **不物化文本**：一次 token 化只产出「行记录」，行文本在渲染窗口时才 slice。所以**原始文本视图显示的内容永远是源文本切片** → 大整数、`\uXXXX` 转义、键序天然保真（这正是 §2 里 raw-slice 想解决的问题，原始视图免费得到）。
3. **行记录里不需要存 token**：`renderPrettyLine` 重新 lex 1–2 个 token（窗口内 50 行 = 100 次 lex，实测 0.005ms）。

### 3.2 实测（Node v24.13，与 Chrome 同 V8；Chrome worker 复核见 §5.4）

| 样本 | 字符 | token/行 | 全量 walk（吞吐） | 单行 lex（高亮用） | 50 行高亮 |
|---|---|---|---|---|---|
| 10MB | 9,965,133 | 669,412 行 | **24.43ms（389MB/s）** | 0.2µs/行 | 0.010ms |
| 50MB | 49,840,274 | 3,328,372 行 | **115.18ms（413MB/s）** | 0.1µs/行 | 0.005ms |

浏览器内复核（Chrome 156 Worker，50MB 走 transfer + `TextDecoder`）：见 §5.4 表（build 与窗口延迟）。

### 3.3 保真 tokenizer 能不能同时服务两件事？

能：**同一个 walker** 既给原始文本视图的行布局，也给「源字面量」的精确显示（因为显示的是 `text.slice(tokenStart, tokenEnd)`，不是 `String(value)`）。给原始文本视图加「按源序显示」几乎不要额外成本——只要不在渲染时对 key 做任何排序。**但它不能替代树视图**（树视图消费的是值图，键序已经丢了），这就是 §2.4 推荐 A 而不是 B 的原因。

## 4. Q3 原始文本视图的 minified 病态

### 4.1 50MB minified = 单行，源码行虚拟化直接失效

| 样本 | 源行数 | 最长行 | `probeText` 形状探测 |
|---|---|---|---|
| 2MB | **1** | 1,992,250 | 0.077ms |
| 10MB | **1** | 9,965,134 | 1.18ms |
| 50MB | **1** | 49,840,275 | 7.10ms |

策略 (a)「原始行虚拟化」在这些样本上一条可用行都没有。形状探测用 `indexOf('\n')` 而不是逐字符循环：72ms → **7.1ms**（50MB）。

### 4.2 三种策略对比（50MB minified）

| 策略 | 结构 | 构建 | 索引内存 | 随机窗口（50 行）p95 | 判定 |
|---|---|---|---|---|---|
| **(a) 源码行虚拟化** | 行偏移数组 | 不可用（1 行） | — | — | **minified 下失效**；对 pretty 源可用（2MB pretty：135,136 行，索引 528B，窗口 0.061ms） |
| **(b) 检查点 pretty 行走器**（推荐） | `Int32Array[lineIndex, srcOffset, depth]` 每 2048 行一个 | **116.3ms** | **19,512B（19.1KiB）** | **0.084ms** | **采用** |
| (c) 预生成 pretty 全文 | 78.6MiB 字符串 + 行数组 | **866.7ms** | **+157.1MiB 堆** | 0.02–0.05ms | **否决**：比 (b) 慢 7.5×、内存大 8000×，且这份文本在 Worker→主线程移交时还要再拷一次 |

(b) 的窗口延迟实测（Node，median / p95，`windowText(startLine, 50)`）：

| 样本 | 行 0 | 中点 | 末 50 行 | **最坏（检查点前 1 行）** |
|---|---|---|---|---|
| 2MB | 0.02 / 0.117 | 0.265 / 0.322 | 0.079 / 0.128 | 0.078 / 0.108 |
| 10MB | 0.010 / 0.017 | 0.049 / 0.065 | 0.017 / 0.025 | 0.072 / 0.083 |
| 50MB | 0.007 / 0.017 | 0.049 / 0.065 | 0.017 / 0.025 | **0.072 / 0.083** |

→ 最坏情况（要从检查点往前数 2048 行）仍是 **0.08ms**，远低于一帧预算。

### 4.3 正确性验证（不是只看「能跑」）

从 walker 重建全部行 → `join('\n')` → `JSON.parse` → 与源文档 `JSON.stringify` 深度等价：**`reparseDeepEquals: true`**，行数 = `lineCount` = 135,136（2MB）。即「pretty 行布局 + 源文本切片」是**无损且可解析**的完整表示。注意键序 = **源序**（这正是原始视图该有的样子，也和树视图不同——两者不必一致，CONTEXT 已定 v1 不联动）。

### 4.4 阈值策略（建议写进设计）

| 条件（Worker 一次 pass 得到） | 行为 |
|---|---|
| `maxLineLength ≤ 4096`（已 pretty / 人类可读） | **(a) 源码行虚拟化**：行偏移检查点，行文本原样显示（保留用户原格式） |
| `maxLineLength > 4096`（minified / 长行） | **(b) 检查点 pretty 行走器**：显示**规范 pretty 布局**，行文本 = 源切片 |
| 单行 > 4096 但文档 ≤ 10MB 且用户点「格式化」 | 可选 (c) 一次性 pretty（10MB → 15.7MiB 文本 / 156ms / +25MiB 堆），仅显式操作、不默认 |
| 行数上限 | 50MB → 3.33M 行；滚动条按 `lineCount × 行高`，无需行偏移数组 |
| 降级兜底 | walker 遇到非法 JSON（解析失败但用户仍要看原文）→ 退化为「按 `\n` 分块 + 每块硬切 4096 字符」的纯文本模式（仍虚拟化），并挂「文本非合法 JSON」提示 |

> 4096 是保守取值：远大于正常格式化 JSON 的行长（`.mock/1.json` 单行 879K 也走 (b)），也远小于任何一帧能渲染的长度。真正的判据是「行虚拟化有没有可用行」，4096 只是让极长单行（比如 base64 字段）也走 pretty 布局。

### 4.5 精确数据结构

```js
// Worker 内，一次 pass（= 一次全量 walk，50MB 115ms；可与 parse 并行/错开）
class RawTextView {
  text: string            // 源文本，唯一真相
  mode: 'source' | 'pretty'
  lineCount: number       // 滚动条唯一需要的总数
  cpEvery = 2048
  cp: Int32Array          // 3 元组：lineIndex, srcOffset, depth   → 3.33M 行时 1626 组 = 19.5KiB
  probe: { lines, maxLine, probeMs }   // 形状探测结果（决定 mode）
  buildMs: number
}
// 取窗口（主线程发起 → Worker 返回 50 行字符串数组）
getWindow(startLine, count) -> string[]     // 实测 p95 0.084ms（50MB）
// 语法高亮（只对窗口内行做）
lexLine(lineText) -> {t: tokenType, s, e}[]  // 0.2µs/行
```

**为什么不是行偏移数组**：全量行偏移（`Int32Array` 4B/行）在 50MB 上要 13.3MiB（3.33M 行），而检查点只要 19.5KiB，代价是从检查点重走 ≤2048 行（0.08ms）。滚动条只需要 `lineCount`，不需要每行偏移。

## 5. Q4 导入数据路径（真机 Chrome 156）

### 5.1 测量方法

`prototype/p1/fixtures/fidelity/`（MV3 扩展，无 host 权限）→ 页面从 `lib/http.mjs` 的 CORS 静态服务 `fetch` 样本 → `new File([blob])` → 四条路径：

| 变体 | 主线程做什么 | Worker 做什么 |
|---|---|---|
| A `file.text()` | UTF-8 解码 + 造 JS 字符串 | 收字符串（**structured clone 二次拷贝**）→ `JSON.parse` |
| B `file.arrayBuffer()` | 只拿 bytes | 收 buffer（**transfer，零拷贝**）→ `TextDecoder` → `JSON.parse` |
| C `file.stream()` | 只造 stream | 收 ReadableStream（**transferable stream**）→ 增量 decode → `JSON.parse` |
| D `arrayBuffer` + 只 decode | — | 收 buffer（transfer）→ decode（分离 decode 与 parse 成本） |
| E paste | `DataTransfer` + `ClipboardEvent('paste')` | —（只验证处理器读 `clipboardData` 的成本与「不进 DOM」） |
| F 负面对照 | `pre.textContent = 整份文本` | — |

> 环境限制（诚实标注）：`File` 由内存 blob 构造，**不含磁盘 I/O**；CDP harness 未暴露 `DOM.setFileInputFiles`，所以「真实文件选择」这条在 #15 已测（2MB→42ms 读到，50MB 拖放→115ms）。本节比较的是**解码/移交/阻塞**这几段，与 blob 来源无关。

### 5.2 结果（完整表在 §5.5）

一句话：**`file.text()` 是唯一会在主线程留 long task 的路径**（50MB：67.9ms 取文本 + **50ms long task** + 48MB 堆增量；因为 UTF-8 解码在主线程、且字符串要 structured clone 一次）。`arrayBuffer`+transfer 与 `file.stream()`+transfer 主线程 **0 long task**、堆增量 0（stream 在 Worker 侧拼块 +50MB）。Worker 端 `TextDecoder` 占 38–55ms，`JSON.parse` 占 88–114ms（与本仓 #15 的 93.2ms 一致）。


### 5.2b 路径排序（推荐）

| 排名 | 路径 | 50MB 实测（中位数） | 理由 |
|---|---|---|---|
| 1 | **`file.arrayBuffer()` → `postMessage(buf, [buf])` transfer → Worker `TextDecoder` → `JSON.parse`** | 主线程 34.5ms / **0 long task** / +0MB 堆；Worker decode 52.6 + parse 88.1；到 paint 182.7ms | 零拷贝移交、主线程零解码、堆增量 0；实现最简单 |
| 2 | `file.stream()` → transferable stream → Worker 流式 decode | 主线程 0ms / **0 long task**；Worker decode 54.5 + parse 93.4；到 paint 149.9ms | 主线程最干净、总时长最短；代价是 Worker 侧要拼块（+50MB 堆增量）、实现复杂、需 Chrome/Edge 支持 transferable stream |
| 3 | `file.text()` → string clone | 主线程 67.9ms + **50ms long task** / +48MB 堆；Worker parse 114.1 | **不采用**：主线程解码 + 一次结构化克隆拷贝（= #15 的 postMessage 往返 151.8ms 的来源），50MB 上直接违反「UI 不冻结」 |

> 与 #15 衔接：`file.text()` 这条就是 #15「拿到文本 115ms」的口径；改成 arrayBuffer+transfer 后主线程这段降到 34.5ms 且没有 long task，Worker 端多出的 52.6ms decode 与原有 93.2ms parse 同线程串行（总 ~141ms vs 原 93ms），换算到「导入→首帧」仍远优于 #15 的 193.6ms；`stream` 路径总时长最优但复杂度更高。**v1 建议用 arrayBuffer+transfer，stream 作为大文件（>50MB）的后续优化项。**

### 5.3 「文档文本永不进 DOM」的验证

- **负面对照（决定性）**：**10MB** 文本写进 `pre.textContent` 后强制 layout = **75,618ms（75 秒）**；2MB 同法 = 5,951ms（`setTextMs` 报 0 是因为赋值是惰性的，代价全在布局）。#15 记的 40s 与此同量级（都比直觉差）。所以「文本进 DOM 文本节点」这条红线不是口味问题，是**唯一能毁掉产品体验的单点**，而且它随文本大小超线性恶化（2MB→6s，10MB→75s，≈12.7× per 5×）。
- **paste 路径**：`dispatchEvent(ClipboardEvent('paste'))` 同步派发 + 处理器内 `getData('text')`，10MB/50MB 实测 handler **0ms**、dispatch 0–0.1ms、主线程 long task 0、堆增量 0，`preventDefault()` 后文本从未创建 DOM 文本节点。与 #15 的「paste 事件本身只花 1ms」一致 → **确认** #11 的修正结论（保留 Cmd+V、只接事件不落文本）。
- 注意：`DataTransfer.setData('text/plain', 5千万字符)` 本身有成本（见 §5.5 的 `setDataMs`），这是**测试造夹具**的成本，真实粘贴时浏览器从系统剪贴板直接给 `clipboardData`，不走 JS 字符串（#15 的 paste 处理器 1ms 就是在真实剪贴板路径上测的）。

### 5.4 原始文本视图在真实 Chrome Worker 里（Q2/Q3 复核）

`rawViewInWorker` 直接跑 worker → 结构同 §4。见 §5.5。

### 5.5 Chrome 实测数字

（Chrome for Testing 156 headless，`--enable-precise-memory-info`；2 轮取中位数/p95，变体交错；测量时 `loadavg`≈5.3，同期有其他成员的 Chrome 负载；`ua=HeadlessChrome/156`，`hardwareConcurrency=10`）

**10MB（9,965,133 字符）**

| 变体 | 主线程取字节/文本 | 主线程 long task | Worker decode | Worker `JSON.parse` | 往返(含 worker) | 主线程堆增量 | 到 paint |
|---|---|---|---|---|---|---|---|
| A `file.text()`（string clone） | 11.7 / 11.7 ms | 0 / 0 ms | — | 16.9 / 16.9 ms | 20.1 / 20.1 ms | 9 / 9 MB | 46.5 / 46.5 ms |
| B `arrayBuffer`+transfer | 3.1 / 3.1 ms | 0 / 0 ms | 7 / 7 ms | 12 / 12 ms | 19.2 / 19.2 ms | 0 / 0 MB | 33.2 / 33.2 ms |
| C `file.stream()`+transfer | 0.1 / 0.1 ms | 0 / 0 ms | 9.7 / 9.7 ms | 11.7 / 11.7 ms | 21.6 / 21.6 ms | 10 / 10 MB | 33.3 / 33.3 ms |
| D `arrayBuffer`+只 decode（分离 decode/parse） | 9.5 / 9.5 ms 全程 | — | 6.9 / 6.9 ms | — | — | — | — |
| E `paste` 事件（DataTransfer→ClipboardEvent） | setData 0 / 0 / dispatch 0.1 / 0.1 / **handler `getData` 0 / 0** ms | 0 / 0 ms | — | — | — | 0 / 0 MB | — |
| F **负面对照**：10MB 写进 `pre.textContent` 后强制布局 | **75618.4 ms** | — | — | — | — | — | — |

**50MB（49,840,274 字符 / 2.96M 节点）**

| 变体 | 主线程取字节/文本 | 主线程 long task | Worker decode | Worker `JSON.parse` | 往返(含 worker) | 主线程堆增量 | 到 paint |
|---|---|---|---|---|---|---|---|
| A `file.text()`（string clone） | 67.9 / 67.9 ms | **50 / 50 ms** | — | 114.1 / 114.1 ms | 132.7 / 132.7 ms | 48 / 48 MB | 200.5 / 200.5 ms |
| B `arrayBuffer`+transfer | 34.5 / 34.5 ms | 0 / 0 ms | 52.6 / 52.6 ms | 88.1 / 88.1 ms | 140.8 / 140.8 ms | 0 / 0 MB | 182.7 / 182.7 ms |
| C `file.stream()`+transfer | 0 / 0 ms | 0 / 0 ms | 54.5 / 54.5 ms | 93.4 / 93.4 ms | 148.1 / 148.1 ms | 50 / 50 MB | 149.9 / 149.9 ms |
| D `arrayBuffer`+只 decode | 54.1 / 54.1 ms 全程 | — | 38.2 / 38.2 ms | — | — | — | — |
| E `paste` 事件 | setData 0.1 / 0.1 / dispatch 0 / 0 / **handler `getData` 0 / 0** ms | 0 / 0 ms | — | — | — | 0 / 0 MB | — |

**原始文本视图在真实 Chrome Worker 里（Q2/Q3 复核，同一 worker 内原地测）**

| 项 | 10MB | 50MB |
|---|---|---|
| mode / 行数 | pretty / 669,412 | pretty / 3,328,372 |
| 检查点组数 / 索引字节 | 327 / 3,924 B | 1626 / **19,512 B** |
| 形状探测 | 0.4 ms | 1.8 ms |
| 全量构建（walk + 检查点） | **37.8 ms** | **296.7 ms** |
| 窗口 50 行（行 0 / 中点 / 末尾）最大 | 0.4 ms | 0.2 ms |
| Worker 内 `TextDecoder`（50MB buffer） | 6.1 ms | 39.4 ms |

> **50MB 构建 296.7ms 与 Node 侧 116ms 不一致**：该 worker 在同一会话里已跑过 4 轮 50MB 的 decode+parse（页面堆 ~148MB），且测量时 `loadavg`≈5.3。倾向解释为 GC 压力 + 并发负载；**Lead 应在安静环境复测这一项**。若稳定在 ~300ms，原始视图仍应在「切到原始视图时」按需构建（并显示进度），而不是导入时预建。


## 6. Q5 截断修复

### 6.1 fixtures 与结果（`fixtures/fidelity/data/truncated/`，18 个）

| fixture（内容） | 检测 | 修复动作（摘要） | 修复后 | 猜测内容 |
|---|---|---|---|---|
| `{"a":1,"b":"hello wor` | ✓ | 补结束引号 + 补 `}` | ✓ | 0 |
| `{"s":"ab\` | ✓ | 丢弃不完整转义 + 补引号 + `}` | ✓ | 0 |
| `{"s":"ab\u00` | ✓ | 丢弃不完整 `\u00` + 补引号 + `}` | ✓ | 0 |
| `{"a":1,"b":{"c":2` | ✓ | 补 2 个 `}` | ✓ | 0 |
| `{"items":[1,2,3` | ✓ | 补 `]}` | ✓ | 0 |
| `{"items":[` | ✓ | 补 `]}` | ✓ | 0 |
| `{"a":1,` | ✓ | 移除尾逗号 + `}` | ✓ | 0 |
| `{"a":[1,2,` | ✓ | 移除尾逗号 + `]}` | ✓ | 0 |
| `{"a":` | ✓ | 丢弃悬空键+冒号 + `}` | ✓ | 0 |
| `{"n":1234567` | ✓ | 补 `}`（数字本身合法，保留原位数） | ✓ | 0 |
| `{"n":1.2e` | ✓ | 只保留合法前缀 `1.2` + `}` | ✓ | 0 |
| `{"t":tru` | ✓ | 丢弃不完整字面量 + 悬空键 + `}` | ✓ | 0 |
| `{"t":nul` | ✓ | 同上 | ✓ | 0 |
| `{"a":1,"bb` | ✓ | 丢弃不完整键 + 尾逗号 + `}` | ✓ | 0 |
| `{"a":{"b":[{"c":[1,{"d":"x` | ✓ | 补 6 个闭合符 + 补引号 | ✓ | 0 |
| `[{"id":1,…},{"id":3,"na` | ✓ | 丢弃半个键 + 尾逗号 + 补 `]` | ✓ | 0 |
| `{"a":1}   \n  ` | 无需修复 | — | ✓（原样） | 0 |
| `{"a":1,"b":2}` | 无需修复 | — | ✓（原样） | 0 |

**检测 16/16（+2 个本非截断）、修复 16/16 `JSON.parse` 通过、0 处内容猜测**，全部 fixture 总耗时 **3.75ms**（单文档 <0.3ms）。

### 6.2 保守档的精确规则（可直接实现）

EOF 处按以下顺序判定（`lib/repair.mjs`）：

1. **在字符串里**：若末尾是半个转义（`\` / `\u00`）→ 删掉整个不完整转义；再补 `"`。若这个字符串是**键名** → 不补引号，直接删整个成员（+ 前一个逗号），因为键没有值可保留。
2. **末尾是半个 token**：字面量不在 `{true,false,null}` 里（`tru`/`nul`）→ 删；数字不合法（`1.2e`）→ 只保留最长的合法前缀（`1.2`），**不补数字**。
3. **尾随逗号**：逗号不可能在闭合符前 → 删。
4. **悬空成员**（`{"a":` 期望值却 EOF）→ 删「键+冒号」（+ 前一个逗号）。
5. **补闭合符**：按容器栈逆序补 `}`/`]`，一次插入。
6. **不是 EOF 形态的语法错误**（错误位置不在末尾附近）→ **拒绝修复**（`unrepairable`），只报错。

### 6.3 修复标记 / 摘要的数据形态（v1 建议）

```js
doc.repair = {
  status: 'none' | 'repaired' | 'unrepairable',
  truncatedAt: 12345,              // = 原文本长度（EOF）
  parseError: 'Unexpected end of JSON input',
  summaryText: '已修复：补 3 个闭合符、1 个结束引号（仅语法闭合，未修改任何已有值）',
  counts: { brackets: 3, quotes: 1, commas: 0, deletedChars: 2 },
  ops: [                           // 逐条可展示，offsets 指向【原文本】
    { at: 12345, op: 'insert', text: '}}]', scope: 'container', note: '补 3 个闭合符 `}}]`（对应未闭合的 {@0, {@12, [@15）' },
    { at: 12344, op: 'insert', text: '"',   scope: 'string',    note: '字符串未闭合 → 补结束引号' },
    { at: 12340, op: 'delete', text: '\\',  scope: 'string',    note: '末尾是不完整转义 → 丢弃（不猜测字符）' },
  ],
}
```

- **UI**：顶部提示条（常驻，直到用户关掉或重新导入）+ 可展开的修复摘要列表（每条一行 note，`at` 可在原始文本视图里跳到该行——行号由 §4 的 walker 反查，成本 0，不是节点定位）。
- **导出**：文件名后缀 `.truncated-repaired.json`（不往 JSON 里塞注释——会破坏可解析性），UI 角标保持。
- **开关**：`修复截断` 偏好关掉后，截断文档走「报错 + 打开原始文本视图」，不产生值图。
- **provenance 保留**：`doc.repair` 挂在文档模型上，不随视图切换丢失；「复制原始文本」永远复制**源文本**（不经修复），「复制/导出 JSON」用修复后的值图 + 后缀。

## 7. 数据结构草案（把 §2–§6 合起来）

```ts
// ── Worker 内的文档模型（真相源 = JSON.parse 的值图）──
interface Doc {
  text: string;            // 唯一真相，永不进 DOM
  value: unknown;          // JSON.parse(text)
  fingerprint: string;     // 用于视图状态恢复（#7 已定）
  rawView: RawTextView;    // §4.5，第一次切到原始视图时构建（116ms/50MB）
  fidelity: FidelityReport | null;  // §2，异步扫描后填（288ms/50MB，可取消）
  repair: RepairReport | null;      // §6.3
}

interface FidelityReport {         // 两级判定，N 必须=真实失真数
  scanMs: number;
  numbers: { total; exact; gt15; gt15Exact; gt15Inexact; nonfinite; negZero; underflow };
  keys:    { total; intStyle; objects; objectsWithIntKeys; reorderRiskObjects; reorderRiskEvents };
  strings: { total; escaped; loneSurrogate; rawLoneSurrogate };
  duplicates: { keys };            // 仅在 detectDuplicates 模式（成本见 §2.4 备注）
  findings: number;                // = 顶部提示里的 N
  samples: { bigintInexact: {lit, parsed, at}[]; reorderRisk: {key, at}[]; ... }; // 各处最多 8 条，用于「对照原文」跳行
}
```

顶部提示文案建议按类别分句（实测 `.mock/1.json` 只有 2 条，措辞要能解释「为什么值可能不对」）：
> ⚠ 检测到 2 个数字超出 double 精度（原文 `297532588187238660`），树中显示的是近似值。[对照原文]

## 8. 残余风险与未测项

| 项 | 状态 |
|---|---|
| `detectDuplicates` 在 50MB 上的成本 | **未测**（每对象一个 `Set`，内存按对象数增长；.mock/1.json 实测 13.4ms vs 12.3ms）。#7 已定「重复键无论」，因此默认关闭，只在 ≤10MB 且用户开「严格保真」时启用 |
| `TextDecoder` 在 Worker 里对 50MB 的实际耗时 | 见 §5.5（由 Chrome 脚本产出）；Node 侧未单独测 |
| `file.stream()` 增量 decode 的峰值内存 | 见 §5.5；**未测**分块大小（默认 64KB）对内存的影响 |
| 磁盘 I/O（真实 `input[type=file]` / 拖放） | **未测**（harness 限制）；#15 已测：2MB→42ms、50MB 拖放→115ms 拿到文本 |
| 原始视图的「坑」：源文本里含 `\r\n` | (a) 模式下按 `\n` 分行会留下 `\r`；建议分行时 strip 尾 `\r`（未测影响，逻辑上只在显示层） |
| pretty 布局与 JSON.stringify 的**字符串折行** | 长字符串（几十 KB 的单行字符串值）在 pretty 里仍是一行 —— 这是 JSON.stringify 的行为，也是本方案的行为；如果将来要软折行，得在 `renderPrettyLine` 上加窗口内二次切分（成本 = 窗口内字符数） |
| 表达式求值与失真的交互 | 未测（属 #12）；风险：表达式对近似值比较，用户看到的是源串 → 结论页可能「看起来对但判错」。建议表达式结果里对失真节点打标（若将来要做联动，正好复用 fidelity.samples 的 offset） |
| 浏览器 | 只测了 Chrome 156（CfT headless）；未测 Safari/Firefox（产品是 MV3 扩展，可接受，但 `ReadableStream` transfer 只在 Chrome/Edge 有） |

## 9. 复跑

```bash
# 0) fixtures（一次性；产物在 prototype/p1/fixtures/fidelity/data/）
node prototype/p1/bench/fidelity/gen-fixtures.mjs

# 1) Node：保真扫描 / tokenizer / 原始视图 / 内存（--expose-gc 才能读堆增量）
node --expose-gc prototype/p1/bench/fidelity/run-node.mjs   > /tmp/fidelity-node.json

# 2) Chrome：导入四路径 + paste + 负面对照 + Worker 内原始视图
node prototype/p1/bench/fidelity/run-chrome.mjs --sizes=10mb,50mb --rounds=2 --negative > /tmp/fidelity-chrome.json

# 3) 截断修复
node prototype/p1/bench/fidelity/run-repair.mjs > /tmp/fidelity-repair.json
```

全部脚本只依赖 `prototype/p1/lib/{chrome,http}.mjs`，**零 npm 依赖**；样本来自 `.spike/samples/`（勿提交）。`run-chrome.mjs` 会把 `bench/fidelity/lib/*.mjs` 拷进 `fixtures/fidelity/gen/lib/`（MV3 CSP 只允许 `'self'`），产物可删。

### 文件清单

```
prototype/p1/bench/fidelity/
  lib/json-lex.mjs      # 零依赖单遍 lexer（token 化 + 行高亮 + 数字/字符串失真分类）
  lib/fidelity.mjs      # 保真扫描器（一次线性扫描，显式栈）+ token 偏移索引（成本证据）
  lib/raw-view.mjs      # 形状探测 / pretty 行走器 / 检查点索引 / 源码行视图 / 预生成 pretty 基线
  lib/repair.mjs        # 保守截断修复（EOF 规则表 + 编辑列表 + 摘要）
  gen-fixtures.mjs      # fixtures 生成
  run-node.mjs          # §2/§3/§4 的 Node 实测
  run-chrome.mjs        # §5 的 Chrome 实测（+ Worker 内 §4 复核）
  run-repair.mjs        # §6 的修复实测
prototype/p1/fixtures/fidelity/
  manifest.json page.html page.js worker.js sw.js   # MV3 bench 扩展
  data/pathological.json data/key-order.json data/truncated/*.json
```
