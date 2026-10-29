# 竞品基线：bejson.com JSON 查看器为什么卡（真实页面实测）

> 起因：这是项目负责人日常使用的在线 JSON 工具（`https://www.bejson.com/jsonviewernew/index.html`）。
> 导入「大 JSON」时首帧和搜索都明显卡顿。本文用真实 Chrome 打开该页面、注入本仓样本复现并量化，
> 作为本产品「极速查看 + 数据层搜索」设计要超越的**竞品基线**。
>
> 页面是第三方应用，内容/实现随时可能变化；本文只记录 2026-10-27 实测的那一版。
> **不是产品代码、不进入扩展包**；脚本在 `prototype/p1/bench/bejson/`。

## 0. 一句话结论

bejson 用的是 **ExtJS 2.2（2008 年代）的 TreePanel + PropertyGrid，完全没有虚拟化**：
- 导入时把**整份 JSON 递归物化成树节点配置**（`json2leaf`），并让**全文一直留在 `<textarea>` 里**；
- 搜索时对**每一个树节点递归 `expand()` 再扫描/回缩**（`searchInNode`），在主线程一次性完成，没有预算/分批/取消。

结果（M4 / Chrome for Testing 156 headless）：

| 样本 | 节点数 / 深度 | 导入后首帧长任务 | 搜索（查询 `hotel`） | 搜索后 DOM |
|---|---|---|---|---|
| `.mock/1.json`（0.84MiB，真实形态） | 45,805 / **15** | **109ms**（中位 3 轮） | **44.0s** | **793,590** 个元素（274,830 个 tree-node） |
| 2MB 合成样本 | 120,118 / 5 | **245ms** | **17.1s** | **1,456,786** 个元素（720,708 个 tree-node） |
| 10MB 合成样本 | 595,030 / 5 | **1164ms**（中位 3 轮） | 未跑（内存/DOM 风险，量级更大） | — |

对照本产品 P-1 实测（同机器、同 10MB 样本）：**首帧 52ms**、主线程堆 0.72MB、DOM 只挂 36–40 行、搜索全量 walk 2.96M 节点 **43–75ms**。差距来自架构，不是常数因子。

## 1. 测量方法

| 项 | 值 |
|---|---|
| 浏览器 | Chrome for Testing **156.0.8078.47**，`--headless=new --no-sandbox`，CDP（复用 `prototype/p1/lib/chrome.mjs`） |
| 页面 | bejson JSON Viewer（ExtJS **2.2**，`/static/bejson/js/component/jsonview/jsonview_files/ext-all.js`） |
| 样本 | `.mock/1.json`（879,330 字符；真实业务形态，深 15）、`.spike/samples/{2mb,10mb}.json` |
| 注入 | 页面 ready 后取 `Ext.getCmp('edit')`（源文本 `<textarea>`），`setValue(text)` + `fireEvent('change')` —— 等价于用户粘贴后触发 change → `check()` 的路径 |
| 文本来源 | 通过本地 CORS 静态服务 `fetch()`（真实用户是剪贴板 paste；见 §5 口径限制） |
| 首帧口径 | `setValue` → 强制 layout → `change`（parse + 全树构建）→ 双 rAF；同时用 `PerformanceObserver('longtask')` 记录主线程长任务 |
| 搜索口径 | 设置 `#searchTextField` = `hotel` → 调 GO! 的 handler → 每 100ms 采样 DOM，直到节点数连续 1.5s 不变（或选中节点） |
| 内存 | `performance.memory.usedJSHeapSize`（页面 isolate） |
| 复跑 | `node prototype/p1/bench/bejson/bench-bejson.mjs .mock/1.json`（详见该目录 README） |

## 2. 首帧：整份文本进 textarea + 整棵树物化

### 2.1 实测（3 轮中位）

| 样本 | `setValue` | 强制 layout | `change`（parse + treebuild） | 主线程长任务 | 页面堆 | 初始 DOM |
|---|---|---|---|---|---|---|
| 0.84MiB | 0.8ms | **71.5ms** | 37.2ms | **109ms** | 19.1MB | 281 |
| 2MB | 1.5ms | **175.6ms** | 66.3ms | **245ms** | 33.2MB | 273 |
| 10MB | 6.4ms | **846.8ms** | 308.8ms | **1164ms** | **150MB** | 276 |

