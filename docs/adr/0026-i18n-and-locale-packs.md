# ADR-0026：国际化（i18n）与按语言懒加载的词条包

- 状态：Accepted（2026-11-16，实现随本 ADR 落地）
- 日期：2026-11-16
- 依据：用户 2026-11-16 需求「加 i18n 支持国际化」＋同日四问拍板（zh-CN + en-US；自动跟随浏览器 + 设置手动覆盖；worker 诊断改结构化；预算先按「英文内联 / 其他语言懒加载」推进，超线前带实测数字确认）；`docs/architecture/README.md` §8（体积预算口径）、§11（实现进度表）
- 相关票：#45（实现票）、#1（架构设计地图）

## 背景

界面文案此前全部**内联中文**：`src/**` 里 327 条唯一文案（396 处），`page.html` 49 处静态标签/`title`/`aria-label`，`manifest.json` 的中文 description。没有词条层、没有语言设置、没有 `_locales`。

三处硬约束决定了本 ADR 的形状：

1. **预算**：`page.js` 51.2KB gz / 预算 52（余 0.8）。全部双语内联预计 55–56，直接击穿预算。
2. **文案跨线程**：worker 会生成用户可见的诊断文案并经协议回页面——`RepairOp.note`（逐条修复说明）、`RepairProvenance.summaryText`（修复摘要）、正则错误 `BAD_PATTERN` 的 `message`、补全项 `ExprCompletion.detail`。这些如果留在 worker 侧拼串，英文界面就会夹中文；如果 worker 自持词条，切语言后**已收到的旧回包**仍是旧语言。
3. **可扩展**：用户明确「之后会支持更多语言」——每加一种语言不能重算 `page.js` 预算。

## 决策

### 1. 词条表与 key 约定

- **扁平 key + 命名空间**：`app.*`（`main.ts` + `page.html` 外壳）、`view.*`（`view/**` 面板/树/原文/标签条）、`core.*`（worker 诊断在页面侧的格式化文案）。key 用点分小写，动词/名词短语（`app.toolbar.import`、`view.search.placeholder`、`core.repair.trailingComma`）。
- **词条值**：`string`，或复数形态 `{ one: string; other: string }`（用 `Intl.PluralRules` 选形，zh 只有 `other`）。占位符统一 `{name}`（只做名字替换，不引入 ICU 语法）。
- **类型化**：`type MessageKey = keyof typeof en`。`en` 是**真相源**，`zh-CN` 必须 key 全集一致、占位符集合一致（单测守护，缺 key 编译期/测试期即红）。
- 词条文件按**语言**分目录、按**层**分文件：`src/i18n/messages/en/{app,view,core}.ts`、`src/i18n/messages/zh-CN/{app,view,core}.ts`。分层拆分是为了并行开发时文件归属清晰，也便于以后按功能扩充；语言注册表 `src/i18n/languages.ts` 是「有哪些语言」的唯一来源。
- **禁止内联中文残留**：单测扫描 `src/**` 的非注释字符串字面量，命中 CJK 即失败（白名单：语言包文件、测试夹具、样本/文档）。这条守护防止新文案绕过词条层。

### 2. locale 解析与加载（所有语言都是按需加载的语言包）

- 解析优先级（高 → 低）：
  1. `?lang=<tag>`（**仅测试/调试**，覆盖一切，不持久化）；
  2. 已存设置 `Settings.locale`（`'auto' | LanguageTag`，默认 `'auto'`）；
  3. `'auto'` 时按 `navigator.language` 归一：`zh*` → `zh-CN`，其余 → `en-US`；
  4. 兜底 `en-US`。
- **每种语言各自一个动态 `import()` 分块**（`src/i18n/messages/<tag>/pack.ts`），**首帧前 `await` 加载当前语言包**（ESM top-level await；入口层渲染前完成）。`page.js` 里**不含任何语言包**——首屏体积与语言数无关，新增语言只加一个 lazy chunk。
- **`en-US` 是回退语言**（`LanguageTag` 兜底、`?lang=` 非法值回落、语言包加载失败时的二次回退），但它同样**不内联**：只有被选中时才加载。加载失败 → 记一次 `warn` → 尝试 en 包 → 再退空表（`t()` 返回 key 本身，便于测试/冒烟暴露）。
- **随包发布的语言包必须完整**：`messages/{en,zh-CN}/pack.ts` 的 key 集与占位符由单测逐 key 守护（`tests/unit/i18n/messages.test.ts` 会遍历注册表里每个 `load()`）；不做「部分语言包 + en 兜底」的运行时合并（避免首屏再背一个 en 包）。
- `<html lang>` 写解析后的 locale（`zh-CN` / `en-US`）；`document.title` 是品牌名，不翻译。
- 数字/日期展示：统一 `formatNumber(n)`（按当前 locale 的 `Intl.NumberFormat`）替换散落的 `toLocaleString()`；切语言时状态栏等重渲染。

