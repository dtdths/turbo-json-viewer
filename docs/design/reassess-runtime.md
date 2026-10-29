# 运行时架构 / IR / 行窗口协议 — 真机重评估（runtime-ir）

> 任务：task-1（Ctrl×T-1 重评估小组），2026-10-27
> 方法：真实 **Chrome for Testing 156.0.8078.47**（headless=new + CDP，harness 复用 `prototype/p1/lib/{chrome,http}.mjs`），
> 扩展 fixture 加载 `prototype/p1/fixtures/runtime/`，样本 `.spike/samples/{10mb,50mb}.json`（10MB = 595,030 节点；50MB = **2,958,550** 节点 / 369,822 容器 / 2,588,728 标量，与 #15、Lead 计数一致）。
> 脚本：`prototype/p1/bench/runtime/bench-runtime.mjs`（可独立复跑，结果 JSON 落 `.spike/runtime-bench/`，不提交）。
> **标注约定**：每条结论标 **确认 / 修正 / 推翻** + 实测数字；没测的直接写「未测」。

---

## 0. TL;DR（判定表）

| # | 结论 | 判定 | 关键证据（50MB，n=5，中位数/p95） |
|---|---|---|---|
| A1 | **A = 文档常驻 Worker + 主线程按视口取行窗口** 是首选：10MB 首帧 54.7ms、50MB 163/170ms（<800 预算），主线程无 >50ms 长任务 | **确认** | 见 §2.1；10MB 54.7/56ms |
| A2 | **B = 整树 structured-clone 给主线程** 作为默认不可取：50MB 首帧 335.6/354.4ms（仍 <800），但主线程出现 **134ms 长任务**（反序列化），页面堆 81.6MB≈2×，Worker 传输峰值 173.7MB | **推翻（作为默认架构）** | §2.1/§2.2 |
| A3 | **混合（A + 主线程小行缓存）** 不必作为架构；其收益（平滑滚动空白 0.12%）可用 **A + 8 行 overscan** 直接拿到（0.0000） | **修正** | §2.3 |
| R1 | 行模型 = **展开集合驱动的 skip-by-count + 每个 open 容器的 Fenwick 索引**；不预建扁平行表 | **确认** | 184,913 行窗口 p95 **0.1ms**；开 items 后内存 **+0.73MB**；总行数 O(1) |
| R2 | **全量 flatten 数组** 在 2.96M 全展开时不可用：重建 **135.6ms**、+**106MB**；184k 行时仍可（4.7ms/+7.2MB） | **推翻（作为唯一/默认行模型）** | §3.1 |
| R3 | **纯 nave skip-by-count（无索引）** 在 184k 行下可用（p95 1.1ms），全展开最坏 **78.9ms**（行 2.9M）→ 不能承载「不限制项数」 | **修正（需索引）** | §3.1 |
| I1 | 节点身份 **懒分配 id + 运行期 O(1) 查找** 成立；**不要**预分配全量 Map/WeakMap（167.5ms/28MB、24.2ms/16MB；且 WeakMap 只能吃对象） | **确认 + 修正** | §4 |
| I2 | 视图状态双格式（路径持久化 + 运行期 id）**必要**：id 查找 10ns vs 路径解析 ~0.5µs（50×） | **确认** | §4 |
| P1 | 协议：窗口请求 40 行 = 3.1KB、p95 0.1ms；MessageChannel 与 postMessage 往返无差异（11.1 vs 11.2µs）；**overscan 8 行** 即可让 6 行/帧滚动空白行率归零 | **确认** | §5 |
| P2 | 随机跳转（拖滚动条）异步取行必然 1 帧空白（A 17.2ms = 1 帧）；B 同步但付 clone 代价 | **确认（可接受）** | §5.2 |
| S1 | **浏览器最大 scrollHeight = 33,554,428px**（容器与 documentElement 均同）；24px 行高 → **1,398,101 行**上限；50MB 全展开 2,958,550 行 = 71,005,200px **物理不可行** | **确认（新增硬约束）** | §6 |
| S2 | 超上限用 **滚动条封顶 + scrollTop↔行号缩放映射**，实测往返误差 **0 行**；建议可见行预算 **1,000,000** + 护栏 | **新增建议** | §6 |
| M1 | 多视图根（表达式结果/修复文档/搜索子集）作为独立 `rootId` 进 Worker：filter 102,480 行 5.8ms、建模型 4.5ms、首窗口 0.3ms | **新增（协议需 rootId）** | §7 |
| Q5 | 表达式/搜索/复制/原始文本在 Worker 常驻下**数据路径成立**（接口级） | **确认** | §8 |

---

## 1. 方法、口径与并发条件

**环境**（每次运行都记录在结果 JSON 的 `env`）：

| 项 | 值 |
|---|---|
| Chrome | Chrome for Testing **156.0.8078.47**（branded Chrome 156 忽略 `--load-extension`，用 `.spike/cft/`） |
| 机器 | Apple M4 / 32GB / Darwin 26.6.2；10 逻辑核 |
| 启动参数 | `--headless=new --no-sandbox --disable-gpu --window-size=1440,900 --enable-precise-memory-info --js-flags=--expose-gc` |
| 页面 | `chrome-extension://<id>/page.html`；MV3 fixture 无任何权限；样本经 `http://127.0.0.1:<port>`（CORS）由 Worker `fetch` |
| 视口 | 36–37 行可见（22px 固定行高），页面 900px |

