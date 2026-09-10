# 表达式求值载体：手写 AST walker vs WASM 内真 JS 引擎（调研 #14）

> 对应 GitHub issue: [#14 调研：表达式求值载体 — 手写 walker vs QuickJS-wasm](https://github.com/dtdths/turbo-json-viewer/issues/14)（wayfinder:research，Part of [#1](https://github.com/dtdths/turbo-json-viewer/issues/1)）。
> 前置：[#3 表达式安全求值引擎与字段提示来源](https://github.com/dtdths/turbo-json-viewer/issues/3) → `docs/research/expression-engine.md`（已定：复用 acorn 解析、绝不 eval、四层防失控、白名单语义）；
> [#4 MV3 与上架约束](https://github.com/dtdths/turbo-json-viewer/issues/4) → `docs/research/mv3-store.md`（CSP/远程代码事实清单，本文第 4 节只做增量）；
> [#2 大 JSON 渲染](https://github.com/dtdths/turbo-json-viewer/issues/2) → `docs/research/json-rendering.md`（文档在 Worker 内的形态与 50MB 上界）。
> 消费方：**#12 设计：表达式过滤视图与执行预算**（本文结论即其拍板输入）；G-7 模块架构。
> 词汇遵循 `CONTEXT.md`（表达式 / 字段提示 / 文档概要 / 容器预览）。

**标注体系**：`【确证】` = 一手来源（官方文档 / 官方 README / 规范 / 项目源码 / 官方 dist）明文可引，给出 URL 或精确文件路径；`【需实测】` = 文档未背书、或只有真机/真实提交才能定论，括号内给出建议实验。`[事实]` = 本次实测或一手来源直述；`[分析]` = 本文推论。**所有体积与性能数字均为本次实测**，方法见 §8 附录（可复现）。

**本会话环境限制（影响证据强度，必须说明）**：`web_fetch` 被沙箱 DNS 策略拦断，一级页面原文一律用命令行 `curl` 抓取核对；**真机 MV3 扩展 spike 无法在本沙箱执行**（Chrome 本体的 helper 进程在 DSH 文件沙箱下无法初始化，`--load-extension` 装入的扩展在 `chrome://extensions` 中不可见，headless 与 headful 均复现），因此第 4 节的**运行时**结论仍为 `【需实测】`（**政策文本**结论已用一手来源确证），且已在 §7 给出可直接照做的 spike 协议。另：本次 `developer.chrome.com` 在沙箱内 TCP 层被阻断，Chrome 文档引文取自 Google 自托管的同站镜像 `developer.chrome.google.cn`（同 DevSite、内容为当前版本；与 #4 直连取得的条文一致），规范 URL 待网络允许时复核——细节见 §4.1 的方法披露。

---

## 0. 结论速览（TL;DR）

**推荐：维持 #3 的手写 walker 路线（acorn + 白名单 tree-walking 解释器，同进程直接引用文档对象），不引入 WASM 内的真 JS 引擎。** 但要把 #3 里两个尚未验证的参数改掉（步数预算口径、以及"白名单"的含义边界）。

| 判据 | 手写 walker（路线 A） | QuickJS-wasm（路线 B） | 谁赢 |
|---|---|---|---|
| 表达式语义 | 白名单子集（不存在=不可表达，结构性安全） | **完整 ES2023**（含 `eval`/`Function`/`Date`/`Proxy`），靠 VM 边界兜底 | A（安全面），B（语法宽容） |
| 包体积（raw / gzip） | acorn 233.3KB/56.9KB + walker ~10KB/~3KB ≈ **243KB / 60KB** | wasm 503.1KB/231.5KB + JS 84.7KB/18.2KB ≈ **588KB / 250KB** | A（省 ≈4× gz、≈2.4× raw） |
| 50MB 文档首次求值 | **57–115ms**（文档已在内存，零拷贝零重解析） | **≈1.58s**（238ms 拷入 + 1079ms VM 内 `JSON.parse` + 106ms 求值 + 147ms stringify + 13ms 拷回） | A（快 14–28×） |
| 同一文档第二次求值 | 57–115ms | 197ms（文档驻留 VM 时） | A（快 2–3.5×） |
| 内存 | 无副本 | 文档在 wasm 堆内**再存一份**（50MB 文档实测 RSS +104MB） | A |
| 死循环掐断 | 自己写：步数/时间双预算，检查点 4096 步，毫秒级确定 | 引擎原生：时间预算误差 **≤0.6ms**；步数预算 = 中断回调计数（**每 10,000 条字节码**回调一次，确定性） | B（能力更硬），A（口径更自由） |
| 内存上限 | 无原生手段，只能靠结果/中间容器尺寸预算 | 原生 `setMemoryLimit`（InternalError: out of memory） | B |
| 错误定位 | 自己抛：`{code, pos, loc}` 直接对应表达式文本 | 引擎抛：`SyntaxError.fileName/lineNumber` + `stack` 里的 `:line:col`，需正则提取 | A（结构化），B（含真堆栈） |
| 双语文案 | 自持 `messageKey`（引擎不含文案） | 需把引擎英文文案（如 `unexpected token in expression`）映射成 messageKey | A |
| MV3 合规 | 结构性合规：不改 CSP、无 wasm、代码完全可审计 | 需 `'wasm-unsafe-eval'`（官方最低策略之一、安装期白名单内、**非"放宽"**）；包内 wasm **不是**远程代码，隐私面板答 No；**唯一非对称软风险 = 审查员对 ~1MB `.wasm` 的可读性判断（§4.1⑥，需提审实测）** | A（少一个变量 + 审查面更小） |
| 维护面 | 原型实测 **311 行（271 行非注释）** 覆盖 §7 语法边界，含预算与错误定位；无第三方引擎版本/漏洞跟版 | 引一个 C 引擎 + 4 个变体 + wasm 构建链；跟 quickjs/quickjs-ng 上游 | A |
| 失败面 | 自己写错语义（可测、可枚举） | 引擎侧内存安全/沙箱逃逸 CVE、wasm 加载/CSP 配置、体积回归 | A |

**一句话**：路线 B 在"原生中断/内存上限"上更强，但代价是 **50MB 文档多付一份拷贝 + 一次 VM 内重解析（~1.3s）**、250KB gz 体积、一个 CSP 声明与一条新的审核问询面；而它换来的"完整 JS 语义"恰恰是本产品**不想要**的东西（#3 §7 明确不收正则/赋值/原型链）。路线 A 的 dispatch 核心已被本次原型实测钉在 **~300 行 / 17 个节点类型**，并且同类成熟库有更小的可比证据（`expression-eval` 43 行 / 10 类型、`jexl` 137 行 / 9 类型、`angular-expressions` 为 CSP 环境专门维护 466 行 walker / 15 类型）——**"手写 walker 的 dispatch 太贵"在本项目语境下不成立**；真正要排期的是 prior art 普遍缺位的三块：**语义矩阵、预算/中断、错误位置**（§1.6）。

**三条附带的结论**（细节分别见 §2.2 / §4.1 / §1.6）：
- **Duktape 从候选表排除**：官方无 wasm 浏览器构建（站点只给 asm.js `dukweb.js` 1.32MB、其引用的 `dukweb.wasm` 是 404），语言停在 ES5（**实测官方 2.7.0 CLI 解析不了 `a?.b.filter(item => item.price > 100)`**，箭头/模板串/`let` 全失败，3.0.0 路线图也没计划），web 构建的超时要么不存在要么是假的，错误对象**没有列号/偏移**（单行表达式恒 `lineNumber=1` → 无法定位 token）。
- **MV3 政策口径已定（政策文本层面）**：包内 `.wasm` **不算**远程代码（RHC 定义逐字点名 "JavaScript and WASM"，判据是"是否来自扩展自身文件"）；那条唯一提到 interpreter 的禁令限定于 *"commands fetched from a remote source"*；`'wasm-unsafe-eval'` 是 Chrome 自己追加的**最低策略**、在安装期白名单内，声明它**不构成"放宽"**，也**不会**换回 JS 字符串 `eval`（CSP3 §6.1.10：*"only permits WebAssembly and does not affect JavaScript"*）；隐私面板答 **"No, I am not using remote code"**。→ B 并不违反成文政策，但留有一个非对称软风险：**审查员看不懂 ~1MB 的 `.wasm`**（MV3 要求"完整功能必须能从提交代码中清晰辨认"），须靠提审验证（§4.1⑥、§7.2 B2/B6）。
- **prior art 校准了"路线 A 的真实工作量"**：dispatch 核心确实只有 ~300–450 行（`expression-eval` 43 行/10 类型、`jexl` 137 行/9 类型、`angular-expressions` 为 CSP 环境专门维护 466 行 walker/15 类型），但**10 个真求值器里只有 2 个有预算/限额、位置信息几乎全是解析期**——**语义矩阵、预算/中断、运行时错误位置**这三块 prior art 没得抄，必须自己排期（§1.6）。

**必须随本结论一起改掉的两处 #3 参数** `[事实]`：
1. **步数预算默认值 1e6 太小**。实测 walker 对"每行一次谓词求值"的消耗是 **5.8 步/行**（单谓词 filter+map），双谓词 + 对象产出是 **11.7 步/行**；200k 行（22MB）文档的合法查询要 **1.16M–2.35M 步**，会被 #3 的 `maxSteps: 1e6` 直接判 `EVAL_STEP_LIMIT`。→ 改为**与文档规模挂钩**：`maxSteps = max(1e6, 16 × 文档节点数)`（50MB/340k 行 → ≈5.4e6 步，实测该查询用 2.0–4.0M 步），并**把时间预算作为真正的刹车**（walkers 实测 30–49M 步/秒，1e6 步仅 20–33ms）。
2. **"白名单"是执行层的，不是语法层的**。路线 A 中白名单是**结构性**的：不在 `NODE_TYPES` 里的语法根本无法表达。原型实测的一个细节：静态校验里"调用的属性名必须在方法白名单里"这一条**会误杀 `Math.max(...)`**（`max` 不在数组/字符串方法表里）——需要额外一条"全局命名空间接收者"规则。这是路线 A 唯一一类真实维护陷阱：**校验器必须理解"接收者是谁"才能判合法调用**，而这层逻辑在路线 B 里由 JS 引擎自己承担（代价是它也放行了 `eval`/`Function`）。

---

## 1. 路线 A：acorn + 手写 walker 的真实规模

> 本节数字来自本次**真写的原型**（`/tmp` 下的 `walker.mjs`，311 行，含解析入口、静态校验、解释器、预算、错误对象）。原型不是产品代码（无测试、未处理全部边界），因此下面的行数是**下界**；但节点类型数、步数消耗、每步成本是真实量级。

### 1.1 节点类型数量（白名单的实际大小）`[事实]`

| 项目 | 数量 | 说明 |
|---|---|---|
| 解释器**实现**的节点类型（= 白名单） | **17** | `Program, ExpressionStatement, Identifier, Literal, TemplateLiteral, TemplateElement, ArrayExpression, ObjectExpression, Property, MemberExpression, ChainExpression, CallExpression, ArrowFunctionExpression, BinaryExpression, LogicalExpression, UnaryExpression, ConditionalExpression` |
| 其中进 `eval()` switch 分派 | **13** | 其余 4 个（`Program/ExpressionStatement` 在入口、`TemplateElement`/`Property` 在其父节点内处理） |
| 解释器**明确拒绝**并给专用错误码的节点类型 | **29** | `For*/While*/DoWhile*/AssignmentExpression/UpdateExpression/Function*/Class*/NewExpression/ImportExpression/Await/Yield/VariableDeclaration/...` ——拒绝是默认行为（default-deny），这 29 个只用来产出更好的文案 |
| 白名单方法 | 数组 15（`map/filter/find/findIndex/some/every/includes/indexOf/lastIndexOf/slice/concat/join/flat/at/reduce`）+ 字符串 13 + `Math` 11 + `Number/String/Boolean/Array.isArray` | 与 #3 §5.2 的提示白名单同表 |

对照：**ESTree 规范本身**（`estree/estree` master @ `875bf70440a8870c4a663865a7a41300cf1add55`，扫 11 个 spec 文件 `es5/es2015/es2016/es2017/es2018/es2019/es2020/es2021/es2022/es2025/es2026`）共定义 **91 个 `interface`**（89 个 AST 节点接口，10 个抽象基类 → **79 个具体节点类型**），其中 `Expression` 子树具体类型 **24** 个、`Statement` 子树 **22** 个，另有 31 处跨文件 `extend interface`、26 个已废弃类型（`deprecated.md`）。`[事实]`（命令见 §8）

于是白名单的算术是：**79 个具体类型 → 24 个属表达式 → 本项目 v1 收 16 个左右 → 必须显式拒绝 8–10 个**（`Assignment/Update/New/TaggedTemplate/MetaProperty/Await/Yield/ImportExpression/正则字面量/BigInt 字面量`）。**白名单的规模由产品语义决定，不由语言规范决定**——这是路线 A 规模可控的根本原因。`[分析]`

### 1.2 行数（含预算与错误定位）`[事实]`

```
$ wc -l walker.mjs            → 311
$ grep -vcE '^\s*(//|/\*|\*|$)' walker.mjs → 271   # 非空非注释行
```

271 行里包含：错误码表与 `EvalFail`（含 `pos/loc`）、两组白名单（节点 + 方法）、`parse()`（acorn 封装 + 长度上限 + 错误转码）、`validate()`（default-deny 遍历 + 深度上限 + 调用点检查）、`Machine`（步数/时间预算、作用域链、own-property 成员读、方法分派、可选链短路的 `SHORT` 哨兵、箭头函数闭包、13 个节点类型的求值）、`run()` 门面。

**产品化估量** `[分析]`：原型是"能跑对"的版本；产品化还要补 ①每个白名单方法的语义测试与边界（`reduce` 初始值、`slice` 负数、`flat` 深度…）②双语 `messageKey` 表与参数化 ③`ChainExpression` 与 `loc` 的组合边界 ④与文档概要（补全）共用白名单表的一致性测试 ⑤fuzz/差分测试（与宿主 JS 语义对比）。经验上**代码量 ×2–3、测试量 ≥ 代码量**，即 **600–900 行实现 + 等量测试**。这仍是一个可以由一个人完整掌握的模块。

### 1.3 原型实测：正确性与定位 `[事实]`

19 条用例全部按预期通过（含 5 条应当被拒的用例），摘录：

| 表达式 | 结果 | 步数 |
|---|---|---|
| `data.hotel_tags.filter(t => t.price > 100).map(t => t.tag_name)` | `["x"]` | 18 |
| `data.nothing?.x ?? 'fallback'` | `"fallback"` | 4 |
| `data.items.reduce((acc,x) => acc + x.price, 0)` | `470` | 18 |
| `` `count=${data.items.length}` `` | `"count=3"` | 4 |
| `data.items.filter(i => i.price >`（语法错） | `{code:"PARSE_ERR_SYNTAX", params:["Unexpected token (1:32)"]}` | — |
| `items.push(1)` / `forEach` | `{code:"STATIC_ERR_CALL", loc:{line:1,column:6}, params:["push"]}` | — |
| `while(true){}` | `{code:"PARSE_ERR_ROOT_SHAPE"}`（只允许单个表达式语句） | — |
| `x = 1` | `{code:"STATIC_ERR_NODE", params:["AssignmentExpression"]}` | — |
| `new Function('return 1')()` | `{code:"STATIC_ERR_NODE", params:["NewExpression"]}` | — |
| `data.constructor.constructor('return 1')()` | `{code:"EVAL_SHAPE_ERROR"}`（own-property 读不到 `constructor`，不跟随原型链） | 5 |
| `typofield`（不存在的根字段） | `{code:"EVAL_UNKNOWN_FIELD", loc:{line:1,column:0}}` | 1 |

要点：**错误定位与错误码是"免费"的**——acorn 的 `pos/loc` 与解释器抛错时的当前节点 `loc` 直接够用，双语文案只需 `messageKey + params` 的映射表（#3 §2 的门面无需修改）。`[事实]`

### 1.4 预算的实现成本与真实口径 `[事实]`

路线 A 的预算是**三行代码级别**的东西（`tick()`：步数自增 + 每 4096 步读一次时钟），实测行为：

- 时间预算 50ms：在 200k 行过滤中执行到 1.2M 步后正常结束（该查询 36ms），未触发；把阈值调小即得 `EVAL_TIME_LIMIT`。
- 步数预算 10,000：触发 `EVAL_STEP_LIMIT`，`steps=10001`，且带 `loc {line:1,column:17}`（指向超限时的 AST 节点）。
- 吞吐：**28.5–48.7M 步/秒**（50MB/340k 行文档）；单谓词 `filter+map` 57–69ms、双谓词 + 对象产出 82–115ms。
- 编译期（`parse` + `validate`）：**0.010ms/次**（1000 次迭代实测），相对求值可忽略；可支撑"输入即校验"的即时反馈（#12）。
- 真实样本（`.mock/1.json`，0.93MB，约 **81,265 个节点**，最大数组 88 项）：44 项 `filter` = 181 步（≈4.1 步/元素）。
- 内存：无副本（对比路线 B 的 +104MB RSS）。`[事实]`

**步数消耗的经验公式**（供 #12 定预算）：`steps ≈ (4–12) × 被回调处理的元素数`，即**与文档中被扫描的规模成正比**，而不是常数。因此 `maxSteps` 要么与文档节点数挂钩（`max(1e6, k×节点数)`，k 取 8–16），要么干脆放大到"只会拦住真失控"的量级（如 50M），**把时间预算（500ms）作为真正的刹车**——实测 50MB 文档上的合法查询用时 57–115ms，余量充足。`[分析]`

### 1.5 维护面 `[分析]`

- 需要跟版的只有 acorn（MIT、零依赖、活跃）；acorn 升级只影响 parser，AST 契约（ESTree）稳定。
- 方法白名单是**单一来源表**（提示与解释器共用），新增方法 = 一行实现 + 一条测试。
- 风险集中在**语义正确性**（自己写的 `reduce` 与 JS 不完全一致之类），可用"差分测试：同一表达式在 Node 里跑一遍对比"系统性覆盖——这类测试路线 B 天然不需要（它跑的就是真 JS），是路线 A 明确要付的税。

### 1.6 同类实现的真实规模（prior art 实测）

> 数据来自并行子调研：把各库在**固定版本**下的 npm tarball / GitHub 源码解包后实测行数与 dispatch 类型数（每条数字附命令，完整报告见子调研产物）。行数口径：`raw` = `wc -l`，`code` = 去注释与空行。`[事实]`

| 库 | 版本 | 求值核心 LOC（文件） | dispatch 类型数 | 用 eval? | 有预算/限额? | 有错误位置? | License | 最后发布 |
|---|---|---|---|---|---|---|---|---|
| `expression-eval` | 5.0.1 | 同步 `evaluate()` = **57 raw / 43 code**（整文件 290/235） | 10 | 0 | 无 | 无 | MIT | 2023-06 |
| `jexl` | 2.3.0 | **318 / 137 code**（`Evaluator.js` + `handlers.js`） | 9 | 0 | 无 | 无 | MIT | 2020-09 |
| `angular-expressions` | 1.6.0 | `ASTInterpreter` = **466 / 454 code**（同文件另有 `ASTCompiler` 809/760） | 15 | 仅 compiler 路径 1 处 | 无 | 仅词法期 column | Unlicense | 2026-07 |
| `JS-Interpreter`（NeilFraser） | `45d00b0` | step handler 表 **1037 / 877 code**（全文件 5023/3719，另有 ES 内建 1922 + scope/property 机 1521） | 36 | 0 | **有**（POLYFILL_TIMEOUT 1000ms、外部 `step()` 计数） | 有（acorn loc + traceback） | Apache-2.0 | 2026-06 |
| `jsonata` | 2.2.2 | evaluator **1825 / 1269 code**（不含 parser 1423 行） | 20 | 0 | **有**（`timeout` D1012 + `stack` D1011） | 有（整数字符偏移 `expr.position`） | MIT | 2026-07 |
| `json-logic-js` | 2.0.5 | dispatcher **176/135** + 算子表 134/121 | 34（按 DSL op 名） | 0 | 无 | 无 | MIT | 2024-07 |
| `expr-eval` | 2.0.2 | 栈式 VM **193 / 178 code** | 13 指令 | 仅可选 `toJSFunction` | 无 | 仅解析期 | MIT | 2019-09 |
| `mathjs` | 15.2.0 | `_compile` 合计 487 行 / 16 文件 | 15 node class | 0 | 无 | 仅解析期 `(char N)` | Apache-2.0 | 2026-04 |
| `filtrex` | 3.1.0 / 2.2.3 | **不是 walker，是代码生成器**（3.x 内联 6216 行 Jison；2.x 170/116） | 无 AST dispatch | **1 处 `new Function`** | 无 | 无 | MIT | 2024-10 / 2021-06 |
| （基线）`jsep` | 1.4.0 | parser 979/604，**内建 `?.`**（不产 `ChainExpression`） | 产 10 种节点 | 0 | 无 | 有 `error.index` | MIT | 2024-11 |
| （基线）`acorn` | 8.18.0 | 6313/4690，228KB | — | 0 | — | 有 loc | MIT | 2026-07 |
| （反例）`safe-eval` / `vm2` | 0.4.1 / 3.12.2 | 26 行（Node `vm`）/ 13,681 行 | 0 | 2 处 `eval(` | 有（vm2） | 有 | MIT | 2018 / 2026-09 |

**四条可迁移结论** `[事实]+[分析]`：

1. **~300–450 行的 dispatch 核心是现实的，且有生产级证据**：`expression-eval` 的同步 `evaluate()` 只 **43 code 行**就覆盖 10 种 ESTree 表达式节点；`jexl` 整个 evaluator **137 code 行 / 9 种**；`angular-expressions` 的 `ASTInterpreter` **454 code 行 / 15 种**（这正是"表达式 + 过滤 + 赋值 + locals"级别的直接可比上界）。我们白名单 ~16 种 → **250–450 code 行**。本次原型 271 非注释行（含预算与错误定位，未含测试）落在同一区间。
2. **但 walker 只占总量的一部分**：angular 的 466 行 walker 复用 1724 行 lexer/AST-builder；jsonata evaluator 1825 行；JS-Interpreter 的 1037 行 step handler 之外还有 3143 行内建与作用域机。本项目这两块基本免费（acorn 提供 parser；JSON 数据无函数/Date/正则，语义面窄），但**不能把"walker 行数"当成模块总工作量**。
3. **prior art 在"预算/中断""运行时错误位置"两块几乎全空白**：10 个真求值器里只有 **2 个**有限额（jsonata 的 guardrails、JS-Interpreter 的外部 `step()` 计数，且后者 `run()` 文档自承 "Vulnerable to infinite loops"），位置信息只有 5 个有、且除 jsonata 外全是**解析/词法期**。→ **预算与错误定位必须作为一等 API 先设计**（#3 §2 的门面已正确这么做）；jsonata 的范式很便宜（入口 `depth++/--` + 每步调用 `guardrails()` 闭包，<30 行），但它要求"入口唯一 + 环境对象贯穿"，先写纯递归 walker 再补预算就会退化成必须外部计步的形态。
4. **MV3 CSP 砍掉了"代码生成"整整一支——而那一支恰好常挂着"手写表达式求值器"的招牌**：`filtrex` 2.x/3.x、`angular-expressions` 的默认路径 `ASTCompiler`、`expr-eval` 的可选 `toJSFunction` 都是 `new Function`。最有说服力的先例是 **`angular-expressions` 同时维护两套引擎，用 `options.csp` 在 `ASTInterpreter`(手写 walker) 与 `ASTCompiler`(new Function) 之间切换**——一个成熟库为了 CSP 环境专门养了 466 行手写 walker 作 fallback。这与我们的处境同构。`[事实]`
5. **维护活性的提醒** `[事实]`：`expr-eval`（2021-10 最后提交）、`jexl`（2021-04）、`filtrex`（2024-10）三个"手写求值器"代表都停在 1–5 年前；仍活跃的是 jsonata、angular-expressions、JS-Interpreter。手写 walker 行数小，但真实数据的边界（稀疏数组、`undefined` vs 缺失键、`null` 传播、数字/字符串强转、Unicode 键）会**长期**消耗时间——这是我们自己养代码的真实成本，应写进 #12 的排期而不是藏在"300 行"里。`[分析]`

---

## 2. 路线 B：WASM 内真 JS 引擎

### 2.1 体积实测（下载官方 dist 后 `wc -c` / `gzip -9`）`[事实]`

测量日期 2026-09-10；`quickjs-emscripten@0.32.0`（2026-02-16 发布）；命令见 §8。

| 变体包（npm） | 关键文件 | raw (B) | gzip -9 (B) |
|---|---|---|---|
| `@jitl/quickjs-wasmfile-release-sync` | `dist/emscripten-module.wasm` | **503,134** | **231,517** |
| 同上 + JS 胶水 | `emscripten-module.browser.mjs` 9,368 / `ffi.mjs` 6,369 / `index.mjs` 282 | 16,019 | 5,542 |
| `quickjs-emscripten-core`（引擎无关的 JS 层） | `index.js` 60,295 + `chunk-*.mjs` 45,838 + … | 116,736 | 27,553 |
| **路线 B 最小生产组合（wasm + core，实测 esbuild 产物）** | `bundle.js`（未 minify）84,712 + wasm | **587,846** | **249,763** |
| `@jitl/quickjs-ng-wasmfile-release-sync`（quickjs-ng 分支） | `emscripten-module.wasm` | 528,551 | 247,167 |
| `@jitl/quickjs-wasmfile-release-asyncify`（asyncify，可在 VM 内 await 宿主异步） | `emscripten-module.wasm` | 1,027,523 | 360,492 |
| `@jitl/quickjs-singlefile-browser-release-sync`（wasm 内嵌进 JS，无需单独 fetch） | 入口实际引用的 `emscripten-module.browser-XIKQQPVU.mjs` | 828,489 | 265,312 |
| `@jitl/quickjs-asmjs-mjs-release-sync`（无 wasm 的 asm.js 回退） | 入口 `index.mjs`（内含全部实现） | 1,104,470 | 333,002 |
| `quickjs-emscripten`（主包，含 4 个变体全量） | `index.global.js` | 2,373,880 | 685,781 |

对照路线 A（#3 §1.1 实测 + 本次原型）：**acorn 233,301 / 56,900 gz + walker ≈10KB / ≈3KB gz ≈ 243KB raw / 60KB gz**。

结论：**路线 B 的浏览器实际载荷 ≈ 588KB raw / 250KB gz**，是路线 A 的 2.4× raw / 4.2× gz。主包 README 自述"最小安装 `quickjs-emscripten-core` + `@jitl/quickjs-wasmfile-release-sync` = 1.3MB（`node_modules` 解压体积）"`【确证】`（[README §Reducing package size](https://github.com/justjake/quickjs-emscripten/blob/main/README.md)），与上表一致（解压体积 ≫ 浏览器传输体积）。相对 map #1 的 10MB 基线，250KB 不构成否决理由——**体积不是本决策的关键判据**。`[分析]`

### 2.2 Duktape：**不可行，从候选表排除**（实测结论）

> 数据来自并行子调研：下载官方 dist/npm tarball 实测体积，并**真编译了官方 Duktape 2.7.0 CLI**（`make -f Makefile.cmdline`）与三方 wasm 构建来跑真实表达式。`[事实]`

**① 不存在官方维护的 Duktape WebAssembly 浏览器构建。**

| 产物 | 版本 | raw / gzip -9 (B) | 性质 |
|---|---|---|---|
| `dukweb.js`（duktape.org 官方站点构建） | 未声明（3.x dev 系） | **1,316,271 / 331,410** | Emscripten **asm.js**，非 wasm |
| `dukweb.wasm`（被 `dukweb.js` 引用） | — | — | **HTTP 404，不存在** |
| npm `duktape` | 0.3.0（2015-09-13） | tgz 1,563,211 | **node-gyp 原生扩展**，没有 `dist/duktape.js` |
| `jseval-wasm` `duktape-eval.wasm` + 胶水 | 1.1.9（2023-12-07） | **247,926/115,620** + 358,618/154,208 ⇒ **606.5KB raw / 269.8KB gz** | 三方 wasm 构建，已停更 |
| `duktape-vm` `duktape-vm.min.js` | 0.1.4（2018-08-28） | **545,245 / 118,406** | 三方 wasm（内嵌 `Uint8Array`），Duktape 2.3.99 |
| `duktape-wasm`（单文件 base64 wasm） | 0.2.0（2019-02-20） | **3,237,912 / 961,540** | 三方，已停更 |

官方未发布的 3.0.0 changelog 仍把 *"Use wasm for dukweb.js compilation"* 列为待办。`[事实]`

**② 它根本无法解析目标语法，且路线图里没有计划修。** 用官方 2.7.0 CLI 现场编译：

```
a?.b.filter(item => item.price > 100)   →  SyntaxError: parse error (line 1)
a?.b                                     →  SyntaxError
(x => x + 1)(1)                          →  SyntaxError
`template ${x}`                          →  SyntaxError: invalid token
let z = 1                                →  SyntaxError: unterminated statement
const z = 1                              →  通过，但可静默重新赋值（官方 wiki 承认 const 是"可写的函数作用域"）
spread / 解构 / for-of / class / ?? / ||= →  全部 SyntaxError
a.b.filter(function(item){return item.price > 100})  →  通过（ES5 写法）
```

同样结果在 `jseval-wasm` 的真 wasm 与 `duktape-vm`（2.3.99）中复现。官方 ES 级别逐字为 **"ECMAScript E5/E5.1, with some semantics updated from ES2015+"**、**"Partial support for ECMAScript 2015 (E6) and ECMAScript 2016 (E7)"**；官方 wiki 的 Post-ES5 特性表里箭头/`let`/模板串/解构/for-of/class/`Promise`/spread **完全没有条目**，未发布的 3.0.0 一项都没计划加。运行时还缺 `find`/`includes`/`Object.entries`/`padStart`/`Promise`/`Map`/`Set`/`Array.from`/`flat`。`[事实]`

**③ 超时是编译期宏，已发布的浏览器构建无一启用。**

- `DUK_USE_EXEC_TIMEOUT_CHECK(udata)` 是**编译期函数式宏**，官方接口文档逐字：*"NOTE: This mechanism is EXPERIMENTAL…"*，`default: false`，依赖 `DUK_USE_INTERRUPT_COUNTER`（同样 default false）；官方 2.7.0 的 `src/duk_config.h` 里逐字写着 `#undef DUK_USE_EXEC_TIMEOUT_CHECK` 与 `#undef DUK_USE_INTERRUPT_COUNTER`；`duktape.h` **没有任何运行时 API**（只有 `duk_debugger_pause()`）。`【确证】`
- 子调研打补丁重编 harness 后确认：启用后 `for(;;){}` 能在 2.00s 被 `RangeError: execution timeout` 中断（**deadline 值本身可在运行时改，不需要重编**），但有两个坑：deadline 过期后不重置会让**后续每次 eval 立刻超时**；且检查只在字节码执行器里，**编译阶段不可中断**。`[实测]`
- **`jseval-wasm` 的 "timeout" 是假的**：只是 JS `setTimeout` reject Promise；实测 `while(true)` 永不返回，进程被外部 12s alarm 杀掉（exit 142 = SIGALRM），而其 wasm 不导出任何 `duk_*`。`dukweb.js` 上游用 `duk_create_heap(NULL,…)`，无超时。**唯一真能中断的是 `duktape-vm@0.1.4`**（3/3 在 9,345/9,997/10,001ms 抛 `RangeError: 3` 且 VM 仍可用），但其 vendored `duk_config.h` 自述 `-dirty` 且两个选项都未定义——发布物出自无法复现的本地树。`[实测]`

**④ 内存上限只能靠 C 侧自定义分配器**：`duk_create_heap(alloc, realloc, free, …)`；子调研实测 cap 可生效且失败可捕获（cap 300,000 → `Error: alloc failed`，峰值 278,274），**但没有任何 npm wasm 构建从 JS 暴露分配器钩子**。另澄清一个常见误解：`DUK_USE_GC_TORTURE` **不是**内存限制（官方逐字：*"Development time option: force full mark-and-sweep on every allocation… to stress test memory management"*）。`[事实]`

**⑤ 错误信息没有列号、也没有字符偏移——这对本产品是致命的。** Duktape 错误对象暴露 `name/message/fileName/lineNumber/stack`，官方源码与全部 `config-options/*.yaml` 里 `grep -i column` **零命中**，`duk_inspect_callstack_entry` 只有 `function/pc/lineNumber`。**表达式是单行的 → `lineNumber` 恒为 1 → 无法定位出错 token**，而 #12 的 UX 明确要求"哪一 token 出错"。`[事实]+[分析]`

**结论：Duktape 被 QuickJS 严格支配，不值得作为候选**——最好的 Duktape wasm 载荷 ≈270KB gz，与 QuickJS-ng 的 247KB gz 同量级，但后者给 ES2020+、运行时 interrupt/deadline、运行时 memory limit 与带行列的 `stack`，前者给 ES5-only、无法解析 `?.`/箭头（且永不会）、web 构建里坏掉的超时、无 JS 侧内存上限、只有行号。**若走 wasm，选 QuickJS(-ng) 而非 Duktape；若"精确字符偏移报错"是核心体验，则手写 acorn 解释器是唯一能给出行列级定位的路线。**`[分析]`

### 2.2.1 其他 wasm 真引擎（实测体积）

| 引擎 | 包 / 文件 | 版本（发布日） | raw / gzip -9 (B) |
|---|---|---|---|
| QuickJS-ng | `@jitl/quickjs-ng-wasmfile-release-sync` `emscripten-module.wasm` | 0.32.0（2026-02-16，内置 quickjs-ng v0.12.1） | 528,551 / **247,167** |
| QuickJS | `@jitl/quickjs-wasmfile-release-sync` | 0.32.0（2026-02-16） | 503,134 / **231,517** |
| QuickJS(-ng) | `quickjs-wasi` `quickjs.wasm` + `index.js` | 3.6.0（2026-08-25） | 636,400/286,220 + 115,939/27,205 |
| QuickJS | `@tootallnate/quickjs-emscripten`（单文件） | 0.23.0（2023-07-18） | 632,760 / **278,100** |
| Boa（Rust→wasm） | `@boa-dev/boa_wasm` `boa_wasm_bg.wasm` | 0.22.0（2026-08-28） | 21,296,176 / **7,518,251**（21MB，直接排除；其 `RuntimeLimits` 是步数/递归计数而非墙钟） |

`@engine262/engine262` 是"用 JS 实现的 ECMA-262"，**不是** wasm 引擎；V8/ChakraCore 编译到 wasm 的可用浏览器产物**未找到**（不声明）。`[事实]`

**对 QuickJS 系 API 的旁证** `【确证】`：`@jitl/quickjs-ng-wasmfile-release-sync@0.32.0` 的 `dist/ffi.d.ts` 导出 `RuntimeEnableInterruptHandler` / `RuntimeDisableInterruptHandler` / `RuntimeSetMemoryLimit` / `RuntimeComputeMemoryUsage` / `RuntimeDumpMemoryUsage`，JS 侧另有 `setInterruptHandler()` 与 `shouldInterruptAfterDeadline()`——**全部是运行时 API，无需重编译**。这与 Duktape 的编译期宏形成直接对照。

### 2.3 运行时上限 API（QuickJS 原生能力 + quickjs-emscripten 封装）`【确证】`

C API（`quickjs.h`，bellard/quickjs 与 quickjs-ng 同名同义）：

```c
/* use 0 to disable memory limit */   void JS_SetMemoryLimit(JSRuntime *rt, size_t limit);
/* use 0 to disable maximum stack size check */ void JS_SetMaxStackSize(JSRuntime *rt, size_t stack_size);
/* return != 0 if the JS code needs to be interrupted */ typedef int JSInterruptHandler(JSRuntime *rt, void *opaque);
void JS_SetInterruptHandler(JSRuntime *rt, JSInterruptHandler *cb, void *opaque);
```

出处：[quickjs-ng `quickjs.h` L508-521 / L1178-1182](https://github.com/quickjs-ng/quickjs/blob/master/quickjs.h)、[bellard/quickjs `quickjs.h` L369-378 / L922-928](https://github.com/bellard/quickjs/blob/master/quickjs.h)。

中断回调的**调用频率是确定性的**：`quickjs.c` 中

```c
/* must be large enough to have a negligible runtime cost and small
   enough to call the interrupt callback often. */
#define JS_INTERRUPT_COUNTER_INIT 10000
```

→ **每 10,000 条字节码调用一次中断回调**（`[事实]`，出处 [quickjs-ng `quickjs.c` L554-556](https://github.com/quickjs-ng/quickjs/blob/master/quickjs.c)）。这正是"步数预算"的落点：用**回调次数**当步数，粒度即 10,000 字节码，且与宿主时钟无关（同一表达式消耗的回调次数可复现）。quickjs-emscripten README 给的例子就是这个用法 `runtime.setInterruptHandler(() => ++interruptCycles > 1024)`，注释写作 "Interrupt computation after 1024 calls to the interrupt handler"`【确证】`（[README §Runtime](https://github.com/justjake/quickjs-emscripten/blob/main/README.md)）。

JS 侧封装（`quickjs-emscripten-core`）：`runtime.setMemoryLimit(bytes)`、`runtime.setMaxStackSize(bytes)`、`runtime.setInterruptHandler(fn)`、辅助函数 `shouldInterruptAfterDeadline(ts)`、`QuickJSContext.evalCode(code, filename?)` → `{value|error}` 句柄；错误对象经 `ctx.dump()` 得到 `{name,message,stack,fileName,lineNumber}`。`【确证】`（同上 README §Runtime / §Interfacing）。

### 2.4 实测：中断、内存、错误映射 `[事实]`

环境：Node 24.13.0 + `quickjs-emscripten@0.32.0` RELEASE_SYNC，方法见 §8。

| 能力 | 实测结果 |
|---|---|
| 时间预算精度 | deadline 设 50 / 200 / 500 / 1000ms → 实际 49.7 / 200.5 / 500.6 / 1000.6ms；错误 `InternalError: interrupted`。**误差 ≤0.6ms** |
| 中断回调粒度 | 紧循环中回调 **每 0.18ms 一次**，约合每 4,878–4,988 次循环迭代一次 → 与 10,000 字节码一致 |
| 步数预算 | 回调计数到 1000 次时中断，耗时 22.35ms（≈10M 字节码）；错误同为 `InternalError: interrupted` |
| 内存上限 | `setMemoryLimit(1MB)` → `InternalError: out of memory`，331ms 触发；8MB → 2,055ms；32MB → 1,869ms。**注意：OOM 的发现延迟不由上限值决定，能到秒级**——真正的刹车只能是时间预算 |
| 栈上限 | `setMaxStackSize(256KB)` + 无限递归 → `InternalError: stack overflow`（可 catch，带 JS 栈帧） |
| 语法错误定位 | `evalCode("a?.b.filter(item => item.price >", "user-expr.js")` → `{name:"SyntaxError", message:"unexpected token in expression: ''", fileName:"user-expr.js", lineNumber:1, stack:"    at user-expr.js:1:33\n"}`。**无 `columnNumber` 字段，列号要从 `stack` 里正则提取** |
| 运行时错误定位 | `TypeError: cannot read property 'map' of null`，`stack: at <eval> (user-expr.js:4:3)` |
| 用户 `throw` 的堆栈 | `Error: boom` + `at f (user-expr.js:1:30) / at g (user-expr.js:2:16) / at <eval> (user-expr.js:3:2)` ——**函数名与行列齐全**，比路线 A 只能给"当前 AST 节点"更丰富 |
| VM 内的 `eval`/`Function` | **可用**（`eval('1+1')` → 2；`new Function('return 1+1')()` → 2）。即 VM 是一个**完整 JS 引擎**，白名单不是结构性的；安全性完全落在 wasm 边界上 |
| 宿主逃逸面 | `globalThis.process/window/fetch/require/std` 全部 `undefined`；只有显式 `setProp` 出去的宿主函数可被调用 |
| 冷启动 | 进程内 `newQuickJSWASMModule(RELEASE_SYNC)` ≈ **3.1–3.9ms**（含 503KB wasm 编译；Node 实测，浏览器需实测），`newRuntime + newContext + eval` ≈ 4ms，`newRuntime+newContext`（wasm 已加载）0.2ms |
| 语法覆盖（实测探针） | 可选链 `?.`、`??`、箭头 + 模板串、`Array.prototype.at/findLast`、`Object.hasOwn`、`String.replaceAll`、`class` 字段/私有字段、`??=`、`BigInt`、`Proxy`、`WeakRef`、正则 lookbehind **全部支持**；`sort()` 等**变异方法可用**；`Date` 可用。缺失：`Intl`、`structuredClone`、`Array.prototype.group`。错误栈形如 `at <anonymous> (eval.js:1:15)` |

**对 #3 四层防御的影响** `[分析]`：路线 B 把第 1–3 层"降级"为"由引擎保证的等价物"（语法层不再能排除循环——`while(true){}` 在 VM 内是合法且能跑的，只能靠 interrupt；静态白名单不存在；解释器预算变成中断回调计数 + 内存上限）。第 4 层（Worker + 看门狗）在两条路线下都需要，但路线 B 因为引擎自身可能因边界 bug 卡死，看门狗的**必须性更高**。

**"完整语法"是双刃剑** `[事实]+[分析]`：实测 VM 内 `?.`、`??`、模板串、`Object.hasOwn`、`findLast`、`replaceAll`、`class` 私有字段、`BigInt`、`Proxy` 全部可用，`sort()`（变异）与 `Date` 也在——即 #3 §7 里**每一条被明确排除的语法在路线 B 下都重新变成合法输入**（正则字面量带来 ReDoS 面、变异方法破坏"文档只读"承诺、`Date` 引入非确定性、`Proxy` 引入元编程面）。要恢复"#3 语义边界"就必须在 VM 之上**再写一层静态校验**（即把路线 A 的 `validate()` 重做一遍，只是理由从"防逃逸"变成"保持产品语义一致"）——这抵消了路线 B"免费获得语法"的卖点。

**对 #12 UX 的影响** `[分析]`：超预算提示在路线 B 下只能是"引擎报 `InternalError: interrupted`"→ 需自行判定是时间还是步数（用两个计数器/两个 handler 分支），文案仍是自持的 `messageKey`；错误定位要把引擎文本（英文、格式随版本变）解析成 `{line,column}` 并映射回表达式文本——**比路线 A 多一层易碎的文本解析**（§2.4 那行 `stack:" at user-expr.js:1:33"`）。路线 B 唯一明显更好的 UX 是"用户 `throw` 的调用栈"，但对"过滤/投影"这类单表达式场景价值有限。

---

## 3. 数据传递成本：50MB 文档在两条路线下的真实代价

### 3.1 实测（同一份 50.29MB / 340,001 行文档，同一台机器）`[事实]`

| 阶段 | 5.81MB 文档 | **50.29MB 文档** | 备注 |
|---|---|---|---|
| (参照) 宿主 `JSON.parse(text)` | 30.5ms | **201.8ms**（≈249MB/s） | 查看器本来就要付一次 |
| **B1** `ctx.newString(doc)` 宿主→wasm 拷贝 | 26.8ms | **238.3ms**（≈211MB/s） | UTF-8 编码进 wasm 线性内存 |
| **B2** VM 内 `JSON.parse` | 104.9ms（≈55MB/s） | **1,079.2ms**（≈47MB/s） | 解释执行的解析器，比宿主慢 **5.3×** |
| **B3** VM 内 `DOC.filter(x=>x.price>100).map(x=>x.name)` | 13.8ms | **105.6ms** | 比宿主原生 14.2ms 慢 **7.4×** |
| **B4** VM 内 `JSON.stringify(result)` | 14.7ms | **146.9ms** | 结果 7.4MB |
| **B5+B6** `getString` + 宿主 `JSON.parse` | 1.5ms | **13.1ms** | |
| **B 合计（首次求值）** | ≈192ms | **≈1.58s** | 还没算 Worker 往返与 UI |
| **B 再次求值（文档驻留 VM）** | — | **197ms** | |
| **A（walker，同文档同表达式）** | — | **57–69ms**（θ 单谓词）/ **82–115ms**（双谓词+对象产出） | **零拷贝、零重解析** |
| A 的步数 | — | 1.97M / 3.99M 步 @ 30–49M 步/秒 | |
| 内存增量 | — | B：**RSS +104MB**（文档在 wasm 堆里再存一份）；A：无副本 | |
| 宿主↔wasm 单次边界调用 | 1.25µs | **1.36µs**（≈800k 次/秒） | |

### 3.2 有没有零拷贝/共享内存路径？`[分析 + 事实]`

**没有可用的零拷贝路径。** 理由与实测依据：

1. **字符串必然是一次拷贝**：宿主 JS 字符串活在 V8 堆里，wasm 只能看到自己的线性内存；`JS_NewStringLen`（quickjs-emscripten 的 `newString`）是把 UTF-8 字节写进 wasm 堆再建 QuickJS 字符串对象。测得的 211MB/s 就是这个拷贝 + 编码的代价，**与文档大小线性相关**（1MB→6.5ms，10MB→51ms，50MB→238ms）。`[事实]`
2. **对象图没有批量导入 API**：要把宿主已解析的对象图交给 VM，只能逐属性 `setProp`/`newObject` 建镜像——每个属性一次边界调用（实测 1.36µs/次）。50MB 文档约 340k 行 × 每行 6–10 个属性 ≈ **2–3.4M 次边界调用 ≈ 3–5 秒**，比"整包文本拷进去让 VM 自己 parse（1.08s）"更慢。`[分析，基于 1.36µs/次的实测]`
3. **"惰性桥接"（VM 内 Proxy → 宿主按需读）同样不划算**：每次属性读至少一次边界调用 + 一次 VM 内对象构造；且会把宿主文档暴露成 VM 可反复触碰的接口（安全面与预算口径都变复杂）。估算同上量级（秒级）。`[分析]`
4. wasm 内存与宿主同进程、同一地址空间（emscripten 的 `memory` 可由宿主读写），所以跨边界**没有结构化克隆或序列化开销**——但"同地址空间"只消除了**额外**序列化，消不掉"两种运行时各自的堆 → 必须复制"这一根本事实。`[分析]`

结论：**路线 B 在数据传递上无法打平路线 A**。它必须至少付"拷入 + VM 内重解析 + 结果拷回"三段，而这恰恰是本产品最贵的一段（50MB 文档上 ≈1.3s）。`[分析]`

---

## 4. MV3 合规：增量事实

> `docs/research/mv3-store.md` 已确证的部分（默认 `extension_pages` CSP = `script-src 'self'; object-src 'self';`、`'unsafe-eval'` 安装期报错且不可放宽、允许值仅 `'self'`/`'wasm-unsafe-eval'`/unpacked-localhost、RHC 定义含 WASM、包内 wasm 必须随包）本文不复述，只列**本次新增**的部分。

### 4.1 增量结论

> 子调研抓取并逐字核对了官方 CSP/manifest 文档、What's New（Chrome 102/103 条目）、CWS 全部政策页（program-policies 索引、mv3-requirements、quality-guidelines、unexpected-behavior、code-readability、user-data-faq、permissions、minimum-functionality、malicious-and-prohibited、best-practices、api-use、cws-dashboard-privacy、troubleshooting、review-process/check-review、remote-hosted-code、improve-security、whats-new）以及 **Chromium 源码**（`extensions/common/csp_validator.cc`、`extensions/common/manifest_handlers/csp_info.cc`）与 **W3C CSP3 规范**。
> **取证方法披露**：本次会话中 `developer.chrome.com` 在该沙箱 TCP 层被阻断（同时不可达：`web.archive.org`、`chrome.google.com`、`chromium.googlesource.com`），故 Chrome 文档引文取自 Google 自托管的同站镜像 **`developer.chrome.google.cn`**（同 DevSite、HTTP 200、文章标题一致、内容为当前版本——其 MV3 requirements 页列出的 *User Scripts API* 比 2023-12 归档的官方文档源码仓库更新）。**规范 URL 仍是 `developer.chrome.com/...`，网络允许时应复核**；Chromium 源码取自 `chromium/chromium` GitHub 镜像 `main`。`docs/research/mv3-store.md`（#4）当时能直连 `developer.chrome.com`，两者条文一致，互为旁证。

**① 包内 `.wasm` 不是远程代码（RHC）`【确证】`**——官方定义把 WASM 点名为 code，且以"是否来自扩展自身文件"为唯一判据：

> "Remotely hosted code, or RHC, is what the Chrome Web Store calls anything that is executed by the browser that is **loaded from someplace other than the extension's own files. Things like JavaScript and WASM.** It does not include data or things like JSON or CSS."
> —— [Deal with remote hosted code violations](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code)

同页还有 *"Regardless of where the code comes from, it is not allowed to have RHC."*；[Improve extension security](https://developer.chrome.com/docs/extensions/develop/migrate/improve-security) 列出脚本源允许值 `self / none / wasm-unsafe-eval /（仅 unpacked）localhost`，并要求 *"Move all external code (JS, Wasm, CSS) into your extension bundle."* **RHC 管的是字节从哪来，不是代码做什么**；因此就 RHC 这条轴，路线 A 与 B 政策上等价（都是"随包分发"）。

**② `'wasm-unsafe-eval'` 是预批准的最低策略，不是"放宽" `【确证】`**：

- 官方最低策略（manifest CSP 参考页逐字）：*"Chrome enforces a minimum content security policy for extension pages. It is equivalent to specifying … `"extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';"`"*，且 *"The extension_pages policy **cannot be relaxed beyond this minimum value**"*。
- Chrome 102（2022-03-22）起允许写入；**Chrome 103（2022-05-12）起不再默认授予**：*"Chrome no longer grants extensions script-src: wasm-unsafe-eval by default. Extensions that use WebAssembly must now explicitly add this directive and value to extension_pages…"*（[What's new in Chrome Extensions](https://developer.chrome.com/docs/extensions/whats-new)）
- **Chromium 源码印证**（`extensions/common/manifest_handlers/csp_info.cc`，`main`，L44-50）：`kDefaultMV3CSP = "script-src 'self';"`、`kMinimumMV3CSP = "script-src 'self' 'wasm-unsafe-eval' 'inline-speculation-rules'; object-src 'self';"`。**注意两点**：①真实常量比文档多一个 `'inline-speculation-rules'`（文档串是严格子集，声明文档串安全）；②同文件 `CSPInfo::GetMinimumCSPToAppend` 注释说明 Chrome 是**追加**最低策略，两条 CSP 按**交集**执行——所以"追加"是安全网不是授权，**不显式声明 `'wasm-unsafe-eval'` 时 wasm 编译仍被默认的 `script-src 'self';` 阻断**。
- 安装期白名单（`extensions/common/csp_validator.cc`，`main`，`DoesCSPDisallowRemoteCode`/`is_secure_directive`）：`script-src` 只接受 `'self'`、`'none'`、localhost 源、`'wasm-unsafe-eval'`；`'wasm-eval'`（旧关键字）只在 MV2 路径，**MV3 不可用**。
- 语义边界（**W3C CSP3 §6.1.10 `script-src`** 逐字）：*"The following WebAssembly execution sinks are gated on the `"wasm-unsafe-eval"` or the `"unsafe-eval"` source expressions: `new WebAssembly.Module()`, `WebAssembly.compile()`, `WebAssembly.compileStreaming()`, `WebAssembly.instantiate()`, `WebAssembly.instantiateStreaming()`"*，且 *"The `"wasm-unsafe-eval"` source expression **only permits WebAssembly and does not affect JavaScript**."*
  → **三个可直接用于设计的推论**：(a) gate 判的是"编译 sink"，**不区分字节来源**（W3C WebAssembly CG [content-security-policy#37](https://github.com/WebAssembly/content-security-policy/issues/37) 仍开放，原文承认 "no distinction between Wasm being executed from a trusted source versus Wasm being executed from an untrusted source"）——**CSP 拦不住运行时抓取的 wasm，拦住它的是 RHC 政策**，所以 `.wasm` 必须随包；(b) 它**没有**换回任何 JS 字符串 `eval`（`'unsafe-eval'` 在 `extension_pages` 仍安装期报错）；(c) 若将来确实需要 JS `eval`，唯一出口仍是 sandbox page/iframe（其 CSP *"can be customized as needed"*）。

**③ 商店政策对"包内解释器"的确切口径 `【确证】`**：官方页面里**唯一**提到 interpreter 的句子是（在 `mv3-requirements` 与面向审查员、对应违规 ID **Blue Argon** 的 `troubleshooting` 页各出现一次）：

> "Building an interpreter to run complex commands **fetched from a remote source**, even if those commands are fetched as data."
> —— [Additional Requirements for MV3](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements)、[Fix Chrome Web Store violations / troubleshooting](https://developer.chrome.com/docs/webstore/troubleshooting)（"Corresponds to notification ID: **Blue Argon**… The intent of this policy is to ensure that Manifest V3 extensions are not including remotely hosted code."）

**该禁止的范围明确限定在"从远程源抓取的命令"**；用户键入表达式 + 用户本地粘贴 JSON 的组合不落在射程内（政策自述意图即"只针对远程托管代码"）。该限定语至少自 2023-12 起未变（归档的官方文档源码仓库 `GoogleChrome/developer.chrome.com@51dd7dd5` 中同一句逐字相同）。**"CWS 禁止扩展内置代码解释器"的说法查无实据**（现行政与归档文件均无独立条款；`chrome.google.com/webstore/program_policies` 与 Wayback 在本沙箱不可达 → 此项列为 `【需实测】`，不要当作既有政策引用）。

**④ 隐私面板声明 `【确证】`**：CWS Dashboard Privacy 页逐字 *"If your extension doesn't need to execute remote code, make sure that it does not and select **'No, I am not using remote code.'**"* → 包内 wasm 的正确答案是 **No**（答 Yes 是虚假声明，招致 *"extra scrutiny, resulting in longer review times"*）。

**⑤ 官方已有"MV3 + 包内 wasm + `wasm-unsafe-eval`"的 Google 自编样例 `【确证】`**：What's New（2023-05-17 "New Samples: WASM in extensions"）指向的 `GoogleChrome/chrome-extensions-samples` 中 `functional-samples/cookbook.wasm-helloworld-print{,-nomodule}/manifest.json` 均为 `manifest_version: 3` + `"content_security_policy": {"extension_pages": "default-src 'self' 'wasm-unsafe-eval'"}`。（样例是 helloworld，**不**等于"完整 JS 引擎执行用户文本"也被背书。）

**⑥ 路线 B 唯一非对称的软风险：审查员可读性 `【需实测】`（判断，非成文规则）`[分析]`**。MV3 要求 *"the full functionality of an extension must be easily discernible from its submitted code… the logic of how each extension operates should be self contained"*、*"If we are unable to determine the full functionality of your extension during the review process, we may reject your submission or remove it from the store"*，Code Readability 也禁止隐藏功能（允许压缩）。手写 walker 是扩展自身可审计的 JS；~1MB 不透明 `.wasm` 对审查员在功能上不可读。**这不是禁令、也不是意图上的混淆**，但它是审查员可能据此认定"无法判定完整功能"的机制。缓解措施：`.wasm` 随包（绝不运行时抓取）、vendor 引擎源码或提供可复现构建、精确声明最低 CSP、隐私面板答 No。

**⑦ 未证实的部分（不得当作政策使用）`【需实测】`**：没有任何可验证证据表明"某个 CWS 上架的、搭载 wasm JS 引擎执行用户文本的扩展被接受"（`chrome.google.com` 在本沙箱不可达）。旁证：`quickjs-emscripten` 仓库 README 与 issue 搜索里**搜不到任何 CSP/扩展（`wasm-unsafe-eval`）相关讨论**（`repo:justjake/quickjs-emscripten "wasm-unsafe-eval"` → 0 命中）。收口实验见 §7.2 B2。

### 4.2 路线 B 需要的 manifest 变化 `[分析，条文见 §4.1]`

```jsonc
{
  "content_security_policy": {
    "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';"
  }
}
```

- 这是 Chrome **允许的最低策略**（`'wasm-unsafe-eval'` 在安装期白名单内，且就在 Chrome 自身追加的最低策略里），**"添加它"不构成对策略的放宽**——该策略无法被放宽到低于此值（§4.1②）。
- 运行时：`.wasm` 随包 + **相对 URL** 加载（`new URL('./emscripten-module.wasm', import.meta.url)`，避开 `chrome.runtime` 在 dedicated worker 内可用性的未决问题），在扩展页派生的 dedicated worker 内 `WebAssembly.instantiate`。**绝不运行时抓取引擎字节**：CSP 不会拦（gate 只看编译 sink，§4.1②(a)），但 RHC 政策会。
- 隐私面板：**"No, I am not using remote code."**
- 需要评估的残余风险：审查员可读性（§4.1⑥）；缓解 = vendor 源码 / 可复现构建说明 / 精确最小 CSP。

---

## 5. 与 #3 四层防御、#12 UX 的接合

| #3 的层 | 路线 A（推荐） | 路线 B（若被选中） |
|---|---|---|
| ① 语法层排除循环 | **结构性**：`while/for/for-of` 不在白名单，`Program` 只允许单个 `ExpressionStatement`（原型实测：`while(true){}` → `PARSE_ERR_ROOT_SHAPE`） | 不成立。`while(true){}` 是合法 JS，只能靠 ②③④ |
| ② AST 静态校验 | **原型实测可用**：17 类型 default-deny、深度上限、调用点名检查、`__proto__` 拒绝；错误带 `loc`（实测 10 条拒绝用例全部给出正确错误码与列号） | 无静态层。等价物是"VM 只暴露什么"（不 setProp 任何宿主对象即可，但语言内 `eval`/`Function` 仍存在） |
| ③ 解释器预算 | 步数 + 时间（每 4096 步查表）+ 结果尺寸；实测 28–49M 步/秒、50ms 内可跑 1.2M 步；**需把 `maxSteps` 提到 `max(1e6, 16×文档节点数)`**，否则 200k 行文档的合法查询被误杀（实测） | 时间预算（误差 ≤0.6ms）+ 步数预算（中断回调计数，粒度 10,000 字节码）+ `setMemoryLimit`（实测 OOM 延迟可达秒级，故时间预算仍是主刹车） |
| ④ Worker + 看门狗 | 同 #3；watchdog 是"自研 walker 有 bug"的最后兜底 | 更需要：引擎/胶水层卡死时看门狗是唯一出口；且 **VM 内的文档副本随 Worker 重建而丢失**，terminate 后要重付 §3.1 的 238ms 拷贝 + 1.08s 重解析 |
| 错误定位（#12） | 引擎自持 `{code, pos, loc}`；文案 = `messageKey + params` 的中英表 | 需把 `SyntaxError.fileName/lineNumber` + `stack` 文本解析成 `{line,column}`；运行时错误可用引擎栈（含用户函数名） |
| 超预算文案（#12） | 直接由自己的预算检查点抛出 `EVAL_STEP_LIMIT` / `EVAL_TIME_LIMIT`，可带"已执行 N 步/耗时 X ms" | 引擎只给 `InternalError: interrupted`；需自行区分时间/步数两个 handler，文案语义要靠自己补 |
| 结果截断（#12） | 由解释器在产出容器处截断（同 #3 §4.3） | 在 VM 内截断（`JSON.stringify` 前切片）或拷回后截断；注意 VM 内 `map` 产出的中间数组会**同时**吃 wasm 堆内存 |
| 重复求值（#12 的"改表达式重跑"） | 每次 57–115ms（50MB） | 首次 1.58s，之后 197ms；**但只要 terminate/重建 Worker 就回到 1.58s** |
| 字段/API 提示（#3 §5） | 与解释器共用同一张白名单表，天然一致 | 提示表另行维护；且 VM 允许调用的方法**多于**提示表（用户手写 `sort()` 也能跑）——"提示什么=允许什么"的闭环被打破 |

---

## 6. 决策矩阵与推荐

### 6.1 加权对比（判据权重按 map #1 的验收线与 #3 已定原则）`[分析]`

| 判据 | 权重 | A | B | 说明 |
|---|---|---|---|---|
| 50MB 压力下的响应（map #1 验收线） | 高 | ★★★★★ | ★★ | 首次 1.58s vs 57–115ms，且文档驻留成本高 |
| 预算/失控防护的"硬"程度 | 高 | ★★★★ | ★★★★★ | 引擎级中断/内存上限更硬，但 OOM 延迟可达秒级 |
| 安全面（无 eval、白名单、无逃逸） | 高 | ★★★★★ | ★★★☆ | A 是结构性的；B 靠 wasm 边界，语言内仍有 eval/Function/Proxy |
| MV3/审核变量数 | 中 | ★★★★★ | ★★★★ | B 多一行 `wasm-unsafe-eval`（**官方最低策略、预批准，不是放宽**）+ 一个"审查员能否读懂 ~1MB wasm"的软判断（§4.1⑥） |
| 维护面与可测试性 | 中 | ★★★★ | ★★★ | A 要自证语义（差分测试）；B 要跟引擎版本、wasm 构建链 |
| 体积 | 低 | ★★★★★ | ★★★★ | 60KB vs 250KB gz；相对 10MB 基线都不致命 |
| 语法宽容度（用户惊喜度） | 中 | ★★★ | ★★★★（但见注） | B 原生支持任意 ES2023；**若要让语义对齐 #3 的边界（禁正则/变异/Date），必须在 VM 之上再补一层静态校验，宽容度优势被大幅抵消** |
| 错误/提示一致性（#3 §5.2 的"单一来源"） | 中 | ★★★★★ | ★★ | A 一套表两侧共用 |

### 6.2 推荐 `[分析]`

**推荐路线 A（手写 walker），并采纳 §0 的两处参数修正；把路线 B 作为"若表达式需求实质扩展"的备选预案登记（见 §6.3）。**

理由归纳：
1. **B 的独特卖点（原生中断/内存上限/完整 JS 语义）对本产品不是主要矛盾**：我们主动选择了非 Turing 完备子集（#3 §7），死循环在语法层即不可表达；B 的硬中断解决的是"我们不存在的问题"，代价却是每次求值付一次全文档拷贝 + VM 内重解析。
2. **数据传递成本不可绕过**（§3.2）：没有零拷贝路径，50MB 上 B 必付 ≈1.3s 的额外固定成本，且内存翻倍。这与 map #1 的 10MB/50MB 验收线直接冲突。
3. **A 的规模已被实测钉死**：311 行原型（271 非注释行）覆盖 17 个节点类型 + 预算 + 错误定位 + 19 条用例全绿。所谓"手写解释器很贵"在本项目语境下**不成立**（对比 §2.2 的既有评测器规模）。
4. **合规变量更少**：A 不需要 `wasm-unsafe-eval`，不需要在审核里解释"包内自带 JS 引擎执行用户输入"。**确切地说（§4.1）**：B 并不违反任何成文政策（包内 wasm 不是远程代码；那条"interpreter"禁令只针对"从远程源抓取命令"；`wasm-unsafe-eval` 是官方预批准的最低策略），所以这不是"合规风险"而是**审查面差异**——A 的全部功能都写在可审计的 JS 里，B 多一个 ~1MB 不透明二进制，恰好落在 MV3 "功能必须能从提交代码中清晰辨认"与 Code Readability 的射程内（`【需实测】`，靠提审验证）。这与 mv3-store 的取向一致。
5. **B 唯一真正的损失是"语法宽容度"，而它同时是负担**：VM 实测支持 `?.`/模板串/`Object.hasOwn`/`findLast`/`replaceAll`/class 私有字段/`BigInt`/`Proxy`/变异 `sort()`/`Date`/正则 lookbehind——即 #3 §7 明确排除的语法**全部重新合法**；要恢复语义边界就得在 VM 之上再写一层静态校验（把路线 A 的 `validate()` 重做），宽容度优势被抵消。相反，A 的白名单失败是**可读错误 + 可廉价扩展**（加一个方法 = 一行 + 一条测试）。

**反面条件（若出现则重开本决策）** `[分析]`：①产品明确要求"用户可写完整 JS（含循环/函数/正则）"，白名单子集的表达力被真实用例证伪；②手写 walker 的语义差异测试成本被证明显著超预期（例如白名单方法语义差分测试长期飘红）；③出现"必须在 VM 内跑第三方 JS 逻辑"的新需求。三者任一成立，路线 B 的 250KB + 1.58s 就是合理代价。

### 6.3 备选预案：若走 B，具体怎么配 `[分析]`

- 变体选 **`quickjs-emscripten-core` + `@jitl/quickjs-wasmfile-release-sync`**（实测 588KB raw / 250KB gz），不要主包（全量 686KB gz）。**若在意上游活跃度与 ES 覆盖，改用 quickjs-ng 变体**（`@jitl/quickjs-ng-wasmfile-release-sync`，实测 wasm 528,551B/247,167 gz，仅 +15.7KB gz；内置 quickjs-ng v0.12.1，官方 README 明言 "may switch to using quickjs-ng by default in the future"）。**Duktape 不要考虑**（§2.2：ES5-only、解析不了 `?.`/箭头、web 构建无有效超时、无列号——被 QuickJS 严格支配）。
- **wasm 的加载路径要避开 `chrome.runtime`**：变体默认用 `new URL('./emscripten-module.wasm', import.meta.url)` 解析（esbuild 打包后 `import.meta.url` 即 bundle 所在位置），因此把 `.wasm` 放在扩展根目录即可用**相对 URL** 加载；不要依赖 `chrome.runtime.getURL()`——`chrome.*` 在 dedicated worker 内是否可用本身是未决项（`mv3-store.md` §3【需实测】）。实测的 ESM 打包产物里确实保留了这条 `import.meta.url` 引用（`grep -c emscripten-module.wasm bundle.js` → 1）。`[事实]`
- 需要 VM 内 await 宿主异步才上 asyncify 变体（实测 wasm 1,027,523B/360,492 gz，+129KB gz、且性能有损）。
- 预算：时间 handler 为主（`shouldInterruptAfterDeadline`，实测 ≤0.6ms 精度）+ 回调计数 handler 为辅（每 10,000 字节码一次，用作"确定性步数预算"）+ `setMemoryLimit`（防内存爆炸，但别指望它及时）。
- 数据：只把**文本**推进 VM（`newString` + VM 内 `JSON.parse`），不要在宿主解析后再逐属性镜像；表达式只允许访问 VM 内的单根（如 `$` 或 `DOC`）。
- 每次求值前把文档留在 VM 里复用（避免重复 238ms 拷贝 + 1.08s 解析），但要有"内存水位 + 重建"策略（重建成本 = 1.58s）。
- 错误：正则解析 `stack` 里的 `:line:col`（实测格式），映射成统一 `{code, loc, messageKey}`。

---

## 7. 需 spike 实测项清单（喂给 #12 / G-7）

### 7.1 路线 A 必须实测（不论选哪条都要做）

| # | 项目 | 验收/方法 |
|---|---|---|
| A1 | **步数预算默认值定稿** | 用 `.mock/1.json`(952KB，实测 81,265 节点) 与合成 10MB/50MB 文档跑一组代表性表达式，记录 `steps` 与耗时；目标：`maxSteps = max(1e6, k×文档节点数)` 的 k 取实测 max(步/元素) 的 2–4 倍（本次实测 4.1 步/元素@44 项、5.8 步/行@单谓词、11.7 步/行@双谓词+对象产出） |
| A2 | 时间预算与实际耗时的关系 | 确认 500ms 上限下 50MB 文档的合法查询不会误杀（实测合法查询 57–115ms，余量充足）；同时确认"输入即校验"体验（实测 `parse+validate` = 0.010ms/次） |
| A3 | 语义差分测试框架 | 同一表达式在 Node 原生求值 vs walker 求值结果逐值对比（覆盖 `slice/find/reduce/flat/concat/at` 边界、`===`/`+` 类型强转、`?.` 与 `??` 组合、稀疏数组、缺失键 vs `undefined`、Unicode 键）——prior art 显示这是手写引擎的真负担（§1.6） |
| A4 | 双语文案表与错误码对齐 | 每个 `code` 在 en/zh 各一条文案 + 参数占位；`loc` 在前端 caret 定位的准确性（含多行表达式）。**运行时错误也要有位置**：prior art 里 10 个求值器只有 5 个有位置且几乎全是解析期，需按"每个 AST 节点包 try/catch 补 `loc`"自行设计（§1.6） |
| A5 | 结果截断与标记 | 产出容器超 `maxResultLength` 时的截断语义 + 导出标记（对齐 CONTEXT「截断不能静默发生」） |
| A6 | 校验器"接收者"规则 | 把 `Math.*`、全局函数与成员方法三类调用点分别定稿（原型首版误杀 `Math.max`，§0 修正 2），并补一组"应拒绝"用例 |

### 7.2 路线 B 若要重启评估才需要（本次未完成，原因见文首环境限制）

| # | 项目 | 方法 |
|---|---|---|
| B1 | **MV3 真机 spike（最高优先）** | 打包最小 MV3 扩展（`script-src 'self' 'wasm-unsafe-eval'` + 包内 `.wasm`），在扩展页与扩展页派生的**dedicated module worker** 内 `WebAssembly.instantiate` + 跑一次 `DOC.filter(...)` + `while(true){}` 加 deadline 中断；记录：①是否成功 ②去掉 CSP 声明后的确切报错文本与 directive 名 ③worker 内是否同样需要声明 ④`chrome://extensions` 错误页是否有 CSP 警告。**本沙箱内 Chrome 无法加载扩展（详见 §8.4），必须在有正常 Chrome 环境的机器上做** |
| B2 | 商店审核口径（含阴性对照） | 提交最小扩展（Unlisted）：包内 wasm JS 引擎 + 用户输入求值 + 精确声明最低 CSP + 隐私面板答 **"No, I am not using remote code"**；记录审核时长与是否收到违规 ID（尤其 **Blue Argon**）。**阴性对照**：把 `.wasm` 改为运行时从 URL 抓取，确认触发 RHC。另外补做本沙箱做不到的两项文献核查：`chrome.google.com/webstore/program_policies` 与 Wayback 上的旧 CWS 政策页 grep `interpreter` / `emulator` / `arbitrary code`（§4.1③ 的历史条款目前**查无实据**） |
| B3 | 沙箱页路线（可选） | 若不想声明 `wasm-unsafe-eval`，评估"沙箱页内实例化 wasm"（沙箱页豁免 RHC 限制且 CSP *"can be customized as needed"*）——代价是 postMessage 往返 + 无扩展 API + 文档要传两次 |
| B4 | VM 内存水位 | 50MB 文档在 VM 内驻留的 wasm 堆峰值（本机实测 RSS +104MB 仅是单次查询后的一刻，需要长会话水位曲线），以及"terminate 重建"的用户可感知代价（≈1.58s） |
| B5 | 引擎版本/漏洞跟版流程 | quickjs vs quickjs-ng（ng wasm +15.7KB gz、ES 覆盖更全、上游更活跃）、CVE 监控、wasm 构建可复现性 |
| B6 | 审查员可读性验证 | 即 B2 的副产品：若审阅者因 ~1MB 不透明 `.wasm` 无法判定功能（MV3 *"full functionality… easily discernible"* / Code Readability），记录其反馈并评估"vendor 引擎源码 + 可复现构建说明"是否能缓解（§4.1⑥） |

---

## 8. 测量方法附录（可复现）

### 8.1 环境

- macOS；Node v24.13.0；npm 11.6.2；Chrome 152.0.7977.83（仅用于 MV3 spike 尝试，未成功）；测量日期 2026-09-10。
- `npm i quickjs-emscripten@0.32.0 acorn@8.18.0 esbuild puppeteer-core`（npm cache 指到 `/tmp`，因沙箱不允许写 `~/.npm`）。
- 沙箱限制：`web_fetch` 被 DNS 策略拦断 → 一律 `curl`；`~/.npm` 不可写 → `--cache /tmp/...`；Chrome helper 进程无法初始化 → MV3 真机 spike 未完成；`developer.chrome.com` TCP 层不可达（`web.archive.org`/`chrome.google.com`/`chromium.googlesource.com` 同样不可达）→ Chrome 文档引文经 `developer.chrome.google.cn` 同站镜像取得，Chromium 源码经 `chromium/chromium` GitHub 镜像取得（详见 §4.1 方法披露）。

### 8.2 体积测量（路线 B）

```bash
# 逐个变体包下载 tarball 后解包，再对每个 dist 文件量 raw 与 gzip -9
url=$(curl -sS "https://registry.npmjs.org/@jitl%2fquickjs-wasmfile-release-sync/latest" | node -e '...console.log(JSON.parse(s).dist.tarball)')
curl -sSL -o v.tgz "$url" && tar xzf v.tgz
raw=$(wc -c < package/dist/emscripten-module.wasm); gz=$(gzip -9 -c package/dist/emscripten-module.wasm | wc -c)
```

### 8.3 运行时能力与数据传递测量（路线 B）

- 能力探针：`newQuickJSWASMModule(RELEASE_SYNC)`；`setInterruptHandler(shouldInterruptAfterDeadline(...))` 跑 `while(true){}` 记录实际耗时；用回调计数器统计粒度；`setMemoryLimit` 跑 `a.push(new Array(1000).fill(0))` 死循环；`evalCode(badSource, "user-expr.js")` + `ctx.dump(error)` 记录错误对象字段。
- 数据传递：生成 340,001 行对象数组（`JSON.stringify` 后 50.29MB），分别测量 `ctx.newString(text)`、VM 内 `JSON.parse(DOC_TEXT)`、VM 内 `filter+map`、VM 内 `JSON.stringify`、`ctx.getString`、宿主 `JSON.parse` 的耗时，并记录 `process.memoryUsage().rss` 前后差值。
- 边界调用成本：`ctx.newFunction` 暴露宿主函数，VM 内循环调用 1,000,000 次计时。

### 8.4 路线 A 原型

- `/tmp/expr-runtime/walker/walker.mjs`（311 行）：`parse`(acorn) → `validate`(default-deny 遍历) → `Machine.eval`（13 类型分派 + 预算 tick + own-property 读 + 方法分派 + 可选链 `SHORT` 哨兵 + 箭头闭包）；`run()` 门面返回 `{ok, value|error, steps}`。
- 用例与性能：`test-bench.mjs` 跑 19 条正确性用例 + 200k 行文档的表达式性能 + 预算触发；`compare50.mjs` 在 340,001 行（50.29MB）文档上复测同一表达式，与 §3.1 的路线 B 数字同机同数据可比。
- MV3 真机 spike 尝试（失败记录）：`puppeteer-core` + 系统 Chrome 152，`--load-extension` / `--disable-extensions-except` / `--disable-features=DisableLoadExtensionCommandLineSwitch`、headless 与 headful 均试；`chrome://extensions` 的 `extensions-item-list` 为空，且 Chrome 日志显示 helper 进程 `Failed to initialize sandbox`/crashpad 写入被拒（DSH 文件沙箱不允许写 `~/Library`）。→ 归入 §7.2 B1。

### 8.5 prior art 与 ESTree 普查（§1.6 / §1.1 的数据来源）

- 每个库按其 npm tarball 或 pinned GitHub tag 解包后统计：`raw = wc -l <文件>`；`code = 去注释与空行`；dispatch 类型数 = evaluator 里 `case 'X':`/class-per-node/指令表的条目数；`eval` 命中 = `grep -cE '\beval\(|new Function\('` 并逐条人工判定是否在求值路径上（如 `expr-eval` 的 1 处仅在可选 `toJSFunction`、`angular-expressions` 的 1 处仅在 `ASTCompiler`）。
- ESTree 普查：`for f in es5 es2015 es2016 es2017 es2018 es2019 es2020 es2021 es2022 es2025 es2026; do curl -sSL -o estree/$f.md https://raw.githubusercontent.com/estree/estree/master/$f.md; done` → `grep -hoE '^interface [A-Za-z0-9_]+( <: [A-Za-z0-9_]+)?' estree/*.md | sort -u | wc -l`；再对 `Expression` 子树做继承闭包计数。

### 8.6 Duktape 侧方法（§2.2）

- 官方 dist / npm tarball 逐个下载解包后量 raw 与 `gzip -9`；`dukweb.wasm` 用 `curl -w '%{http_code}'` 验证为 **404**。
- **真编译官方 Duktape 2.7.0 CLI**（`make -f Makefile.cmdline`，MD5 与官方下载页一致）后逐条跑语法探针，记录每条的确切报错；同样的探针在 `jseval-wasm` 的 `.wasm` 与 `duktape-vm`（内嵌 Duktape 2.3.99）中复现。
- 超时机制：打补丁启用 `DUK_USE_EXEC_TIMEOUT_CHECK` + `DUK_USE_INTERRUPT_COUNTER` 重编 harness（`harness.c`），用 `for(;;){}` 验证中断时刻与两个陷阱（deadline 不重置、编译期不可中断）；对 `jseval-wasm` 的"timeout"用外部 alarm 兜底证明其无效（`while(true)` 永不返回，进程被 SIGALRM 杀掉）。
- 内存上限：`duk_create_heap` 传自定义分配器计数，验证 cap 生效与失败可捕获及峰值字节数。
- 错误映射：`grep -i column` 覆盖 Duktape 源码 `src-input/*.c,h` 与全部 `config-options/*.yaml`，零命中；实测多行脚本的 `lineNumber`。

### 8.7 MV3/CWS 侧方法（§4）

- 抓取并 grep 官方政策页（列表见 §4.1 方法披露）的**提取文本与原始 HTML**，检索 `interpreter|emulator|arbitrary code|code interpreter`；命中仅 2 处且为同一句，已逐字引用并附页面 URL。
- Chrome 文档经同站镜像 `developer.chrome.google.cn`；Chromium 常量与安装期白名单取自 `chromium/chromium` 镜像 `main` 的 `csp_info.cc` / `csp_validator.cc`（给出文件与行号）；历史条文对照归档仓库 `GoogleChrome/developer.chrome.com@51dd7dd5`。
- 所有引用 URL 均以 `curl -w '%{http_code}'` 验证（镜像页与 GitHub raw 均 200）；不可达主机清单见 §4.1。

---

## 9. 参考来源

**一手来源（QuickJS / Duktape 引擎侧）**
- QuickJS C API：[bellard/quickjs `quickjs.h`（`JS_SetMemoryLimit` / `JS_SetMaxStackSize` / `JS_SetInterruptHandler`）](https://github.com/bellard/quickjs/blob/master/quickjs.h)、[quickjs-ng `quickjs.h`](https://github.com/quickjs-ng/quickjs/blob/master/quickjs.h)、[quickjs-ng `quickjs.c`（`JS_INTERRUPT_COUNTER_INIT 10000` 及其注释）](https://github.com/quickjs-ng/quickjs/blob/master/quickjs.c)
- quickjs-emscripten：[README（Runtime 限制：`setMemoryLimit`/`setMaxStackSize`/`setInterruptHandler`/`shouldInterruptAfterDeadline`；Packaging：变体表与 "最小安装 1.3MB"；WebAssembly loading；quickjs-ng 说明）](https://github.com/justjake/quickjs-emscripten/blob/main/README.md)、[npm quickjs-emscripten@0.32.0](https://registry.npmjs.org/quickjs-emscripten/latest)、[@jitl/quickjs-wasmfile-release-sync](https://registry.npmjs.org/@jitl/quickjs-wasmfile-release-sync/latest) / [@jitl/quickjs-ng-wasmfile-release-sync](https://registry.npmjs.org/@jitl/quickjs-ng-wasmfile-release-sync/latest)（体积实测数据源）
- Duktape：[duktape.org](https://duktape.org/)、[dukweb.js（官方站点 asm.js 构建；其引用的 `dukweb.wasm` 返回 404）](https://duktape.org/dukweb.js)、[官方 API 文档（`DUK_USE_EXEC_TIMEOUT_CHECK` "EXPERIMENTAL"、default false）](https://duktape.org/api.html)、官方 2.7.0 源码包 `src/duk_config.h`（`#undef DUK_USE_EXEC_TIMEOUT_CHECK` / `#undef DUK_USE_INTERRUPT_COUNTER`）、[Duktape wiki（Post-ES5 特性表、const 语义）](https://github.com/svaarala/duktape-wiki)、npm [duktape](https://registry.npmjs.org/duktape/latest)（node-gyp 原生扩展）/ [duktape-wasm](https://registry.npmjs.org/duktape-wasm/latest) / [duktape-vm](https://registry.npmjs.org/duktape-vm/latest) / [jseval-wasm](https://registry.npmjs.org/jseval-wasm/latest)（三方 wasm 构建的体积与"假 timeout"实测对象）；`@boa-dev/boa_wasm`、`quickjs-wasi` 见 §2.2.1
- 仓库内：[`docs/research/expression-engine.md`](./expression-engine.md)（#3）、[`docs/research/mv3-store.md`](./mv3-store.md)（#4）、[`docs/research/json-rendering.md`](./json-rendering.md)（#2）、[`CONTEXT.md`](../CONTEXT.md)

**一手来源（MV3 / CWS / 规范，§4 增量）**
- Chrome 文档（本次经 `developer.chrome.google.cn` 镜像取得，规范 URL 如下）：
  - [Manifest – Content Security Policy（最低策略原文 "Chrome enforces a minimum content security policy…"、"cannot be relaxed beyond this minimum value"）](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy)
  - [What's new in Chrome Extensions（Chrome 102 "wasm-unsafe-eval allowed in Manifest V3 CSP"；Chrome 103 "requires wasm-unsafe-eval"；2023-05-17 "New Samples: WASM in extensions"）](https://developer.chrome.com/docs/extensions/whats-new)
  - [Deal with remote hosted code violations（"Things like JavaScript and WASM"）](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code)
  - [Improve extension security（"Move all external code (JS, Wasm, CSS) into your extension bundle."；script-src 允许值）](https://developer.chrome.com/docs/extensions/develop/migrate/improve-security)
  - [Additional Requirements for MV3（"Building an interpreter to run complex commands fetched from a remote source…"；"full functionality… easily discernible"；sandboxed pages 豁免）](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements)
  - [Fix Chrome Web Store violations / troubleshooting（违规 ID **Blue Argon** 与同一句 interpreter 条文）](https://developer.chrome.com/docs/webstore/troubleshooting)
  - [Code Readability Requirements](https://developer.chrome.com/docs/webstore/program-policies/code-readability)、[Quality Guidelines / single purpose](https://developer.chrome.com/docs/webstore/program-policies/quality-guidelines)、[Fill out the privacy fields（"select 'No, I am not using remote code.'"）](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)
- 规范：[W3C CSP Level 3（§6.1.10 `script-src` 的 wasm 执行 sink 清单与 `"wasm-unsafe-eval" only permits WebAssembly and does not affect JavaScript`；§4.5.1 EnsureCSPDoesNotBlockWasmByteCompilation）](https://www.w3.org/TR/CSP3/)、[WebAssembly CG content-security-policy#37（wasm-unsafe-eval 不区分可信/不可信来源，open）](https://github.com/WebAssembly/content-security-policy/issues/37)
- Chromium 源码（`chromium/chromium` 镜像 `main`）：`extensions/common/manifest_handlers/csp_info.cc`（`kDefaultMV3CSP` / `kMinimumMV3CSP` / `CSPInfo::GetMinimumCSPToAppend`）、`extensions/common/csp_validator.cc`（MV3 安全源白名单、`kWasmEvalSource` 仅在 MV2 路径）
- 归档旁证：`GoogleChrome/developer.chrome.com@51dd7dd5`（2023-12-05 归档）`site/en/docs/webstore/program-policies/mv3-requirements/index.md` 第 13 行与现行条文逐字相同
- 官方样例：[chrome-extensions-samples `cookbook.wasm-helloworld-print{,-nomodule}/manifest.json`（MV3 + `default-src 'self' 'wasm-unsafe-eval'`）](https://github.com/GoogleChrome/chrome-extensions-samples)

**本文实测产物（临时目录，非仓库文件）**
- 路线 A 原型：`/tmp/expr-runtime/walker/walker.mjs`（311 行）、`test-bench.mjs`（19 条用例 + 性能 + 预算触发）、`compare50.mjs`（50.29MB/340,001 行同数据对比）、`mock-bench.mjs`（`.mock/1.json`）。
- 路线 B：`/tmp/expr-runtime/qjs/`（8 个变体包的 dist 与 gz 测量）、`/tmp/expr-runtime/bench/probe2.mjs`（中断/内存/错误映射能力探针）、`bench.mjs`（50MB 数据传递）、`es-features.mjs` 式探针（语法覆盖）、`/tmp/expr-runtime/mv3/`（未跑通的 MV3 spike 扩展 + `drive.mjs` 驱动）。
- 子调研产物：`/tmp/evaluator-priorart/report.md`（prior art 与 ESTree 普查）、`/tmp/duktape-research/report.md`（Duktape 全套实测，含官方 2.7.0 CLI 编译、超时/内存分配器 harness、三方 wasm 复现）、`/tmp/mv3-engine-research/report.md`（MV3/CWS 事实表 563 行，含 Chromium 源码与页面原文抓取件）。