### 3. 运行时切换（设置面板第 14 行）

- 设置项 `locale: 'auto' | LanguageTag`，默认 `'auto'`；持久化在既有 `tjv.settings.v1`，`normalizeSettings` 白名单回落（未知语言 → `'auto'`）。
- 设置面板新增「语言」行（**13 → 14 行**），选项由 `LANGUAGES` 注册表生成：`跟随系统` / `简体中文` / `English`（选项 label 用**各语言自己的自称**，不翻译）。
- 切换流程：写设置 → `applyLocale(next)` → 按需 `import()` 语言包 → 换活动词条表 → **全量重渲染**：
  - `page.html` 静态节点：`data-i18n="key"`（写 `textContent`）与 `data-i18n-attr="title:key,aria-label:key"` 批量回填；
  - 各面板 `relabel()`（搜索/大纲/设置/表达式/概要按各自 render 路径重建文案；设置面板整表重建）；
  - 动态文案按「持有状态重渲染」：状态栏、三条 notice、表达式结果条、标签条标题/aria、空态、模态、右键菜单（菜单项文案由 `view/menu` 在打开时取词条）；
  - `html lang` / `document.title` / `aria-label` 同步。
- **worker 无语言状态**：诊断文案在回包里是结构化数据（见 §4），页面在**渲染时**格式化，所以切语言后旧回包也能即时变成新语言，无需重发命令。

### 4. worker 诊断结构化（协议小改，页面格式化）

| 位置 | 现状 | 改为 |
|---|---|---|
| `RepairOp.note` | 拼好的中文串（含 `lit`/`keep` 等插值） | `note: RepairNote`（`{ code, ...params }` 判别联合；code 如 `trailing-comma` / `literal-partial` / `number-prefix` / `closers` / `dangling-key` …；`closers.where` 保留**原文本偏移串**（如 `'{@0, [@9'`），不改成语义枚举——它在旧文案里就是这个串，改语义会改变输出） |
| `RepairProvenance.summaryText` | 拼好的中文摘要 | **删除字段**；页面由 `counts`（brackets/quotes/commas/deletedChars）走 `core.repair.summary.*` 词条拼出，与 i18n 化之前**逐字一致**：删除项单列、闭合符/结束引号合并成一组统一加「补」前缀（`补 6 个闭合符、1 个结束引号`）、计数保持裸数字（不加千分位） |
| 搜索 `BAD_PATTERN` | `CoreError.message` 中文 | 保持 `code='BAD_PATTERN'`，新增 `patternIssue: 'syntax' \| 'too-long' \| 'backtracking'` + `message` 保留引擎原文（英文 reason 直接附在本地化前缀后） |
| `ExprCompletion.detail` | 拼好的中文串 | `detail: CompletionDetail`（`{ scope: 'root-field' \| 'sampled-field' \| 'global' \| 'math' \| 'array-method' \| 'string-method' \| 'json' \| 'property' \| 'array-length'; kind?: JsonKind \| 'mixed'; freq?; samples? }`）；页面格式化成 CM6 需要的字符串 |

`RepairNote` / `CompletionDetail` 是**领域枚举**，不是 i18n key——worker 不感知语言，页面把 domain code 映射到 `core.*` 词条（映射表放 `src/shared/` 或 `src/i18n/format.ts`，单测覆盖每个 code 都有词条）。

### 5. 静态 HTML 与 manifest

- `page.html`：默认文案保持**英文**（`en` 是内联真相源，未加载/加载失败时的兜底即英文），静态节点加 `data-i18n` / `data-i18n-attr`；启动时按当前 locale 批量回填。`<html lang>` 由启动脚本改写。
- `manifest.json`：`name` / `description` / `action.default_title` 改 `__MSG_extName__` 等；新增 `default_locale: "en"`；`src/app/_locales/{en,zh_CN}/messages.json`，`build.mjs` 把 `_locales` 拷进 `dist/`（不进 bundle，不占预算）。
- 扩展名 `Turbo JSON Viewer` 本身不翻译（品牌名）；`description` 翻译。

### 6. 预算口径（2026-11-16 实测回填）

- **`page.js` ≤ 52KB gz 不变（实测 51.2）**：中文内容（4.38KB gz）全部移出，语言包零内联；留下的成本是 `t()`/复数/数字格式/`data-i18n` 回填/relabel 接线 + 调用点里的 key 字面量（约 +4.1KB，相对移出中文后的 46.8 基线）。曾评估「en 内联」方案：实测 `page.js` 会到 **57.0KB**（击穿 52），故否决。
- **语言包单列预算：每个 ≤ 7KB gz**（实测 **en 6.0 / zh-CN 6.8**）。语言包是动态 import 的 chunk，不计入「懒加载 chunk 合计 146」（那是 CM6 编辑器分块，实测 145.7）；`node build.mjs --analyze` 增加 `locale packs` 行逐包打印。
- **首屏诚实口径 = `page.js + 当前语言包`**：en 用户 **57.2**、zh 用户 **58.0**（均为 gz；扩展本地加载，无网络往返）。该数字单列记录，不与 52 混算——52 是「与语言无关的代码」预算，语言包按「每语言 ≤7KB」独立守。
- `worker.js` 无硬预算（实测 65.5，诊断结构化后略降）。
- 新增语言 = 新增一个 ≤7KB 的 lazy chunk，`page.js`/首屏代码不变。