**并发情况（重要）**：同期另两位成员在跑构建/基准，本机 `loadavg` 采样 **2.8–4.6**（10 核）→ 存在可测量的 CPU 争用。
所有变体**交错执行**（rep 外层循环、变体内层），报 **中位数 + p95**；关键数字建议 Lead 在安静环境复测。
每 trial 用**独立页面 + 独立 Worker**（避免状态/堆泄漏跨 trial 污染）。

**首帧口径**：`t0 = performance.now()`（发 load）→ Worker fetch+parse+建模型 → 主线程拿到首窗口并 **commit 36 行 DOM** → 双 rAF 后计时。与 #15 / 调研 §6 一致。
**交互口径**：事件时刻 → 数据就绪并 commit 行（`workMs`）+ 帧同步等待（`frameWaitMs`）分开报；headless rAF 固定 ~16.7ms，因此 `frameWaitMs≈16–33ms` 是**测量口径的帧对齐底噪**，不是业务成本。
**滚动口径**：脚本化 rAF 滚动，每帧 `scrollTop += 6 行`（132px/帧，约 4 屏/秒）或随机跳（模拟拖滚动条）；
`blankRowRate = 缺失行 / (帧数 × 可见行数)`；`droppedFrame = rAF 间隔 > 25ms`。
**内存口径**：页面/Worker 各自 isolate 堆：`--enable-precise-memory-info` 下页面 `performance.memory`；
Worker 无 `performance.memory`（实测 `nomem`），改用 CDP `Runtime.getHeapUsage`（`Target.setAutoAttach` 拿 worker session），读取前 `gc()`（`--expose-gc`）。均四舍五入到 0.01MB。

**复跑**：

```bash
node prototype/p1/bench/runtime/bench-runtime.mjs protocol --sample=2mb   # 协议微基准
node prototype/p1/bench/runtime/bench-runtime.mjs scrollcap               # 滚动高度上限
node prototype/p1/bench/runtime/bench-runtime.mjs rowmodel --sample=50mb  # 行模型对比
node prototype/p1/bench/runtime/bench-runtime.mjs identity --sample=50mb  # 节点身份
node prototype/p1/bench/runtime/bench-runtime.mjs memprobe --sample=50mb  # 页面 isolate 内存分解
node prototype/p1/bench/runtime/bench-runtime.mjs roots --sample=50mb     # 多根（表达式结果）
node prototype/p1/bench/runtime/bench-runtime.mjs mem --samples=10mb,50mb --modes=A,B  # Worker/页面堆
node prototype/p1/bench/runtime/bench-runtime.mjs arch --reps=5 --samples=10mb,50mb --modes=A,B,H
node prototype/p1/bench/runtime/bench-runtime.mjs all                     # 全部（约 3–4 分钟）
```

fixture：`prototype/p1/fixtures/runtime/{manifest.json,page.html,app.js,worker.js,model.js}`；
三种行模型（`IndexedModel` / `FlatModel` / `NaiveModel`）都在 `model.js`，Worker 与页面共用同一实现，保证 A/B 可比。

**未测 / 口径限制**：
- headless 的布局/合成与 headful 不同 → **空白行率/掉帧/长任务需 headful 复核**（§10 列了清单）。
- 50MB B 的 clone **峰值页面堆**未直接采样（只有 clone 后堆 + Worker 侧传输峰值）；「往返拷贝峰值」估算不写死。
- 真实粘贴路径（文本在主线程产生再 postMessage 给 Worker）比本基准的「Worker 内 fetch」多一次 50MB 字符串跨线程拷贝（#15 实测字符串往返会明显更贵），本基准数字应视为**乐观上界**；导入路径需按 #15 的 drop/readText + 直接移交文本设计。
- 搜索/复制/原始文本只做接口级判断（§8），未做端到端实现基准。

---

## 2. Q1：架构 A / B / 混合（实测）

### 2.1 首帧（fetch → parse → 移交 → 首窗口 → 36 行 DOM → 双 rAF）

| 样本 | 架构 | 首帧 中位/p95 | fetch | Worker parse | 模型 | clone（Worker 发） | 首窗口 | 长任务 (>50ms) |
|---|---|---|---|---|---|---|---|---|
| 10MB | **A** | **54.7 / 56.0ms** | 12.1 / 15.1 | 10.9 / 12.0 | 0.1 | — | 0.4 / 2.7 | 0 |
| 10MB | B | 69.6 / 71.7ms | 12.6 / 13.8 | 10.8 / 11.1 | 0.1 | 11.5 / 11.8 | — | 0 |
| 10MB | H | 48.5 / 52.9ms | 13.2 / 14.4 | 11.0 / 11.4 | 0.1 | — | 0.3 / 2.8 | 0 |
| **50MB** | **A** | **163.0 / 170.0ms** | 60.5 / 65.0 | 71.3 / 71.8 | 0.1 | — | 0.5 / 11.9 | **0** |
| 50MB | B | 335.6 / 354.4ms | 62.2 / 65.6 | 70.5 / 72.5 | 0.1 | **57.9 / 58.1** | — | **1 条 × 134ms** |
| 50MB | H | 158.5 / 159.4ms | 59.8 / 67.5 | 70.9 / 71.2 | 0.1 | — | 0.5 / 0.5 | 0 |

