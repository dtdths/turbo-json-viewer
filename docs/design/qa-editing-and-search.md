# 问答：编辑 JSON 与「没有全量树」怎么搜索

> 来源：项目负责人两个问题（2026-10-27）——
> 1）「文本永不进 DOM，那我如何修改 JSON？」（日常用 bejson 的 textarea 改 mock 数据）
> 2）「没有全量化树，怎么实现搜索？」
>
> 本文把两个问题的边界、可选方案与实测数据写清楚。
>
> **2026-10-27 决定**：不走 B（全文源文本编辑）；采用 C 的实现——**临时子树 JSON 编辑**（点节点 → 编辑该节点 JSON → 替换；覆盖标量/增删字段/子结构/键改名；不改原文件、不落盘），详见 #16 与 ADR-0006。下文保留 A/B/C 分析作为背景。

## 1. 「文本永不进 DOM」的准确含义

这条约束来自 #15 的实测：把 10MB 文本塞进 `<textarea>` / 单个 DOM 文本节点，Chrome 会因文本布局阻塞主线程几十秒。
它约束的是**「整份文档作为单个 DOM 文本节点」**，不是「文本在 JS 内存里」、也不是「不能编辑」。

- 导入/查看路径：文本只存在于 Worker（`arrayBuffer` → `TextDecoder` → `JSON.parse`），原始文本视图按行窗口渲染；
- 编辑路径：只要编辑器是**行虚拟化/文档模型**（CodeMirror 6 的 Text rope + 视口行渲染），就不违反这条约束。

### 1.1 CM6 承载大文本的实测（MV3 扩展页，CfT 156）

用现有 `prototype/p1/fixtures/stack/` 的 CM6 最小集（`state+view+autocomplete+commands`，无 JS 高亮）：

| 文本 | `insert` 耗时 | 插入后 DOM 节点 | 首个渲染行的文本长度 | 页面堆 | 长任务 |
|---|---|---|---|---|---|
| `.mock/1.json`（879KB，minified） | 4.8ms | 10 | **2,088 字符**（视口切片） | 3.3MB | 0 |
| 10MB（minified 单行） | **3.5ms** | 8 | **2,088 字符**（视口切片） | 13.8MB | 0 |

关键点：CM6 不会把整份 10MB 文本放进 DOM；它只渲染视口内的行/字符窗口（首个可见行只 2,088 字符）。所以「加一个编辑模式」在性能上可行。
注意：本次只测了最小集（无 JS 高亮）的插入/挂载；编辑交互（选中、undo、IME、横向滚动、高亮开启后的成本）仍需实测；10MB 单行在编辑体验上也需要折行/格式化策略。

### 1.2 如果编辑是 v1 需求：三个选项

| 选项 | 做法 | 成本/风险 | 适合 |
|---|---|---|---|
| **A. 保持纯只读**（当前地图） | 编辑在外部工具（VS Code/bejson）；我们强化「复制子树 / 复制原文 / 导出文件 / 重新导入」 | 零范围变更；mock 改完要切工具 | 编辑只是偶尔发生 |
| **B. 源文本编辑模式（推荐若必须编辑）** | 顶部「编辑」→ CM6 打开源文本（≤阈值）→ Apply → Worker 重新 parse → 新文档根；树/搜索/导出照常 | 新增一个面板 + 保存/校验/状态恢复；**改动 v1 纯只读范围**；阈值需实测（10MB 插入已可行，建议先 ≤10MB，超出只读） | 贴近 bejson 的 textarea 工作流，同时保留快速查看/搜索 |
| **C. 结构化/子树编辑**（v1.1） | 树内联改值，或选中子树在 CM6 里改后回写 Worker | 改动最小、对大文档也适用，但交互/撤销/路径维护复杂 | 大文档只改少量字段 |