10MB 下：文本进入 DOM（textarea）后强制布局 847ms，解析+建树 309ms，合起来一条 **1.16s 的主线程长任务**；页面堆 150MB。
真实用户按 Ctrl+V 还要先经过浏览器把 10MB 文本插进 textarea（本测量用 `setValue` 写入，**是乐观下界**；#15 已经证明大文本进 DOM 文本节点的代价会随体积超线性恶化）。

### 2.2 代码层根因（`jsonviewercn_encode.js`，ExtJS 2.2）

1. **全文留在 textarea**：左栏 `#edit` 是一个 Ext TextArea，值就是整份 JSON；没有「只保留摘要/虚拟化文本」的概念。
2. **change 时整份 parse + 全树物化**：
   ```js
   // check(): textarea.getValue().split('\n').join(' ') → JSON.parse(..., reviver)
   // reviver 把大数字串成 BigNumber（每个数字一次 BigNumber 构造）
   ...
   this.treebuild();
   // treebuild(): tree.removeAllChildren(); tree.appendChild(this.json2leaf(root))
   // json2leaf(): 递归为每个字段创建 {text, children, icon, ...} —— 全量节点模型
   ```
   45,805 / 120,118 / 595,030 个节点都先变成 Ext 树节点配置对象；展开与否只影响 DOM，不影响这棵「全量模型」的构建成本。
3. **ExtJS 2.2 TreePanel / PropertyGrid 无行虚拟化**：展开即挂 DOM；没有窗口化、没有行池。
4. **大数字处理**：`check()` 先对源文本做正则替换 + `JSON.parse` reviver，把数字包成 `BigNumber`——保真考虑（这点比很多 viewer 好），但每个数字都付 BigNumber 构造/内存成本。

## 3. 搜索：全树递归 expand/collapse，主线程一次跑完

### 3.1 实测（单轮；查询 `hotel`）

| 样本 | 搜索耗时（DOM 稳定） | 最长单条长任务 | DOM 峰值 | 搜索后堆 |
|---|---|---|---|---|
| 0.84MiB / 45,805 节点 | **44.0s** | **32.4s** | **793,590** 元素（274,830 tree-node） | 86.7MB |
| 2MB / 120,118 节点 | **17.1s** | 4.2s | **1,456,786** 元素（720,708 tree-node） | 167.8MB |

> 注意：**更小的真实样本反而更慢**（44s vs 17s）。搜索成本不只取决于体积，还取决于「命中数 × 祖先路径深度」：`.mock/1.json` 深 15、`hotel*` 命中大量嵌套字段；2MB 合成样本只有 5 层。这解释了为什么用户日常的 0.8MB 业务 JSON 体感很差。

### 3.2 代码层根因

```js
// GO! handler → searchStart()
// searchStart(): 150ms DelayedTask → searchFn()
// searchFn(): 清空命中；searchInNode(treeRoot, query)；有命中则 selectNode(第一个)
// searchInNode(node, query):
//   1) node.text 命中 → push
//   2) 保存展开状态，node.expand(false,false) —— 强制展开
//   3) 对每个 child 递归 searchInNode
//   4) 若原来不是展开状态 → collapse(false,false)
```

- 搜索前树是折叠的（初始 DOM 仅 281 个元素）；搜索会把**每一个节点**依次 `expand()`（创建子节点 DOM），扫完再 `collapse()`。对 45,805 节点的真实样本，这一来一回创建/销毁 **27 万个 tree-node DOM 元素**，其中最长一次主线程长任务 32.4s——浏览器完全无响应。
- **没有分批/让出/取消**：150ms 延迟只是防抖，真正扫描是同步递归。
- **命中以 DOM 节点为结果载体**：无法做「渐进式结果列表」或「只渲染可视命中」。
- 搜索后 DOM 峰值不回落（793,590 → 793,588，1,456,786 → 1,456,784），页面堆 87–168MB，后续操作继续背这个包袱。