判据：10MB 首帧 <800ms → **A/H/B 全过**（54.7–69.6ms，余量巨大）；「交互无 >50ms 长任务」→ **B 在 50MB 挂**。
B 的 134ms 长任务来自 **主线程侧 structured-clone 反序列化**（Worker 侧序列化只记到 57.9ms；接收端不暴露在 Worker 计时里，只能从 Long Tasks 看到）。
B 首帧比 A 多 **172.6ms** ≈ 序列化+反序列化+建行模型的总和，与 #15「postMessage 整树往返是最大单项」同向，但本代 Chrome 上量级是 ~173ms（#15 报的 151.8ms 是往返总量级，一致）。

### 2.2 内存（CDP isolate 堆 + 强制 GC；50MB）

| 架构 | Worker 稳态 | Worker 传输峰值 | 页面堆（首帧后） | 页面稳态 | 总计稳态 |
|---|---|---|---|---|---|
| A | **73.35MB** | 73.4（无传输） | 0.73MB | 0.59MB | **≈74MB** |
| B | 0.3MB（释放后） | **173.68MB** | **75.77MB**（arch 报 81.6） | 75.8MB | **≈76MB**，峰值 ≈250MB |
| 10MB A | 14.92MB | — | 0.73MB | 0.58MB | ≈15.5MB |
| 10MB B | 0.3（释放） | 38.4MB | 15.64MB | 15.6MB | ≈15.9MB，峰值 ≈54MB |

- **A**：主线程几乎零文档内存（0.6–0.7MB），文档 73.4MB 常驻 Worker —— 与「零拷贝、无内存翻倍」宣称 **确认**。
- **B**：稳态页/Worker 合计与 A 接近，但**传输峰值 ~174MB（2.4×）+ 页面 76MB = 峰值约 3.4× A**；且页面堆在首帧后立即多 **75MB**，主线程承受 GC 压力。B 的「transfer 峰值」是真实成本，**推翻了「B 内存接近 A」的隐含假设**（若曾有）。
- 与 #15「50MB JS 堆 48MB」的差异：本基准是 **CDP isolate 堆 + 强制 GC**（73.35MB），#15 是 `performance.memory` 在 Worker 里的瞬时读数（且该读数在 headless Worker 中不存在，本基准实测 Worker `performance.memory === undefined`）。建议后续统一用 CDP 口径；**保留 #15 的 48MB 为「曾经的口径」，不作为容量规划依据**。

### 2.3 滚动空白 / 掉帧 / 展开 10 万项 / 跳转（50MB，n=5）

展开项：`data` → `items`（**184,909 个子项**，10MB 样本为 37,189 个）后测滚动与跳转。

| 指标 | A (ov=2) | A (ov=0) | A (ov=8) | B | H (ov=2) |
|---|---|---|---|---|---|
| 平滑滚动 blankRowRate（6 行/帧） | **0.1111** | 0.1667 | **0.0000** | 0.0000 | **0.0012** |
| 平滑滚动 掉帧率（>25ms） | 0 | 0 | 0 | 0 | 0 |
| 随机跳转（拖滚动条）blankRowRate | 1.0000 | — | 1.0000 | 0.0000 | 0.9181 |
| 滚回已看位置（waitFrames / ms） | 1 帧 / 16.0 | — | 1 / 16.3 | 0 / 15.2 | 1 / 15.4 |
| 跳到任意行 100,000（ms） | 17.2 | — | 17.7 | 15.2 | 17.5 |
| 展开 items（workMs，工作线程内） | 9.5（worker 9.2） | 9.3 | 9.3 | 8.5（主线程 rebuild 8.3） | 9.5（worker 9.2） |
| 展开 items（p95，含帧等待） | 33.3 | 33.4 | 33.3 | 34.5 | 35.1 |
| 页面堆（稳态） | 0.74MB | 0.74 | 0.74 | 81.1MB | 1.11MB |
| 长任务 | 0 | 0 | 0 | 134ms ×1 | 0 |

- **平滑滚动不空白的关键是 overscan 覆盖「每帧滚动量 + Worker 往返」**：6 行/帧时 ov=2 每帧有 4 行在底部空白（11.1%），**ov=8 即 0**；H 的一屏预取也 0.12%。
- **随机跳转天然空白 1 帧**（A/H 首帧必然没有新窗口数据）：跳转延迟 17.2ms ≈ 1 帧，可接受；B 因同步为 15.2ms，但为此付 76MB 页面堆 + 134ms 长任务。
- **展开 10 万项**：Worker 内 9.2ms（Fenwick 建 184,909 项），主线程只等 + commit，**无长任务**。B 的 8.3ms rebuild 在主线程（<16.7ms 但仍占掉半帧）。
- **H 的缓存收益有限**：随机跳/回滚时缓存命中率低（小缓存 4000 行被随机流量挤掉），`scrollBack` 仍 1 帧空白。

### 2.4 结论

