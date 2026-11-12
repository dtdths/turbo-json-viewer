# ADR-0020：无损数字值模型（整数 BigInt；`JSON.parse` 退位为编辑器校验）

- 状态：Accepted（2026-11-11，#32 拍板；实现票 = #33，验收结果见 §11）
- 日期：2026-11-11
- 依据：**#32 grill 记录**（2026-11-11，13 条决策全部「按推荐」拍板）；本机 50MB bench（Node v24.13.0 / Apple M4，方法与数字见 §2）；#31 保真条修订（ADR-0003 2026-11-11 晚）
- 相关：ADR-0003（**被本 ADR 修订**：真相源与保真报告口径）、ADR-0001/0002（值图 / 行模型 / 身份）、ADR-0006（子树编辑）、ADR-0010（复制）、ADR-0012（导出）、ADR-0018（表达式引擎）、ADR-0005（技术栈与构建预算）、ADR-0011（设置）

> **取代**：ADR-0003 的「真相源 = `JSON.parse` 值图」与「大整数精度流失（`precision`）检测」两项结论由本 ADR 取代；ADR-0003 原文保留为历史记录，只加指针与修订段。
> **一句话**：导入解析改用自研无损 parser——**超出安全整数范围的整数值用 `BigInt` 精确表示**，其余数字（含高精度小数）仍是 `Number`；导出/复制/编辑用配套无损序列化器；`JsonKind` 不新增成员（BigInt 归 `number` 类）。

## 1. 背景

用户 2026-11-11 看保真条「大整数精度 2 处」，对比原文与树发现显示值一模一样（例 `297532588187238660`），追问：

> 「如果你的原文不对，那原文意义在哪？」「为何不能把原文视图里的值改对？比如先转字符串显示、类型仍是 number」

已澄清的事实（写进 #32 与 ADR-0003 修订）：原文视图逐字显示源文本，是**唯一没被 JS 改写的真相**；`JSON.parse` 把该字面量解析成 double `...656`（该量级步长 64，660 不是 64 的倍数），而 JS 打印 double 用最短往返十进制，恰好仍是 `...660`——所以树/原文/导出串看不出差异，缺口在**呈现层**；用 BigInt 精确检测不是误报。

**用户明确否决的两条路**：

1. **只改显示**（树里显示原文数字、类型仍是 number）——复制/导出/表达式/编辑仍用 double，属「显示层说谎」。
2. **把值改成字符串显示**——类型语义反转、导出会带引号（数据损坏）。

**ADR-0003 曾否决自研 parser**（理由：失去 V8 原生快路径、要自定义 `-0`/`1e400` 语义）。本 ADR 用本机实测重新量化这个代价（§2），确认**值得付**：性能与内存代价可接受，且这是唯一能同时修好树/复制/导出/编辑/表达式四条链路的方式。

**为什么不是"换个 parser"**：仓库没有无损层/旁路字面量；`JSON.parse` 值图是唯一真相源（`import.ts:4`、`row-model.ts:4`、`root-store.ts:55` 都把它写成不变量）。BigInt 一旦进值图，`JsonKind` 闭合 union、树预览、复制、导出、编辑、measure、表达式、保真报告**全部**会坏（§2.4 清单）——这是数据模型级改动。

## 2. 事实（本机实测，2026-11-11）

**测量口径**：Apple M4 / 32 GiB / macOS arm64；Node v24.13.0（V8 13.6）。每个测量独立 `node --expose-gc` 进程；时间用 `performance.now()` 包住 parse 段（不含读文件/`TextDecoder` 解码，解码单独计时 50MB≈5–6ms）；每档 5 轮取中位（个别 3 轮）；堆 = parse 前后强制 GC 的 `heapUsed` 差值（源文本仍被引用、不计入值图增量）。

### 2.1 手写无损 parser vs 基线（50MB 混合文档：50,000,058 B / 3,332,525 节点）

