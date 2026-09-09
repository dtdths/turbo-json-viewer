# 表达式安全求值引擎与字段提示来源（调研 #3）

> 对应 GitHub issue: [#3 调研：表达式安全求值引擎与字段提示来源](https://github.com/dtdths/turbo-json-viewer/issues/3)（wayfinder:research，Part of #1）。
> 本调研只定**引擎**（词法/语法、求值、预算、错误定位、提示数据源与协议），**不做 UX**（输入框形态、按钮、视觉）。
> 交付物按分支约定落为 `docs/research/<ticket>.md`（issue 正文曾建议文件名 `表达式引擎.md`，本文件即其实现）。
> 词汇遵循 `CONTEXT.md`：表达式（Expression）、字段/API 提示（Completion）、文档概要（Document Profile）。

**检索方法说明（可复核性）**：正文每个事实标注 `[事实]` 或 `[分析]`。`[事实]` 均引自一级来源（Chrome 官方文档页、项目官方 README/CHANGELOG/dist、npm registry、官方 playground 仓库），并给出 URL；体积数字为本次实测（下载 dist 后 `wc -c` 与 `gzip -9`，方法见 1.1）。`[分析]` 为推论/建议，不冒充事实。本会话的 `web_fetch` 工具被沙箱 DNS 策略拦断，故一级页面原文一律改用命令行 `curl` 直接抓取核对（引文与页面内容一致，页面标注了 `Last updated` 日期）；抓不到原文的表述一律标注为 `[分析]`。

---

## 0. 结论速览（TL;DR）

| 决策点 | 推荐 | 一句话理由 |
|---|---|---|
| 词法/语法 | **复用 [acorn](https://github.com/acornjs/acorn)（核心 parser）**，不自研 tokenizer | 全覆盖目标语法（`?.`/箭头/模板串/全部基础运算符）且**零成本**、零依赖、纯 parse 不执行、ESTree AST + `loc` + 错误 `pos/loc`、MIT、活跃维护（8.18.0, 2026-07）；实测主模块 ≈228 KB 原始 / ≈57 KB gzip，远小于 10MB 基线预算 |
| 求值 | **自研 AST 解释器**（对 ESTree 做白名单解释），**不依赖 Function/eval** | MV3 扩展页 CSP 固定为 `script-src 'self'`，`eval()`/`new Function()` 被禁且**不可**放宽（见 §3 原文）。自研解释器才能做步数/时间/内存预算与白名单强制 |
| 防死循环/爆炸 | 四层：语法层排除循环 → AST 静态校验（节点白名单+深度/长度上限）→ 解释器预算（步数+时间检查点+结果截断）→ Worker 内运行 + 主线程硬看门狗 `terminate()` | 防御纵深，任一层失效都有兜底；预算口径参考 JSONata 2.2 guardrails |
| 字段提示数据源 | **文档概要（schema 采样）**：取前 N 项合并键 + 频率排序；小型文档全量扫 | `CONTEXT.md` 已定「数据源是文档概要，不是运行期反射」 |
| API 提示 | **白名单**：数组/字符串常用只读方法 + 少量 Math/全局，表见 §5.2 | 与解释器白名单同一份清单，杜绝提示与执行不一致 |
| 补全协议 | **自研 completion source（CodeMirror 6 `@codemirror/autocomplete` 形态）**，不引 LSP | 单文档单语言的页内补全，LSP 是「跨工具语言服务」的进程间协议，引入它只增加 JSON-RPC/服务器复杂度；Monaco 则体积不匹配（npm 包 unpacked ≈ 93 MiB） |
| 错误定位 | 复用 parser 抛出的 `pos`/`loc` → 表达式文本 caret 定位 + 稳定错误码 + 中英文案表 | acorn/meriyah 原生给出位置；文案层双语（本 ticket 只保证引擎可输出定位与码） |

**推荐路线一句话**：`acorn(ecmaVersion:'latest', locations:true)` 产出 ESTree → 自研 ~300–600 行白名单解释器（own-property 读取 + 仅可调用白名单方法/箭头函数 + 每节点步数递增）在 Worker 内运行，前端对结果预览/导出做尺寸截断并带「截断标记」。

---

## 1. 候选对比

### 1.1 词法/语法实现：自研 vs 复用现成 parser

目标语法（issue #3 原文）：`a?.b.filter(item => item.price > 100)`——可选链、箭头函数、常用数组 API、模板串、基础运算符、可读错误定位。

**先决事实：现有 parser 全部是「纯解析、不执行」**，解析阶段不使用 `eval`/`new Function`（各自源码/README 未见此类调用；这也意味着它们天然符合扩展页 CSP——CSP 禁的是「把字符串当代码执行」，不禁止把字符串**解析**成 AST）`[分析]`。因而 **MV3 CSP 对「选哪个 parser」没有区分度**；区分维度是语法覆盖、AST 质量、体积、维护度。`[事实]` Chrome 文档对 CSP 的描述见 §3，其中没有针对解析库的豁免条款，也没必要有。

#### 实测体积（本次测量，2026-09）

| 库 | 版本（registry latest） | 主文件原始体积 | gzip 后 | 说明 |
|---|---|---|---|---|
| acorn | 8.18.0 | 233,301 B（`dist/acorn.mjs`，未压缩） | **56,900 B** | 源包自带未压缩版；bundler 压缩后更小 |
| meriyah | 7.3.3 | 116,341 B（`dist/meriyah.min.mjs`，已压缩） | **32,503 B** | |
| jsep | 1.4.0 | 10,836 B（`dist/jsep.min.js`，已压缩） | **3,475 B** | 但箭头/模板串需插件、节点与错误无位置，见 1.1.2 |
| espree | 11.2.0 | 35,933 B（`dist/espree.cjs`） | 10,009 B | **依赖 acorn + acorn-jsx**，真实合计 ≈ acorn(57KB)+espree(10KB) gzip |

测量方法：`curl` 下载 `cdn.jsdelivr.net/npm/<pkg>@<version>/dist/...` 后 `wc -c`，`gzip -9` 后 `wc -c`；npm registry `dist.unpackedSize` 仅供参考（是整包 tarball 解压体积，非浏览器 bundle 体积）。`[事实]` 数据源：[npm registry acorn/latest](https://registry.npmjs.org/acorn/latest) 等 registry 页、[jsDelivr data API](https://data.jsdelivr.com)。

基线：map #1 要求扩展 10MB 基线 / 50MB 压力上界；即使解析器大一个数量级也不构成瓶颈，故体积是**次要**判据，语法覆盖与维护是主判据。`[分析]`

#### 1.1.1 目标语法覆盖（读各自官方 README/CHANGELOG 所得）`[事实]`

| 语法点 | acorn | meriyah | jsep | espree |
|---|---|---|---|---|
| 可选链 `a?.b` `a?.[k]` | 核心支持（CHANGELOG：7.3.0, 2020-06-11 加入 optional chaining） | 核心支持（ES2020 标准内） | **核心支持**（v1.1.0+；实测 `a?.b`、`a?.b.c?.[0]` 可解析） | 核心支持（转包给 acorn） |
| 箭头函数 `x => x>1` | 核心（ES6） | 核心 | 仅 `@jsep-plugin/arrow` 插件且仅**表达式体**（源码实现里箭头体走表达式解析；实测无插件时 `x => x > 1` 报错） | 核心 |
| 模板串 `${}` | 核心（ES6） | 核心 | 仅 `@jsep-plugin/template` 插件（实测无插件时报错） | 核心 |
| 对象/数组字面量 | 核心 | 核心 | 对象需 `@jsep-plugin/object` | 核心 |
| 全量语句（for/while/if/声明） | 可解析（我们须自行做子集校验） | 可解析 | **只解析表达式，不含语句**（README：「parse JavaScript expressions but not operations」） | 可解析 |
| ESTree AST | 是 | 是（ESTree-compatible） | 近 esprima/SpiderMonkey AST（节点字段简化） | 是（ESTree） |
| `loc`/`start`/`end` 位置 + 语法错误带 `pos/loc` | `locations:true` 开启；错误对象带 `pos`+`loc`（实测：SyntaxError 带 `pos` 与 `loc{line,column}`） | `loc`/`ranges` 选项；错误带起止 `loc`（实测消息含 `[line:col-line:col]`） | **节点无 `start/end/loc`**（实测节点键仅 `type/computed/object/property`）；错误为无位置普通 Error | 同 acorn（需开 `loc:true`） |
| 依赖 | 零依赖 | 零依赖 | 零依赖 | acorn + acorn-jsx + eslint-visitor-keys |
| License / 维护 | MIT / 活跃（8.18.0 @2026-07-28） | ISC / 活跃（7.3.3） | MIT / 维护一般（1.4.0，最近一次发版较旧） | BSD-2-Clause / ESLint 团队维护（11.2.0） |

> 出处：[acorn CHANGELOG](https://github.com/acornjs/acorn/blob/master/acorn/CHANGELOG.md)（7.3.0 条目）、[acorn README](https://github.com/acornjs/acorn)、[meriyah README](https://github.com/meriyah/meriyah)（ECMAScript 2024 / ESTree / loc / onToken）、[jsep README 与 CHANGELOG](https://github.com/EricSmekens/jsep)（插件表与「not operations」声明；可选链 v1.1.0）、[espree README（built on top of Acorn）](https://github.com/eslint/espree)。表格中「实测」指本次用其官方 dist 在 Node 24 上直接解析验证。`[事实]`

**实测记录（本次，Node 24，直接 import 官方 dist 验证）**：
- `acorn.parse('a?.b.filter(item => item.price > 100)', {ecmaVersion:'latest', locations:true})` → 成功；根节点 `ChainExpression`，往下 `CallExpression → MemberExpression(prop filter) → ArrowFunctionExpression(params:[item], body BinaryExpression) → MemberExpression(prop price)`，与 ESTree 预期一致。
- 同一输入 meriyah 同样解析成功。
- `acorn.parse('a?.b.filter(item => item.price >', …)` → `SyntaxError: Unexpected token (1:32)`，`err.pos=32`、`err.loc={line:1,column:32}`；meriyah 同错误输入抛带起止 `loc` 的错误。
- jsep：`a?.b`、`a?.b.c?.[0]` 成功（核心可选链可用）；`x => x > 1` 与 `` `hi ${x}` `` 无插件即抛错；解析出的节点键仅 `type/computed/object/property` 等——**无 start/end/loc**。
- 四个候选的官方 dist 全量 grep `eval(`/`new Function`：0 命中。

#### 1.1.2 逐库点评

- **acorn**：事实上的生态标准核心（ESLint 的 espree、Babel 之外被广泛用为 parse-only 内核）。`loc`、token 回调、`parseExpressionAt` 都有；错误对象带 `pos`/`loc`。对「表达式子集」足够，且**多出来的语句语法没关系——我们的语法白名单在 AST 校验层做**（§4.2），不需要一个「天生只会表达式」的 parser。
- **meriyah**：解析快、min 版小（32.5KB gz），ESTree + `onToken`/`onComment`；作为备选完全成立。注意它校验正则字面量默认走宿主 RegExp（`validateRegex` 选项）——我们计划不支持正则字面量，无影响。`[事实]`（README）
- **jsep**：4KB gz 很诱人，且可选链核心支持（v1.1.0+，实测通过）；但①箭头函数只有插件且仅**表达式体**、模板串/对象字面量也要挂插件——目标语法 `a?.b.filter(item => item.price > 100)` 里的箭头函数正是短板；②**节点与错误都不带位置**（实测节点无 start/end/loc、错误是纯文本「Unexpected … at character N」），直接损害「可读错误定位」需求；③插件语义面需要自己核实维护。**结论：语法与定位需求不达标，弃**。`[分析]`
- **espree**：acorn 的 ESLint 包装（token-translator、visitor-keys），多一层我们不需要的 ESLint 兼容；直接依赖 acorn 更薄。`[分析]`
- **@babel/parser**：语法覆盖最全，但输出是 **Babel AST（非 ESTree，需 `estree` 插件还原）**，主模块单文件 481 KB（gz ≈ 92 KB）且依赖 @babel/types；我们不需要 JSX/TS/插件体系。`[事实]`（registry + [babel parser 文档](https://babeljs.io/docs/babel-parser)）
- **oxc-parser**：Rust 原生解析器，npm 入口依赖 `node:module`，浏览器直用不行；wasm 入口面向 WASI，在 MV3 里还要处理 `wasm-unsafe-eval`（§3.4）——对表达式子集没有收益。`[事实]`（其 dist 源码与 registry）
- **cherow**：曾主打小体积，但 npm 停更于 2018、GitHub 仓库已 404，**弃**。`[事实]`（registry / GitHub）
- **自研 tokenizer+parser**：目标语法不算小（可选链+箭头+模板串+对象字面量+运算符优先级），复刻 acorn 级健壮性（含 Unicode、ASI、错误恢复）是数周工作量且维护成本高；用 acorn 约 57KB gz 换来的是「语法永远对齐标准、边界情形（嵌套/转义/注释）免费」。**自研只该出现在极端体积约束下，本产品不满足该前提。** `[分析]`
- 反向兜底：若担心 acorn 对「未来语法」的解析（比如某天用户打出 `a?.b ||= 1`），AST 校验层天然拒绝之（节点类型不在白名单）——不需要 parser 理解语义。`[分析]`

**结论：acorn（首选）或 meriyah（备选，若在意 32KB vs 57KB gz 且愿意接受其小众生态）。** `[分析]`

### 1.2 求值方式：AST 解释器 vs Function/eval

- **依赖 `Function`/`eval`：不可行（本产品语境）**。MV3 扩展页（含 background/worker 上下文）默认 CSP `script-src 'self'`，无 `'unsafe-eval'` → `eval()`、`new Function()` 等「把字符串当代码执行」全部被拒；且 `extension_pages` 策略**不可放宽到 unsafe-eval**（安装期即报错，原文见 §3）。`[事实]`
- **沙箱（sandbox）逃逸口**：MV3 仍有 `content_security_policy.sandbox`，默认策略含 `'unsafe-eval'`，文档明说 sandbox 页可用 eval。但 sandbox 页无扩展 API、与主页面只能 `postMessage`、且是**另一个文档**——把表达式求值搬到沙箱 iframe 会引入消息往返、破坏「在 Worker 内受预算约束」的架构，并把「引擎安全边界」押在沙箱语义上；**不采用**。`[事实]+[分析]` 用途参考：仅在需要 eval 的第三方库（如旧模板引擎）场景使用（[sandboxing-eval 指南](https://developer.chrome.com/docs/extensions/how-to/security/sandboxing-eval)）。
- **AST 解释器：可行且更优**。我们只需要一个**白名单求值器**（不是完整 ES 语义机）：解析由 acorn 完成，解释器自研。理由：`[分析]`
  1. **预算可控**：步数在解释器内自增（每个 AST 节点 + 每次数组回调迭代），时间检查点、结果截断都在自己代码里——`eval` 是黑盒，无法预算；
  2. **白名单可强制**：调用点必须是「白名单成员方法 / 箭头函数 / 白名单全局」，属性读只走 own property——`eval` 下这些只能靠改写用户代码；
  3. **无原型链逃逸**：不接触宿主 Function/Object 构造器即无 `({}).constructor.constructor(...)` 类沙箱逃逸面；
  4. **错误定位**：解释器抛错时把当前 AST 节点 `loc` 映射回表达式文本；
  5. **体积/确定性**：约 300–600 行，结果可复现、可测试。
- 语义基准：目标语义对齐 ECMA-262 相应运算符（`===`/`>`/`&&`/`??`/算术/模板串）。因 JSON 文档无函数、无 Date，解释器只需处理 plain object / array / string / number / boolean / null，语义面大幅收窄。`[分析]`

> 求值相关的 CSP 确切条款与出处集中在 §3 原文区。

---

## 2. 推荐方案与理由

**方案**：

```
用户输入表达式文本（< 输入长度上限，如 4 KiB）
  → acorn.parse(text, { ecmaVersion:'latest', locations:true, allowReturnOutsideFunction:false })   [Worker 内]
      ├─ 语法错误 → 错误码 + pos/loc → UI caret 定位（双语文案表）
      └─ ESTree AST → 静态校验（节点类型白名单、for/while/赋值/声明拒绝、递归深度上限、危险属性名检查）
           → 自研解释器求值（词法环境栈、own-property 读、白名单方法分派、步数预算 + 时间检查点 + 结果截断）
                → 结果（JSON 值 / 截断标记 / 超预算错误码）
```

**理由汇总**（对照 §1 表格）：

1. **语法覆盖与错误定位免费获得**：可选链/箭头/模板串/对象字面量/运算符优先级/Unicode/ASI 由 acorn 承担，我们只维护「子集白名单」与「求值器」两个薄层；acorn 的原生 `pos`/`loc` 错误直接服务「可读错误定位」。`[事实]+[分析]`
2. **CSP 合规是结构性的**：全链路没有任何「字符串→代码」执行点（parser 是纯解析；解释器是自研遍历），因此不依赖任何 CSP 放宽（§3 已证放宽不可行），商店审核无需解释 unsafe-eval。`[分析]`
3. **预算在求值器内部实现**，而不是靠「跑完再杀」：步数/时间/输出尺寸三个计量点都在解释器循环里，能给出**确定性错误码**（如 `EVAL_STEP_LIMIT`）而不是「Worker 无响应」。Worker + 主线程看门狗只作为最终兜底（§4.4）。`[分析]`
4. **一套白名单两端复用**：提示补全的 API 白名单 == 解释器允许调用的白名单（§5.2），不会出现「提示了却执行不了」。`[分析]`
5. **备选均被排除**：jsep 语法/定位覆盖不足（箭头与模板串需插件、节点与错误无位置）；meriyah 可作性能备选；自研 parser 成本高；eval/sandbox 路线不可行或不值得（§1.2）。`[分析]`

**喂给 G-6 的接口建议**（本 ticket 只定引擎语义，接口形态待 G-6）`[分析]`：

```ts
// 建议的引擎门面（示意）
interface EvalEngine {
  parse(text: string): { ok: true; ast: Node } | { ok: false; error: EvalErrorInfo };
  validate(ast: Node): { ok: true } | { ok: false; error: EvalErrorInfo };   // 静态白名单
  evaluate(ast: Node, root: JsonValue, budget: Budget): EvaluateResult;      // 同步、可中断检查点
}
interface Budget {
  maxSteps: number;          // 建议默认 1_000_000
  maxTimeMs: number;         // 建议默认 500（检查点每 4_096 步查一次）
  maxResultLength: number;   // 结果数组/字符串上限（截断前）
  maxResultJsonBytes: number;// 预览/导出序列化上限（截断前）
}
interface EvalErrorInfo { code: string; pos?: number; loc?: {line:number;column:number}; messageKey: string; params?: string[] }
// messageKey → i18n 双语文案表（en/zh），引擎不内嵌文案
```

---

## 3. MV3 扩展页 CSP：确切约束与出处

> 注：调研引用的概念页 `developer.chrome.com/docs/extensions/develop/concepts/content-security-policy` 已 404 退役（2026-09 探访），内容现由 manifest 参考页与迁移指南等页面承载，引文均逐字核对自在线页面。

**3.1 默认策略（未声明 manifest 键时）`[事实]`**
出处：[Manifest – Content Security Policy（Chrome Extensions 官方参考，Last updated 2024-02-13）](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy)：

> 默认等价于声明
> ```jsonc
> "content_security_policy": {
>   "extension_pages": "script-src 'self'; object-src 'self';",
>   "sandbox": "sandbox allow-scripts allow-forms allow-popups allow-modals; script-src 'self' 'unsafe-inline' 'unsafe-eval'; child-src 'self';"
> }
> ```
> 「In this case, the extension will only load local scripts and objects from its own packaged resources. **WebAssembly will be disabled, and the extension won't run inline Javascript or be able to evaluate strings as executable code.**」

**3.2 作用范围含 Worker `[事实]`**（同页）：
> 「The **'extension pages' policy applies to page and worker contexts in the extension**. This would include the extension popup, **background worker**, and tabs with HTML pages or iframes that were opened by the extension.」

[迁移指南 Improve extension security](https://developer.chrome.com/docs/extensions/develop/migrate/improve-security)（Last updated 2023-03-08）：
> 「`extension_pages`: Refers to contexts in your extension, **including html files and service workers**.」

> 推论 `[分析]`：从扩展页派生的 dedicated Worker 是扩展的 worker 上下文并按 CSP 继承规则继承创建者策略，故**求值 Worker 同样禁 eval**。Chrome 文档对 dedicated worker 没有逐字说明，此处按上述两条引文的「worker contexts」措辞推断——实现时按「Worker 内同样不可 eval」为准（反正我们不 eval）。

**3.3 不可放宽到 `'unsafe-eval'`（安装期报错）`[事实]`**（Manifest CSP 参考页）：
> 「Chrome enforces a minimum content security policy for extension pages」= `"extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';"`
> 「The `extension_pages` policy **cannot be relaxed beyond this minimum value**. In other words, you **cannot add other script sources** to directives, such as adding `'unsafe-eval'` to `script-src`. If you add a disallowed source to your extension's policy, Chrome will throw an error like this at install time:
> `'content_security_policy.extension_pages': Insecure CSP value "'unsafe-eval'" in directive 'script-src'.`」

[Improve extension security](https://developer.chrome.com/docs/extensions/develop/migrate/improve-security) 补充脚本源白名单：
> 「Manifest V3 disallows those that allow remote code execution. The `script-src`, `object-src`, and `worker-src` directives **may only have the following values**: `self`, `none`, `wasm-unsafe-eval`, *(unpacked-only)* localhost sources… Content security policy values for `sandbox` have no such new restrictions.」
> 「You can no longer execute external logic using `executeScript()`, `eval()`, and `new Function()`.」
> 「In Manifest V3, all of your extension's logic must be part of the extension package. You can no longer load and execute **remotely hosted files** according to Chrome Web Store policy.」

**3.4 `'wasm-unsafe-eval'` 与 wasm（背景信息，非本方案需求）`[事实]`**
[Chrome Extensions What's New](https://developer.chrome.com/docs/extensions/whats-new)：Chrome 102（2022-03）起 MV3 允许在 `extension_pages` 里显式加 `wasm-unsafe-eval`；Chrome 103（2022-05）起**不再默认授予**，必须显式声明才能用 WebAssembly。→ 若哪天引擎想用 wasm（如 oxc-parser 之类原生解析），需在 manifest 显式声明；本方案不用。

**3.5 结论句（写进设计评审用）`[分析]`**
> MV3 扩展页（含 worker 上下文）的 CSP 是 `script-src 'self'`，`eval`/`new Function`/远程代码不可用且不可放宽（只有 `wasm-unsafe-eval` 与 unpacked-localhost 可加）；因此「用户 JS 子集」必须经 **parser（纯解析）+ 自研 AST 解释器** 路线执行，sandbox 逃逸口存在但会牺牲架构与预算控制，不采用。

---

## 4. 防死循环/爆炸：工程做法

防御模型是四层纵深，任何一层失效都被下一层兜住 `[分析]`：

### 4.1 语法层排除循环（结构性，最便宜）
- 表达式子集**根本不含** `for`/`while`/`do-while`/`goto`/`function` 声明（见 §7 边界表）。
- 递归来源只剩「可调用自身」。子集里**没有命名函数**，箭头函数匿名、无法引用自己；无全局可调用对象（无 `Function`/`eval`/`setTimeout`…），因此**递归在语法层即被排除**。`[分析]`
- 剩下的「迭代」只有数组方法（filter/map 等）——由解释器以**步数计量**的方式自实现（每个元素回调 = 固定步数），天然受限。`[分析]`

### 4.2 AST 静态校验（parse 之后、执行之前）
白名单校验器一次性遍历 AST，拒绝（带错误码+节点 loc）：`[分析]`
- **节点类型白名单**：仅接受表 §7「支持」侧的节点；出现 `ForStatement`/`WhileStatement`/`AssignmentExpression`/`UpdateExpression`/`FunctionDeclaration`/`ClassDeclaration`/`NewExpression`/`ImportExpression`/`AwaitExpression`/`YieldExpression`/正则字面量等即拒绝；
- **递归深度上限**：AST 最大深度（建议 ≤ 128）与表达式长度/字符数上限（建议 ≤ 4,096）在 parse **前**就可用简单字符计数拦截，防 acorn 自身递归栈被恶意深嵌套打爆（parse 时对 RangeError 兜底 catch 转成「表达式过深/过复杂」错误码）；`[分析]`
- **调用点检查**：`CallExpression` 的 callee 只能是①白名单成员方法名（§5.2）②箭头函数值③白名单全局；否则拒绝；`[分析]`
- **属性名检查**：对象属性读只允许 `own property`；对数组/字符串访问长度与方法按内置逻辑处理。`__proto__`、`prototype`、`constructor` 不做原型链跟随（见 §5 安全注记）。`[分析]`

### 4.3 解释器预算（执行中）
- **步数预算** `[分析]`：解释器维护单调递增计数器，每个 AST 节点求值 +1，数组方法每处理一个元素按常量（如 1）累加。默认 `maxSteps ≈ 1_000_000`：1e6 步在 Worker 里耗时远低于 1s，足以覆盖真实过滤场景（对 10MB 文档的 `filter` 也就几十万次迭代），超限抛 `EVAL_STEP_LIMIT`。
- **时间预算 + 检查点** `[分析]`：计数器每 4,096 步读一次 `performance.now()`（读取本身廉价，避免每次读时钟）；超过 `maxTimeMs ≈ 500` 抛 `EVAL_TIME_LIMIT`。
- **内存/输出预算 + 截断** `[分析]`：表达式的中间结果（如 filter 产出的新数组）与最终结果受尺寸上限约束。策略：产出容器超过元素上限（建议 `maxResultLength ≈ 200_000`）即停止并标记 `RESULT_TRUNCATED`（携带截断点信息），预览与**导出都带截断标记**（对齐 CONTEXT.md「截断不能静默发生」的修复标记精神）；字符串字面量与模板结果设长度上限。预览序列化（JSON 文本）单独设字节上限。**预算与截断是「结果语义」的一部分**：截断结果在树视图/复制/导出时明确标注，可复现性靠「同输入同预算同结果」保证。
- **数组方法回调内的异常**：回调里再触发数组方法会递归展开→同样走步数计量，天然封顶（a.map(x=>x.filter(...)) 每一层都在预算内）。`[分析]`

### 4.4 Worker 隔离 + 主线程看门狗（最终兜底）
- 求值放**专用 Worker**（扩展页派生、继承扩展页 CSP——反正无 eval）。`[事实]`（§3.2）
- 解释器若因自身 bug 出现真死循环（预算逻辑漏算），Worker 主线程侧加**硬看门狗**：发消息后超过硬时限（建议 3× maxTimeMs）无应答 → `worker.terminate()`，下次求值惰性重建 Worker（成本可忽略）。terminate 是最后手段但**保证 UI 永不冻结**。`[分析]`
- 更细：求值消息体含完整输入，Worker 无状态，重建无状态损失。`[分析]`

### 4.5 参照：JSONata 2.2 的 guardrails（同类产品的工程实践）`[事实]`
[JSONata（github.com/jsonata-js/jsonata）官方 Guardrails 文档](https://github.com/jsonata-js/jsonata/blob/master/docs/guardrails.md)（在线版 [docs.jsonata.org/guardrails](http://docs.jsonata.org/guardrails)；仓库内版本化于 `website/versioned_docs/version-2.2.0/guardrails.md`，引入 PR [#795](https://github.com/jsonata-js/jsonata/pull/795)）：

> JSONata 自认 **Turing-complete**，「it is possible to write unbounded, or infinite loops…could cause a denial of service situation」；库提供可配置 guardrails：**`stack`**（限制 eval-apply 循环深度，超限抛 `D1011`；防递归爆栈）、**`timeout`**（毫秒，抛 `D1012`；防尾递归式无限循环——stack 挡不住它）、**`sequence`**（中间/最终序列最大长度，抛 `D2015`；防内存耗尽）、**`RegexEngine`**（ReDoS：正则执行在核心求值器之外，`timeout` 保护不到，需换引擎）。

对我们的启示：① 同类引擎都承认「语言 Turing-complete → 必须显式预算」，而我们用**非 Turing 完备子集**（无循环无递归）把问题从源头消掉大半，属于更省心的位置；② JSONata 暴露 `timeout`+`sequence`（时间+序列长度）两维与我们的「步数+时间+尺寸」口径一致；③ ReDoS 的教训：**别把正则字面量放进子集**（§7 不支持正则），需要字符串方法时只用字符串参数。`[分析]`

---

## 5. 字段/API 提示：数据源与协议

### 5.1 字段提示数据源 = 文档概要（schema 采样）

`CONTEXT.md` 已定原则：补全数据源是**文档概要（Document Profile）**，不是运行期反射（我们不执行用户表达式来取字段；也不把整棵大文档当提示索引）。建议采样算法 `[分析]`：

1. **小型文档（估算节点数 < 阈值，如 50k）**：遍历全部成员键，建 `path → 频率/类型` 统计，可同时产出嵌套字段路径样本。
2. **大型文档**：每层数组**取前 N 个元素采样（建议 N=32，可配置）**合并键：
   - 对同构数组，样本间的键做 union，键频率 = 各样本出现次数累加（出现于多元素同名的键频次更高）；
   - 对象成员顺序按首次出现稳定排序（对齐「成员键序需保持」的产品承诺，提示列表也稳定）；
   - 顶层用前 N 条**不同形状**（若前 32 条全同构则继续扫描到出现第 2 种形状为止，避免大文档首块恰好同构导致的偏差）。
3. **输出为补全用索引**：`{ flatFields: [{name, freq, kind}], pathSamples: [...] }`，轻量、可缓存、可在 Worker 或主线程惰性算一次。
4. **排序**：频率降序为主、字母序为辅；常用「文档根字段」永远置顶（`a?.b` 的 `a` 是最高频根键）。
5. 提示内容还包括**类型引导**：数组字段后接 `.map/.filter` 时，下一级提示来自数组元素样本形状（利用采样中元素对象键）——这是「对当前文档做 schema 采样」的增值项，尽力而为，退化即回到普通字段/方法字典。`[分析]`

> 这与 map #1「Not yet specified」里「字段/API 提示与搜索共用的 schema 采样/文档概要（结构统计、节点计数、路径索引）」一致；本调研确认该方向可行且把算法细化如上。`[分析]`

**为什么不做「运行期反射式补全」**：DevTools Console 的补全在**可执行上下文**里靠 eager evaluation 拿真实值（见 §6.2），JSON 查看器不能为补全去执行部分表达式（安全+成本），因此字段补全只能来自静态的文档概要。`[分析]`

### 5.2 API 提示 = 白名单（与解释器共用同一张表）

「提示什么 = 允许调什么」：方法白名单是引擎安全边界的对外可见部分，写死为一份清单并两侧共用。建议 v1 清单 `[分析]`：

| 类别 | 成员 | 备注 |
|---|---|---|
| 数组（只读风格，均返回新值或标量） | `length`、`map`、`filter`、`find`、`findIndex`、`some`、`every`、`includes`、`indexOf`、`lastIndexOf`、`slice`、`concat`、`join`、`flat`、`at`、`reduce`、`reduceRight` | issue 核心是 map/filter/find；reduce 若想先砍可砍（预算内回调照算步数）。**变异方法（push/sort/splice/pop/reverse…）一律不进**——文档只读语义 + 消除副作用面 |
| 字符串 | `length`、`includes`、`startsWith`、`endsWith`、`indexOf`、`slice`、`toUpperCase`、`toLowerCase`、`trim`、`split`、`replace`（**仅字符串参数**）、`charAt`、`substring` | 无正则参数 → 无 ReDoS 面 |
| 数学 | `Math.abs/floor/ceil/round/trunc/max/min/pow/sqrt`（白名单子集） | |
| 全局/工具 | `typeof`（运算符）、`Array.isArray`、`Number(...)`/`String(...)`/`Boolean(...)` 转换、`JSON.stringify/parse`（可选，v1 可不开） | 无任何「逃逸向」全局（Function/eval/process/window/globalThis/constructor 链） |
| 对象 | 无内置方法（字段读是 own-property） | 提示 `.length` 只在数组/字符串上下文出现 |

> 若某方法语义复杂（reduce 初始值/箭头四参签名），解释器逐方法实现并配测试。每加一个方法都同时出现在「提示」与「解释器白名单」两个文件（单一来源，防漂移）。`[分析]`

### 5.3 补全用什么协议：LSP vs 自研

**结论：自研 completion source（CodeMirror 6 形态），不引 LSP。** `[分析]` 理由：

- **LSP 的定位**是「语言服务跑在**独立进程**、与工具经 **JSON-RPC** 通信（textDocument/didOpen/didChange/diagnostics/definition…），让同一 server 复用于多个工具」——官方定义见 [Language Server Protocol overview](https://microsoft.github.io/language-server-protocol/overviews/lsp/overview/)。[VS Code 文档](https://code.visualstudio.com/api/language-extensions/programmatic-language-features)也明说语言特性**要么**进程内 `registerCompletionItemProvider`，**要么**起一个 LSP server——后者收益是「任意语言写 server + 跨编辑器复用」。我们只有**一个工具（扩展页）一个文档一个自定义小语言**，既不能也不需起进程；为它实现 LSP server 只增加协议层复杂度。`[事实]+[分析]`
- **页内编辑器层面**：CodeMirror 6 提供官方 `@codemirror/autocomplete`：`CompletionSource = fn(context: CompletionContext) → CompletionResult | Promise<…> | null`，`CompletionResult = {from, to, options: Completion[], validFor, filter}`，由编辑器自动做前缀匹配与排序（[CM6 autocomplete 参考](https://codemirror.net/docs/ref/#autocomplete)、[示例](https://codemirror.net/examples/autocompletion/)）。我们的「文档概要 + 白名单」正好实现成一个 completion source，进程模型是纯函数 `getCompletions(text, pos, profile)`，测试友好。`[事实]`
- **Monaco 选项**：功能强但体积与形态都不匹配——`monaco-editor@0.56.0` npm 包 unpacked ≈ **93 MiB（97,911,464 B，1,909 个文件）**（registry 实测），单个 dev 核心 chunk 就 ≈ 4.8 MB；其语言服务需 Web Worker（扩展页场景多一层 CSP/加载成本）；官方 FAQ 明确 **VS Code 扩展不能在 Monaco 里跑**（除非纯 JS LSP 方案），自带 provider API（`monaco.languages.registerCompletionItemProvider`）与 LSP 不是一回事。单行表达式输入用它属大炮打蚊子。`[事实]`（[registry](https://registry.npmjs.org/monaco-editor)、[monaco-editor README/FAQ](https://github.com/microsoft/monaco-editor)）
- **协议边界建议**：引擎暴露同步 API `completions(text, pos, profile): CompletionItem[]`（见 §2 接口），UI 层（不管最终用 CM6 还是别的编辑器）注册为 completion source；**不做** JSON-RPC/LSP 传输。佐证：连 CodeMirror 官方 LSP client 也是把 `serverCompletionSource` **包装成 CM 的 completion source**（[CM6 lsp-client](https://codemirror.net/docs/ref/#lsp-client)）——LSP 至多只是同一 source API 的可选后端。若未来要跨工具（如给 VS Code 插件复用），再把同一内核包成 LSP server，内核与传输解耦即可，现在不做。`[分析]`
- 提示文案双语（en/zh）属 UI 数据层：建议与错误文案同用 `messageKey + 参数` 结构（§2），避免引擎内嵌文案。`[分析]`

---

## 6. 竞品/参照：输入体验与边界（只记录，不做 UX 决策）

### 6.1 jq（官方 playground 与 CLI）`[事实]`
- 官方 web playground：[jqlang/playground](https://github.com/jqlang/playground)（play.jqlang.org）——Next.js 构建，**集成 jq-wasm**（WebAssembly 版 jq，浏览器本地执行、数据不出浏览器，可选分享 snippet）。CLI 之外最接近「表达式→结果」的产品形态。
- jq 是**独立语言**（非 JS 子集），输入体验=过滤器文本+结果区；官方 CLI 错误输出格式含位置信封：jq 源码 `src/main.c` 打印 `jq: error (at %s): %s\n`（`jq: error (at <stdin>:1:15): …` 形态）。**jq CLI 无自动补全**；递归通过 `recurse` 等显式函数，jq 手册的 Recursion 一节说明「递归可能无限，tail call 被优化」（[jq 手册 Recursion](https://jqlang.github.io/jq/manual/#Recursion)）——即 jq 把「用户可能写跑飞」交给用户自己负责（有 `--debug-dump-disasm` 等但**无内置预算**，手册未声明时间/深度预算）。`[事实]`（手册该节只描述语义；「无内置预算」按手册未提及作 `[分析]`）
- 对我们的启示 `[分析]`：web 化用 wasm 是一个选择，但 wasm 在 MV3 需显式 `wasm-unsafe-eval`（§3.4）且我们根本不需要跑 jq 语言；jq 的经验是**结果区与输入区同屏**与**错误带位置**，我们照搬后两点即可。

### 6.2 DevTools Console（参照点：输入体验、eager evaluation、错误、补全机制）`[事实]`
- 官方 Chrome 68 发布说明（[What's New In DevTools 68](https://developer.chrome.com/blog/new-in-devtools-68)）列出 console 的输入体验目标：**Eager Evaluation**——「As you type expressions, the Console previews the result」；**Function autocompletion**——「After typing a function call such as `document.querySelector('p')`, the Console shows you the functions and properties that the **return value** supports」。
- Console 补全弹窗混排**表达式历史**（「Autocomplete from history」）与**当前上下文活动对象的 own/原型链属性**（含 `#private` 属性建议），见官方 [Console 参考](https://developer.chrome.com/docs/devtools/console/reference/)。补全机制是「运行期内省」而非静态分析——官方文档未逐句说明机制，此为 `[分析]`；实现上 DevTools 前端在输入框用 CodeMirror 的 JS completion（无语言服务器）。
- 机制推论 `[分析]`：console 补全以**运行期值**为来源（对当前执行上下文真实求值/内省），且 console 能这么做是因为它运行在浏览器主调试上下文（无我们这种「用户输入→本机文档求值」的安全/预算约束，也不受扩展页 CSP 约束）。因此不能照搬其数据源，只能借鉴其**交互形态**（预览、函数签名提示、返回值属性补全的「类型感知」愿景）。
- 边界参照 `[分析]`：console 中跑 `while(true){}` 会挂起页面且无文档化的「停止」机制（只能靠浏览器无响应对话框/调试器打断）——这正是我们要用预算+Worker 消除的问题，可作验收反例。
- 错误展示参照：console 把未捕获异常以结构化方式展示并可直接展开对象；我们的「结果可复制/导出」对应它右键 copy 的能力。`[分析]`

### 6.3 JSONata（Playground + 引擎预算）`[事实]`
- 官方 playground 应用仓库 = [jsonata-js/jsonata-exerciser](https://github.com/jsonata-js/jsonata-exerciser)（「Playground for trying out JSONata expressions」），托管于 try.jsonata.org / jsonata.org（[JSONata README](https://github.com/jsonata-js/jsonata) 首页链接）。其编辑器用 **Monaco + 自定义 Monarch 语法**，求值在**客户端**完成；**错误按 `err.position/token` 映射为编辑器内联波浪线**（deltaDecorations）——这正是我们要的「可读错误定位」的现成交互参照。`[事实]`
- 引擎：JSONata 是**自研 parser + 自研求值器**的语言（[github.com/jsonata-js/jsonata](https://github.com/jsonata-js/jsonata)，`src/parser.js` + AST 求值器），v2.2.2 dist 实测**无 `eval(`/`new Function` 出现**（对 `jsonata.min.js` 全量 grep，0 命中——引擎自求值路线与我们推荐一致）。`[事实]`（实测方法：grep 官方 dist）
- JSONata 表达式语言可写递归/无限（自认 Turing-complete）→ guardrails：`timeout`（超时，错误码 D1012）、`stack`（eval-apply 深度，D1011）、`sequence`（序列长度，D2015）在源码与 [docs/guardrails.md](https://github.com/jsonata-js/jsonata/blob/master/docs/guardrails.md) 有文档（§4.5）。对照我们的边界表：**JSONata 需要 stack/timeout/sequence 三道预算，因为我们自证非 Turing 完备（无循环/无递归/无副作用），预算需求更低**，但仍保留步数/时间/输出三道保险。`[事实]+[分析]`

### 6.4 对「结果可复制/导出」与双语文案的引擎侧含义（补充背景）
- **可复制/导出**：引擎结果必须是「纯 JSON 值 + 截断/预算标记」的结构，导出器只需序列化；截断结果导出时带标记与说明（同「修复不能静默发生」的 provenance 精神）。`[分析]`
- **中英双语**：引擎不内嵌文案；错误/提示统一 `messageKey(+params)`，由 i18n 表渲染 en/zh（错误码如 `PARSE_ERR_SYNTAX`、`EVAL_STEP_LIMIT`、`EVAL_ILLEGAL_CALL`、`RESULT_TRUNCATED`…）。`[分析]`

---

## 7. 「支持 / 不支持」语法边界表（v1 目标，可作 G-6 验收基线的初稿）

> 判据：功能需要 + 解释器白名单可实现 + 无沙箱逃逸/无循环递归/无 ReDoS。表中为建议初稿，G-6 可按需增删（例如砍 reduce、加数组展开 `...`）。

| 类别 | ✅ 支持 | ❌ 不支持（含原因） |
|---|---|---|
| 字面量 | 数字、字符串（`'`/`"`）、布尔、`null`、`undefined`、**模板串（含 `${}` 插值）**、数组字面量 `[1,2]`、对象字面量 `{a:1, b}` | 正则字面量（ReDoS、正则执行在预算外）；BigInt/`0x`/数字分隔符按需；`Symbol` |
| 标识符/路径 | 字段读取（own property，任意合法 JSON 键名含 `constructor` 等——只读 own data，不走原型链）、括号下标 `x["k"]`/`x[0]` | 原型链跟随（`__proto__`、`constructor`、`prototype` 不可经原型取到函数/对象）；未声明标识符（报「字段不存在」而非返回 undefined？见错误语义，倾向报错以助拼写纠错） |
| 可选链 | `a?.b`、`a?.[k]`、`a?.(...)` | — |
| 运算符 | `+ - * / %`、`< <= > >=`、`== === != !==`（建议只用 `===/!==`，宽松相等易误用）、`&& \|\| ! ??`、三元 `? :`、一元 `-`、`typeof` | 赋值类（`= += -= ++ --`）；`in`/`instanceof`/`new`/`delete`/位运算（`& \| ^ ~ << >>` 如需再议）；`**`（如需再议） |
| 箭头函数 | `x => expr`、`(a,b) => expr`；参数可缺省与否待 G-6（建议先只支持单表达式体） | 块体箭头 `x => { ... }`（v1 不开：块内语义面增大）；默认参数/解构参数；`async`/`await`；`function` 声明 |
| 数组方法（白名单） | `map filter find findIndex some every includes indexOf slice concat join flat at reduce(可选) length` | `push sort splice reverse pop shift unshift fill copyWithin forEach?`（变异/无返回值侧，v1 全不开；`forEach` 若用户想要可由 map 顶替，暂不开） |
| 字符串方法（白名单） | 见 §5.2 表 | `match/replace(正则)/split(正则)/exec`（防 ReDoS） |
| 全局 | `Array.isArray`、`Number/String/Boolean(...)`、`Math.*` 白名单子集；如需 `JSON.parse/stringify` 另评 | 一切可逃逸/可执行构造：`Function eval setTimeout setInterval fetch import process globalThis window require` 等（**子集语言里这些名字直接不可解析为可调用**，白名单校验拒绝） |
| 语句/声明 | 仅「一个表达式」（`Program.body[0]` 必须恰为 ExpressionStatement 且无其余语句） | `for/while/do/if/switch/try/return/var/let/const/function/class/import/export/with/label/goto` |
| 其它 | 表达式内注释（acorn 默认随 `onComment` 可选，v1 可忽略）、括号分组 | `new`、`class`、生成器、`async`、`yield`、`import()`、解构赋值、展开 `...`（v1 不含；若要数组拼接用 `concat`）、`with`、标签、正则、`debugger` |
| 预算相关 | 超时/超步数/超尺寸均返回**确定错误码**；结果截断带标记 | 无「静默跑完再杀」：任何运行超限都回到错误码，用户可改表达式重试 |

**边界表使用的实现说明**：静态校验按**节点类型白名单**而非「黑名单」实现——未知节点一律拒绝（默认安全）；因此「表里没写的语法 = 不支持」，即使 acorn 能解析。`[分析]`
**实现注意**（实测）：可选链会让 acorn 把外层包成 ESTree 的 `ChainExpression` 节点（`a?.b.filter(...)` 根为 `ChainExpression → CallExpression`）——**校验白名单必须显式包含 `ChainExpression`**，否则合法的可选链表达式会被自己的校验器误杀；解释器对 `ChainExpression` 按内层节点求值即可。`[事实]`（实测节点链，见 §1.1.1 实测记录）

---

## 8. 开放问题 / 喂给 G-6 的清单

1. 错误语义细节：`a.typo`（缺失字段）——按 JS 语义应返回 `undefined`（含可选链上下文，无差别），但可在错误/补全里对「拼写接近已有字段」的读取给出纠错建议。建议 v1 返回 `undefined` 并附纠错提示。`[分析]`
2. 默认预算数值（步骤/时间/尺寸）需原型压测（.mock/1.json 952KB 样本）后定稿；本文建议默认 1e6 步 / 500ms / 200k 元素。
3. 提示索引的「大文档阈值」与采样 N 用 map #1 的性能 harness 校准。
4. `reduce`/`JSON.*`/`**`/数组展开是否进 v1（依赖表达式实际用例）。
5. 表达式的执行结果如何回灌视图（结果树/导出/复制）属 G-6/UX，引擎只保证「JSON 值+标记」输出与确定性。
6. 是否需要「表达式收藏/语法速查」等附加——不在本 ticket 范围。

---

## 参考来源（正文 URL 汇总）

**Chrome / MV3 CSP（全部 `[事实]`，引文已逐字核对）**
- [Manifest – Content Security Policy（官方参考；默认策略/作用范围/不可放宽原文，Last updated 2024-02-13）](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy)
- [Improve extension security（MV3 迁移指南；eval/new Function/远程代码/可声明的 script-src 值原文，Last updated 2023-03-08）](https://developer.chrome.com/docs/extensions/develop/migrate/improve-security)
- [Chrome Extensions What's New（Chrome 102/103 wasm-unsafe-eval 变更）](https://developer.chrome.com/docs/extensions/whats-new)
- [Manifest – sandbox（sandbox 页可用 eval、无扩展 API、postMessage 通信）](https://developer.chrome.com/docs/extensions/reference/manifest/sandbox)
- [How to: sandboxing eval（沙箱使用场景指南）](https://developer.chrome.com/docs/extensions/how-to/security/sandboxing-eval)
- [Content scripts（隔离世界 CSP 禁 eval）](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)

**Parser 库（体积为本次实测；版本/覆盖引自官方 README/CHANGELOG/registry）**
- [acorn README](https://github.com/acornjs/acorn) / [acorn CHANGELOG（可选链 7.3.0）](https://github.com/acornjs/acorn/blob/master/acorn/CHANGELOG.md) / [npm acorn](https://www.npmjs.com/package/acorn)
- [meriyah README](https://github.com/meriyah/meriyah) / [npm meriyah](https://www.npmjs.com/package/meriyah)
- [jsep README](https://github.com/EricSmekens/jsep) / [npm jsep](https://www.npmjs.com/package/jsep)
- [espree（ESLint monorepo）](https://github.com/eslint/espree) / [npm espree](https://www.npmjs.com/package/espree)
- npm registry metadata & [jsDelivr](https://www.jsdelivr.com)（体积实测数据源）

**预算实践参照**
- [JSONata Guardrails 文档（stack/timeout/sequence/RegexEngine）](https://github.com/jsonata-js/jsonata/blob/master/docs/guardrails.md) / [docs.jsonata.org/guardrails](http://docs.jsonata.org/guardrails) / [jsonata-js/jsonata](https://github.com/jsonata-js/jsonata)（自研求值、无 eval；guardrails PR [#795](https://github.com/jsonata-js/jsonata/pull/795)）

**补全/编辑器/协议**
- [LSP overview（协议定位原文）](https://microsoft.github.io/language-server-protocol/overviews/lsp/overview/)
- [VS Code 语言特性编程文档（进程内 provider vs LSP server）](https://code.visualstudio.com/api/language-extensions/programmatic-language-features)
- [CodeMirror 6 @codemirror/autocomplete 参考](https://codemirror.net/docs/ref/#autocomplete) / [示例](https://codemirror.net/examples/autocompletion/) / [lsp-client 参考](https://codemirror.net/docs/ref/#lsp-client) / [lint 参考](https://codemirror.net/docs/ref/#lint)
- [monaco-editor（README/FAQ 与体积）](https://github.com/microsoft/monaco-editor) / [npm monaco-editor（体积实测）](https://www.npmjs.com/package/monaco-editor) / [monaco.d.ts](https://cdn.jsdelivr.net/npm/monaco-editor@0.56.0/monaco.d.ts) / [npm codemirror](https://www.npmjs.com/package/codemirror)

**竞品/参照体验**
- [jqlang/playground（官方 jq playground，jq-wasm 本地执行）](https://github.com/jqlang/playground)
- [jq 手册 Recursion 节](https://jqlang.github.io/jq/manual/#Recursion) / [jq 源码 src/main.c（`jq: error (at %s)` 输出）](https://github.com/jqlang/jq)
- [What's New In DevTools 68（Eager Evaluation / Function autocompletion 原文）](https://developer.chrome.com/blog/new-in-devtools-68) / [Console 官方参考（历史补全、活动对象属性、#private）](https://developer.chrome.com/docs/devtools/console/reference/)
- [jsonata-exerciser（官方 playground 应用：Monaco + 错误内联波浪线）](https://github.com/jsonata-js/jsonata-exerciser) / [try.jsonata.org](http://try.jsonata.org/) / [jsonata.org](https://jsonata.org)

**仓库内关联**
- [CONTEXT.md（词汇表：表达式/文档概要/修复标记）](../CONTEXT.md)（相对路径）；[issue #3](https://github.com/dtdths/turbo-json-viewer/issues/3)；[map #1](https://github.com/dtdths/turbo-json-viewer/issues/1)