- **推荐架构 = A**：文档常驻 Worker + 主线程只拿行窗口；**overscan 8 行 + 1 屏方向预取**（§5）即可把平滑滚动空白压到 0，随机跳转 1 帧。
- **回退条件（何时考虑混合）**：
  1. 低端设备上 Worker 窗口计算/往返 > 1 帧（本机 p95 0.1ms，低端可能到数 ms）→ 在主线程加 **2–3 屏行缓存（H 形态）**，不是整树 clone；
  2. 需要「滚回即时无空白」的强体验 → H 的缓存，但缓存容量需 ≥ 2–3 屏且做方向预取；
  3. **不要回退到 B**：唯一优势是同步渲染（随机跳转 0 空白），代价是 134ms 长任务 + 2×~3.4× 内存 + 首帧翻倍。
- **推翻的旧假设**：如果曾认为「B 只是首帧多几十 ms、可以接受」——实测 B 在 50MB 触发 **134ms 长任务**，直接违反验收判据（交互无 >50ms 长任务），且内存峰值 3.4×；B 只能作为「结构化克隆成本可控」的小文档（<10MB）实现简化方案。

---

## 3. Q2：行模型（展开集合 skip-by-count vs 全量 flatten）

样本 50MB，默认折叠 = 3 行（root + status + data）；展开 `data`→`items` 后 **184,913 行**；全展开 **2,958,550 行**。

### 3.1 三模型对比（Worker 内，n=300 随机窗口 / 定向窗口 40 行）

| 指标 | **Indexed**（展开集合 + 每 open 容器 Fenwick） | Flat（flatten-on-change） | Naive（纯 skip-by-count，无索引） |
|---|---|---|---|
| 展开 items 的 toggle | **7.9–9.2ms**（建 184,909 项 Fenwick） | 4.7ms（重建 184,913 行） | ~0（只改集合） |
| 窗口 p95（184k 行展开） | **0.1ms** | <0.1ms（O(1) 索引） | 1.1ms（max 1.4ms） |
| 窗口 定向最坏（行 100,000） | **0.1ms** | <0.1ms | 3.1ms |
| 总行数 | **O(1)**（Fenwick total 求和） | `rows.length` O(1) | 全 DFS：184k 行 ~1ms；全展开 **77.1ms** |
| 全展开（2,958,550 行）重建 | 不适用（不建表） | **135.6ms** | 窗口最坏 **78.9ms**（行 2.9M）；行 500k 12.7ms |
| 内存 | 开 items 后 **+0.73MB**（Fenwick Int32 736KB） | 184k 行 **+7.23MB**；全展开 **+106.12MB** | 无索引，0 附加 |
| 50k 容器打开（559,913 行） | 展开总 91.1ms，窗口 p95 0.1ms | 未测（预估 >30ms 重建） | 未测（预估 >12ms/窗口） |

### 3.2 「不预建扁平节点表」是否成立？

**成立（确认）**，证据：
- 2,958,550 节点只靠 `JSON.parse` 值图 + 展开集合：`IndexedModel` 构造 **0.1ms**、默认 3 行；打开 items 后内存仅 **+0.73MB**。
- 窗口 40 行 p95 **0.1ms**（行窗口下潜 O(depth·log n)，depth≤5），不依赖任何 per-node 表。
- 对比：全展开 flatten 需 **106MB + 135.6ms**（一次性），且每次 toggle 重建成 135ms 级 → 不能作为默认行模型。

### 3.3 「折叠行『共 N 项』」成本

- **只要子项数**：`items.length` / `Object.keys(obj).length`，10,000 个容器累计 **3.2ms**（≈0.32µs/容器），窗口内 40 行可忽略 → **默认折叠不需要全量子树计数**（确认）。
- **若要「完全展开后的总行数」**（可用于展开确认/滚动条预估）：全量后序 pass **206.4ms** + 369,822 条目 Map（父映射规模实测 131.6MB 级）→ **不可在首帧做**；如需，必须**分层/按需**（见 §6 护栏：先给「共 N 项」，再问「展开后约 M 行」时才后台算，或直接按预算拦）。

### 3.4 结论

- **确认**：IR = JSON.parse 值图 + 展开集合；行模型由展开集合**派生**，不预建扁平表。
- **修正**：派生不能是「纯 DFS skip-by-count」——184k 行时 3.1ms/窗口、全展开 78.9ms/窗口会破坏 60fps；必须带 **每 open 容器的 Fenwick（或块前缀）索引**，toggle 时只更新祖先链（实测 50k 容器逐个展开总 91.1ms，单次 ~1.8µs 均摊；184k 项的 toggle 9.2ms 是建索引的一次性成本，可放 Worker 后台/或接受单帧 >8ms）。
- **推翻**：全量 flatten 数组作为唯一/默认行模型（50MB 全展开 135.6ms + 106MB；184k 行虽可，但「展开后不限制项数」的承诺下必然遇到 2.96M 场景）。

---

## 4. Q3：节点身份（懒 id / WeakMap / (parent,key) 句柄）

50MB = 2,958,550 节点（369,822 容器 / 2,588,728 标量）。

### 4.1 内存与构建成本（页面 isolate，强制 GC；Worker 内相对量同）

