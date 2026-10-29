# IR / 文档模型与 Worker 管线 — v1 spec

> 关联：#7、ADR-0001、ADR-0002。本文收口 #7 的剩余决策，是 #13（模块 seam）的前置。
> 术语见 `CONTEXT.md`；真机数据见 `docs/design/reassess-runtime.md`。

## 1. 不变量

1. 真相源 = Worker 内的 `JSON.parse` 值图；主线程不持有文档。
2. 不预建扁平行表、不建全局 parentMap；行模型由展开集合 + 每个 open 容器的 Fenwick 派生。
3. 节点身份懒分配：只给被触达的容器；标量用 `(parent, slot)` 句柄。
4. 源文本只在导入期使用：解析 + 保真扫描 + 文档概要采样完成后**释放**；不保留原文视图。
5. 所有行窗口请求都带 `rootId + rowVersion`；所有结果/命中集都带 `docRevision`。
6. **不重解析整份文档**（编辑/修复除外）；结构变化只更新受影响容器与祖先链。

## 2. 数据模型

```
Root {
  rootId: string                 // 'doc' | 'expr:N' | 'repaired'
  kind: 'doc' | 'expression' | 'repaired'
  value: unknown                 // JSON.parse 值图（expression 根是新数组/对象，元素引用原节点）
  expanded: Set<object|array>    // 展开集合（容器身份）
  model: RowModel                // 派生行模型
  docRevision: number
  rowVersion: number
  parentRootId?: string          // expression/repaired 指回 doc
  provenance?: RepairProvenance  // repaired 根
  createdAt / lastUsedAt
}
```

- **Path**：规范字符串，根 `$`；段为 `.key` 或 `[i]`；用于持久化、复制、hover/aria 展示。
  非标识符键用括号形式；持久化时以 `(rootKind, path)` 还原。
- **Node identity**：懒 id（`WeakMap<container,int>` + `id→node` 数组）；标量 `(parent, slot)`。
  id 只在运行期使用；不建全局 parentMap；父链由行模型下潜栈/展开节点维护的 `id→(parentId,slot)` 提供。
- **Document Profile**：导入后异步采样字段名/路径样本（前 N 项），供表达式补全/静态路径校验；不参与搜索。

## 3. 行模型

- 可见行 = 根行 + 已展开子树的子项行；每个 open 容器维护 Fenwick（子项可见行数前缀和）。
- `totalRows` = 根可见行数（Fenwick 总和）；滚动条用真实行号；超 33,554,428px 时封顶 + 缩放映射（ADR-0001）。
- 窗口：`{rootId, rowVersion, seq, start, count}` → `Row[]`；40 行约 3.1KB；p95 0.1ms（Worker 计算）。
- `Row = { label, depth, kind, preview, count, open, rowId }`；路径/完整值按需另取。
- 折叠行「共 N 项」= `array.length` / `Object.keys(obj).length`；不预计算子树总行数。
- 展开/折叠：更新该容器 Fenwick 与祖先可见计数；`rowVersion++`。
- 替换编辑：父容器 Fenwick 点更新（子项位置不变），被替换节点按 S1 处理；见 `edit-spec.md`。

## 4. 根与版本

### 4.1 版本号

| 计数器 | 何时 +1 | 用途 |
|---|---|---|
| `docRevision` | 导入、修复、`replaceNode`、重置 | 判断表达式结果/搜索命中是否过期 |
| `rowVersion` | 展开、折叠、`replaceNode`、重置 | 行窗口校验（丢弃错行回包） |

- 行窗口回包带 `rowVersion`；页面丢弃不匹配回包（`STALE_ROW`）。
- 表达式结果/搜索命中带 `docRevision`；不匹配即 stale（UI 提示重新执行），不自动重算。
- `seq` 只用于丢弃同一版本的迟到回包（单飞 + 合并）。

### 4.2 表达式结果根

- 每次求值创建一个新根（`expr:N`），元素**引用**原文档节点，不复制。
- **最多保留最近 3 个**；第 4 个创建时释放最久未用的根（LRU）。
- 文档修改后：已有结果根标 stale（`docRevision` 不匹配），保留到 LRU/显式关闭；UI 显示 stale banner。
- 结果根有自己的 `expanded/model/rowVersion`；行号是根内坐标。

### 4.3 搜索

