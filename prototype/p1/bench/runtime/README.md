# runtime bench（task-1 重评估）

`node prototype/p1/bench/runtime/bench-runtime.mjs <command>` — 真实 Chrome（CfT 156）+ CDP，
扩展 fixture 在 `prototype/p1/fixtures/runtime/`，样本从 `.spike/samples/`（不提交）。

| command | 内容 | 约耗时 |
|---|---|---|
| `protocol` | postMessage vs MessageChannel 往返、窗口请求载荷/延迟、render+layout 成本 | 8s |
| `scrollcap` | 浏览器最大 scrollHeight 探针 + scrollTop↔行号缩放映射误差 | 5s |
| `rowmodel` | Indexed / Flat / Naive 三行模型：toggle、窗口延迟、全展开成本、内存 | 8s |
| `identity` | 懒 id / eager Map / WeakMap / id 数组 / 路径解析 的构建与查找成本 | 8s |
| `memprobe` | 页面 isolate 内存分解（树、Map、parentMap、FlatModel、Fenwick） | 8s |
| `roots` | 多视图根：表达式结果根（filter 引用原节点）建立与首窗口 | 6s |
| `mem` | Worker（CDP Runtime.getHeapUsage）/页面堆：A vs B | 8s |
| `arch` | A/B/H 首帧、滚动空白率、toggle、跳转、长任务、内存（默认 5 rep，变体交错） | 60–120s |
| `all` | 以上全部（`--reps=` 控制 arch 重复数） | 2–4min |

常用参数：`--reps=5`（arch 重复次数）、`--samples=10mb,50mb`、`--modes=A,B,H`、`--sample=50mb`。

输出：stdout 打印 JSON；原始结果落 `.spike/runtime-bench/<command>-<ts>.json`
（含 `env`：Chrome 版本 / loadavg / cpus，用于判断并发争用）。

注意：
- 需 Chrome for Testing（`.spike/cft/`，harness 自动选；品牌版 Chrome ≥137 忽略 `--load-extension`）。
- 扩展启动参数含 `--enable-precise-memory-info --js-flags=--expose-gc`；Worker 堆通过
  `Target.setAutoAttach` 后的 worker session 读 `Runtime.getHeapUsage`（Worker 无 `performance.memory`）。
- 同一时刻只跑一个重负载 Chrome；arch 变体已交错，报告取中位数/p95。
- headless 的滚动/长任务数字仅作相对比较，关键结论需 headful 复核（见 `docs/design/reassess-runtime.md` §10）。