| 解析路径 | parse ms | ×基线 | 值图堆 | 文本+图堆 | RSS 峰 |
|---|---:|---:|---:|---:|---:|
| `JSON.parse`（现状基线） | **120.9** | 1.00× | **+67.1 MB** | 118.5 MB | 225 MB |
| 手写 parser，数字=Number | 322.7 | 2.67× | +125.2 MB | 176.7 MB | 407 MB |
| **手写 parser，lossless（本方案）** | **338.7** | **2.80×** | **+140.9 MB（2.10×）** | 192.3 MB | 425 MB |
| 手写 parser，strict（字面量写法也保真） | 393.5 | 3.26× | +142.0 MB | 193.4 MB | 430 MB |
| `JSON.parse` + 恒等 reviver | 1018.5 | 8.42× | +67.1 MB | — | 584 MB |
| `JSON.parse` + reviver→BigInt/Raw | 1027.1 | 8.50× | +82.6 MB | — | 601 MB |

- 时间代价**主要来自放弃 V8 原生 parser**（无 BigInt 的手写版已 2.67×）；BigInt 只再 +5% 时间、+16MB 堆。
- **reviver/`JSON.rawJSON` 原生路线出局**：恒等 reviver 就 8.4×（瓶颈 = 每节点 JS 回调 + 二次遍历，不是 BigInt）；大整数密集 50MB 达 21.9×/25.9×。
- 10MB 目标线：`JSON.parse` 21.6ms/+13.5MB → lossless **77.8ms（3.60×）/+28.5MB（2.11×）**；5MB：12.1 → 45.1ms（3.73×）。
- 1M 条记录 53MB：167.1 → 456.6ms（2.73×）、堆 92.9 → 128.2MB（1.38×）。
- 全大整数 50MB 最坏（2,631,579 个数字）：72.2 → 315.3ms（4.37×）、堆 20.1 → 82.7MB（4.11×）——纯数字 JSON 基线的 double 数组打包是 BigInt 最坏情况。
- 深嵌套：`JSON.parse` 与手写 parser 都能吃 100 万层（2MB 文本 52.9 vs 110.1ms）。**`JSON.stringify` 在 ~1 万层就 RangeError**（现状已有，本 ADR 不修）。
- 短字符串驻留可把 50MB 值图堆从 140.9MB 降到 123.3MB（1.84×），+12% 时间——记为可选的后续优化，不在本 slice 承诺。

### 2.2 BigInt / 序列化 / 跨线程序列化

- 单值成本（100 万值）：Number +7.7MB → BigInt +30.6MB（4.0×，≈+23 B/值）；字符串承载 +45.9MB 且类型语义差（否决）；包装对象 `{raw}` +76.4MB 且破坏 `isContainer`（否决）。
- `BigInt` 可 structured clone（100 万 63.0ms vs Number 54.3ms，+16%）；**`JSON.rawJSON` 直接 `DataCloneError`**；包装类 clone 后丢 prototype（5.4× 慢）——协议红线「只放 structured-clone-safe 普通对象」不变。
- `JSON.stringify(BigInt)` → `TypeError: Do not know how to serialize a BigInt`；`JSON.parse` 永远产不出 BigInt。
- `toJSON` 对 BigInt **有效**（规范对 Object 取 `toJSON`；修正常见误解）：`BigInt.prototype.toJSON = function(){return JSON.rawJSON(this.toString())}` 可让标准 stringify 输出裸数字——但这是改全局原型（影响面大），**本 ADR 不采用**，改为显式无损序列化器。
- 50MB stringify 成本（本机实测，非外推）：`JSON.stringify` 基线 118–119ms → 无损序列化器 191–193ms（1.6×，RSS 386→591MB）；全数字 50MB：184–188 → 558–577ms（3×，RSS 322→777MB）。
- `strict` 档能逐字节往返（10MB/50MB 实测 exact），代价是给所有非规范字面量（`212559.30` 之类）加包装、解析再 +11%~31%、+45MB/100 万值——**否决**（见 §3 Q3）。

### 2.3 首帧外推（非实测；需 Chrome 复测）