- 不创建独立 root。搜索返回命中集合 `{ docRevision, hits:[{path, field, snippet, rowHint?}] }`。
- 命中集合作为视图状态；结果列表虚拟化；跳转 = 展开祖先 + 用行模型算行号 + 滚动。
- 文档修改后清空命中并提示重新搜索（不复用旧 hit）。

### 4.4 修复根

- 截断修复发生在导入期；修复后的文档作为 `kind:'repaired'` 根（或 doc 根带 provenance）。
- `docRevision` 从 1 开始；`docFingerprint` 由源文本计算（释放文本前），用于视图状态恢复。

## 5. 解析 / 导入管线

```
main: import(bytes|text, {source})
  → Worker: decode → JSON.parse → Root(doc) → 展开根/顶层可见 → 首窗口
  → async: 保真扫描（BigInt 精确判定 + 整数键规则）→ 小报告（异常字面量片段）
  → async: Document Profile 采样（前 N 项键/路径）
  → 释放源文本
```

- 首帧不等待保真/profile；扫描 50MB ≈288ms，异步执行。
- 截断输入先尝试保守闭合（#8/ADR-0004），失败则报错；修复结果带 provenance。
- 新导入可取消旧导入（`loadId`）：忽略旧结果；旧根释放。
- 大文档（>50MB）提示预估内存/耗时，允许继续；仍受可见行预算约束。

## 6. 编辑（摘要）

- 唯一 mutation：`replaceNode(rootId, path, jsonText)`（子树 JSON 编辑，ADR-0006/edit-spec）。
- Worker：`JSON.parse(jsonText)`（≤5MB）→ 替换 → `docRevision++`、`rowVersion++` → 行模型更新 → 返回 `{totalRows, changedRow}`。
- 撤销/重做/重置：Worker 维护编辑历史（path + old/new 值快照，深度 100）；重置 = 回到导入值（由历史逆操作或原始值快照）。
- 复制/导出一律用当前值图。

## 7. 内存预算（50MB 样本）

| 项 | 实测/估算 |
|---|---|
| 值图 | ≈73MB（Worker 稳态） |
| 源文本 | 0（解析后释放） |
| Fenwick（184k 子项容器） | +0.73MB |
| 懒 id（2000 触达节点） | +0.06MB |
| 表达式结果根（10 万引用） | ≈0.8MB/根；LRU 3 |
| 主线程 | <1MB（行窗口/UI） |

## 8. 协议摘要

| 消息 | 方向 | 说明 |
|---|---|---|
| `load` | main→worker | 导入（bytes/text + source） |
| `window` | main→worker | `{rootId,rowVersion,seq,start,count}` |
| `toggle` | main→worker | 展开/折叠（rowVersion++） |
| `replaceNode` | main→worker | 子树 JSON 编辑（docRevision++/rowVersion++） |
| `getNodeJson` | main→worker | 取节点规范 JSON（≤5MB） |
| `getTrail` | main→worker | JSON 地图祖先 trail（O(depth)） |
| `eval` | main→worker | 表达式求值 → 新 expr root |
| `search` / `cancel` | main→worker | 搜索命中/取消 |
| `copy` | main→worker | 子树/路径/原值/键名 |
| `undo/redo/reset` | main→worker | 编辑历史 |
| `loaded/root/window/reply/progress/event` | worker→main | 结果/回包/进度/修复事件 |

## 9. 边界与测试

- 根为标量/空对象/空数组；超大数组；深 15 层；整数样式键；重复键（已丢失）；大整数（保真报告）。
- 展开 184k 子项后窗口 p95 0.1ms；旋转/滚动/编辑无 >50ms 长任务（headful 复核）。
- 表达式结果根：连续 4 次求值只保留 3 个；文档修改后结果标 stale。
- 搜索：结构修改后命中清空；不建 root。
- 导入取消：旧 load 结果被忽略；旧根释放。
- 内存：50MB 文档 Worker ≈73MB；无源文本副本。

## 10. 与其它文档

- 行窗口/滚动/多根：`docs/adr/0001`；IR/行模型/身份：`docs/adr/0002`
- 保真/原始视图移除：`docs/adr/0003`（修订）
- 导入/修复：`docs/adr/0004`
- 编辑：`docs/adr/0006`、`docs/design/edit-spec.md`
- JSON 地图：`docs/adr/0007`、`docs/design/json-map-spec.md`