### 7. 测试与冒烟（2026-11-16 实测回填）

- 单测（新增 `tests/unit/i18n/` 4 个文件，64 条）：语言 package key 全集一致 / 占位符一致（**遍历注册表内每个 `load()`，含并行新增语言**）/ 用 TypeScript parser 扫「`src/**` 无内联中文字面量」/ `page.html` 的 `data-i18n*` key 都存在且默认英文 / locale 解析矩阵（`?lang` > 设置 > navigator > fallback）/ 复数选形（en one/other、zh 单形）/ 每个 `RepairNote` / `CompletionDetail` / `patternIssue` code 都有词条且**中文输出与 i18n 化之前逐字一致** / `formatNumber` / 设置 `locale` 白名单回落 / 语言包加载失败回退 en 包。
- 现有 16 套冒烟**钉 `zh-CN`**：`launchChrome` 统一加 `--lang=zh-CN --accept-lang=zh-CN`（一处改动覆盖全部脚本），断言文案零改动（仅设置行数 13 → 14 与 `ExpressionCompletion.detail` 结构化断言两处同步）。
- 新增 `smoke-i18n`（第 17 套，**20/20**）：`?lang=en-US` 全量抽查（外壳/设置 14 行/状态栏/文档/右键菜单/踩概要/修复摘要+逐条 note/正则错误）、切 zh 即时性（**含已渲染的修复条按新语言重渲染** = worker 结构化诊断的证据）、en 持久化（浏览器 zh-CN 下刷新仍英文）、`?lang=zh-CN` 覆盖已存 en-US、0 page 异常 / 0 console error。
- dev hook：新增 `localeState()`（解析 locale、偏好、`<html lang>`、zh 包是否已加载、词条表 key 数），`HOOK_MEMBERS` 契约同步（83 → 84）。
- 运行期切换的「已渲染动态文案」：状态栏/提示条/空态/入口层/标签条/面板标签全部重画；**表达式行内错误与状态行、搜索正则错误**保留结构化源数据、切换时重新格式化（`applyExpressionInlineText` / `searchPatternCore`）。已知差距：编辑弹层里已显示的 parse 错误是引擎原文（不本地化）；输入框里未提交的表达式文本不重写。

## 验收（2026-11-16 实测回填）

- [x] `npm run check` 全绿：**1307 单测 / 56 文件**（基线 1241，+66：i18n 4 文件 + view/server 新增）。
- [x] 17 套冒烟串行全绿（原 16 套断言零改动，除设置 14 行 / `CompletionDetail` 结构化两处）+ 新增 `smoke-i18n` **20/20**。
- [x] `node build.mjs --analyze`：`page.js` **51.2KB gz ≤52**、语言包 **en 6.0 / zh-CN 6.8KB gz（每包 ≤7）**、懒加载 **145.7KB ≤146**（语言包单列）、`worker.js` 65.5（无硬预算）。
- [x] 截图：`.spike/smoke/i18n-en-settings.png` / `i18n-en-repair.png` / `i18n-zh.png`；`?lang=` 覆盖、设置切换、刷新持久化由 `smoke-i18n` 覆盖。
- [x] 文档：`README.md`（状态/预算/红线/17 套）、`docs/architecture/README.md` §3.6 + §8 预算 + §11 `6.31`、`CONTEXT.md`（界面语言 / 语言偏好 / 词条 / 语言包 / 跟随系统 / 结构化诊断）、`docs/architecture/build-and-test.md` §3.4（语言包单列预算 + 首屏口径）、`docs/design/direction.md`（设置面板 14 行）、`seams.md`（依赖方向：`i18n` 叶子、`core` 不 import `i18n`）。

## 已知差距（本轮不做）

- 不引入 ICU MessageFormat / 翻译平台工作流（词条在仓库内手写，`en` 真相源 + `zh-CN` 全量守护）。
- 不做 RTL、字体/排版按语言的差异微调（当前两种语言均为 LTR + 同一字体栈）。
- 不做「源文本编码/JSON 内容」的语言处理——i18n 只覆盖界面文案，文档内容原样。
- 不做每语言独立的快捷键/⌘ 符号（macOS `⌘` 保持现状，Windows 键位另议）。
- 不做语言包的增量热更新（扩展更新才换词条）。
