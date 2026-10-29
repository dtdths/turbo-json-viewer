# Turbo JSON Viewer

本地只读 JSON 查看器（Chrome MV3）。文档常驻 Worker、主线程只取视口行窗口、固定行高虚拟化；搜索 / 表达式 / 临时子树编辑全部在本地完成，无网络请求。

## 开发

```bash
npm install
npm run build        # esbuild → dist/（page / worker / sw 三入口）
npm run watch        # 监听重建（改完在 chrome://extensions 点刷新）
npm run check        # typecheck + 单测 + build
npm run smoke        # 真机冒烟：导入 → 首帧 → 展开 → 滚动（headless CfT）
npm run smoke:ext    # 以真实 unpacked 扩展跑同一套冒烟
```

冒烟样本默认用 `.spike/samples/10mb.json`（`.spike/` 已 gitignore）；没有的话用 `.spike/gen-samples.js` 生成，或 `node scripts/smoke.mjs <任意样本路径>`。

## 在 Chrome 里加载

1. `npm run build`
2. `chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选择 `dist/`
3. 点扩展图标打开查看页；拖入 / 选择文件 / 直接 ⌘V 粘贴

品牌版 Chrome（≥137）会忽略 `--load-extension`，自动化验证请用 Chrome for Testing（见 `prototype/p1/README.md`）。

## 目录

- `src/{app,view,viewmodel,core,protocol,shared}` — 分层与依赖方向见 `docs/architecture/README.md`
- `docs/adr/` — 架构决策（0001–0008）；`CONTEXT.md` — 领域词汇
- `prototype/` — 视觉方向（A/B/C）与性能 spike，不发布
- `scripts/smoke*.mjs` — 真机冒烟
- `tests/unit/` — vitest 纯逻辑测试

## 状态

slice 1–4 已可跑：导入 → Worker 解析 → 行窗口 → 树虚拟化/展开折叠/滚动；**搜索完工**（44px 两行虚拟结果列表 + 树命中/当前命中高亮 + 上下条 / Enter / ⌘G / F3 + `docRevision` 过期逻辑，过期 UI 在编辑 slice 5 接入后真实可见）。10MB `hotel` 搜索 **91ms**、跳转 **2.7ms**、37k+ 命中列表滚动 0 长任务；实现进度与实测数字见 `docs/architecture/README.md` §11。

红线：仅 `storage` 权限、无网络、禁 eval、文档不落盘、不改原文件。
