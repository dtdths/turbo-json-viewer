# 技术方案重评估（2026-10-27）

> 目标：在进入 P-1 原型 / IR 设计之前，用**真实 Chrome 实测**把既有技术方案里最吃重的假设重新过一遍（运行时架构、IR/行模型、技术栈、保真/文本/导入/修复），把「确认 / 修正 / 推翻」写清楚，并给出可交接的 ADR 与下一步。
>
> 输入：wayfinder 地图 [#1](https://github.com/dtdths/turbo-json-viewer/issues/1)、调研 `docs/research/*.md`、真机数据 #15、P-1 spike 票 [#5](https://github.com/dtdths/turbo-json-viewer/issues/5)。
> 产出：本文件 + `docs/adr/0001–0005` + 三份分线报告 + 可复跑真机 harness（`prototype/p1/`）。
>
> **结论只写实测能支撑的部分**；数字全部来自 Chrome for Testing 156 / Apple M4 / 32GB，headless=new + CDP（品牌版 Chrome ≥137 忽略 `--load-extension`，详见 `prototype/p1/README.md`）。headless 与 headful 的差异、并发条件、未测项在各分报告与本文 §5 明说。

## 0. 一页结论

| 判定 | 决策 | 结论要点 |
|---|---|---|
| ✅ 确认 | **文档常驻 Worker + 主线程按视口取行窗口** | 50MB 首帧 **150ms**（静默复测；报告 163ms），10MB **52ms**；主线程堆 0.72MB、零长任务。 |
| ❌ 推翻（作为默认） | 整树 structured-clone 到主线程（B 方案） | 50MB 首帧 **321ms**、**132ms 主线程长任务**、页面堆 81.6MB、Worker 传输峰值 173.7MB。只适合 <10MB 的简化实现。 |
| ✅ 确认 | 行模型由展开集合派生、**不预建扁平节点表** | 展开 18.5 万项后窗口 p95 **0.1ms**、内存 **+0.73MB**；全量 flatten 全展开要 135.6ms/+106MB。 |
| 🔧 修正 | 行模型不能是「纯 skip-by-count」 | 需给**每个 open 容器建 Fenwick**（184k 行窗口 3.1ms → 0.1ms）；toggle 一次性 9.2ms。 |
| 🔧 修正 | 节点身份「解析期分配 id」 | 必须**懒分配**（全量 Map 167.5ms/28MB vs 懒分配 0.4ms/0.06MB）；标量没有对象身份，用 **(parent, slot)** 句柄；**不建全局 parentMap**（131.6MB）。 |
| 🆕 新增 | **多视图根 `rootId + rootVersion`** | 表达式结果/修复文档/搜索子集都是新根；filter 10.2 万行 5.8ms、建模型 4.5ms、首窗口 0.3ms。 |
| ❌ 推翻 | 「展开后不限制项数」的字面承诺 | 浏览器 scrollHeight 上限 **33,554,428px** → 24px 行高最多 **1,398,101 行**；50MB 全展开 2,958,550 行 = 超限 2.12×。改为 **1,000,000 行预算 + 滚动条封顶/映射 + 全展开护栏**。 |
| ✅ 确认 | 自研固定行高 DOM 行虚拟化 | 40 行/帧 0.03–0.09ms、零掉帧；推荐**行节点池 + textContent**（1000 帧 31.2ms vs innerHTML 86.2ms）；canvas 仍排除。 |
| ✅ 确认 | 原生 TS 无框架 + 手写 UI 部件 | 7 个部件 354 行 / 3.11KB gz；原生 `<dialog>`/`aria-activedescendant` 够用；不引 focus-trap/floating-ui/组件库。 |
| ✅ 确认（修正体积） | CodeMirror 6 仅表达式框 | MV3 CSP 下可用（mount 7.1ms、0 处 eval）；最小可用集 **99.4KB gz**（非「几十 KB」），含 JS 高亮 142.8KB。 |
| ✅ 确认 | esbuild 多入口 + vitest；Vite+CRXJS 不引 | 多入口构建 67ms、watch ~104ms、vitest 12 测试 511ms。 |
| ✅ 确认 | `JSON.parse` 为真相源；不做 raw-slice 显示层 | raw-slice 索引 88.9MiB + 237ms，且就是已移出的反向索引；`.mock/1.json` 真实失真 **2 处**（#7 记为 0）。 |
| 🔧 修正 | 失真检测「>15 位数字」 | 必须 **BigInt 二级精确判定**：该启发式在真实样本报 57、真实只有 2（96.5% 误报）；整数键规则收紧为「整数键后跟字符串键」不算失真。 |
| 🔧 修正（换架构） | 原始文本视图「源码行虚拟化」 | minified 50MB = **单行**，源码行虚拟化不可用；改为**检查点 pretty 行走器**：3.33M 行索引 19.5KiB、构建 116ms（Node）/297ms（Chrome）、窗口 p95 0.084ms；预生成 pretty 867ms/157MiB 否决。 |
| 🔧 修正 | 导入路径 | 50MB `file.text()` 产生 **50ms 主线程 long task**；改为 **arrayBuffer → transfer → Worker TextDecoder**（0 long task，到 paint 182.7ms）；stream 为后续优化。 |
| ✅ 确认（证据加强） | 文档文本永不进 DOM 文本节点 | 10MB 文本写入 DOM 后强制布局 **75,618ms**；paste 处理器读 `clipboardData` 0ms。 |
| ✅ 确认（规则化） | 保守截断闭合 + 修复标记/摘要 | 18 个截断 fixture：16/16 检测、16/16 修复后 parse 通过、0 处内容猜测、总 3.75ms。 |

**一句话**：主线（Worker 常驻文档 + 固定行高 DOM 行虚拟化 + 原生 TS + JSON.parse + acorn walker + esbuild）被实测支持；需要改的是**行模型索引细节、节点身份分配时机、展开护栏、原始文本视图算法、导入解码位置、失真判定规则**，以及新增**多视图根协议**。

---

## 1. 方法与证据

| 项 | 值 |
|---|---|
| Chrome | Chrome for Testing **156.0.8078.47**（品牌版 Chrome 156 忽略 `--load-extension`；CfT 下载在 `.spike/cft/`） |
| 启动 | `--headless=new --no-sandbox --disable-gpu --enable-precise-memory-info`，由 `prototype/p1/lib/chrome.mjs` 启动并通过 CDP 驱动 |
| 样本 | `.spike/samples/{2mb,10mb,50mb}.json`（50MB = 49,840,274 字符 / **2,958,550 节点** / 369,822 容器）、`.mock/1.json`（真实形态，879,330 字符） |
| 扩展 | 无 host 权限的 MV3 fixture；样本经 `prototype/p1/lib/http.mjs` 的 CORS 静态服务喂给页面/Worker（模拟“文本已在内存”，不含磁盘 I/O） |
| 口径 | 首帧 = fetch → Worker parse → 建模型 → 首窗口 → 提交 36–40 行 DOM → 双 rAF；交互 = 事件时刻 → 数据就绪并 commit；滚动 = rAF 脚本化滚动，掉帧 >25ms 计；内存 = CDP isolate 堆 + 强制 GC（页面与 Worker 分开） |
| 并发 | 分线报告测量时 loadavg 2.8–5.8（其他成员并行）；关键 A/B 数字已由 Lead 在**安静环境复测**（见 §2.1），两轮差异 <10% |

三份分线报告（本文件的证据附件）：

- [reassess-runtime.md](reassess-runtime.md) — 运行时架构 / IR / 行窗口协议 / 滚动上限 / 多根（411 行）
- [reassess-stack.md](reassess-stack.md) — DOM 行渲染 / CM6 / UI 部件 / 构建测试 / 体积预算（337 行）
- [reassess-fidelity.md](reassess-fidelity.md) — 保真 / 原始文本 / 导入 / 截断修复（438 行）

真机 harness 与可复跑脚本：`prototype/p1/`（`smoke.mjs` 冒烟、`bench/runtime`、`bench/stack`、`bench/fidelity`；样本与结果 JSON 落 `.spike/`，不提交）。

### 1.1 竞品基线（bejson，2026-10-27）

作为对照，用同一台机器/同一个 Chrome 自动化实测了项目负责人日常使用的 bejson JSON Viewer
（[`docs/research/bejson-baseline.md`](../research/bejson-baseline.md)，脚本 `prototype/p1/bench/bejson/`）：

| 样本 | bejson 首帧长任务 | bejson 搜索（`hotel`） | 本产品 P-1 对照 |
|---|---|---|---|
| `.mock/1.json`（45,805 节点 / 深 15） | 109ms | **44.0s**，DOM 峰值 **793,590** | — |
| 2MB（120,118 节点 / 深 5） | 245ms | **17.1s**，DOM 峰值 **1,456,786** | — |
| 10MB（595,030 节点） | **1164ms**，堆 150MB | 未跑（风险） | 首帧 **52ms**、主线程堆 0.72MB、DOM 36–40 行 |

根因是 ExtJS 2.2 的「全文 textarea + 全量树模型 + 无虚拟化 + 搜索时全树递归 expand/collapse」；
它正好是本文否决的 B 方案（整树物化）与 #10 要避免的「DOM 层搜索」的教科书反例。
值得注意：真实业务样本（0.84MB、深 15）搜索比 2MB 合成样本还慢 2.6×——**性能回归集必须包含 `.mock/1.json` 这种形态**。

---

## 2. 重评估后的架构

### 2.1 数据流（最终形态）

```
┌─ 页面（主线程，零文档）──────────────────────────────────────┐
│ 行虚拟化：固定行高 22–24px，视口 36–40 行 + overscan 8 行      │
│ 行渲染：行节点池 + textContent（v1 DOM；canvas 排除）          │
│ 滚动：totalRows 真实行号；超 cap 时 scrollTop↔行号缩放映射     │
│ 窗口状态：单飞 + 合并 + seq 丢弃 + rootId/rootVersion 校验     │
│ 视图：树 / 原始文本 / 表达式结果；选择/复制/高亮落在真实 DOM   │
└───────────────┬───────────────────────────────────────────────┘
                │ MessageChannel（窗口请求/回包，独立通道）
                │ postMessage（load / toggle / eval / search / copy / cancel）
┌───────────────▼───────────────────────────────────────────────┐
│ Worker（文档常驻）                                             │
│ JSON.parse 值图（真相源）+ 展开集合 + 源文本（按需）            │
│ 行模型：每个 open 容器 Fenwick（skip-by-count，无扁平表）       │
│ 多根：doc / expression / repaired / search（rootId+version）    │
│ 表达式：acorn + 白名单 walker（500ms 刹车）→ 新根               │
│ 搜索：全文档扫描 → 命中集合；复制：子树 stringify/路径/原值/键名 │
│ 保真：BigInt 精确失真扫描；原始文本：检查点 pretty 行走器        │
└───────────────────────────────────────────────────────────────┘
```

### 2.2 架构 A vs B（静默复测，50MB）

| 指标 | A（Worker 常驻 + 行窗口） | B（整树 clone 到主线程） |
|---|---|---|
| 首帧 中位 / p95 | **150.2 / 166.3ms** | 320.7 / 330.4ms |
| Worker parse | 70.9ms | 70.2ms |
| 主线程长任务 | **0** | **1 × 132ms** |
| 页面堆（首帧后） | **0.72MB** | 81.6MB |
| Worker 传输峰值 | —（无整树传输） | 173.7MB |
| 平滑滚动空白行率（ov2 / ov8） | 11.1% / **0%** | 0% |
| 随机跳转空白 | 1 帧（≈17ms） | 0 帧（同步） |

结论：**A 为默认架构**；B 仅可作为 <10MB 的简化实现或极端低端机的备选。H（A + 主线程 2–3 屏缓存）作为低端机降级预案，不作为架构。

### 2.3 行模型 / 身份 / 协议（要点）

- **行模型**：`JSON.parse` 值图 + `Set<容器>` 展开集合；每个 open 容器一份 Fenwick（子项前缀和），窗口按「下潜 O(depth·log n)」取行；`totalRows` O(1)。184,913 行窗口 p95 **0.1ms**；展开 items 一次性 9.2ms；内存 +0.73MB。**不建扁平行表**（全展开 135.6ms/+106MB）。
- **节点身份**：运行期懒分配整数 id（只给被展开/选中/锚点/命中触达的容器）；标量用 `(parent 容器, slot)`；路径字符串用于持久化；**不建全局 parentMap**（131.6MB）。id 查找 10ns vs 路径解析 ~0.5µs（50×）→ 双格式必要。
- **协议**：窗口请求 `{rootId, rootVersion, seq, start, count}`，回包 `Row[]`（40 行 ≈3.1KB）；窗口计算 p95 0.1ms，端到端含 rAF 约 2ms；`seq` 丢弃迟到回包，`rootVersion` 不匹配回 `STALE_ROOT`；overscan **8 行** + 方向 1 屏预取；MessageChannel 与 postMessage 往返无性能差异（11µs），用 MessageChannel 是为了隔离窗口请求与控制命令。
- **多视图根**：表达式结果（引用原节点、上限 20 万）、修复后文档、搜索子集均为独立根；行号是根内坐标，id 不必全局唯一。

### 2.4 滚动条上限与「全部展开」护栏（新增硬约束）

- Chrome `scrollHeight` 上限 **33,554,428px**；24px → **1,398,101 行**，22px → 1,525,201 行。
- 50MB 全展开 2,958,550 行 × 24px = 71,005,200px = 上限 2.12× → **物理不可行**。
- 方案：`contentPx = min(totalRows*rowH, cap)` + `scrollTop↔行号`缩放映射（实测 8 个采样点往返误差 0 行）；**可见行软预算 1,000,000 行**；到预算拒绝继续「全部展开」，提示「仅展开前 10 万项 / 先在表达式里过滤」；正常默认折叠路径只有几行，不会触发。

---

## 3. 逐项决策与对旧方案的差异

### 3.1 运行时 / IR

| 决策 | 旧 | 新 | 影响票 |
|---|---|---|---|
| 文档位置 | Worker 常驻 | ✅ 维持 | #5/#13 |
| 主线程行数据 | 行窗口 | ✅ 维持；窗口 40 行 + overscan 8 + 方向预取 | #5/#13 |
| 行模型 | 展开集合派生 | 🔧 维持「不预建扁平表」，但**必须加 per-open Fenwick**；纯 DFS 最坏 78.9ms/窗口不可接受 | #7/#13 |
| node id | 解析期分配、路径+id 双格式 | 🔧 双格式维持；id **懒分配**、标量用 (parent,slot)、不建 parentMap | #7 |
| 多视图根 | 未定义 | 🆕 `rootId + rootVersion`；expression/repaired/search 根 | #7/#10/#12 |
| 展开上限 | 「不限项数」 | ❌ 改为 1,000,000 行预算 + 滚动条映射 + 护栏 | #9/#5 |
| 首帧验收 | 10MB <800ms | ✅ 实测 10MB 52ms / 50MB 150ms（headless；headful 待复核） | #5 |

### 3.2 技术栈 / UI / 构建

| 决策 | 旧 | 新 | 影响票 |
|---|---|---|---|
| 框架 | 原生 TS 无框架 | ✅ 维持；7 个 UI 部件手写 3.11KB gz | #13 |
| 行渲染 | DOM 行虚拟化 | ✅ 维持；推荐行节点池 + textContent（31.2ms/1000 帧） | #13 |
| CM6 | 仅表达式框 | ✅ 维持可用；🔧 体积按 **99.4KB gz（最小集）/ 142.8KB（含 lang）** 计；`lang-javascript` +45KB 作为产品取舍 | #12 |
| 其他库 | 待定 | ✅ 不引 focus-trap / floating-ui / 组件库；原生 `<dialog>`、`aria-activedescendant` 通过实测 | #13 |
| 构建 | esbuild + vitest | ✅ 维持；多入口 67ms、watch 104ms、vitest 511ms；Vite+CRXJS 不引 | #13 |
| 首屏预算 | 未定 | 🆕 不含 CM6 ≈37KB gz（acorn 实测 33.7 + 自有 3.3）；含 CM6 最小集 ≈138KB gz | #13 |

### 3.3 保真 / 原始文本 / 导入 / 修复

| 决策 | 旧 | 新 | 影响票 |
|---|---|---|---|
| 真相源 | JSON.parse | ✅ 维持 | #7 |
| 失真检测 | >15 位数字 / 整数键混排启发式 | 🔧 **候选 → BigInt 精确判定**（真实样本 57 报 → 2 真，96.5% 误报）；整数键规则收紧；`1e400`/下溢单独查 | #7/#11 |
| 失真提示 | 顶部提示 + 切原始文本 | ✅ 维持；不做 raw-slice（88.9MiB/237ms） | #7/#11 |
| 原始文本视图 | 自研行虚拟化 + tokenizer | 🔧 改为**检查点 pretty 行走器**；`maxLineLength>4096` 走 pretty 布局，否则源码行虚拟化；索引 19.5KiB、窗口 0.084ms | #11 |
| 文本保留 | 未定 | 🆕 源文本需常驻 Worker 才能即时切原始视图（50MB 文本 ≈95MB）；内存策略（保留/丢弃重读）**待 #7/#11 定案** | #7/#11 |
| 导入 | file.text()/paste | 🔧 **arrayBuffer + transfer + Worker TextDecoder**（0 long task）；paste/preventDefault 维持；stream 为后续 | #11 |
| 截断修复 | 保守闭合 + 摘要 | ✅ 维持；已规则化（EOF 规则 1–6、`doc.repair` provenance、导出后缀） | #8/#11 |

---

## 4. 更新后的验收线与预算

| 项 | 建议值（实测依据） |
|---|---|
| 10MB 导入→首帧 | **<800ms**（实测 A：52ms；含真实粘贴文本移交会更慢，待 headful 复核） |
| 50MB 压力 | <800ms（实测 A：150ms）；内存 ≈73MB（树）+ 文本（若常驻 ≈95MB） |
| 交互 | 主线程无 >50ms 长任务；窗口请求端到端 p95 ≈2ms；行渲染 0.1–0.2ms/帧；展开 18.5 万项 workMs 9.2ms |
| 滚动 | 平滑滚动空白行率 0（overscan 8）；随机跳转 1 帧空白可接受；掉帧 0（headless 待 headful 复核） |
| 展开护栏 | 可见行软预算 1,000,000；硬上限 1,398,101 @24px；超预算拒绝全展开并提示 |
| 首屏 JS | 37KB gz（不含 CM6）/ ≈138KB gz（CM6 最小集）/ ≈182KB（含 JS 高亮） |
| 内存 | 文档节点 50MB ≈73MB Worker 堆；文本 ≈95MB（若保留）；无主线程文档副本 |

---

## 5. 仍未定 / 风险 / 下一步

### 5.1 必须在 headful 复核（P-1 验收）

1. A + overscan 8 的**平滑滚动空白率/滚动锚定**（headless 的 rAF 与合成器行为不同）。
2. B 的 132ms 主线程长任务是否仍在（预期在；它是反序列化成本）。
3. **真实导入路径**：文本经 postMessage 从主线程交给 Worker 的耗时/峰值（本 spike 在 Worker 内 fetch，未含字符串跨线程拷贝）。
4. DPR 2 / 浏览器缩放 125%–150% 下 22–24px 行高与布局成本。

### 5.2 设计阶段待定

- **源文本内存策略**（保留 → +95MB/50MB；丢弃 → 切原始视图需重读文件，粘贴来源无法重读）——#7/#11 定。
- **表达式结果根生命周期**（LRU/释放；连续求值保留旧根以便对比）。
- **搜索子集根**与搜索命中集合的内存上限、渐进式返回。
- **复制子树**：大子树 stringify 的预算/分片（本 spike 只测单条 0.004ms）。
- **重复键检测**在 50MB 的成本（本 spike 未测）。
- **CM6 `lang-javascript`（+45KB gz）** 是否进入 v1（产品取舍）。
- **真实磁盘 I/O** / 真实剪贴板 / Windows 高对比度 / 屏幕阅读器 / 移动端。
- **滚动条缩放映射的 UX**（1px 对应多行时的拖动精度）与预算提示文案。

### 5.3 下一代 wayfinder 图上的动作

- [#5](https://github.com/dtdths/turbo-json-viewer/issues/5) P-1 spike：本文件 + 三份报告 + ADR 已覆盖其必测项 → **可关闭**（headful 复核另立任务）。
- [#7](https://github.com/dtdths/turbo-json-viewer/issues/7) IR：按 ADR-0002 落地 IR/行模型/多根协议；剩源文本内存策略。
- [#9](https://github.com/dtdths/turbo-json-viewer/issues/9)：按 §2.4 定「全部展开」护栏与滚动条映射的交互语义。
- [#11](https://github.com/dtdths/turbo-json-viewer/issues/11)：按 ADR-0003/0004 改原始视图与导入路径；补源文本内存策略。
- [#12](https://github.com/dtdths/turbo-json-viewer/issues/12)：按 §3.2 定 CM6 包集合与体积预算；表达式结果根接 ADR-0001/0002。
- [#13](https://github.com/dtdths/turbo-json-viewer/issues/13)：阻塞项 #5 关闭后只剩 #7；按 ADR-0005 落模块 seam（页面/worker/协议/渲染分层）。
- [#8](https://github.com/dtdths/turbo-json-viewer/issues/8)：修复规则已可落地（ADR-0004 附录）。
- [#10](https://github.com/dtdths/turbo-json-viewer/issues/10)：搜索数据路径按多根协议接；全量 walk 43–75ms 量级已测。
- [#6](https://github.com/dtdths/turbo-json-viewer/issues/6) 视觉：不受本次技术重评估影响（行高 22–24px、双主题待定）。

---

## 6. 交付物 / 复跑

| 产物 | 路径 |
|---|---|
| 本重评估 | `docs/design/tech-reassessment.md` |
| 分线报告 | `docs/design/reassess-{runtime,stack,fidelity}.md` |
| ADR | `docs/adr/0001-worker-resident-doc-and-row-window.md` … `0005-tech-stack-and-build.md` |
| 真机 harness | `prototype/p1/lib/{chrome,http}.mjs`、`prototype/p1/smoke.mjs`、`prototype/p1/README.md` |
| 可复跑基准 | `prototype/p1/bench/runtime/bench-runtime.mjs`、`bench/stack/`（npm scripts）、`bench/fidelity/run-*.mjs` |
| 样本/结果 | `.spike/samples/*`、`.spike/runtime-bench/*`（gitignored） |

```bash
# 冒烟
node prototype/p1/smoke.mjs
# 运行时（约 2–4 min）
node prototype/p1/bench/runtime/bench-runtime.mjs all
# 保真/文本（Node，零依赖）
node prototype/p1/bench/fidelity/run-node.mjs
node prototype/p1/bench/fidelity/run-repair.mjs
# 栈/DOM/CM6（需 npm install，见 bench/stack/README）
cd prototype/p1/bench/stack && npm run build && npm run bench:dom && npm run bench:cm6
```
