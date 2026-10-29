# bejson.com JSON viewer 基线（竞品 / UX 参考）

用真实页面（`https://www.bejson.com/jsonviewernew/index.html`）复现「大 JSON 首帧卡 + 搜索卡」，作为本产品要超越的竞品基线。

```bash
# 首帧（不跑搜索）
SEARCH=0 node prototype/p1/bench/bejson/bench-bejson.mjs .mock/1.json
# 首帧 + 搜索（默认 120s 观察窗口；可用 SEARCH_CAP_MS 调整）
node prototype/p1/bench/bejson/bench-bejson.mjs .mock/1.json
node prototype/p1/bench/bejson/bench-bejson.mjs .spike/samples/2mb.json
```

- 页面是第三方 ExtJS 2.2 应用；bench 用 `Ext.getCmp('edit').setValue(text)` + `fireEvent('change')` 模拟「粘贴后触发解析/建树」的路径。
- 文本通过 `lib/http.mjs` 的 CORS 服务喂给页面（真实用户是剪贴板粘贴；两条路径的差异见 `docs/research/bejson-baseline.md`）。
- 指标：`setValueMs` / `textareaLayoutMs` / `changeHandlerMs` / 长任务 / DOM 峰值 / 堆；搜索用 DOM 稳定作为结束条件。
- 结果只用于对比分析，**不要**把这里的数据当成产品性能数字。