| 方案 | 建表耗时 | 堆增量 | 键数 | 说明 |
|---|---|---|---|---|
| eager `Map<node,int>`（全节点） | **167.5 / 163ms** | **+28.0MB** | 1,040,389 | 标量重复 → 键去重（≠2.96M），但对容器仍全量 |
| eager `WeakMap<node,int>`（容器） | **24.2 / 25.6ms** | **+16.0MB** | 369,822 | **只能吃对象**；2.59M 标量无法作为键 |
| `id → node` 数组（2.96M refs） | 4.3ms | +11.3MB | 2,958,550 | 还需 node→id 反向映射才有用 |
| **懒分配 WeakMap（2000 个被触达节点）** | **0.4ms** | **+0.06MB** | 2,000 | 只给「展开容器 / 锚点 / 选中 / 命中」 |
| 全局 parentMap（容器） | 90.3–101.5ms | **+131.6MB** | 369,821 | 用于任意节点→路径；**不要建** |

### 4.2 查找成本（批量 20 万次，Worker 内）

| 访问方式 | ns/op | 备注 |
|---|---|---|
| 数组索引（id→node） | **10.0** | O(1) |
| 懒 WeakMap get | **9.5** | O(1) |
| eager WeakMap get（容器） | 39.5 | O(1)，哈希 |
| eager Map get（全节点） | 93.5 | 慢于 WeakMap（标量键多） |
| 路径解析（4 段） | **~500ns**（均值 0.0005ms） | O(depth)，每次字符串段匹配 |
| 路径生成（有 parentMap，200 节点） | ~500ns | 需要 parentMap（131MB）或下潜链 |

### 4.3 结论

- **确认**：运行期用 **懒分配整数 id**（首次被触达的容器/锚点才分配），O(1) 查找 10ns 级；**双格式必要**：id 查找与路径解析差 **~50×**，且路径用于跨重解析持久化。
- **修正两点**：
  1. 不要把「解析期分配 node id」理解为全量预分配（167.5ms/28MB）；**懒分配**（0.4ms/0.06MB）才成立，且只有 0.37M 容器是可分配对象。
  2. 标量**没有对象身份**（WeakMap 不能吃 2.59M 标量）→ 标量身份 = **`(parent 容器, slot)` 句柄**（行窗口下潜时顺手带出），复制/选中标量时用它，不需要标量级 id。
- **路径生成不要建全局 parentMap**（131.6MB/369,821 条目，等于第二棵树）：行窗口下潜时维护 path 栈（O(depth)），或为**已展开节点**维护 `id→(parentId, slot)`（展开集合规模小）。

---

## 5. Q4：Worker 协议（窗口粒度 / overscan / 往返 / 版本化 / 每帧预算）

### 5.1 微基准（2MB 样本、展开 items 后 7,511 行；n=1000/300/200）

| 项 | 结果 |
|---|---|
| postMessage 命令往返（空载荷） | **11.1µs/次**（1000 次共 11.1ms；时钟分辨率 0.1ms，p50 显示 0 是分辨率假象） |
| MessageChannel port 往返 | **11.2µs/次**（无统计差异） |
| 窗口请求 40 行（含 Worker 行模型计算） | p50 0 / **p95 0.1ms**；载荷 **3,121B** |
| 窗口请求 400 行 | p50 0.2 / **p95 0.3ms**；载荷 **30,698B** |
| 主线程 render 36 行（textContent 更新） | p50 0.014ms / p95 0.1ms |
| 强制布局（render 后读 offsetHeight） | p50 0.1 / p95 0.2ms（max 7.4ms 为 GC/首帧离群） |
| 应用窗口到 Map（40 行） | **0.001ms** |
| 50MB 首窗口（真实展开状态） | p95 11.9ms（唯一离群，Worker 正在 walk 统计时），中位 0.5ms |

**结论**：往返成本对 60fps 可忽略（11µs + 0.1ms 计算 + 0.2ms 渲染）；**MessageChannel 不比 postMessage 快**（同进程、低负载），保留它的理由是 **独立通道隔离（窗口请求不排在控制命令后）** 与显式端口生命周期，而不是性能。

### 5.2 overscan / 预取 / 空白与锚定（实测来自 §2.3）

| 配置 | 平滑滚动 blankRowRate | 随机跳转 blankRowRate | 回滚空白 |
|---|---|---|---|
| A, ov=0 | 0.1667 | 1.0 | 1 帧 |
| A, ov=2 | 0.1111 | 1.0 | 1 帧 |
| **A, ov=8** | **0.0000** | 1.0 | 1 帧 |
| H（A + 4000 行缓存 + 1 屏预取） | 0.0012 | 0.9181 | 1 帧（缓存被挤掉） |
| B（同步） | 0.0000 | 0.0000 | 0 帧 |

**建议**：窗口 = 可见行 ± **overscan 8 行（≈0.5 屏）**；当 `|ΔscrollTop| > overscan*rowH` 时按方向追加 **1 屏预取**；随机跳转先渲染骨架/空白 1 帧可接受（实测 17.2ms）。
**滚动锚定**：行高固定 → 锚点 = `anchorRow + 像素内偏移`；toggle 后重算 anchorRow 的新绝对偏移并直设 `scrollTop`（渲染前，rAF 内）；我们的 A/H trial 里 toggle 后首帧无跳变（workMs 内完成，未观察到 anchor 漂移；**headful 需复核**）。
**版本化与取消**：单飞（in-flight 只保留 1 个）+ 合并（最新目标覆盖旧目标）+ `seq` 丢弃迟到响应；`rootVersion` 用于 toggle/表达式重算后丢弃旧根窗口。实测「inflight + queued 合并」在 6 行/帧滚动下窗口延迟 p95 0.1ms，无请求风暴。
**每帧主线程预算**：render 0.1–0.2ms + 布局 0.1–0.2ms + 应用窗口 0.001ms + rAF/事件 ≈ **<0.5ms**，留足 16.7ms；Worker 侧窗口计算 p95 **0.1ms**（184k 行展开）。