**建议**：
- 如果「改 mock 数据」是高频动作 → 选 **B**；它复用已定的 CM6（表达式框）与同一份文本，不新增权限，且性能上成立。需要把地图 Out of scope 的「v1 纯只读」改成「v1 只读查看 + 受限源文本编辑（≤阈值）」并补 ADR。
- 如果编辑只是偶尔 → 选 **A**，我们先做到「看 + 搜 + 导出」比 bejson 快一个数量级，编辑仍在外部工具完成。

> 精确的约束措辞建议改为：**「整份文档不得作为单个 DOM 文本节点/普通 textarea 承载；编辑模式必须使用行虚拟化/文档模型编辑器（CM6），并设大小阈值」**。当前 ADR-0004 的「任何路径都不得把整份文本写入 DOM 文本节点」应加这条注脚（编辑器例外）。

### 1.3 最终采用：子树 JSON 编辑（2026-10-27）

用户提出「点对象/数组 → 该值放入输入框 → 自行编辑 → parse 回去」，即 C 的实现，作为唯一编辑入口：

1. 点击/右键节点 → 「编辑该节点 JSON」→ CM6 弹层（行虚拟化），内容 = `JSON.stringify(value, null, 2)`。
2. 用户自由编辑：改标量、增删字段、增删子结构、改键名都在 JSON 文本里完成。
3. Apply → 文本发 Worker → `JSON.parse` → **整段替换该节点** → `rootVersion++` → 行模型更新（被替换节点默认折叠；父容器展开时重建其 Fenwick）→ 主线程重取窗口并高亮。
4. 原文件不动；撤销/重置；导出才落盘（`-edited`）。

它比逐字段菜单简单：**一个 mutation（replaceNode）覆盖所有编辑**；代价是结构变化时行模型/展开集合/锚点要更新，且子树文本有大小阈值（建议 5MB，根节点同限）。

## 2. 「没有全量树」怎么搜索

### 2.1 先区分三层东西

| 层 | 是否完整存在 | 说明 |
|---|---|---|
| **文档值图（Document Value Graph）** | **完整存在（Worker 内存）** | `JSON.parse` 的结果，2.96M 节点全在。这是数据真相，不是 UI 树。 |
| **行模型（Row Model）** | 按需派生 | 由展开集合 + per-open Fenwick 算「当前可见行」；不预建 2.96M 行的扁平表（135.6ms/+106MB 已否决）。 |
| **DOM** | 只有视口 40 行 | 行节点池 + textContent。 |

「没有全量化树」= 没有为每个 JSON 节点物化一个 UI 行/DOM 节点；**不等于没有数据**。搜索扫的是第 1 层，不是第 2/3 层。

### 2.2 搜索算法（Worker 内，数据层）

```ts
// 对值图做一次 DFS；键名、标量值、路径都可以参与匹配
function search(root, query, budgetMs, maxHits) {
  const Q = query.toUpperCase();
  const hits = [];            // { path, field: 'key'|'value'|'path', node, snippet }
  const stack = [[root, '$', null]];
  let steps = 0;
  while (stack.length) {
    const [v, path, key] = stack.pop();
    if (key != null && key.toUpperCase().includes(Q)) hits.push({ path, field: 'key' });
    if (v !== null && typeof v === 'object') {
      for (const [k, child] of entries(v)) stack.push([child, join(path, k), k]);
    } else if (String(v).toUpperCase().includes(Q)) {
      hits.push({ path, field: 'value' });
    }
    if (++steps % 20000 === 0 && performance.now() - t0 > budgetMs) {
      // 预算到：先返回已命中结果，剩余分片继续（或取消）
    }
  }
  return hits;
}
```

- **覆盖折叠/未渲染内容**：因为扫的是完整值图；默认折叠只影响行模型/DOM，不影响数据。
- **命中是纯数据**：`{path, field}`；结果列表本身虚拟化。
- **跳转**：`expandAncestors(hit.path)`（只展开少量祖先）→ Worker 用 Fenwick 算出该路径的**行号** → 虚拟列表 `scrollToRow` → 只对可视行渲染高亮。
- **渐进/取消**：分片扫描（如 2 万节点/片）、`requestId/rootVersion` 丢弃过期结果；输入变化立即取消旧搜索。
- **为什么不用行模型搜索**：行模型是投影（折叠行只有 1 行、展开才有子行），会漏掉折叠内容；数据层搜索才完整。