仓库 Chrome 基线：50MB 首帧 150.2ms（parse 93.2ms）、10MB 首帧 52ms（parse ≈11ms）。按 parse 相对倍数外推：10MB 首帧 ≈**81ms**、50MB 混合 ≈**318ms**、50MB 大整数密集 ≈**464ms**。10MB 验收线 800ms 仍远够。**注意**：bench 是 Node/V8 13.6，目标 Chrome ≥120 是 V8 12.0，定稿验收前用仓内 headless harness 用同批样本复测 parse 段与 worker 堆。

### 2.4 BigInt 进值图后现状会坏的地方（实现前的事实清单）

- **静默错**（面更大）：`jsonKind()` 的 typeof 白名单对 `'bigint'` 落到 `default → 'null'`（`row-model.ts:46`）→ 行值/类型列/折叠摘要/搜索预览/大纲/编辑标题全显示 `null`。
- **直接抛**：4 个产品路径的整树 `JSON.stringify` —— `doc-service.ts:532`（打开编辑器）/`:586`（编辑 no-op 比较）/`:692`（导出）/`copy.ts:82`（复制子树）；表达式 `JSON.stringify` 有 catch → 受控错误。
- **表达式全 NaN 面**：`toNumberValue` 无 bigint 分支、`display(1n)=''`、`sanitize` 显式把 bigint 变 `null`、`kindOf → 'null'`；BigInt 字面量被静态拒绝。
- **保真报告反直觉**：它只扫源文本、判定式 `BigInt(lit) !== BigInt(Number(lit))` 与值图无关——**不改造会继续误报「大整数精度」**，不存在自然空转。
- 搜索：数字值**从不参与搜索**（`search.ts` 只 match 键名 + 字符串值），无损化不改变；仓库**没有按值排序**功能；整数字符串键重排仍由 fidelity `key-order` 检测（JS 对象语义，改数字表示修不了）。

## 3. 决策（#32 grill 13 条，2026-11-11 全部拍板）

| # | 决策 | 选择 |
|---|---|---|
| Q1 | 无损范围 | **只做整数**：超安全范围的整数值用 BigInt；高精度小数保持 Number（现状不改，另票）。**不假装无损** |
| Q2 | 表示与类型 | **BigInt 只作为 number 的第二种载体**；`JsonKind` 不新增成员（BigInt 归 `number`），协议/主题/CSS/行窗口不动 |
| Q3 | 导出/复制口径 | **值无损、不追求字节往返**：工具自己写无损序列化器，BigInt 输出裸十进制数字；原文逐字真相继续由「原文视图 / 复制原文」承担 |
| Q4 | 表达式语义 | **原生语义最小集**：BigInt 之间算术/比较/真值按 JS 原生；混算（bigint 与 number）给确定错误；`Math.*` 收 BigInt 报错；`Number()/String()/模板串` 允许（显式转换、有损自选）；表达式数字字面量与 `JSON.parse/stringify` 都走同一套无损处理器；步数预算不变 |
| Q5 | 编辑态 | **同一套无损处理器**：编辑器显示原文数字、Apply 用无损 parser 校验、no-op 判定改结构化深比较 |
| Q6 | 保真报告 | **保留链路、改判定基准**：整数 `precision` 退场（无损后恒 0，自检移到单测）；`key-order` 继续报；上溢/下溢按 Q7 口径；不再误报 |
| Q7 | 上溢/超大整数 | **整数型上溢也走 BigInt（无损）**，但设**展开位数上限 10,000 位**，超上限保持 `Infinity` + 报 `overflow`（防内存炸弹）；小数下溢保持现状 + 报 `underflow` |
| Q8 | 默认开关 | **默认开启无损、v1 不做设置开关**（避免两套解析/显示语义与测试矩阵翻倍） |
| Q9 | 性能接受度 | **接受** parse 2.8–4.4×、值图堆 2.1–4.1×；定稿前 Chrome 复测（§2.3） |
| Q10 | 体积预算 | **`page.js` 48 / 懒加载 146 预算不动（0 增长目标）**；`worker.js` 记录到 ADR（预计 +8–12KB gz），不设硬预算 |
| Q11 | parser 对拍 | **以 `JSON.parse` 为硬不变式**：语法接受面/重复键/`__proto__`/BOM/尾逗号/`-0`/深度逐例对拍 + 差分 fuzz；显式栈 |
| Q12 | 搜索 | **不动**（数字仍不参与搜索），记为已知差距、需要时另票 → **2026-11-12 用户反馈后修订**：数字按显示文本参与搜索（ADR-0014 修订） |
| Q13 | 交付流程 | 先 ADR + #32 评论 + 开实现票，然后 TDD 实现、分段提交、push 前问 |