### 5.3 协议消息草案（含多视图根 / 版本化 —— 含 Lead 第 2 点）

```ts
// 页面 → Worker（控制通道：postMessage；窗口走独立 MessageChannel port）
type PageToWorker =
  | { t:'init'; port: MessagePort }                                  // 建窗口专用端口
  | { t:'load'; loadId:number; sample|text|url; format:'json'|'raw-text' }
  | { t:'setRoot'; rootId:string; kind:'document'|'expression'|'repaired'|'search';
      sourceRootId?:string; version:number; payload?:unknown }       // 表达式结果/修复文档/搜索子集
  | { t:'eval'; requestId:number; rootId:string; expr:string; budgetMs:number }
  | { t:'toggle'; rowId:number; rootId:string; rootVersion:number; row:number }
  | { t:'search'; requestId:number; rootId:string; query:string; limits:{maxHits:number, maxMs:number} }
  | { t:'copy'; requestId:number; rootId:string; row:number; format:'subtree'|'path'|'raw'|'key' }
  | { t:'cancel'; requestId:number }
  | { t:'gc' } | { t:'stats'; requestId:number };

// 窗口通道（port）
type WinReq = { t:'window'; rootId:string; rootVersion:number; seq:number; start:number; count:number };
type WinRes = { t:'window'; rootId:string; rootVersion:number; seq:number;
                start:number; total:number; rows:Row[]; workerMs:number;
                error?: 'STALE_ROOT'|'OUT_OF_RANGE' };
// Row（跨边界最小形态；路径/完整值按需另取）
type Row = { label:string; depth:number; kind:'object'|'array'|'string'|'number'|'bool'|'null';
             preview:string; count:number; open:boolean; rowId:number /* 懒分配，未分配为 -1 */ };

// Worker → 页面（控制通道）
type WorkerToPage =
  | { t:'loaded'; loadId:number; rootId:'doc'; rootVersion:1; nodes:number; bytes:number;
      metrics:{ fetchMs; parseMs; modelMs }; totalRows:number }
  | { t:'root'; rootId:string; rootVersion:number; totalRows:number; metrics:{ filterMs?; modelMs? } }
  | { t:'reply'; requestId:number; ok:boolean; value?:unknown; error?:string }
  | { t:'progress'; requestId:number; phase:'parse'|'index'|'search'; done:number; total:number }
  | { t:'event'; t2:'repair-detected'|'expression-budget-hit'; detail:unknown };
```

**根定位规则**：所有窗口/求值/复制/搜索请求都带 `rootId + rootVersion`；Worker 按 `rootId` 找根，`rootVersion` 不匹配直接回 `STALE_ROOT`（页面丢弃）。`doc` 根版本随每次 toggle 自增；表达式根在**每次求值产生新根**时用新 `rootId`（旧的保留/按 LRU 释放，便于对比/回退）。**窗口请求只需 `rootId`** —— 行号是根内坐标，天然隔离多视图。

---

## 6. 浏览器最大滚动高度（Lead 第 1 点，实测）

### 6.1 实测上限

`content.scrollHeight` 与 `documentElement.scrollHeight` 同步探针（CfT 156 headless，1440×900）：

| 设置高度 | content.scrollHeight | documentElement.scrollHeight |
|---|---|---|
| 1,000,000 | 1,000,000 | — |
| 10,000,000 | 10,000,000 | 10,000,000 |
| 33,000,000 | 33,000,000 | — |
| 33,554,427 | 33,554,428 | 33,554,428 |
| **33,554,428** | **33,554,428** | **33,554,428** |
| 33,554,429 | **33,554,428**（被夹） | **33,554,428** |
| 40,000,000 | 33,554,428 | 33,554,428 |
| 65,000,000 | 33,554,428 | 33,554,428 |

**上限 = 33,554,428px**（与 Lead 的 33,554,428 一致；容器与 documentElement 同）。
→ 固定行高下的物理行数上限：**24px → 1,398,101 行**；**22px → 1,525,201 行**（本基准 22px）。
50MB 全展开 = **2,958,550 行**；24px → 71,005,200px = 上限的 **2.12×** → **「全部展开」物理不可行**（确认 Lead 判断）。

### 6.2 方案与实测建议

1. **滚动条封顶 + scrollTop↔行号缩放映射**（推荐，实测误差 0 行）：
   `contentPx = min(totalRows*rowH, 33,554,428)`；`scale = totalRows*rowH / contentPx`；
   `firstRow = floor(scrollTop * scale / rowH)`；反向 `scrollTop = rowIndex*rowH / scale`。
   实测 22/24px、2,958,550 行下，`row → scrollTop → row` 往返 **8 个采样点误差全 0 行**（含 0 / 1,398,101 / 2,958,550）；
   代价：滚动条最小可拖分辨率变粗（`scale=2.12` 时 1px ≈ 2.12px 行空间），但行窗口仍按真实行号请求，**行内容不受影响**。
