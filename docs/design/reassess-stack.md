# 重评估：技术栈 / DOM 行渲染 / CodeMirror 6 / 无框架 UI 部件 / 构建链

> 任务：共享任务 `task-2`（重评估小组 stack-ui）。决策上下文：[#13](https://github.com/dtdths/turbo-json-viewer/issues/13)（视图层栈 + esbuild + vitest）、[#12](https://github.com/dtdths/turbo-json-viewer/issues/12)（求值载体 + CM6 仅表达式框）、[#11](https://github.com/dtdths/turbo-json-viewer/issues/11)（原始文本视图不引 CM6）、[#5](https://github.com/dtdths/turbo-json-viewer/issues/5)（P-1 spike 必测项）、[#2](https://github.com/dtdths/turbo-json-viewer/issues/2)（渲染方案调研）。
> 交付物：本文 + `prototype/p1/bench/stack/**`（可复跑脚本 + 最小构建配置）+ `prototype/p1/fixtures/stack/**`（MV3 bench 扩展页）。
> 标注：**确认** = 原决策被实测支持；**修正** = 方向对但细节/参数要改；**推翻** = 原决策不成立。未测的写「未测」，不补数字。

## 0. 结论速览

| # | 决策点 | 结论 | 一句话证据（全部真机 CfT 156 / M4 实测） |
|---|---|---|---|
| 1 | DOM 行渲染（固定 24px、40 行/帧） | **确认** | 5 种写法每帧 JS 都在 **0.03–0.09ms**（1000 帧总时 31.2–86.2ms），60fps 下 0 掉帧、0 长任务；**推荐「行节点池 + textContent 复用」**（31.2ms/1000 帧，是 innerHTML 的 2.8× 快） |
| 2 | CodeMirror 6 仅用于表达式框 | **确认（可用）+ 修正（包集合与体积预期）** | MV3 CSP 下加载/初始化/输入/补全全通、bundle 内 **0 处 eval/new Function**；但最小可用集 **90.7KB gz**（state+view+autocomplete），含 lang **145.9KB gz**；任务给定的「acorn 57KB gz」实测 **33.7KB gz** |
| 3 | 交互部件自研 or 引小库 | **修正** | 7 个部件自研 **354 行源 / 3.11KB gz** 覆盖全部；**不引 focus-trap**（原生 `<dialog>` 白送 top-layer+inert，6.69KB gz 省掉）、**暂不引 @floating-ui/dom**（20 行 clamp 通过边界测试，6.33KB gz） |
| 4 | esbuild 多入口 + vitest；Vite+CRXJS | **确认** | 一份配置打出 page+module worker+SW **67ms**（16 模块）、增量 watch **~104ms**、vitest 12 tests **511ms**、`tsc --noEmit` **624ms**、E2E harness 启动 **~0.4s**；**Vite+CRXJS 不值得引**（无框架、无 CSS 构建，HMR 收益被 SW 重载复杂度抵消；未实测） |
| 5 | 首屏 JS 体积预算 | **确认（给出具体预算线）** | 应用自有代码 **≈3.2KB gz**（acorn 33.7 + 自研 3.2 ≈ **37KB gz** 首屏）；+CM6 最小集 → **≈138KB gz**；+lang → ≈182KB gz。商店审核可读性 OK |

---

## 1. 方法与环境

| 项 | 值 |
|---|---|
| 机器 | Apple M4 / 32GB（与 #15 同一台） |
| Chrome | **Chrome for Testing 156.0**，`--headless=new --no-sandbox`，由 `prototype/p1/lib/chrome.mjs` 启动并加载未打包 MV3 扩展 |
| Node | v24.13.0（构建/单测/体积测量）；**所有渲染与输入延迟都在真 Chrome 扩展页里测** |
| 扩展页 | `prototype/p1/fixtures/stack/`（`page.html` DOM bench、`ui.html` 部件 bench、`cm6-min.html` / `cm6-lang.html` CM6 bench），`permissions:["storage"]`，`content_security_policy.extension_pages = "script-src 'self'; object-src 'self'"` |
| 样本 | 合成行模型 `makeRows()`：20 万逻辑行（固定行高场景只需逻辑行，不物化 DOM）；行内容含长字符串（380 字符）以压 `text-overflow` |
| 并发 | 测量期间其他小组成员在跑重负载 Chrome；DOM 基准的 rAF 均值 16.66–16.73ms、0 掉帧说明该轮争用可忽略；**结构结论稳，±20% 的细节数字建议安静环境复跑** |
| 口径 | 每变体 5 个交错 round × 1000 帧（sync 紧循环，取帧时间中位/p95/总时），另跑 600 帧 rAF 驱动看掉帧；`PerformanceObserver('longtask')` 计长任务；`performance.memory` 取堆增量（带 `--enable-precise-memory-info`）；体积 = esbuild `bundle+minify` 后 **gzip -9** |

复跑（全部命令在 `prototype/p1/bench/stack/`）：

```bash
cd prototype/p1/bench/stack
npm install --registry=https://registry.npmjs.org --cache=/tmp/npm-cache-dsh
npm run build            # esbuild 多入口 → fixtures/stack/*.js
npm run build:cm6        # CM6/acorn/focus-trap/floating-ui 单包体积 + splitting 对比
node build-cm6-layers.mjs  # CM6 逐包增量体积
npm run bench:dom        # 真机 DOM 行渲染（~60s，需独占 Chrome）
npm run bench:cm6        # 真机 CM6 CSP/初始化/输入/补全 + textarea 基线
npm run bench:ui         # 真机 UI 部件 / a11y / i18n
npm run bench:build      # 构建/watch/vitest/tsc 时间
npm test                 # vitest 单测
```

产物：`results/*.json`（原始数字）+ `results/layers/`（CM6 分层产物）。

---

## 2. Q1 — DOM 行渲染（真机 Chrome，MV3 扩展页）

### 2.1 设计

同一份 20 万行行模型、固定 `height:24px`、视口 **40 行/帧**；每行结构 `div.row > span.tk-key + span.tk-p + span.tk-val`（四类 token 着色）。5 种写法：

| 变体 | 写法 |
|---|---|
| `innerHTML` | 拼 HTML 字符串 + `escapeHtml`（`& < > " '` 全转义）后一次 `host.innerHTML = html` |
| `createElement` | 每行 `createElement`×4 + `textContent`，逐行 `appendChild` 到活容器 |
| `cloneNode` | 预建 `<template>` 行骨架，`cloneNode(true)` 后填 `textContent` |
| `fragment` | `createElement`+`textContent` 批量塞进 `DocumentFragment`，最后一次挂载 |
| `reuse` | 40 个行节点常驻池，每帧只改 `style.paddingLeft` 与 `textContent`（不增删 DOM） |

每帧都包含「卸载旧行 + 挂 40 行新行」成本（`reuse` 除外，它按设计只更新文本）；帧时间用 `performance.now()` 包住渲染调用；另测「渲染 + 强制 layout/style」（`void scroller.offsetHeight`）以覆盖样式/布局成本。

### 2.2 结果（5 交错 round × 1000 帧；单位 ms）

| 变体 | JS 中位/帧 | JS p95 | JS max/帧 | **1000 帧 JS 总时** | 布局+样式 中位/帧 | 节点数/帧 | 长任务 | rAF 均值帧 | rAF p95 | 掉帧 |
|---|---|---|---|---|---|---|---|---|---|---|
| innerHTML | 0.1 | 0.2 | 7.0 | **86.2** | 0.2 | 161 | 0 | 16.73 | 17.5 | 0 |
| createElement | 0.1 | 0.2 | 13.0 | **74.1** | 0.2 | 161 | 0 | 16.67 | 17.5 | 0 |
| cloneNode | 0.1 | 0.2 | 7.5 | **67.2** | 0.2 | 161 | 0 | 16.67 | 17.4 | 0 |
| fragment | 0.1 | 0.2 | 7.5 | **76.0** | 0.2 | 161 | 0 | 16.66 | 17.5 | 0 |
| **reuse** | **0.0** | **0.1** | **0.5** | **31.2** | 0.2 | 161 | 0 | 16.66 | 17.5 | 0 |

其他检查（全部变体一致）：

| 检查 | 结果 |
|---|---|
| XSS（行内含 `<img onerror>` / `<script>` / `<svg onload>`） | **5/5 通过**：无元素注入、无 handler 触发、文本原样可见（`innerHTML` 变体靠转义也通过，但转义是必须项、且是唯一有注入面的写法） |
| 省略号 | `textOverflow=ellipsis`，`scrollWidth 3675 > clientWidth 720` → **生效**（`div.row` 上 `white-space:nowrap;overflow:hidden;text-overflow:ellipsis` 对多 span 行有效） |
| 固定行高 | 5 种写法实测行高都 **恰好 24.00px**（`height` + `line-height` 双写，无 margin/padding 干扰） |
| 堆增量 | 5 轮平均 −1.5MB…+1.2MB（噪声，无单调增长）→ **无明显 GC 抖动**；长任务 0 |

> 200k 逻辑行不需要全部物化，所以「逻辑行数」不影响上述数字；`reuse` 的 40 节点池大小 = 视口行数。

### 2.3 结论与推荐写法

**结论：确认** —— 固定行高 DOM 行虚拟化在本场景完全可行：40 行/帧的主线程成本是 **0.03–0.09ms/帧**，比 16.7ms 帧预算低 **两个数量级**，布局/样式也只要 0.2ms。也就是说「DOM 行渲染」不是瓶颈，**不要为了性能上 canvas**（原 #2 结论成立）。

推荐实现（`src/renderer.ts`，约 70 行，≈1KB gz）：

1. **行节点池 + `textContent` 更新（对应 `reuse`）**：池大小 = 视口 + overscan，行节点常驻，滚动时只改文本/缩进/类名。它是 5 种写法里唯一没有「每帧 40×4 次节点创建」的，1000 帧总时 31.2ms（innerHTML 86.2ms、createElement 74.1ms）。
2. **不要用 `innerHTML` 拼串**：即使转义正确也最慢、且引入了唯一的 XSS 面（转义漏一处 = 注入）；实测 max/帧 7ms 的尖峰也最高。
3. **首次渲染可用 `DocumentFragment` 批量挂载**（76.0ms/1000 帧，与 cloneNode 同档），但进入滚动稳态后切到池复用。
4. 行结构：`height:24px; line-height:24px` 显式双写（只写 `line-height` 时，行内若有更大字号/内联图片会把行撑高——本次以固定高规避）；缩进用 `padding-left: depth*12px`，不要嵌套容器（嵌套会让缩进依赖 DOM 深度、破坏行高一致性）。
5. 省略：`white-space:nowrap; overflow:hidden; text-overflow:ellipsis` 放在行容器上；**不要**把长文本塞进 `title` 属性或 DOM 文本之外的地方，虚拟行卸载后没有第二份数据源。
6. 文本节点安全：只用 `textContent`（或 `innerText` 的等价语义），`data-*` 只放 node id/索引，不放用户文本。
7. 坑：`createElement` 变体出现过 **13ms** 单帧尖峰（首帧 JIT/GC），池复用把它压到 0.5ms；`reuse` 变体必须在别的写法改写容器后重新挂回自己的池（本 bench 里踩到过，实现时用一个「容器被外部替换」的守卫）。

---

## 3. Q2 — CodeMirror 6（仅表达式输入框）

### 3.1 打包体积（esbuild bundle + minify + gzip -9）

| 包/组合 | raw | gz | 说明 |
|---|---|---|---|
| `@codemirror/state` | 48.4KB | **16.2KB** | EditorState 基础 |
| + `@codemirror/view` | 201.3KB | **65.3KB**（Δ+49.1） | 编辑器核心（DOM、输入、绘制） |
| + `@codemirror/autocomplete` | 277.9KB | **90.7KB**（Δ+25.5） | 补全弹层/listbox |
| + `@codemirror/commands` | 310.2KB | **100.9KB**（Δ+10.2） | history/默认键位 |
| + `@codemirror/lang-javascript` + language 高亮 | 430.2KB | **145.9KB**（Δ+45.0） | 语法高亮 |
| **cm6-min**（state+view+autocomplete+commands，本 bench 的「最小可用」） | 312.6KB | **99.4KB** | 实测输入/补全均通 |
| cm6-lang（+javascript） | 430.8KB | **142.8KB** | |
| textarea+自研补全基线 | 2.2KB | **1.0KB** | 见 §3.4 |
| acorn（仅 parse） | 121.7KB | **33.7KB** | 任务书里的 57KB gz **不复现**（见 §6） |
| focus-trap | 20.3KB | 6.69KB | 未采用（§4） |
| @floating-ui/dom | 15.9KB | 6.33KB | 未采用（§4） |

CM6 两个入口 `splitting:true` 时共享 chunk 后总量 145.0KB gz vs 不分包 242.2KB gz——但我们只发一个入口（表达式框只有一处），**不需要 splitting**。

构建耗时：cm6-min 首包 **37ms**，重复 5 次 **20/23/26/20/28ms**；cm6-lang 26ms。

### 3.2 MV3 扩展页 CSP 下实测

| 项 | 结果 |
|---|---|
| CSP 是否真的生效 | **是**：扩展页脚本加载期 `eval()` 与 `new Function()` 都抛 `EvalError: ... 'unsafe-eval' is not allowed` |
| CM6 bundle 是否含 eval/new Function | 扫描 minified 产物：cm6-min / cm6-lang / textarea-baseline 均 **0 处**（bench 自身的 CSP 探针已剔除后统计） |
| 首次 mount | **7.1ms**（min）/ 4.2ms（lang）；重复 mount 20 次 **中位 0.1ms、p95 0.5ms** |
| 编辑器 DOM 规模 | `#cm6-min-host` 内 **6 个元素**（空文档），远小于行列表 |
| 真实键盘输入（CDP `Input.insertText`，走 Blink 输入管线） | 39 字符 **13ms**（≈0.33ms/字符），期间 0 长任务 |
| autocomplete popup | **出现**：`ul[role=listbox]`、`li[role=option]`、`aria-activedescendant` 指向当前项、7 个候选、弹层 252×100；从开始输入到 popup 可见 **106.2ms**（含 CM6 默认 100ms 的 `activateOnTyping` 延迟） |
| 继续输入过滤（`data.hot`） | 候选过滤正常（同上 popup 结构） |
| lang 高亮 | 插入 `data.hotel_tags.filter(item => item.price > 100)` 后 `.cm-line span` = 2（数字 + 箭头）→ 语言包生效 |
| 控制台错误/异常 | 0 |

### 3.3 一个必须记住的测量陷阱

**CSP 断言必须在扩展页脚本「加载期」执行**。用 CDP `Runtime.evaluate` 去调 `eval()` 会被 DevTools 的 CSP 旁路放行——本 bench 第一版就是这样读到 `evalBlocked:false`（假阴性）。正确做法：在模块顶层执行探针并缓存结果（`src/cm6-min.ts` 的 `cspAtLoad`），或读 `document` 的 `securitypolicyviolation`。E2E 断言 CSP 时同样适用。

### 3.4 与「textarea + 自研补全」的代价对比

| | CM6（最小集） | textarea + 自研补全（`src/textarea-baseline.ts`） |
|---|---|---|
| 体积 | **99.4KB gz**（含 lang 142.8） | **1.0KB gz** |
| 实现代码 | 0 行（配置 30 行） | **~80 行** |
| mount | 7.1ms 首次 / 0.1ms 后续 | 0.2ms |
| 输入 39 字符 | 13ms | 12ms |
| 补全弹层 | 原生 `role=listbox/option` + `aria-activedescendant` + 位置冲突处理 + 键盘上下选择 | 自研 `role=listbox/option`，**无** `aria-activedescendant`（可加 ~10 行）、无碰撞翻转 |
| 语法高亮 | 原生 | 无 |
| undo/redo、选区、IME/组合输入、括号匹配、超长行折行 | 原生 | 需自研（IME、组合事件最容易出错的一类） |
| 维护 | 上游稳定、社区 | 约 80 行自持 |

### 3.5 结论

**确认**：CM6 在 MV3 扩展页 CSP 下**完全可用**（无 eval、初始化 7ms 级、输入 0.33ms/字符、补全弹层与 a11y 结构齐全），#12「表达式框用 CM6」的技术前提成立，**没有性能理由换掉它**。

**修正（体积预期与包集合）**：
- 体积不是任务书预估的「几十 KB」，最小可用 **99.4KB gz**，含语法高亮 **142.8KB gz**。做首屏预算时必须按 100–145KB 计（见 §6）。
- 最小包集合建议：**`@codemirror/state` + `@codemirror/view` + `@codemirror/autocomplete`（90.7KB）**；`commands`（+10.2KB）看是否需要 undo/默认键位（表达式框建议要，history 对长表达式体验重要）；`lang-javascript`（+45KB）**只在高亮是硬需求时引入**，否则可省 45KB。
- 把 autocomplete 的 `activateOnTyping` 延迟从默认 100ms 调到 50ms 左右（实测 106ms 到 popup，其中 100ms 是固定延迟），表达式框场景输入停顿更短。
- **备选（若体积预算吃紧）**：textarea + 80 行自研补全，1.0KB gz，交互与 CM6 的可见差异只有「高亮、undo、IME 边界、弹层定位」；判断门槛建议：**首屏 gz 预算 ≥150KB 就留 CM6，<80KB 就降级 textarea**。

**残余风险（未测）**：IME/中文组合输入、真实屏幕阅读器对 CM6 listbox 的播报、移动端/触摸选区、`activateOnTyping` 调参后的稳定性。

---

## 4. Q3 — 无框架 UI 部件与 a11y

### 4.1 全部手写，逐部件实测（真机 Chrome，`ui.html`）

| 部件 | 源行数 | 实测行为（CDP 真输入） | 引库？ |
|---|---|---|---|
| 右键菜单 `ui/menu.ts` | 79 | `role=menu`/4×`menuitem`；`ArrowDown` 焦点下移（index 0→1）；`Enter` 触发动作并关闭（`["copy-json"]`）；`Escape` 关闭且**焦点还原到 opener**（`menu-anchor`）；外部 `pointerdown` 关闭；在视口右下角打开时**自动夹回**（`inside=true`） | 手写；**不引 @floating-ui/dom**（clamp 20 行够用，6.33KB gz 省掉） |
| Toast `ui/toast.ts` | 38 | `role=status` `aria-live=polite`，1 条可见、自动消失 | 手写 |
| 模态 `ui/dialog.ts` | 40 | 原生 `<dialog>`：`:modal=true`、**背景按钮不可聚焦（inert）**、5 次真实 Tab 只在 `OK/Cancel` 与浏览器 chrome（`BODY`）间循环、`Escape` 关闭 | 手写；**不引 focus-trap**（6.69KB gz 省掉） |
| 可拖拽分栏 `ui/splitter.ts` | 51 | `role=separator`；CDP 真鼠标拖拽 **+80px 精确生效**，`aria-valuenow` 同步 320→400；键盘 `ArrowRight` +16px | 手写 |
| 工具条 `ui/toolbar.ts` | 36 | `role=toolbar`，roving tabindex：任意时刻 **1 个 tabbable**；`ArrowRight` 0→1、`End`→3，焦点跟随 | 手写 |
| 虚拟行键盘导航 `ui/treeNav.ts` | 79 | 两种策略都通过：**aria-activedescendant**（容器保持焦点，`aria-activedescendant=tn-row-26`，行不 tabbable）/ **roving tabindex**（焦点落到第 26 行，1 个 tabbable）。处理耗时中位 **0.1ms**、p95 ≤0.3ms（200 行） | 手写 |
| i18n `ui/i18n.ts` | 32 | `getUILanguage()=zh-CN`、`getMessage('extName')=「Turbo JSON 技术栈基准」`；1000 次原始 `getMessage` **1.1ms** vs 缓存后 **0.1ms** | 手写，无需库 |
| **合计** | **354 行源（含注释）** | **打包后 3.11KB gz**（含全部 7 个部件） | — |

AX 树（CDP `Accessibility.getFullAXTree`）实测暴露：`tree`×2、`treeitem`×400（带名称 `"field_N"`）、`toolbar`、`separator`、`status`、`button`×6 → 自研部件**确实进入了无障碍树**。

### 4.2 a11y 最低可行方案（v1）

1. **树**：`role=tree` 容器 + 行 `role=treeitem` + `aria-level`；滚动虚拟化下用 **`aria-activedescendant`**（容器 `tabindex=0`，200 个虚拟行不进 tab 序、也不因回收而丢失焦点）——实测处理 0.1ms/键，且比 roving 少维护「哪个行当前 tabbable」。若产品更看重原生焦点环，roving 也可行（0.1ms），二选一，不要混用。
2. **菜单**：`role=menu`/`menuitem` + `tabindex=-1` + 打开即聚焦首项 + Arrow/Home/End/Enter/Escape + Escape 还原 opener + 外部点击关闭（本 bench 全部实测通过）。
3. **对话框**：直接用原生 `<dialog>.showModal()`：top-layer、背景 inert、Esc、焦点包含全由平台提供；只需补 `aria-labelledby`、初始焦点、返回值映射。
4. **Toast**：`role=status` + `aria-live=polite`（不要 `assertive`，避免打断读屏）。
5. **分栏**：`role=separator` + `aria-valuenow/min/max` + 键盘方向键（实测 aria 值同步）。
6. **工具条**：`role=toolbar` + roving tabindex（实测 1 个 tabbable）。
7. **焦点管理**：菜单打开/关闭、对话框打开/关闭、展开/折叠后行回收，都要显式 `focus()`；虚拟行回收时若焦点在行上，先落到容器再回收。
8. **i18n**：`_locales` + `getMessage`，启动时 prime 进 map 即可（1.1ms→0.1ms，可忽略，但便于统一缺省 key 兜底与 `$1` 替换）。

### 4.3 推荐（哪些手写、哪些引库）

- **全部 7 个部件手写**：354 行、3.11KB gz、零外部维护依赖，且行为已被 CDP 真输入验证。
- **不引 focus-trap**（原生 `<dialog>` 已给 inert+top-layer+Esc；focus-trap 6.69KB gz 只有在「非 dialog 的浮层也要困住焦点」时才需要）。
- **暂不引 @floating-ui/dom**（菜单靠 20 行视口 clamp 即通过边界测试；等出现「锚定 + 自动翻转 + 滚动跟随」的复杂浮层（表达式补全弹层若要自研）再说，6.33KB gz）。
- **不引组件库**（与「无框架」决策一致；本 bench 的体积证据：自研 UI 总量 ≈ 3.1KB gz，远小于任何库的最小引入）。

**未测**：真实屏幕阅读器（VoiceOver/NVDA）播报、移动端触摸、Windows 高对比度模式、浏览器缩放 125%/150% 下的 24px 行高（可能变非整数）。

---

## 5. Q4 — 构建 / 开发 / 测试

### 5.1 esbuild 多入口（page + module worker + SW）

一份 `build.mjs` 配置、`format=esm`、`splitting=false`，同时产出：

| 产物 | raw | gz | 角色 |
|---|---|---|---|
| `bench-dom.js` | 7.0KB | **2.74KB** | 扩展页脚本（DOM bench 全部逻辑） |
| `bench-ui.js` | 9.3KB | **3.11KB** | 扩展页脚本（7 个 UI 部件） |
| `worker.js` | 0.4KB | **0.27KB** | **module Worker**（`new Worker(url,{type:'module'})`） |
| `sw.js` | 0.2KB | **0.14KB** | **MV3 module SW**（`"background":{"service_worker":"sw.js","type":"module"}`） |
| `app.js` | 130.9KB | **36.96KB** | 「应用形状」bundle（acorn+tokenizer+renderer+UI） |

- **构建耗时：冷启动 126ms wall（esbuild 本身 67ms）**，16 个模块；产物全为独立 IIFE 式 ESM 文件，无需 bundler 特定插件。
- 结论：**确认** —— page/worker/SW 三类目标同一份配置可打，不存在「page 能打、SW 不能打」的坑；worker/SW 产物各 0.14–0.27KB gz，说明 esbuild 对这两个 entry 的 tree-shaking 正常。

### 5.2 dev watch 自动重载

- esbuild `context().watch()` 增量重建实测：首轮 3.06ms，稳态 **100.86–106.38ms，中位 103.9ms**（10 轮，`performance.now()` 从 `writeFile` 完成到 `onEnd`）。
- 结论：**确认** —— 改一行到产物落盘 ~104ms，完全够「文件变更 → 自动重载扩展页」的体验；`onEnd` 钩子里触发 `chrome.runtime.reload()`（或让页面轮询 dev stamp）即可，无需 HMR。
- **未测**：自动重载的实际端到端时延（重载 → 页面可用），只测了重建；建议实现时在 `onEnd` 里调 SW 的 `chrome.runtime.reload()`，页面侧用 `chrome.runtime.onInstalled` 或轮询 stamp 兜底。

### 5.3 vitest / tsc

- `vitest run`：**2 文件 / 12 测试 / 511ms**（纯逻辑：`visibleWindow` 边界、行模型确定性、tokenizer 转义/未闭合/线性）；exit 0。
- `tsc --noEmit`：**624ms，0 error**（strict + `moduleResolution:bundler`，`src/` 全量）。
- 单测边界（结论）：**纯函数**（行窗口算术、tokenizer、路径/展开集合运算、预算计数、acorn AST 白名单校验）适合 vitest；**DOM 行为**（行渲染、焦点、CSP、CM6）不要用 jsdom 硬凑——用本 harness 在真 Chrome 里跑（本报告 §2–§4 全部如此），两者互补。

### 5.4 本 harness 做 E2E 的可行性

- 启动 `withChrome()` → 就绪 **~0.4s**；打开扩展页 + 等就绪 ~0.2s；单条 `page.eval` 往返 ms 级。
- 已用它完成：CSP 断言、CM6 初始化/输入/补全、菜单/对话框/分栏/工具条/树导航的真键盘与真鼠标操作、AX 树导出、i18n。
- 结论：**确认可行**，无需 Puppeteer/Playwright 依赖（Node ≥22 全局 WebSocket，零 npm 依赖）。
- 坑（都已踩过并修）：① 多 target 时**非前台页 rAF 会被节流**→ 需要 `Page.bringToFront` 再测帧；② **CDP `Runtime.evaluate` 旁路 CSP**（§3.3）；③ 扩展 `_locales` 里 `$COUNT$` 这类占位符**未在 `placeholders` 声明会让整个扩展加载失败**，表现为 `net::ERR_BLOCKED_BY_CLIENT`（排查浪费 10 分钟，记为 pitfall）。

### 5.5 Vite + CRXJS 是否值得

**结论：不值得（v1）。** 理由（未实测 CRXJS 现状，属判断）：
1. 无框架、无 CSS 预处理器、无 TS 类型生成需求 → Vite 的主要卖点（插件生态、HMR、按需转换）无用武之地；
2. esbuild 多入口 67ms + watch 104ms 已经比多数 HMR 冷启动快；
3. MV3 的 HMR 仍绕不开「SW/worker 重载、扩展 reload 会清空页面状态」，复杂度高于 esbuild watch + 一次 `runtime.reload()`；
4. CRXJS 引入一层版本耦合（Vite/CRXJS/MV3 兼容矩阵），对一个 3 个入口的扩展是负资产。
   → 保留决策：到「样式调整密集到影响手感」时再评估（原 #13 已这么写，本次维持）。

---

## 6. Q5 — 体积预算与商店审核可读性

### 6.1 实测构成

| 组成 | gz | 备注 |
|---|---|---|
| 应用自有代码（acorn 除外的 UI+渲染+tokenizer+行模型） | **≈3.3KB** | 由 `app.js 36.96 − acorn 33.7` 反推，与 `bench-ui.js 3.11KB` 互相印证 |
| acorn（仅 parse 路径） | **33.7KB** | 任务书写的「57KB gz」不复现；本次 acorn 8.19.0 + esbuild minify + gzip -9 |
| 序列化/表达式/树逻辑（未在本次实现，估） | ~5–10KB | 未测 |
| **首屏 JS（不含 CM6）** | **≈37–40KB gz** | +CSS/AST 文本 ≈1–2KB |
| + CM6 最小集（state+view+autocomplete+commands） | **+99.4KB → ≈138KB gz** | 建议预算线 |
| + CM6 + lang 高亮 | **+142.8KB → ≈182KB gz** | 只有高亮是硬需求才到这一档 |

### 6.2 预算建议

- **首屏 JS 预算线：≤150KB gz（含 CM6 最小集）**；若加 lang 高亮则 ≤200KB gz。以本次实测的 ≈37KB（自有+acorn）+ 99.4KB（CM6）刚好落在 138KB。
- 体积大头排序：**CM6 99.4 > acorn 33.7 > 自有代码 3.3**。要瘦身先砍 CM6（去 commands −10.2 / 去 lang −45 / 或降级 textarea −98），再考虑 acorn（用手写极小校验器替代 acorn 可省 33.7KB，但会牺牲白名单 AST 的可靠性——**不建议**，见 #12）。
- **商店审核可读性**：产物为 3–5 个独立 minified ESM 文件、无 `eval`/`new Function`、无远程脚本、无动态代码加载（`import()` 仅包内），MV3 策略合规；审核关注点主要是「为什么需要 storage」「为什么读剪贴板」，与体积无关。保持「生产构建不含 sourcemap、不含 sourcesContent」即可。
- **修正**：任务书给的两个体积锚点要更新 —— **acorn = 33.7KB gz（不是 57）**；**CM6 = 99.4–142.8KB gz（不是「仅几十 KB」）**。

---

## 7. 推荐栈清单（含版本/体积）

| 层 | 选型 | 版本（实测） | 体积（gz） | 结论 |
|---|---|---|---|---|
| 语言/框架 | 原生 TypeScript（无框架） | TS 5.9.3（`tsc --noEmit` 624ms/0 error） | — | **确认** |
| 行渲染 | 自研行节点池 + `textContent`；首次可 `DocumentFragment` | — | ≈1KB | **确认**（31.2ms/1000 帧） |
| 虚拟化 | 自研固定行高算术窗口 | — | <0.5KB | **确认**（`visibleWindow` 12 单测覆盖边界） |
| 表达式编辑器 | CodeMirror 6：`@codemirror/state` 6.7.6 + `view` 6.43.15 + `autocomplete` 6.20.4 + `commands` 6.11.1 | 同上 | **99.4KB** | **确认（可用）+ 修正（去 lang 45KB 除非必须）** |
| 表达式解析 | acorn 8.19.0（仅 parse）+ 自研 walker | 8.19.0 | **33.7KB** | **确认** |
| UI 部件 | 自研：menu / toast / dialog(原生) / splitter / toolbar / treeNav / i18n | — | **3.11KB**（354 行） | **修正**：不引 focus-trap、不引 floating-ui |
| Worker | 包内 module Worker（文档常驻） | — | 0.27KB | 确认（构建产物正常） |
| SW | MV3 module service worker | — | 0.14KB | 确认 |
| 构建 | esbuild 0.28.2 | 0.28.2 | — | **确认**：多入口 67ms、watch 104ms |
| 单测 | vitest 5.0.5 | 5.0.5 | — | **确认**：12 tests / 511ms |
| E2E | 自研 CDP harness（零依赖） | Node 24 | — | **确认**：启动 0.4s，已覆盖 CSP/输入/a11y |
| Vite+CRXJS | 不引入 | — | — | **不值得（v1）** |

---

## 8. 成本与残余风险

**成本（相对原方案）**
- CM6 是最贵的单项：99.4KB gz（最小集）/ 142.8KB（含 lang），等于自有 UI 代码的 32–46 倍；如果接受 textarea 基线，可省 98KB gz，代价是失去高亮/undo/IME 边界/弹层定位。
- 手写 UI 部件 354 行、零依赖，维护成本主要是「a11y 回归」——建议把本次的 CDP 断言（菜单 Escape 还原焦点、dialog 背景 inert、toolbar 1 tabbable、tree aria-activedescendant、i18n 语言）固化为仓库 E2E 脚本。
- 自研行虚拟化+池渲染的坑集中在「行回收时的焦点、选中、DOM 结构一致性」，不是性能。

**残余风险 / 未测**
1. 只在 **headless CfT 156 + M4 + DPR 1** 测；品牌 Chrome 的 UI 线程、低端机（Intel/4 核）、Windows 字体度量、**125%/150% 缩放下的 24px 行高**未测（可能非整数，需 `line-height` 兜底）。
2. DOM 基准测的是「逻辑行 + 池渲染」，**未测**真实文档展开/折叠时的行数组重建（另一组可能覆盖）；也未测滚动惯性/触控板下的 overscan 策略。
3. CM6 **未测** IME/中文组合输入、真实读屏播报、移动端触摸选区；`activateOnTyping` 调参后未复测。
4. UI 部件**未测**真实 VoiceOver/NVDA、高对比度、移动端；AX 树只验证了 role/name 存在，未验证播报顺序。
5. **Vite+CRXJS 结论未实测**（按构建耗时与无框架事实推断）。
6. 测量期间有其他成员的 Chrome 重负载并发；结构结论（数量级差、0 掉帧、0 长任务）稳，±20% 的细节建议在安静环境用 §1 命令复跑。
7. `results/dom.json` 与 `results/ui.json` 是单次运行快照；`bench:dom` 每次约 60s（含 5×600 帧 rAF）。

---

## 9. 复跑与产物

```bash
cd prototype/p1/bench/stack
npm install --registry=https://registry.npmjs.org --cache=/tmp/npm-cache-dsh
node build.mjs && node build-cm6.mjs && node build-cm6-layers.mjs
node bench-dom.mjs      # ~60s，需独占（其它 Chrome 会污染帧时间）
node bench-cm6.mjs
node bench-ui.mjs
node bench-build.mjs
npx vitest run
```

| 文件 | 内容 |
|---|---|
| `results/dom.json` | 5 变体 × (5 round × 1000 帧 sync + 600 帧 rAF)、XSS/省略号/行高检查 |
| `results/cm6.json` | CSP 探针、mount/输入/补全、textarea 基线、bundle eval 扫描 |
| `results/ui.json` | 菜单/对话框/分栏/工具条/树导航/AX/i18n + LOC |
| `results/build.json` / `build-all.json` | 多入口产物体积、watch 重建、vitest、tsc |
| `results/cm6-build.json` / `cm6-layers.json` | 单包体积、逐包增量、splitting 对比 |
| `fixtures/stack/` | MV3 bench 扩展（manifest/_locales/4 个页面/CSS/构建产物） |
| `src/` | 行模型、tokenizer、5 种 DOM 变体、推荐 renderer、CM6 入口、7 个 UI 部件、worker/SW |
| `test/` | 12 个 vitest 单测（行窗口/行模型/tokenizer） |