## 4. 值模型契约

### 4.1 数字载体

值图里数字有两种 JS 载体，**对外都算 `number` 类型**：

- `number`：安全整数（`|x| ≤ 2^53−1`）、非整数、安全区内精确值；`-0` 保留（`Object.is(-0, 0) === false`）。
- `bigint`：数值上是整数且 `|x| > 2^53−1` 的字面量 → 精确值（例：`297532588187238660` → `297532588187238660n`）。
- 整数型字面量若**展开位数 > `BIGINT_DIGIT_CAP = 10_000`** → `Infinity`（与 `JSON.parse` 同口径）并进入保真 `overflow` 报告。
- 高精度小数（如 `0.1234567890123456789`）→ `Number`（精度仍丢，**属已知差距，不报**——与今天行为一致）。
- 非整数小数的上溢/下溢仍按 `Number` 语义：如「401 位整数部分 + 小数」形态 → `Infinity`（报 overflow）、`1e-400` → `0`（报 underflow）。注意 `1.5e400` 数值上是整数（15×10^399）→ 走 BigInt 精确，不是上溢。

### 4.2 新模块（单一来源，parser 与保真扫描共用，禁止两处各写一份规则）

**`src/core/number-literal.ts`**

```ts
export const BIGINT_DIGIT_CAP = 10_000;
export const MAX_SAFE_BIGINT = 9007199254740991n;
export interface NumberLiteralInfo {
  integerValued: boolean;
  /** number（安全整数/小数/±Infinity）| bigint（超安全范围整数）| null（整数超 cap → Infinity） */
  value: number | bigint | null;
  overflow: boolean;
  underflow: boolean;
}
export function analyzeNumberLiteral(lit: string): NumberLiteralInfo;
```

**`src/core/lossless-json.ts`**

```ts
export class LosslessParseError extends Error {
  readonly position: number; readonly line: number; readonly column: number;
}
export function parseLossless(text: string): unknown;
export function serializeLossless(value: unknown, indent?: number): string | undefined;
export function deepEqualJson(a: unknown, b: unknown): boolean;
```

### 4.3 parser 不变式（硬约束）

1. **与 `JSON.parse` 的语法接受面逐例一致**：值类型、空白（仅 `0x09/0x0A/0x0D/0x20`）、BOM 拒绝、尾逗号/注释拒绝、数字语法、字符串转义与孤立代理项、重复键**最后赢**、空文本报错。
2. `__proto__` 必须是 own property 且**不改原型**（`Object.defineProperty`；沿用 `walk.ts` 的 `defineOwn` 口径）。
3. **显式栈、非递归**；100 万层深嵌套不爆栈（与 Node 24 的 `JSON.parse` 对齐）。
4. 字符串解码自己实现（不借 `JSON.parse`）；错误信息模仿 V8，含 `(line L column C)` / `position N`，并给 `LosslessParseError.position/line/column`（1-based）——上游 `import.ts` 的 `parseErrorPosition` 与 `PARSE` 行列口径不变。
5. 纯函数、零依赖；热路径 charCode 扫描。
6. 数字一律经 `analyzeNumberLiteral`；`value === null` → `Infinity`。

### 4.4 序列化口径

- 无 BigInt 的普通 JSON 值：与 `JSON.stringify(value, null, indent)` **逐字节等价**（缩进夹取、字符串转义复用 `JSON.stringify(string)`、`-0 → "0"`、非有限 number → `null`、对象键顺序 = `Object.keys`、undefined/function/symbol 的数组元素 → `null`、对象成员跳过、顶层 → `undefined`）。
- BigInt → **裸十进制数字**（`297532588187238660`，无引号无 `n`）。输出仍是合法 JSON 数字；能被本 parser 无损再导入。
- 不追求字面量写法/字节级往返（`1.50` 导出为 `1.5`），逐字真相在原文视图。
- 递归实现（与 `JSON.stringify` 同样受调用栈限制；>1 万层 RangeError 属现状已知差距）。