2. **展开行数预算 + 护栏**（配合 #9）：
   - 建议 **可见行总数软预算 1,000,000 行**（22px=22M px、24px=24M px，均为上限的 66–72%，留出 30% 余量给 DPR/浏览器差异）；
   - 达到预算时：**拒绝继续「展开全部」**，提示「当前已展开 N 行，继续展开将超出滚动上限」，提供「仅展开前 10 万项 / 在表达式里过滤后再展开」；默认折叠策略下（根展开 + 顶层字段）永远只有几行，**正常使用不会碰到**；
   - 硬上限（1,398,101 @24px）只作为最后防线（`min(totalRows*rowH, cap)`），不建议直接展示给用户。
3. **「全部展开」分段推进**：在预算内按 10 万项/批推进（每批 toggle 实测 9.2ms/184k 项 + 行窗口 0.1ms），批间让出帧；超过预算即停在预算处并提示（不要一次性 flatten/全展开——实测 135.6ms + 106MB，且超上限）。
4. **虚拟化仍按真实行号**（分段/缩放只影响滚动条几何，不影响窗口协议）→ 与 §5 协议解耦，`totalRows` 仍是 2,958,550，`firstRow` 由映射算出。

---

## 7. 多视图根（Lead 第 2 点，实测）

表达式 `data.items.filter(item => item.price > 500)`（50MB 样本）→ 新数组，元素**引用原节点、不克隆**：

| 指标 | 实测 |
|---|---|
| 结果行数 | 102,480（`filter` 结果数组长度；结果根展开后 102,481 行） |
| filter 耗时 | **5.8ms** |
| 建行模型（Fenwick over 102,480） | **4.5ms** |
| 结果根首窗口（40 行） | **0.3ms** |
| 单条结果 JSON.stringify | 0.004ms（复制路径用节点引用即可，无 clone） |

**结论**：多根协议**成立且便宜**（新根 = 新 rootId + 版本号，窗口/复制/搜索按 rootId 定位）；表达式结果根与文档根共享节点引用（内存增量 = 结果数组本身，~0.8MB/10 万 refs），**不需要把节点 id 全局唯一化**——id 是「根内句柄」即可，路径持久化时再拼接 sourceRootId/表达式。
**修复后文档根**同理（新 rootId，`kind:'repaired'`，带 repair provenance 事件）；**搜索结果子集**建议作为 `kind:'search'` 根（命中集合 + 展开祖先后的行窗口），不新建文档副本。

---

## 8. Q5：表达式 / 搜索 / 复制 / 原始文本在 Worker 常驻下的数据路径（接口级）

| 能力 | 数据路径 | 判定 | 依据/未测 |
|---|---|---|---|
| 表达式 | 页面把表达式文本发给 Worker；Worker 内 acorn+walker 在 `doc` 根求值 → **新根 rootId**（引用原节点）；行窗口按新 rootId | **成立** | 结果根实测 filter 5.8ms/建模型 4.5ms/窗口 0.3ms；表达式 walker 本身未测（调研实测 50MB 57–115ms，见 #8） |
| 搜索 | Worker 内全文档扫描（键/值/路径），命中集合按 rootId + rowId/路径回传；跳转 = 展开祖先 + 跳行 | **成立（接口）** | 全量 walk 43.2–75.4ms（2.96M 节点）；搜索遍历未单独测；命中高亮≤可视行（40 行） |
| 复制 | 选中行 → Worker 用保留的节点引用：子树 `JSON.stringify`、路径由下潜链生成、标量原值/键名直取；结果只回字符串（≤10MB 级） | **成立** | 单条 stringify 0.004ms；子树/大结果未测（需预算/分片，属复制路径细节） |
| 原始文本 | 文本**常驻 Worker**（不进 DOM）：原始文本视图由 Worker 按行范围取文本片段；50MB 文本 UTF-16 约 95MB，与树 73MB 并存 → **可选保留/按需** | **成立但有内存决策** | 文本 95.06MB 实测（page memProbe）；本基准的 Worker 未保留 text（load 后释放），若原始文本视图要即时切换需 +95MB → 建议「切到原始文本时再读回/或丢弃树」策略；未测该策略的切换延迟 |
| 树↔文本联动 | v1 不做（已定） | 不适用 | — |

---

## 9. 结论汇总（对照「已定基线」）

