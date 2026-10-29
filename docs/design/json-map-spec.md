# JSON 地图（Canvas 层级塔）— v1.1 spec

> 关联：#17、ADR-0007。用户命名的「json 地图」：主视图之外常驻的小窗口，用 Canvas 画出**当前选中节点**在文档中的位置与层级。
> 解决痛点：节点过深时不知道上一层是谁、当前 index 多少、再上一级是什么。

## 1. 范围

**做（v1.1）**
- 纵向「层级塔」：从根到当前节点，一层一行；显示 key / `[i/N]` / 相邻兄弟 key。
- 当前节点 = **选中行**；无选中时显示**根节点**。
- 点击祖先 → 主树选中并滚到该祖先；点击兄弟 → 选中该兄弟；hover → 完整 key/路径提示；面板可折叠。
- Canvas 绘制；DPR/主题适配；a11y 文本回退。
- 数据由 Worker 按需返回 `trail`（O(depth)），不遍历全文档。

**不做（v1.1）**
- top-level 概览条 / 全文档压缩地图（C）。
- 同心环（B）。
- 拖拽/缩放地图、地图内搜索命中、多选。
- 地图作为主视图（仅辅助导航）。

## 2. 视觉

### 2.1 布局

右下角浮动面板，默认约 **260×220**（可按深度微调高度，最大约 320px），可折叠为 40×40 的小按钮。

```
┌ JSON 地图 ────────────────┐
│ root                     │
│ └ data                   │
│   └ hotel_list [1234/5000]│
│     └ rooms [5/12]       │
│       └ price ◉          │
└──────────────────────────┘
```

- 每层一行：缩进或 `└` 连接线 + 截断的 key + 类型色点 + `[i/N]`。
- 当前节点行高亮（accent 背景/左边条 + `◉`）。
- 当前层的相邻兄弟：显示为行内小刻度/短标签（默认前后各 2 个），当前 index 位置用竖线标记；长 key 截断，hover 显示全名。
- 深度超过可视行数（默认最多 12 行）：显示前 2 层 + `… 隐藏 N 层 …` + 当前附近的层级；hover `…` 显示完整路径；点击可展开该段（面板内滚动/临时加高）。
- 主题色、字体、圆角遵循 #6 设计 token；Canvas 按 `devicePixelRatio` 缩放。

### 2.2 绘制

- 单 Canvas；行高约 22px；文本测量结果缓存（key → width）。
- 只重绘变化时/选中变化/主题变化/尺寸变化；滚动不触发重绘（选中不变）。
- 兄弟刻度按 `index / count` 定位；count 很大时只画当前 ±2 与当前位置标记。
- 空文档/根为标量：显示一行「根: <类型>」并结束。

## 3. 数据协议

Worker 在选中变化时返回（不扫全树）：

```ts
type MapLevel = {
  key: string | number;          // 对象键或数组下标
  kind: 'object'|'array'|'string'|'number'|'boolean'|'null';
  index: number;                 // 当前子项在该容器中的下标（0-based）
  count: number;                 // 该容器的子项数
  siblings: { key: string|number; index: number; kind: string }[]; // 前后各 2 个
};
type MapTrail = {
  rootKind: string;
  levels: MapLevel[];            // 根 → 当前节点的父级；不含当前行
  current: {
    key: string | number | null; // 根时 null
    kind: string;
    preview: string;             // 截断的值预览
    path: string;                // 规范路径（hover/a11y）
  };
  depth: number;
};
```

- 主线程发 `{ t:'getTrail', rootId, rootVersion, path }`；Worker 由 path/选中行生成 trail。
- 文档修改（replaceNode）后，若选中节点仍在，刷新 trail；被删则回退到父级。
- 不缓存全量；每条 trail 大小 = O(depth + 4×2)。

## 4. 交互

| 操作 | 行为 |
|---|---|
| 选中行变化 | 刷新地图（跟随选中） |
| 点击祖先行 | 主树选中该祖先并滚动到其行 |
| 点击兄弟短标签/刻度 | 主树选中该兄弟（不自动展开；若为折叠容器，选中其行） |
| hover 祖先/兄弟 | Tooltip：完整 key + 完整路径 + 类型/`[i/N]` |
| 面板折叠按钮 | 收成小按钮；状态记在视图状态（不持久化文档） |
| 无选中 | 显示根节点（root + 顶层字段列表的路径塔） |
| 键盘 | 地图本身不可聚焦；提供文本 breadcrumb（见 §6）作为等价导航 |

- 地图与主树选择是**单向跟随**：地图点选会改主树选中；主树选中变化会刷新地图。
- 不在地图上做拖拽/缩放/框选。

## 5. 性能

- 选中变化时 1 次 `getTrail` 往返（p95 目标 <2ms，O(depth)）；Canvas 重绘目标 <1ms。
- 50MB / 2.96M 节点文档：不额外遍历；只沿选中路径 + 每层 ±2 兄弟取值。
- 不阻塞行窗口滚动；地图重绘可与行窗口请求并行。

## 6. a11y

- Canvas `aria-hidden="true"`；面板下方/内部提供文本 breadcrumb：
  `root › data › hotel_list[1234] › rooms[5] › price`，可聚焦、可读屏。
- 面板开合按钮有 `aria-label` / `aria-expanded`。
- 选中变化时 `aria-live="polite"` 播报「当前路径：…」。
- 颜色不单独承载信息：类型同时有文本/图标或色点 + 形状。

## 7. 边界 / 验收

- `data.hotel_list[1234].rooms[5].price`：地图显示 4 层祖先 + 当前；`[1234/5000]`、`[5/12]` 正确；相邻兄弟 key 正确。
- 深 15 层：显示前 2 + 隐藏段 + 当前附近；hover 展示完整路径。
- 无选中：显示根与顶层字段。
- 点击 `rooms` 行：主树选中并滚到 `rooms`；点击兄弟 key：选中兄弟。
- 编辑某节点后：trail 刷新；删除选中节点后回退父级。
- 50MB 文档：选中变化不产生 >16ms 长任务；Canvas 绘制 <1ms。
- DPR 1/2、深浅主题、长 key 截断、根为标量/空对象/空数组。
- 读屏能获得与 Canvas 等价的路径文本。

## 8. 实现备注 / 依赖

- 模块：`ui/json-map.ts`（Canvas 组件）+ Worker 协议 `getTrail`；与 #13 的渲染/UI 分层对齐。
- 依赖 #6 的设计 token（颜色/字体/间距）；#9 的选择语义（选中行、滚动）。
- v1.1 实施；不进入 v1 主线。