### 4.5 深相等

编辑 no-op 判定用 `deepEqualJson`（替代两次 `JSON.stringify` 比较）：类型严格（`number 5` 与 `bigint 5n` 不相等）、数组按序、对象**键顺序也相同**（与旧 stringify 比较语义一致）、`Object.is` 判 `-0`。

## 5. 下游改造（必须一起过，否则半损）

| 位置 | 现状 | 改后 |
|---|---|---|
| `core/import.ts` | `JSON.parse`（两处：直解 + 修复文本） | `parseLossless`；错误映射沿用 `PARSE` + 行列 |
| `core/repair.ts` | 自校验 `JSON.parse` | `parseLossless`（单一 parser 真相） |
| `core/doc-service.ts` | `getNodeJson` / 编辑 no-op / `parseEditText` / `exportDoc` 用标准 JSON API | 依次换 `serializeLossless` / `deepEqualJson` / `parseLossless` / `serializeLossless` |
| `core/copy.ts` | 子树 `JSON.stringify`、原始值 `JSON.stringify(number)` | 子树 → `serializeLossless`；`rawValueText` 增加 bigint → `String(value)` |
| `core/row-model.ts` | `jsonKind`/`scalarPreview` 无 bigint | bigint → kind `'number'`、预览 `String(value)` |
| `core/measure.ts` | 标量下界无 bigint | bigint 下界 = `String(value).length` |
| `core/outline.ts` / `core/search.ts` | 走 `jsonKind`/预览 | 随 row-model 自然正确；搜索数字口径不变 |
| `core/fidelity.ts` | 文本扫描 `precision/overflow/underflow/key-order` | **precision 退场**；数字判定与 parser 共用 `analyzeNumberLiteral`；保留 overflow/underflow/key-order |
| `protocol/types.ts` | `FidelityCounts.precision`、`FidelityHit.reason:'precision'` | 删除 `precision`（`number = overflow + underflow`），reason 只剩 `overflow/underflow` |
| `app/main.ts` | 保真条按类别文案含「大整数精度」 | 去掉该类；其余（上溢/下溢/键序、多命中导航、常驻对照）不变 |
| `core/expression/*` | BigInt 全 NaN 面 | 见 §6 |
| `view/` | 树/原文渲染 | **不动**（`JsonKind` 不变、BigInt 不出 worker） |

## 6. 表达式语义（Q4 落地）

- **字面量**：允许 `123n`（撤销 `BigIntLiteral` 静态拒绝）；**严格 JSON 数字语法**的字面量按 `acorn` 的 `raw` 走 `analyzeNumberLiteral`（否则 `$.uid > 1234567890123456789` 右侧先丢精度）；JS 专属写法（数字分隔符 `1_000`、`0x/0o/0b`、sloppy legacy octal `0777`）**保持 acorn `node.value` 的 JS 语义**（`isJsonNumberLiteral` 单一判定）——审查修复：否则 `1_000` 会变 NaN、`0777` 会变十进制 777。
- **算术 `+ - * / %`**：两边都是 BigInt → 原生（`/` 截断；**除零/模零给 `EVAL_DIV_BY_ZERO`**，不能落成泛化 PARSE 错误）；一边 BigInt 一边非 BigInt（且不是字符串拼接）→ `EVAL_MIXED_NUMBER`（文案「超大整数不能进行该运算：<op>」；同一 code 也用于一元 `+` / `Math.*`，所以文案不写死「混算」）；`+` 遇字符串仍按 JS 拼接（`${1n}`/`String(1n)` 正常出 `'1'`）。
- **比较 `< <= > >=`**：任一侧 BigInt → 原生关系比较（JS 允许 BigInt 与 Number 混合比较，不做有损转换）；字符串比较路径不变。
- **`Math.*`**：任一实参是 BigInt → `EVAL_MIXED_NUMBER`（对齐原生 `TypeError`）。
- **显式转换**：`Number(bigint)` → `Number(value)`（允许、可能丢精度，用户显式选择）；`String(bigint)`/模板串 → 十进制串。
- **`JSON.parse/stringify`**：分别改用 `parseLossless` / `serializeLossless`（表达式内也一致无损）。
- **结果归一化**：`sanitize` 保留 BigInt（不再变 `null`）；`kindOf` → `'number'`。
- **预算不变**：BigInt 运算算 1 步，三档预算与步数公式不动。