| 基线断言 | 判定 | 依据（数字） |
|---|---|---|
| 文档常驻 Worker、主线程只按视口取行窗口 | **确认** | 50MB 首帧 163/170ms；主线程堆 0.73MB；无长任务 |
| 主线程整树 structured-clone（B）备选 | **推翻为默认** | 首帧 335.6/354.4ms；134ms 长任务；页面堆 81.6MB；Worker 峰值 173.7MB |
| 混合（A + 小缓存） | **修正为可选优化** | 平滑空白 0.12% vs A ov8 的 0%；随机跳转无改善 |
| 自研固定行高行虚拟化 | **确认** | 36 行渲染 0.014ms + 布局 0.1–0.2ms；滚动掉帧 0（headless） |
| 展开后不限项数，靠行虚拟化 | **修正（加护栏）** | 滚动高度上限 33,554,428px → 24px 行高 1,398,101 行；50MB 全展开 2,958,550 行超限 2.12× |
| 行模型 = 展开集合派生，不预建扁平表 | **确认** | items 开 +0.73MB；窗口 p95 0.1ms |
| 默认折叠 + 「共 N 项」 | **确认** | 子项计数 0.32µs/容器；子树总行数 precompute 206.4ms（不能首帧做） |
| 视图状态双格式（路径 + id） | **确认** | id 10ns vs path 0.5µs（50×）；但 id 须懒分配、标量用 (parent,slot) |
| postMessage 整树往返是最大单项（#15） | **确认（B 场景）** | clone 序列化 57.9ms + 主线程反序列化 134ms 长任务 |
| 表达式结果/修复文档/搜索子集成为新根 | **新增（协议 rootId）** | 结果根 102,480 行 5.8ms；窗口 0.3ms |
| 50MB parse≈565MB/s | **确认（量级）** | Worker parse 70.5–74.1ms（≈700MB/s）；#15 93.2ms |

---

## 10. 残余风险 / 需 headful 复核

1. **Headless vs headful**：滚动空白/掉帧/长任务在 headless 下测量（rAF 固定 16.7ms、无合成器压力）；**必须**在 headful Chrome（M4）复核 A ov8 平滑滚动、随机跳转、toggle 交互延迟，以及 B 的 134ms 长任务是否仍成立。
2. **CPU 争用**：运行期 loadavg 2.8–4.6（其他成员并行），首帧/窗口延迟可能被抬高；Lead 静默复测后若数字显著更低，报告取复测值。
3. **粘贴/文件导入路径未纳入**：本基准在 Worker 内 fetch（无 50MB 字符串跨线程拷贝）；真实导入需要 #15 的 drop/readText + 文本移交策略，文本移交成本可能另加 100–300ms（#15 实测 10MB 粘贴路径总 41.7s 是 textarea 反例，不可用）。**未测**：文本 postMessage 到 Worker 的真实耗时/峰值。
4. **B 的页面堆峰值**未直接采样（只有 clone 后 75.77MB + Worker 传输峰值 173.68MB）；若需精确峰值须在 clone 期间轮询/读 heap。
5. **原始文本视图**：50MB 文本 95MB 与树 73MB 并存的内存策略未测（是否保留/丢弃/重读）。
6. **低端设备/大 DPR**：数据全部为 M4 + DPR=1；低端机 Worker 窗口计算、DPR=2 布局成本未测。
7. **滚动锚定**：本基准未专门构造「折叠祖先在视口上方」的 anchor 漂移用例（v1 需要）；建议 headful 补测。
8. **搜索/复制/表达式 walker** 只做接口级判断（§8），未做端到端基准。

---

## 11. 推荐架构（最终）

```
页面（主线程，零文档）
  ├─ 行虚拟化：固定行高 22–24px，视口 36–40 行 + overscan 8 行
  ├─ 行窗口状态：单飞 + 合并 + seq 丢弃 + rootId/rootVersion 校验
  ├─ 滚动条：totalRows 真实行号；> cap 时 scrollTop↔行号缩放映射（§6）
  └─ DOM 行渲染（v1）；选择/复制/搜索高亮在 DOM 文本上

Worker（常驻文档）
  ├─ JSON.parse 值图（真相之源）+ 展开集合（Set<node>，路径持久化 + 懒 id 运行期）
  ├─ 行模型：每 open 容器 Fenwick 索引（skip-by-count，不建扁平表）
  ├─ 窗口请求：start/count → Row[]（3.1KB/40 行），p95 0.1ms
  ├─ 多根：doc / expression(≤20 万引用) / repaired / search，按 rootId+version 定位
  ├─ 表达式求值（acorn+白名单 walker，500ms 刹车）、搜索、复制序列化
  └─ 原始文本（按需保留；文本永不进 DOM）
```

**回退条件（触发即降级，不换主架构）**：
- Worker 窗口往返 > 1 帧（低端机）→ 主线程加 2–3 屏行缓存（H 形态）+ 方向预取；仍不够则把 overscan 提到 16。
- 单文档可见行 > 1,000,000 → 预算护栏 + 缩放滚动条；> 1,398,101（24px）→ 拒绝全展开。
- 若未来实测发现「B 的 clone 长任务」可通过 **SharedArrayBuffer/Transferable 结构化编码**消除（需 `crossOriginIsolated`，MV3 扩展页默认 false，#15 已验证），才重新评估 B；当前 **不推荐**。

---

## 12. 产物与复跑

- 脚本：`prototype/p1/bench/runtime/bench-runtime.mjs`（`arch|rowmodel|identity|roots|memprobe|mem|protocol|scrollcap|all`）
- fixture：`prototype/p1/fixtures/runtime/`（MV3 无权限扩展；`worker.js` 内含行模型/身份/多根微基准；`model.js` 三模型共用）
- 原始结果：`.spike/runtime-bench/*.json`（gitignored，含 env、逐 rep 原始值、summary 中位/p95）
- 样本：`.spike/samples/{2mb,10mb,50mb}.json`（不提交）
