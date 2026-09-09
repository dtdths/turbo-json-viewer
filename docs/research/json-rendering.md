# 大 JSON 渲染性能方案调研（issue #2）

> 调研 ticket：[#2 调研：大 JSON 渲染性能方案与既有实现](https://github.com/dtdths/turbo-json-viewer/issues/2)（`wayfinder:research`，map [#1](https://github.com/dtdths/turbo-json-viewer/issues/1) 的子项）
> 分支：`research/json-rendering` ｜ 交付对象：P-1「渲染引擎选型与性能基线 spike」
> 状态：**完成**（结论就绪，待 spike 验证量级）
>
> **标注约定**：内联的 markdown 链接 = 调研核对过的出处（名称见文末「参考资料」）；`（分析）` = 本文推理/估计，**非既有文献结论**。调研环境无法直接 fetch 网页（沙箱 DNS 限制），链接均由 web_search 定位到权威页面（官方文档/规范/仓库），引用其内容已尽量保守；`react-json-view` 一类的事实性描述来自可公开核对的仓库与 issue。

## 0. 结论摘要（TL;DR）

- **推荐方向：Web Worker 内解析 → 把树拍平成「可见行列表 + 序列化折叠集合」的纯数据模型 → DOM 行虚拟化渲染（首选 @tanstack/react-virtual 这类 headless 虚拟化原语，或 react-arborist 这类现成虚拟树组件）→ 文本选择/复制/搜索高亮全部落在真实 DOM 文本上。** v1 不引入 canvas 文本绘制（见 §3）。
- 大数组展开/长列表滚动 60fps 的关键不是「更大的 overscan」，而是**只挂载视口行 + 少量 overscan**（树视口通常 20–80 行 → 挂载 DOM 最多几百行/几千节点），任何时刻都远低于「DOM 过大」阈值（Lighthouse 建议 <~1500 节点、>1 万挂载节点开始劣化 布局/绘制/GC）。
- 10MB 首帧 <800ms 的前提是**解析不进主线程**（Worker），并控制跨线程移交的成本（structured clone 二次分配）；JSON.parse 本身在桌面约 100–400MB/s（分析估计，见 §2.6），10MB 文本解析 ~0.03–0.1s，构不成主要矛盾，瓶颈在解析后的**模型构建 + 首屏行数渲染调度**与移交拷贝。
- 既有查看器的卡死根因高度趋同：**递归全树渲染/全量子节点挂载 + 无记忆化 + 在展开交互时整树重渲**；深层级再叠加递归栈/同步全遍历问题（详见 §5）。
- 测量口径：`粘贴→首帧` = parse mark → 首屏可见行 commit → 双 rAF 后取 `performance.now()`；交互延迟 = 事件 mark → 双 rAF；滚动流畅度 = 脚本化滚动下 rAF 帧间隔 >~25ms（>1.5×16.7ms）计为掉帧，报掉帧率；长任务 ≥50ms 计数（W3C Long Tasks）。协议见 §6。

## 1. 背景与硬约束

领域术语沿用 `CONTEXT.md`（节点 / 展开状态 / 容器预览 / 复制 / 搜索 / 表达式 / 查看现场）。

| 约束/验收线 | 出处 | 对渲染方案的含义 |
|---|---|---|
| 10MB 文本粘贴 → 首帧 <800ms，解析在 Worker、UI 不冻结 | map #1「验收线」 | 主线程只做渲染；解析/建模型在 Worker；跨线程移交成本必须受控（§2.6） |
| 展开/滚动 60fps | map #1 | 每次展开/滚动主线程工作必须在个位数 ms；帧预算 16.7ms（§6） |
| 折叠状态外部化（可序列化、可记忆/重置） | CONTEXT「展开状态/查看现场」 | 展开/折叠集合与滚动位置是**视图数据**，独立于 DOM；虚拟化渲染天然把「行=数据」与「DOM=瞬时呈现」分开（§4.6） |
| 文本选择 / 复制 / 搜索高亮在渲染结果上可用 | issue #2 | 强约束：**排除了纯 canvas 文本绘制**（canvas 无浏览器级文本选择/查找，见 §2.3） |
| 输入 = 粘贴 + 本地文件/拖拽；v1 纯只读；数据不出本机 | map #1「已确认约束」 | 无网络数据通道；渲染纯本地，无远端 chunk 流式加载这一选项 |
| MV3（CSP 禁 eval/远程代码） | map #1 | 渲染选型不受影响；表达式过滤/求值需白名单解释器（另一 ticket 范畴），但**禁 `Function`/`eval` 类捷径**适用于所有动态代码路径 |
| 表达式过滤与搜索需在**结果**上可用 | issue #2 | 过滤=生成子文档/结果集后，结果本身仍是可虚拟化渲染的树；搜索命中定位需「展开祖先 + 跳到行」（§4.5） |
| 容器预览（超大容器默认只采样前 N 项，不改变展开状态） | CONTEXT | 「预览」与「展开」语义分离：预览 = 惰性渲染可见 N 项；真正全展开的超大数组才走虚拟化/分批（§4.2） |

样本：`.mock/1.json`（952KB，对象宽/深、含多数组字段）为典型形态；压力上界 ~50MB（map #1）。

## 2. 方案空间与可行上限

### 2.1 基线（必挂）：全量 DOM 树渲染

把整棵展开树递归渲染为嵌套 DOM、每次展开/折叠触发整树重渲。`react-json-view` 一类既有实现即此模式（§5）。上限：几千节点 DOM 后布局/样式计算开始劣化（[web.dev Lighthouse DOM size](https://web.dev/articles/lighthouse-dom-size) 建议 <~1500 节点；>1 万挂载节点影响内存/布局/绘制）；每次交互重渲整树，深层 + 宽层同时放大 render 与 layout 成本。**10–50MB 文档在此模式下无解**，只作对照基线。

### 2.2 DOM 行虚拟化：自研 vs 用库

**机制本质**：窗口化作用于「逻辑行列表」——折叠子树 = 1 行，展开 = 多行；渲染层只挂载视口内行 + 少量 overscan（树视口通常 20–80 可见行 → 挂载行只有几百个，每帧布局/样式计算毫秒级即可完成）。展开/折叠只是往行数组里插入/删除行并重设 `count`，这是扁平虚拟化器的原生能力，**所有列出的列表库都没有树概念，树语义由你这一层提供**（[react-window README](https://github.com/bvaughn/react-window)；[@tanstack/react-virtual API](https://tanstack.com/virtual/latest/docs/api/virtualizer.md)）。

库位对比（事实来自各库官方 README/文档）：

| 库 | 特性 | 上限与注意 |
|---|---|---|
| react-window | FixedSizeList/VariableSizeList/Grid；无树、无自动测高、无 sticky | 数千~1 万行可用；动态高度需自维护尺寸表并手动 `resetAfterIndex` 失效缓存；无树语义（社区补丁 react-window-tree 等） |
| @tanstack/react-virtual | **headless**（不带组件）；ResizeObserver `measureElement` 自动测高；双轴；scrollToIndex；容器或 window 滚动 | 视口有界即可上百万项；**树形/展开状态完全由外部模型持有** —— 与本项目「状态外部化」诉求最贴合 |
| react-virtuoso | 可变高度；内置 sticky（`topItemCount`）；totalCount/无限 | 10 万+项可用；列表语义较固化 |
| react-arborist | 虚拟化**树**组件：自带 open/close 与缩进、动态行高、搜索 | 大型树（可见行虚拟化）；数据模型/UI 较有主见 |
| rc-virtual-list | 极简容器滚动列表 | ~1 万量级；无 sticky/window/树 |
| ag-grid | 行+列 DOM 虚拟化（DOM 回收 + buffer），支持 tree-data | 10 万+行验证充分；但表格 DNA、体积/许可重 |

自研 ≈ 200 行核心（偏移数组 + 绝对定位行 + rAF 滚动监听），好处是行高语义/缩进/粘性完全自控，坏处是测高、sticky、边界 case 都要自己做（分析）。**建议：不重复造轮子，用 headless 虚拟化原语自组装树层**（§3 与 §7）。

**规模上限的数学**：60fps 不是 JS 算不过来，而是挂载行数 → 布局/样式重算与 GC 抖动。保持挂载集 = 视口 + overscan（几百行）即安全；虚拟化器自身处理 1M+ 逻辑项无压力（[tanstack 文档](https://tanstack.com/virtual/latest/docs/guides/measuring-dynamic-virtual-items)、[ag-grid DOM 虚拟化文档](https://www.ag-grid.com/javascript-data-grid/dom-virtualisation/) 各自给出大行数证据）。

### 2.3 Canvas 文本绘制

**可行上限参考**：glide-data-grid 把行列画到 `<canvas>`、自带渲染/调度循环，官方以「近百万单元格 60fps」作卖点（README 口径，非独立测量）（[README](https://app.unpkg.com/@glideapps/glide-data-grid@6.0.3/files/README.md)、[Glide 工程博客](https://www.glideapps.com/blog/glide-data-grid-typescript)）。AG Grid **不是** canvas——官方文档描述的是 DOM 回收虚拟化（[官方文档](https://www.ag-grid.com/javascript-data-grid/dom-virtualisation/)）。

**对本项目的代价（决定性）**：
- 文本**不可被浏览器选中/复制**，find-in-page 与扩展自身的搜索高亮都看不见 canvas 内容 → 必须自建选择模型、命中测试、剪贴板层（ClipboardEvent + plaintext/html，必要时 execCommand 回退），并**自己绘制**搜索高亮；
- DPR 非整数与缩放会产生模糊：canvas 是位图，缩放即重栅格化，需 DPR-aware 缩放与文本重排；
- 无障碍/键盘导航全程手写（aria gridcell 结构或离屏 DOM 回退）；
- 长文本折行/富文本行需要自写文本布局 + 缓存 `measureText`。

canvas 只有在「每帧 DOM 单元格成本顶不住」的极端密度下才赢；本项目 v1 有选择/复制/搜索高亮的硬需求，**直接否决纯 canvas**（分析 + 上述事实）。见 §2.5 的混合方案与 §3 的否决理由。

### 2.4 CSS 捷径：content-visibility:auto + contain-intrinsic-size

浏览器可跳过屏外元素的布局/绘制（[web.dev content-visibility](https://web.dev/articles/content-visibility)）。注意点：
- 需要正确的 `contain-intrinsic-size` 估计，否则滚动条跳动/滚动高度坍缩（有真实修复案例：先 1px 后落到 400px 的 fallback（[hermes-webui PR #5639](https://github.com/nesquena/hermes-webui/pull/5639)））；
- **它不是虚拟化**：DOM 节点仍然全部存在并需构建，只省 layout/paint；几千行的中等列表可救，10–50MB 不可（分析）。

### 2.5 混合方案

- 「折叠行为 DOM 行 + 单个超大展开数组落 canvas / 惰性 DOM chunk」可行，但**渲染路径与选择模型双份**，维护与一致性成本高；只在「某一病理区域真的撑爆 DOM 预算」时值得（分析）。
- 更省的混合：**全部 DOM 虚拟化为主**，对真正巨大的展开数组用「分批惰性挂载 chunk（滚动到才建 N 行）」或叠加 `content-visibility`；语义上对齐 CONTEXT 的「容器预览」（预览不改变展开状态）。
- 折叠状态本身永远外部化（数据层），与渲染技术无关——这是两种混合的共同基座（§4.6）。

### 2.6 量级预期：解析与内存（规划区间，非测量）

- V8 `JSON.parse` 桌面吞吐常见量级 ~100–400 MB/s（对照 simdjson 的对比与 json-ext 基准（[simdjson](https://www.npmjs.com/package/simdjson)、[json-ext benchmarks](https://raw.githubusercontent.com/discoveryjs/json-ext/HEAD/benchmarks/README.md)）**（分析：量级区间推断）** → 10MB ~0.03–0.1s、50MB ~0.1–0.5s，纯 parse 不构成 800ms 瓶颈；
- 内存：源字符串已是 UTF-16（~2B/字符）；parse 期间瞬时堆 = 完整对象图 + 扫描缓冲，峰值堆常为数倍于字符串大小；[Chromium 曾有「让 JSON.parse 少用内存」的改动](https://codereview.chromium.org/7241023/) 与 [RN 侧 parse 堆尖峰实测](https://hackernoon.com/lite/the-hidden-js-heap-cost-of-jsonparse-in-react-native) 佐证 parse 期分配显著 **（分析：5–10× 字符串大小峰值堆、50MB 紧凑文档约 0.5–2M JS 对象为推断区间，需 spike 实测）**；
- `JSON.parse` 无增量 API：若要懒物化可见子树需自研流式解析（jsonparse/clarinet 一系）或在 Worker 内做两遍；跨 Worker 移交解析树走 structured clone = **又一次整树分配**，须计入首帧预算（分析）。

### 2.7 总对比表

| 方案 | 原生支持 | 可持续规模 | 关键代价/坑 | 结论 |
|---|---|---|---|---|
| 全量 DOM 递归渲染 | 树天然 | 千级节点 | 每次交互整树重渲；10–50MB 必死 | 排除（基线） |
| 自研扁平虚拟化 | 定/变高行、缩进=padding | 10 万+行 | 测高/sticky/rAF 自持 | 可用，~200 行核心 |
| react-window | 列表/网格；无树/无测高/sticky | 数千–1 万+ | 变高抖动、尺寸表自管 | 可选 |
| @tanstack/react-virtual | headless 虚拟化原语 | 视口有界 1M+ 项 | 组件全自组 | **首选** |
| react-virtuoso | 变高+sticky+totalCount | 10 万+ | 列表语义固化 | 可用 |
| react-arborist | 虚拟树组件 | 大型树 | 数据模型/UI 有主见 | 备选（组件级） |
| ag-grid | 行+列 DOM 虚拟化/tree-data | 10 万+ 行验证充分 | 表格 DNA/许可/体积 | 过重 |
| Canvas 文本绘制（glide 类） | 近百万单元格 60fps 宣称 | 百万级单元格 | 无原生选择/复制/查找/高亮；DPR 模糊；a11y 手写 | **v1 排除** |
| content-visibility + contain-intrinsic-size | 纯 CSS 跳屏外布局/绘制 | 数千行 DOM 量级 | 非虚拟化；intrinsic-size 估错跳滚动条 | 仅作补充 |
| 混合（DOM 折叠行 + canvas/chunk 大数组区） | 大数组区域 | 极大数组 | 双渲染路径/双选择模型 | 仅病理区域、且有 DOM 预算依据时 |

## 3. 推荐方向

**主推（v1）**：

1. **解析与模型构建在 Web Worker**：parse + 一次后序遍历建节点索引/子树统计；主线程只消费不可变文档模型（§4.1/4.2 的「子树行数预算」在此一趟算出）。移交成本与 Worker 内两遍解析的取舍由 spike 实测（§2.6）。
2. **渲染 = 扁平可见行列表上的 DOM 虚拟化**：折叠集合 + 滚动位置为外部可序列化状态（`Set<path>` / 路径前缀集合 + scroll 锚点），行组件 keyed by 节点路径；用 headless 虚拟化原语（@tanstack/react-virtual：自动测高 + scrollToIndex + overscan）自组树层，或评估现成虚拟树组件 react-arborist（§2.2 对比）。
3. **文本选择/复制/搜索高亮全在真实 DOM 文本上**（浏览器原生能力），搜索命中高亮由命中节点路径派生，随行回收而重建（§4.5）。
4. 大数组展开采用虚拟化兜底 + 可选 chunk 惰性挂载；预览语义（前 N 项）按 CONTEXT 保持与展开分离。

**否决纯 canvas 的理由（v1）**：验收线要求「文本选择/复制/搜索高亮可用」——canvas 无浏览器级文本层，等于自研选择、剪贴板、命中测试、高亮绘制与无障碍层，v1 复杂度爆炸；且本场景是「树」而非「百万单元格表格」，DOM 虚拟化已能把挂载成本压到每帧预算内。**当且仅当**将来出现「单区域需要几十万单元格同屏」时才重开评估（分析，基于 §2.3 事实）。

**Spike 必须验证的假设/风险（喂给 P-1）**：
- 10MB 首帧 800ms 预算下，Worker parse + structured clone 移交 vs 懒解析两遍路线的实测分配曲线；
- 折叠/展开一个含 10 万+ 子项节点的**增量重拍平 + 行高度缓存失效**成本（§4.2/4.4）；
- 展开节点导致视口上方行数变化时的滚动锚定实现（§4.3）；
- 「展开祖先→跳到命中行」在最坏（命中深藏于折叠巨树）时的交互延迟（§4.5）。

## 4. 行级虚拟树机制细节（实现笔记）

### 4.1 可见行模型与「行号 → 节点」映射
窗口化对象是「逻辑可见行列表」（折叠=1 行，展开=多行）。三种映射（分析）：
- **(a) flatten-on-change**：每次 toggle 重建可见行数组，直接索引（O(1) 查行、O(可见行数) 重建）；配合虚拟化器（tanstack 风格：`count` + index→item，toggle 后以新 count 重渲（[tanstack 动态尺寸指南](https://tanstack.com/virtual/latest/docs/guides/measuring-dynamic-virtual-items)））；
- **(b) 节点→[起始行, span] 映射 + 累计偏移数组**：二分查行→节点；
- **(c) skip-by-count 遍历**：DFS 中折叠节点贡献 1+其预算数，无需行数组，O(深度+兄弟数) 查行。

react-arborist 即「只渲染可见节点」的现成虚拟树（[README](https://github.com/jameskerr/react-arborist)、[v4 重写 PR #235](https://github.com/jameskerr/react-arborist/pull/235)、[变高讨论 #276](https://github.com/jameskerr/react-arborist/issues/276)）。深度实为「任意深」：只要行模型不递归渲染 DOM，深层级只是逻辑遍历深度问题，与 DOM 层数无关（分析）。

### 4.2 子树行数预算、占位行与 FOUC
- **子树行数预算**：解析后一趟后序遍历即可得每节点后代数 → 折叠节点的「完全展开行数」O(1) 可得；**精确的部分展开总数**需只对 open 子节点求和——前缀数组会随每次 toggle 失效，库通常干脆重拍平（分析）。预算用于：滚动条总量估算、「展开 N 项容器预览」、以及折叠行上「共 M 项」标注（对齐 CONTEXT 容器预览）。
- **展开超大节点的占位与 FOUC**：先按预算/`contain-intrinsic-size` 高度挂**骨架行**，等真实行 `measureElement` 后替换，避免滚动条/锚点跳动；防 FOUC 的原则：高度缓存优先、行 keyed by path、临时内容高度不得与最终缓存估计背离（[DEV：Virtualizing Huge JSON Files in React——同样的 estimate-then-measure 流程](https://dev.to/utku_akyuz/virtualizing-huge-json-files-in-react-the-technical-breakdown-3ef4)）。

### 4.3 滚动锚定（折叠祖先上方行数变化）
- CSS `overflow-anchor:auto`（默认）会钉住锚节点并在其上内容变化时调滚动（[MDN overflow-anchor](https://developer.mozilla.org/en-US/docs/Web/CSS/overflow-anchor)、[css-scroll-anchoring-1](https://www.w3.org/TR/css-scroll-anchoring-1/)），局限：每滚动容器一个锚、用户滚动中被抑制、旧 Safari 不支持、且——对虚拟化是决定性的（分析）——视口上方的行**已卸载**，锚节点消失后浏览器回退到裸 scrollTop 像素 → 漂移。显式锚定仍是规范开放话题（[csswg 讨论](https://lists.w3.org/Archives/Public/public-css-archive/2022Dec/0228.html)）。
- 因此**自实现 JS 锚定**：记住首个可见行的**节点路径 + 行内像素偏移**；展开/折叠后按 4.1 的映射重算该行新偏移并 `scrollTop` 直设，paint 前批量（microtask/rAF），夹到合法区间（分析，基于上述事实）。

### 4.4 行缓存、回收与 overscan
- 行高测量一次（ResizeObserver `measureElement`）后按**节点路径 + 深度**缓存，有缓存跳过重测（[TanStack/virtual PR #1183](https://github.com/TanStack/virtual/pull/1183)）。
- **行 key 必须用稳定节点路径而非数组下标**：回收实例只重绑同子树；否则内部行状态（展开箭头动画、临时 UI）会跨节点泄漏（分析）。
- overscan = 视口外多渲染几行（按速度放大），吞掉快速甩动与异步测高修正期的空白闪烁。
- react-window 的 `VariableSizeList` 需手动缓存失效且无树语义；社区补丁有 [react-window-tree](https://packages.ecosyste.ms/registries/npmjs.org/keywords/react-window-tree)、[react-tree-virtual](https://www.npmjs.com/package/react-tree-virtual)（npm）。

### 4.5 搜索命中：展开祖先 + 跳行
- 命中索引建在**逻辑（全展开）空间**上、每命中带节点路径；「跳到命中」= 自底向上展开全部折叠祖先 → 等拍平 settle → `scrollToIndex(rowOf(hit))`。**先滚动到折叠祖先内部的行 = 陈旧索引或空行**（antd 虚拟树搜索踩坑实例（[juejin 中文](https://juejin.cn/post/7651954728703672326)）；react-arborist 提供 node 级 open 与滚动 API（[README](https://github.com/jameskerr/react-arborist)））。
- 高亮**从命中路径派生**，随行回收重渲时自动正确（分析）。
- 与表达式过滤的关系：过滤产出结果集/子文档后，搜索命中定位走同一套「展开祖先 + 跳行」，结果视图本身仍是可虚拟化渲染的树（分析）。

### 4.6 折叠状态外部化（与渲染技术正交）
- 展开状态 = `Set<路径>`（或路径前缀压缩）+ 滚动锚点（§4.3）即「查看现场」（CONTEXT 术语），可序列化（storage 配额内持久化、或跨视图复用）。
- 「行是数据、DOM 是瞬时呈现」的虚拟化架构**天然**满足外部化：toggle 只改外部集合与行数组，不触碰文档数据（CONTEXT：视图只消费文档模型与视图状态）。此分层同时是「渲染/逻辑分层」seam（map #1 要求）——渲染深度调优无需动逻辑。

## 5. 既有 JSON 查看器卡死根因对照

> 注：本节在**时间盒内**完成（§5 专用子调研未能在期限内归位，主代理以受限检索补足）。机制细节为公开仓库/issue 可核对的事实 + 明确标注的（分析）推断；个别 viewer（jsoncrack、jsonhero）的大文件定量证据本环境未能深挖，列为「待补证」。结论方向不影响 §3 主推荐。

**共性失败模式**（对照 §2.1 基线）：
- **递归全树组件渲染**：把整棵展开树递归渲染成 React/组件树，全量子节点在展开瞬间进 DOM；无渲染层虚拟化 → 大数组展开 = 一次挂载海量 DOM 节点 + 布局重算，主线程长时间阻塞；
- **交互即整树重渲**：展开/折叠触发整树或大子树重新 render（无 memo / 无行级隔离），深度与宽度同时放大成本；
- **深层级**：递归组件 + 同步遍历在深嵌套（如万级深度）下逼近 JS 调用栈或同步遍历预算（分析）；
- 反例（值得借鉴）：DevTools 控制台的**对象懒加载预览**——只按需取当前可见属性，而非物化整个子树（分析：DevTools 前端按需展开的对象预览是业界通行做法）。

**逐个对照**：

| Viewer | 渲染机制（证据/推断） | 大数组/深层级瓶颈 | 证据链接 |
|---|---|---|---|
| react-json-view（mac-s-g） | React 递归组件渲染整棵展开树；对象/数组按展开状态逐层递归 | 大对象场景明确被报慢、请求优化/虚拟化（官方 issue）；深层级递归渲染有栈/同步遍历风险（分析） | [issue #235: Optimization for very large json objects](https://github.com/mac-s-g/react-json-view/issues/235) |
| @textea/json-viewer | react-json-view 的维护分支；引入 JSON 索引/路径机制（path/index 结构） | 索引/路径机制在大文档下有自身 bug 面（issue #419 的 PATH/index 报错即其例）；本体仍为递归树渲染（分析） | [issue #419: JSON Indexing issue leads to PATH error](https://github.com/TexteaInc/json-viewer/issues/419) |
| react-json-view-lite | 轻量重构：宣称轻依赖、更快渲染（README 口径） | 渲染机制与大文档上限未见系统测量；递归树模型基本盘未变（分析） | [README（unpkg）](https://app.unpkg.com/react-json-view-lite@2.4.1/files/README.md#1) |
| jsonhero（triggerdotdev/jsonhero-web） | 把 JSON 推断成对象模型再渲染为可浏览/搜索 UI（README：「browse, search and navigate at speed」） | 大文件走 schema 推断/建模管线；其规模上限与极端样本表现本环境未核实（待补证）；渲染层是否虚拟化未见明确证据（分析） | [仓库 README（镜像同源）](https://github.com/cccZone/jsonhero-web#1) |
| jsoncrack（AykutSarac/jsoncrack.com） | 图/思维导图式可视化（非行式树）+ 编辑器 | 图布局在大 JSON 上的可交互上限与行式树不同维度；相关 perf 投诉未在时间盒内取到具体 issue（待补证） | [仓库](https://github.com/AykutSarac/jsoncrack.com) |
| Chrome DevTools 网络预览 JSONView | DevTools 前端实现（RequestPreviewView.js）；JSONView 实现 Searchable、配「乐观解析器」 | 是 DevTools 面板层（受文件长度/浏览器层限制）；非通用树式查看器，无展开状态外部化 | [JSONView Searchable（Chromium code review）](http://codereview.chromium.org/1899893003/patch/300001/310011#1)｜[乐观 JSON 解析器](https://codereview.chromium.org/654083006/patch/20001/30004#1) |
| Chrome 内置 JSON 文档视图 | 直接在标签页打开 .json 的折叠树视图（浏览器原生渲染，非 DevTools 前端） | 大文件/超大数组下的交互上限未在本环境核实；机制属另一实现层（分析） | —（待补证） |
| Monaco（仅文本） | 按文本行虚拟化渲染 + 全文档 tokenize；无 JSON 结构树 | pretty 化的 50MB JSON = 百万级文本行 → 行模型/tokenize 成本；单行 minified 50MB = 超长行灾难；都落在「文本」而非「结构」维度（分析） | —（业界共识性机制，待补证） |

**对照结论**：既有 viewer 卡死集中于「结构层无虚拟化 + 交互整树重渲 + 递归深度」三个根因；它们的问题不是「树形展示」本身，而是**没有把树拍平成行、没有把行与 DOM 解耦**。本文 §3 主推方案直接针对这三个根因设计；DevTools 控制台的懒预览与本文「容器预览」语义同源（CONTEXT：预览不改变展开状态），可作为交互范式参考。

## 6. 测量协议（spike 可复测口径）

**指标定义**（全部对齐 §1 验收线）：
1. `tParse`：parseStart → parseEnd（Worker 内）；
2. `tFirstRows`：parseEnd → 首屏可见行首次 commit（双 rAF 后取 `performance.now()`，即「首帧」操作化定义）；
3. 首帧 = `tParse + tFirstRows`，目标 <800ms（10MB 基线样本）；
4. 交互延迟（展开/折叠/搜索跳转）：事件 mark → 双 rAF（paint 后）；目标：无长任务打断（W3C Long Tasks：主线程 ≥50ms 任务即感知卡顿（[规范](https://www.w3.org/TR/longtasks/)、[MDN PerformanceLongTaskTiming](https://developer.mozilla.org/en-US/docs/Web/API/PerformanceLongTaskTiming)），新型号见 [Long Animation Frames](https://developer.chrome.com/docs/web-platform/long-animation-frames)）；
5. 掉帧率：脚本化滚动中记录每帧 rAF 的 `now()-prev`，帧间隔 >~25ms（>1.5×16.7ms）计掉帧，报比例（阈值选择为分析）；16.7ms/帧的帧预算为 RAIL/web.dev 常规口径（[Long Tasks 规范](https://w3c.github.io/longtasks/)）；
6. FCP + 长任务计数：`PerformanceObserver`（`paint` / `longtask`，`entry.attribution[0].containerType`）在页面加载**前**用 `addInitScript` 安装；
7. 内存：`performance.memory.usedJSHeapSize` 增量（Chrome-only、有弃用警告（[MDN](https://developer.mozilla.org/en-US/docs/Web/API/Performance/memory)）；`--enable-precise-memory-info` 可拿非取整值）；需要对象级归因时 `HeapProfiler.collectGarbage` + `takeHeapSnapshot` 差分——只在展开/折叠循环后堆增量异常时才做。

**步骤**：固定环境（单台机器、headless Chromium、禁动画、固定视口/DPR、≥5 次取中位数、预热）→ 应用内埋 `performance.mark` + 暴露 `window.__ready`（首屏行 commit 时 resolve）→ 脚本化加载（粘贴/设文本，await `__ready`，一次 evaluate 读 marks + observer 缓冲）→ 交互脚本（`t0=now(); toggle(node); rAF(rAF(read))`）→ 可选 CDP `Tracing.start`（`devtools.timeline`/`blink.user_timing`）做归因（[Puppeteer+Chrome trace 自动化](https://www.shymean.com/article/frontend-performance-automation-puppeteer-chrome-trace)）；CDP `Performance.getMetrics` 的 JSHeapUsedSize/Nodes/LayoutCount 是采样计数、无任务时长（[解读](https://stackoverflow.com/questions/53723263)）。

**MV3 环境要点**：Puppeteer 需 `--load-extension=<dir>` + `--disable-extensions-except`（新版 Chrome 支持 headless 扩展（[Puppeteer 指南](https://pptr.dev/guides/chrome-extensions)、[launch 选项 PR #13852](https://github.com/puppeteer/puppeteer/pull/13852)）；扩展页 `chrome-extension://<id>/index.html` 是普通 target 可直接量测；MV3 后台逻辑在 service worker（无 DOM，单独挂 CDP 才能量其计时）；**页内 observer 是可靠主记录**，外部 trace 需按 target id 过滤事件（分析）。

## 7. 给 P-1 spike 的行动清单

1. 用 §6 协议搭基线 harness：合成 10MB/50MB 样本（含「对象宽/深 + 超大数组」形态，参照 `.mock/1.json` 拉伸），跑出 parse/移交/首帧三段数值。
2. 用 headless 虚拟化原语（tanstack virtual）搭最小树层 spike：验证 4.1 的 flatten-on-change 在 10 万子项展开下的 toggle 成本；对比 react-arborist 现成组件路线。
3. 验证滚动锚定（§4.3 JS 锚）与搜索「展开祖先→跳行」（§4.5）在折叠祖先巨大时的延迟。
4. 验证 Worker 移交成本三种路线（structured clone 整树移交 / Worker 内两遍 / 懒流式解析）的内存-时间曲线，选首帧最优。
5. 记录决策为 `docs/adr/` 条目（按 map #1 惯例），结论与本文 §3 对照修订。

## 8. 参考资料

标注分组；除本文「（分析）」外均为调研过程核对的权威页/仓库页：

- **虚拟化库官方文档/仓库**：[react-window](https://github.com/bvaughn/react-window)｜[@tanstack/react-virtual API](https://tanstack.com/virtual/latest/docs/api/virtualizer.md) 与 [动态尺寸指南](https://tanstack.com/virtual/latest/docs/guides/measuring-dynamic-virtual-items)｜[react-virtuoso sticky/top-items](https://virtuoso.dev/react-virtuoso/virtuoso/top-items/)｜[react-arborist](https://github.com/jameskerr/react-arborist)（[v4 PR #235](https://github.com/jameskerr/react-arborist/pull/235)、[变高 #276](https://github.com/jameskerr/react-arborist/issues/276)）｜[rc-virtual-list](https://github.com/react-component/virtual-list)｜[react-component/tree](https://github.com/react-component/tree)｜[el-tree-v2](https://element-plus.org/en-US/component/tree-v2.html)｜[ag-grid DOM 虚拟化](https://www.ag-grid.com/javascript-data-grid/dom-virtualisation/) 与 [cell renderer](https://www.ag-grid.com/javascript-data-grid/component-cell-renderer/)｜[ariakit 组件 vs headless 讨论 #1930](https://github.com/ariakit/ariakit/discussions/1930)
- **Canvas/数据网格**：[glide-data-grid README](https://app.unpkg.com/@glideapps/glide-data-grid@6.0.5/files/README.md)｜[Glide 工程博客](https://www.glideapps.com/blog/glide-data-grid-typescript)｜[渲染系统源码走读（次级）](https://deepwiki.com/glideapps/glide-data-grid/2.3-canvas-rendering-system)
- **CSS 技巧与规格**：[web.dev content-visibility](https://web.dev/articles/content-visibility)（[源文件](https://github.com/GoogleChrome/web.dev/blob/e38618367501970200cca662a750a3a3e2afe2c9/src/site/content/en/blog/content-visibility/index.md)）｜[MDN content-visibility](https://developer.mozilla.org/en-US/docs/Web/CSS/content-visibility)｜[hermes-webui intrinsic-size fallback PR #5639](https://github.com/nesquena/hermes-webui/pull/5639)
- **滚动锚定**：[MDN overflow-anchor](https://developer.mozilla.org/en-US/docs/Web/CSS/overflow-anchor)｜[css-scroll-anchoring-1](https://www.w3.org/TR/css-scroll-anchoring-1/)｜[csswg 显式锚定讨论](https://lists.w3.org/Archives/Public/public-css-archive/2022Dec/0228.html)
- **性能口径/测量**：[web.dev Lighthouse DOM size](https://web.dev/articles/lighthouse-dom-size)｜[W3C Long Tasks](https://www.w3.org/TR/longtasks/)（[spec 工作稿](https://w3c.github.io/longtasks/)）｜[MDN PerformanceLongTaskTiming](https://developer.mozilla.org/en-US/docs/Web/API/PerformanceLongTaskTiming)｜[Long Animation Frames](https://developer.chrome.com/docs/web-platform/long-animation-frames)｜[Puppeteer Chrome 扩展指南](https://pptr.dev/guides/chrome-extensions)｜[launch 选项 PR #13852](https://github.com/puppeteer/puppeteer/pull/13852)｜[Puppeteer+Chrome trace 自动化（中文）](https://www.shymean.com/article/frontend-performance-automation-puppeteer-chrome-trace)｜[Performance.getMetrics 解读](https://stackoverflow.com/questions/53723263)｜[MDN performance.memory](https://developer.mozilla.org/en-US/docs/Web/API/Performance/memory)
- **解析/内存量级参考**：[json-ext benchmarks](https://raw.githubusercontent.com/discoveryjs/json-ext/HEAD/benchmarks/README.md)｜[simdjson](https://www.npmjs.com/package/simdjson)｜[RN JSON.parse 堆尖峰实测](https://hackernoon.com/lite/the-hidden-js-heap-cost-of-jsonparse-in-react-native)｜[Chromium JSON.parse 省内存改动](https://codereview.chromium.org/7241023/)
- **虚拟树实现参考**：[DEV: Virtualizing Huge JSON Files in React](https://dev.to/utku_akyuz/virtualizing-huge-json-files-in-react-the-technical-breakdown-3ef4)｜[react-window-tree](https://packages.ecosyste.ms/registries/npmjs.org/keywords/react-window-tree)｜[react-tree-virtual](https://www.npmjs.com/package/react-tree-virtual)｜[TanStack/virtual 测高 PR #1183](https://github.com/TanStack/virtual/pull/1183)｜[antd 虚拟树搜索踩坑（中文）](https://juejin.cn/post/7651954728703672326)
