# 保真 / 原始文本视图 / 导入 / 修复 bench（task-3）

零 npm 依赖，全部脚本独立可跑、只往 stdout 打 JSON（便于 Lead 在安静环境复测）。

```bash
# 0) fixtures（一次性）
node prototype/p1/bench/fidelity/gen-fixtures.mjs
# 1) Node：保真扫描 / tokenizer / 原始视图 / 内存
node --expose-gc prototype/p1/bench/fidelity/run-node.mjs      > /tmp/fidelity-node.json
# 2) Chrome（CfT 156 headless）：导入四路径 / paste / 负面对照 / Worker 内原始视图
node prototype/p1/bench/fidelity/run-chrome.mjs --sizes=10mb,50mb --rounds=2 --negative > /tmp/fidelity-chrome.json
# 3) 截断修复
node prototype/p1/bench/fidelity/run-repair.mjs                > /tmp/fidelity-repair.json
```

结论与测量表见 **`docs/design/reassess-fidelity.md`**。

## 目录

| 文件 | 作用 |
|---|---|
| `lib/json-lex.mjs` | 零依赖单遍 JSON lexer；`lexToken`/`lexLine`/`classifyNumberLiteral`/`classifyStringToken` |
| `lib/fidelity.mjs` | 保真扫描器（一次线性扫描，显式深度栈）+ `buildTokenIndex`（raw-slice 成本证据） |
| `lib/raw-view.mjs` | `probeText` 形状探测、`walkPretty` 可恢复行行走器、`PrettyLineView`（检查点索引）、`SourceLineView`、`prettifyToString`（基线） |
| `lib/repair.mjs` | 保守截断修复：EOF 规则 1–6、编辑列表、`summaryText`、`counts` |
| `gen-fixtures.mjs` | 生成病态 / 键序 / 18 个截断 fixture |
| `run-node.mjs` | §2/§3/§4 的 Node 实测（同 V8） |
| `run-chrome.mjs` | §5 的 Chrome 实测；会把 `lib/` 拷进 `fixtures/fidelity/gen/lib/`（MV3 CSP 只允许 `'self'`） |
| `run-repair.mjs` | §6 的修复实测 + provenance 数据形态 |

`prototype/p1/fixtures/fidelity/` 是 MV3 bench 扩展（`page.html`/`page.js`/`worker.js`）；
`data/` 是 committable fixtures，`gen/` 是 `run-chrome.mjs` 生成物（可删）。

## 口径

- 每项 ≥3 次（Chrome 变体 2 轮）取**中位数 + p95**，变体**交错**执行；脚本打印 `env.loadavg`，并发负载时以中位数为准。
- Node 侧内存用 `--expose-gc` + `heapUsed` 增量；Chrome 侧用 `performance.memory.usedJSHeapSize`（`--enable-precise-memory-info`）与 `PerformanceObserver('longtask')`。
- 样本永远从 `.spike/samples/` 读，**不要提交**。