## 7. 保真报告（ADR-0003 修订）

- **整数 precision 退场**：整数由 parser 保证精确，检测恒 0 → 删除该类别（`FidelityCounts.precision`、`reason:'precision'`、文案分支）。「自检」移到单测（同一字面量：`BigInt(lit) === value`）。
- **保留**：`overflow`（整数超展开位数上限 → Infinity；或**非整数**小数上溢，如「401 位整数部分 + 小数」）、`underflow`（非整数小数 → 0，如 `1e-400`）、`key-order`（JS 对象整数字符串键重排，改数字表示修不了）。注意 `1e400` / `1.5e400` 数值上是整数 → BigInt 精确，**不报** overflow（与 §4.1 一致）。
- 数字判定**与 parser 共用** `analyzeNumberLiteral`，禁止两份规则漂移。
- 保真条 DOM/导航/常驻对照/状态栏/跳原文能力**全部保留**（ADR-0003 2026-11-11 晚修订不变），只改计数类别与文案。
- `parsed` 对照：overflow 显示 `Infinity`、underflow 显示 `0`；不再有「原文 X → 实际 Y（大整数精度）」这一支。

## 8. 明确不做 / 已知差距

- **高精度小数无损**（`0.1234567890123456789` 仍静默丢精度、不检测）——另票。
- **字面量字节级往返**（`1.50`、`-0.0`、`1e3` 的写法不保留）——原文视图承担逐字真相；strict 包装档已否决。
- **整数样式键序无损**（需换成 Map/数组承载，破坏全仓消费者）——不做，保真条继续报。
- ~~**数字值搜索**——不做，另票~~ → **2026-11-12 用户反馈后已实现**（数字按显示文本参与搜索；详见 ADR-0014 修订）。
- **深嵌套导出/复制 >1 万层 RangeError**——现状已有，本 slice 不修。
- **`BigInt()` 构造器不进表达式白名单**（`BigInt(number)` 会二次丢精度，容易误导）；`123n` 字面量足够。
- **不提供设置开关**（Q8）。
- 保真扫描耗时（50MB ≈330ms）本 slice 不优化；parser 替换后整数类命中消失，扫描仍跑（key-order/上溢/下溢）。
- **Chrome 复测**（§2.3）做成实现票的验收步骤，不是可选项。

## 9. 预算（Q10；预算变更必须先问）

- `page.js` gzip 预算 **48KB 不动**（47.6 现状）：BigInt 不出 worker、行窗口只传 preview 字符串、`JsonKind` 不变 → 目标 **0 增长**。
- 懒加载 chunk 合计预算 **146KB 不动**（145.5 现状）。
- `worker.js` 现 61.1KB gz、**无硬预算**：解析器/序列化器/值模型/表达式改动主要吃这里；预计 **+8–12KB gz**（原型 parser 235 行 / 2.6KB gz；生产版含自写 unescape + 错误行列 + 边界，估 +2–4KB）。实现完成后把实测数写进 §11，并更新架构 README。
- 若实现中 `page.js` 撞上 48KB：停下来找用户拍板，不默认超。

## 10. 验收