## 4. 与本产品设计的对照（为什么我们的方案能避开）

| 失败模式（bejson） | 本产品设计（P-1 实测） |
|---|---|
| 全文进 `<textarea>`，10MB layout 847ms、堆 150MB | 文本永不进 DOM：paste `preventDefault` 读 `clipboardData`；文件走 `arrayBuffer` + transfer → Worker `TextDecoder`（ADR-0004） |
| 主线程 `JSON.parse` + BigNumber reviver | Worker `JSON.parse`（50MB 93ms；10MB ~11ms） |
| 全量树节点模型（`json2leaf` 递归 45k–595k 节点） | 值图 + 展开集合；只对 open 容器建 Fenwick，不建扁平行表（ADR-0002） |
| 展开即挂 DOM（零虚拟化） | 固定行高行虚拟化 + 行节点池：**只挂 36–40 行**，0.03–0.09ms/帧（ADR-0001/0005） |
| 搜索 = 全树递归 expand/collapse，主线程 44s | 搜索在 Worker 数据层扫描（2.96M 节点 43–75ms），命中是纯数据；跳转 = 展开祖先 + 行号；只对可视行高亮（#10 / ADR-0001） |
| 无预算/无取消/无渐进 | 表达式/搜索均带时间/步数/结果预算与取消（#12/#10）；根版本化丢弃迟到结果 |

**对应到验收线**：10MB 导入→首帧目标 <800ms（本产品实测 52ms）；搜索的可感知延迟目标应是「输入后立即出结果列表/高亮」，而不是 bejson 的 17–44s 冻结。

## 5. 口径限制 / 未测

1. **headless**：布局/合成与 headful 有差异；搜索的 44s 主要来自 ExtJS DOM 操作 + 长任务，架构性结论不受影响，但具体秒数会随机器/页面版本变化。
2. **文本来源**：本测量用 `Ext.setValue` + `fireEvent('change')` 模拟粘贴后的 change 路径，未走真实系统剪贴板 paste；真实 paste 的 textarea 插入成本可能更高（本数字是下界）。
3. **单轮搜索**：搜索只跑了 1 轮/样本（每次 17–44s）；首帧是 3 轮中位。
4. **未跑 10MB 搜索**：2MB 已到 1.46M DOM / 168MB 堆；10MB 预计更高，有崩溃风险，未测。
5. 该页面是第三方资产，可能随时改版；本基线只用于设计对照，不进入产品包。

## 6. 对产品的启示

- **首帧的敌人不是 `JSON.parse`**（10MB 仅 ~11ms），而是「把文本塞进 DOM」+「一次性物化整棵树」。这与 #15 的 40s textarea 教训、P-1 的 B 方案否决完全一致。
- **搜索的敌人不是字符串扫描**（2.96M 节点 43–75ms），而是「用 DOM 展开/折叠来表达搜索范围」。搜索必须先在数据层得到命中集合，再只渲染可视行。
- **真实业务 JSON 的「深 + 宽 + 命中多」比体积更毒**：0.84MB 的真实样本搜索比 2MB 合成样本还慢 2.6×。性能基线不能只跑合成样本，`.mock/1.json` 这种形态要进回归集。
- 搜索体验上，bejson 的「查找 → GO! → 全部展开 → 逐项下一个」是用户熟悉的路径；我们的数据层搜索可以保留「下一个/上一个 + 命中计数」，但结果必须是**渐进/可取消**的（#10 设计时对齐）。

## 7. 复跑

```bash
# 首帧（不跑搜索）
SEARCH=0 node prototype/p1/bench/bejson/bench-bejson.mjs .mock/1.json

# 首帧 + 搜索（默认 120s 观察窗口；SEARCH_CAP_MS 可调）
node prototype/p1/bench/bejson/bench-bejson.mjs .mock/1.json
node prototype/p1/bench/bejson/bench-bejson.mjs .spike/samples/2mb.json
```

脚本：`prototype/p1/bench/bejson/bench-bejson.mjs`；说明：`prototype/p1/bench/bejson/README.md`。