### 2.3 实测（Node v24，与 Chrome 同 V8；键名+标量值匹配，不含路径构建）

| 样本 | 容器 / 标量 | `JSON.parse` | 搜索 walk（`hotel`） | 命中数 |
|---|---|---|---|---|
| `.mock/1.json` | 10,344 / 35,461 | 4.1ms | **5.1ms** | 58 |
| 10MB | 74,382 / 520,648 | 30.9ms | **38.4ms** | 37,189 |
| 50MB | 369,822 / 2,588,728 | 119.6ms | **155.2ms** | 184,909 |

（P-1 在 Chrome Worker 里测的同类全量 walk 是 43–75ms/2.96M 节点；上表为 Node 上界/量级，正式预算以 #10 的 Chrome 实测为准。）
即使 50MB、18 万个命中，**扫描本身也在 500ms 预算内**；成本大头在结果列表与高亮渲染，而它们只作用在可视行（≤40 行）。

> **2026-10-29 复核（slice 4 验收）**：上表「命中数」是旧口径——`37,189` 恰好等于 10MB 样本里 `hotel` 的**键名**命中数，`.mock/1.json` 的旧值 `58` 未复现。当前 `src/core/search.ts` 同时匹配键名与字符串值：`.mock/1.json` = **186**（键 140 / 值 46），10MB raw = **74,378**（键 37,189 / 值 37,189），超过 `SEARCH_LIMIT = 50,000` 后截断为 `50,000+`（50MB 同理只会更多）。搜索 walk 实测（Node，不含结果传输/渲染）：`.mock/1.json` 3.3–4.7ms、10MB 满量 42.7ms（capped 28.2ms）；Chrome 内端到端数字见 `docs/architecture/README.md` §11「slice 4 搜索验收」。

### 2.4 对照 bejson

bejson 的搜索不是「扫数据」，而是「对全树递归 `expand()` 再扫 DOM」：`.mock/1.json` 实测 **44s**、DOM 峰值 793,590（详见 `docs/research/bejson-baseline.md`）。
我们的 5.1ms 扫描 + 可视行高亮，是同一任务在数据层完成的结果。

## 3. 决定与待拍板

**已定（2026-10-27）**：唯一编辑入口 = **临时子树 JSON 编辑**（点节点 → 编辑该节点 JSON → 替换）；覆盖标量改值、增删字段/子结构、键改名；不改原文件、不持久化；源文本/全文编辑不做（ADR-0006、#16）。

**仍待 #16 拍板**：
1. ✅ 已定：CM6 加 JSON 语法高亮/lint（`@codemirror/lang-json`）。
2. ✅ 已定：根节点编辑阈值 5MB（50MB 根只读；子树同样 5MB）。
3. ✅ 已定：Apply 后展开状态 = **S1**（保留被替换节点自身展开，子节点折叠）；S2 作为 v1.1 增强。标量是否保留行内快捷编辑：v1 不做（统一走 JSON 编辑器）。
4. 撤销深度、修改徽标、重置、导出命名。
5. 原始文本视图标注（原文件文本、不含修改）与是否提供「按值图重建 pretty 文本」。
6. 表达式/搜索结果的 stale / 清空 / 重算策略。

## 4. 复跑/数据来源

- CM6 大文本插入：`prototype/p1/fixtures/stack/`（`window.__cm6` API；本次临时脚本测量，未固化）。
- 搜索 walk：本次临时 Node 脚本；P-1 的 Chrome Worker 数据见 `docs/design/reassess-runtime.md` §8。
- bejson 对照：`docs/research/bejson-baseline.md`。