- `npm run check`（tsc + vitest + build）全绿；新增单测覆盖 §4/§6/§7 全部规则 + parser 差分 fuzz。
- 15 套冒烟串行全绿；冒烟期望按新口径更新（`smoke-fidelity` 类别、`smoke-copy`/`smoke-export`/`smoke-edit` 大整数、`smoke-expression` BigInt 语义）。
- 关键行为（必须逐条演示）：
  1. `297532588187238660` / `1234567890123456789`：树显示、类型列 number、复制子树、复制原始值、导出、编辑回填均为**精确十进制**、不带引号。
  2. `1e400`：值为 BigInt 10^400（不再 Infinity），导出为 401 位整数（本 parser 可无损再导入）。
  3. `1e10001`：保持 `Infinity` + 保真报 `overflow`（且**不再**报大整数精度）。
  4. `0.1234567890123456789`：保持现状（number，精度丢、不报）。
  5. 键序失真仍报、导航/对照/跳原文不受影响。
  6. 表达式：`filter(x => x.id > 1234567890123456789)` 精确（单测钉住裸字面量与 `n` 后缀两种形态）、`x.id + 1` 报 `EVAL_MIXED_NUMBER`（文案「超大整数不能进行该运算：+」）、`String(x.id)` 正常。
  7. 编辑：回填 → 不修改 Apply 为 no-op；改动小数/结构后 Apply 正常。
- 体积：`node build.mjs --analyze` 记录 page/worker/css/懒加载；page ≤48、懒加载 ≤146。
- 性能：50MB/10MB 首帧与值图堆用 Chrome harness 复测（Node 数字只作对照），数字进 §11。

## 11. 实现结果（2026-11-12）

- **代码落地**：
  - 新建 `src/core/number-literal.ts`（`analyzeNumberLiteral` / `BIGINT_DIGIT_CAP=10_000` / `MAX_SAFE_BIGINT`；parser 与 fidelity 共用）与 `src/core/lossless-json.ts`（`parseLossless` / `serializeLossless` / `deepEqualJson` / `LosslessParseError`；显式栈非递归、字符串自解码、`__proto__` 安全、错误带 1-based 行列且消息含 `position N (line L column C)`）。
  - 管线换装：`import.ts`（两处解析）、`repair.ts`（自校验）、`doc-service.ts`（`getNodeJson` / 编辑 no-op → `deepEqualJson` / `parseEditText` / `exportDoc`）、`copy.ts`（子树 + 原始值）。
  - BigInt 值消费方：`row-model.jsonKind`（bigint → `number`）/`scalarPreview`（十进制串）、`measure.scalarLowerBound`（位数）、`outline`/`search` 随 row-model 自然正确（搜索口径不变）。
  - 表达式：`validate` 允许 `BigIntLiteral`；`walk.evalLiteral` 用 `raw` 走无损判定、允许 `123n`；同类型算术原生；混算/一元 `+`/`Math.*` → `EVAL_MIXED_NUMBER`；关系比较任一侧 BigInt 走原生；`display`/`toNumberValue`/`toPropertyKey`/`sanitize`/`kindOf` 补 BigInt；表达式内 `JSON.parse/stringify` 改用无损处理器；步数预算不变。
  - 保真：`fidelity.classifyNumber` 改用 `analyzeNumberLiteral`（整数精确 → 不报；超 cap/小数上溢 → `overflow`；小数下溢 → `underflow`），删 `precision`/`parsedExact`/本地 `normalizeDecimal`；`protocol/types.ts` 删 `FidelityCounts.precision` 与 `reason:'precision'`；`app/main.ts` 条文案去掉「大整数精度」。
  - `protocol/types.ts` 新增 `ExprErrorCode = 'EVAL_MIXED_NUMBER'` / `'EVAL_DIV_BY_ZERO'` + `shared/expression-copy.ts` 文案「超大整数不能进行该运算：{0}」/「除数为 0」。
