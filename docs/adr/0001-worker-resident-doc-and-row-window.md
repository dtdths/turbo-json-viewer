# ADR-0001：文档常驻 Worker + 行窗口协议（含展开护栏与多视图根）

- 状态：Accepted
- 日期：2026-10-27
- 依据：`docs/design/reassess-runtime.md`、`docs/design/tech-reassessment.md` §2–§4；
  真机 CfT 156 / M4 / 32GB，n=3–5，静默复测；样本 `.spike/samples/{10mb,50mb}.json`。
- 相关票：#5（P-1 spike）、#7（IR）、#13（模块 seam）

## 背景

#15 实测：50MB 文档 parse 93ms、但「parse 后整树 postMessage 回主线程」的往返是最大单项（151.8ms）。
「文档常驻 Worker、主线程只取视口行窗口」正是为消掉这段成本而设计的，但此前未验证：
异步取行会不会造成滚动空白/卡顿、预取/缓冲怎么设、行模型与身份怎么在 Worker 内组织。

## 决策

**采用架构 A：文档常驻 Worker，主线程零文档，只按视口请求行窗口。**

1. **首帧**：页面把导入数据（`arrayBuffer` transfer 或文本）交给 Worker；Worker `JSON.parse` + 建行模型；
   主线程请求首窗口（36–40 行）并提交 DOM。实测 50MB 首帧 **150ms**（p95 166ms）、10MB **52ms**，零 >50ms 长任务。
2. **行窗口协议**：请求 `{rootId, rootVersion, seq, start, count}`；回包 `Row[]`（40 行 ≈3.1KB）。
   窗口 = 可见行 ± **overscan 8 行**；`|ΔscrollTop| > overscan×rowH` 时按方向追加 **1 屏预取**；
   **单飞 + 合并**（只保留 1 个 in-flight，最新目标覆盖排队目标）+ `seq` 丢弃迟到回包 + `rootVersion` 不匹配回 `STALE_ROOT`。
   MessageChannel 与 postMessage 往返无性能差异（11µs）；用独立 MessageChannel 隔离窗口请求与控制命令。
3. **多视图根**：文档根 `doc`、表达式结果根 `expression`、修复文档根 `repaired`、搜索子集根 `search`；
   行号是根内坐标；id 不必全局唯一。表达式结果引用原节点（filter 10.2 万行 5.8ms、建模型 4.5ms、首窗口 0.3ms）。
4. **滚动上限与展开护栏**：浏览器 `scrollHeight` 上限 33,554,428px → 24px 行高最多 **1,398,101 行**。
   可见行**软预算 1,000,000 行**；`contentPx = min(totalRows×rowH, cap)` + `scrollTop↔行号`缩放映射（实测误差 0 行）；
   到预算拒绝继续「全部展开」并提示替代路径（仅展开前 N 项 / 先过滤）。正常默认折叠路径不会触发。
5. **回退条件（不换主架构）**：低端机窗口往返 >1 帧 → 主线程加 2–3 屏行缓存（H 形态）+ 方向预取；
   仍不够则 overscan 提到 16。**不回退到 B（整树 clone）**：50MB 首帧 321ms、132ms 主线程长任务、页面堆 81.6MB、
   Worker 传输峰值 173.7MB；B 只适合 <10MB 或作为简化实现。

## 后果

- 主线程内存 ≈0.72MB（50MB 文档），Worker ≈73MB；无整树二次分配。
- 随机跳转（拖滚动条）必然 1 帧空白（≈17ms），可接受；平滑滚动靠 overscan 8 压到 0%。
- 主线程需要维护窗口状态机（单飞/合并/seq/版本），并处理滚动锚点（toggle 后按「锚点行 + 像素偏移」重设 scrollTop）。
- 需要 headful 复核：空白率/锚定/长任务/DPR（见重评估 §5.1）；本 ADR 的数字来自 headless。
- 源文本是否常驻 Worker（50MB 文本 ≈95MB）仍未定，见 ADR-0003 与 #7/#11。

## 被否决的替代

| 方案 | 否决理由 |
|---|---|
| B：Worker parse → 整树 clone 到主线程 | 50MB 首帧 321ms、132ms 长任务、页面堆 81.6MB、传输峰值 173.7MB；同步渲染的收益不值这些代价 |
| H：作为默认架构（主线程小缓存） | 平滑滚动空白仅从 11.1%→0.12%，A+overscan 8 已 0%；随机跳转无改善；缓存被随机流量挤掉 |
| SharedArrayBuffer 零拷贝 | 需要 `crossOriginIsolated`；MV3 扩展页实测 false（#15），不可用 |
| canvas 行渲染 | 无浏览器文本层 → 选择/复制/搜索高亮/a11y 全要自造；DOM 行渲染每帧仅 0.03–0.09ms，无性能理由 |


## 修订（2026-10-27）：版本号拆分与结果根策略

- 原 `rootVersion` 拆为：`docRevision`（导入/修复/编辑内容）与 `rowVersion`（展开/折叠/编辑行映射）。
  行窗口校验 `rowVersion`；表达式结果/搜索命中用 `docRevision` 判断 stale。
- 表达式结果根：最多保留最近 **3** 个（LRU），元素引用原节点。
- 搜索**不创建独立 root**：命中集合作为视图状态，跳转 = 展开祖先 + 行号。
- 源文本解析后释放（无原始文本视图）；详见 `docs/design/ir-spec.md`。

## 修订（2026-10-30）：多个 doc 根并存

- 上文 §3「多视图根」列了 `doc` / `expression` / `repaired` / `search` 四类根，但骨架实现只有**一个** `doc` 根
  （`DOC_ROOT_ID = 'doc'`，第二次 `load` 原地覆盖）。多文档标签要求**同时存在多个 `kind='doc'` 的根**
  （`doc:1`、`doc:2`……单调不复用），并由新增的 `closeRoot` 命令显式释放；详见 ADR-0009。
- **行窗口协议不变**：仍以 `{rootId, rowVersion, seq, start, count}` 定位；页面按 `rootId` 丢弃非活动标签的迟到回包。
- `ROW_BUDGET` 是**每根**预算，不是全局预算（多标签各自独立受 1,000,000 行约束）。
- 主线程每标签一份 `RowWindowSource`；切标签不重建根、不重新解析。