- **单测**：930 → **979**（`number-literal` 9、`lossless-json` 17（含 1000 例差分 fuzz 与语法拒绝面对拍、孤立代理项、**1,000,000 层深嵌套**、`__proto__`、重复键、`-0`、`1e400` 导出 401 位→再导入）、row-model/measure/search/outline BigInt 用例、表达式 BigInt 用例、fidelity 口径重写）。`npx tsc --noEmit` 干净。
- **搜索（2026-11-12 用户反馈修订）**：数字（number / BigInt）按**树里显示的文本**参与值搜索（`row-model.scalarPreview` 同源），布尔/null 不参与；`search-reference` 同步并补 7 条 parity 用例、`smoke-search` +4 检查（大整数可搜 / 普通数字 / bool-null 不命中 / 0 长任务）。详见 ADR-0014 修订。
- **冒烟**：15 套串行全绿；受影响套件计数变化——`smoke-fidelity` **35/35**（fixture 按新口径重写：大整数/`1e400` 不再报、超 cap 才报 overflow；导航/循环/常驻对照/跳原文不变、与修复条并存仍绿）、`smoke-copy` **38 → 43**（树行/子树/根子树/原始值/键名精确十进制）、`smoke-export` **21 → 22**（导出剪贴板逐字含裸大整数）、`smoke-edit` +3（编辑器回填精确、no-op 不推版本、编辑后仍精确）、`smoke-expression` **45 → 52**（读/算术/混合关系/混算错误/数组过滤/字符串转换/JS 字面量语义/BigInt 除零）、`smoke-search` **97 → 101**（数字可搜）。
- **体积**（`node build.mjs --analyze`）：`page.js` **47.6KB gz / 预算 48（未变，0 增长）**；懒加载 chunk 合计 **145.6KB gz / 预算 146（未变）**；`worker.js` 61.1 → **63.2KB gz（+2.1，无硬预算，记录）**；`page.css` 8.2 不变。
- **性能 / Chrome 复测（2026-11-12，仓内 headless harness + `.spike/samples/50mb.json`）**：50MB `loadText` → 首行 **427ms**（仓库旧基线 150.2ms，**2.8×**，与 Node bench 的 2.80× 一致）；保真扫描 **256.6ms**（首帧后异步）、**0 个长任务**（解析在 Worker 内，不阻塞主线程）、0 异常 / 0 console error。10MB 首帧仍 9ms（`smoke-fidelity` 实测）。
  - **已知缺口（如实登记，未做假）**：Chrome 内 **worker 值图堆**未直接采样——CDP 对 dedicated worker 无稳定 attach 路径，现有 harness 只测了页面侧首帧/长任务；值图堆以 **Node bench 2.1×（+140.9MB @50MB）** 作对照。若后续要硬性核对 Chrome 堆，需给 harness 加 `Target.setAutoAttach` 或 Worker 内自报 `performance` 指标（另开票）。
- **push 前双轴审查修复（2026-11-12，Standards 轴 1 硬违规 + 4 judgement call 收口）**：① 表达式数字字面量只有严格 JSON 语法走无损判定（新增 `isJsonNumberLiteral`），修复 `1_000`/`0777` 回归并加单测；② BigInt 除零/模零 → 新增 `EVAL_DIV_BY_ZERO`（文案「除数为 0」），不再被泛化成 `PARSE_ERR_ROOT_SHAPE`；③ `EVAL_MIXED_NUMBER` 文案改「超大整数不能进行该运算：{0}」（覆盖混算/一元 `+`/`Math.*`，不再只写「混算」）；④ BigInt 混合关系比较的单一原生断言收进 `nativeRelational()` 并加边界单测（`1n < 1.5` / `-1n > -1.5` / `1n < '2'` 等）；⑤ 三处数字语法扫描加交叉注释（parser 严格 / fidelity 宽松是有意的，判定仍单一来源）。
- **与 ADR 的偏差**：无设计级偏离；两处实现口径细化——① `1.5e400` 数值上是整数（15×10^399）→ 走 BigInt 精确（不是 Infinity），「非整数上溢」需 401 位整数部分 + 小数才出现；② 编辑 no-op 用 `deepEqualJson`（键序敏感、`-0` 用 `Object.is`），与旧 stringify 比较语义对齐。

## 12. 记录

- #32（设计票）：grill 13 条拍板评论 + 关闭（completed）。
- #33（实现票）：本 ADR 的 §4–§10 即其验收依据；实现结果见 §11。

## 指针（2026-11-12，#34 / ADR-0022）

`serializeLossless` 将增加**可选** `{ escapeUnicode?: boolean }`（默认 `false`，保持与 `JSON.stringify` 逐字节等价；开启时字符串/键的非 ASCII → `\uXXXX`，BigInt 仍裸十进制）。只有文件导出（及整份复制）透传该开关；子树复制 / 编辑回填 / 表达式内 `JSON.stringify()` 不传。见 ADR-0022。
