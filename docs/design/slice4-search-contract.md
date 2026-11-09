# Slice 4（搜索完工）实现契约 — 2026-10-29

> 状态：**已实现（2026-10-29）**，验收数字见 `docs/architecture/README.md` §11「slice 4 搜索验收」。
> 注：`docRevision` 过期分支有 SearchState 单测 + dev hook `searchMarkStale()` 验收；真实操作触发要等 slice 5 编辑接入。
> 本文件是 slice 4 并行开发的唯一接口契约；实现细节与分层约束见
> `docs/architecture/README.md`（§3.3/§3.4/§4 搜索数据流）与
> `docs/architecture/seams.md`（S2/S3）。
>
> 分层不变：`app → view → viewmodel → protocol ← core`。
> - `viewmodel/search-state.ts` 纯 TS、零 DOM、可单测；
> - `view/panels/search-panel.ts` 只做 DOM（虚拟列表 + 头部/过滤/空态），**不发请求**；
> - `app/main.ts` 是唯一装配点（调 `core.search` / `core.expandTo`、把结果推给 view）；
> - **不改 protocol 形状、不改 core 语义**。

## 1. 视觉/行为目标（C · 工作台，`docs/design/direction.md` §6）

- 左面板 320px：查询框（focus ring）+ 命中总数（未过滤 total；truncated 时 `50,000+`）+ 上一个/下一个 + `n / 过滤后数量` + 过滤（全部/键名/值）。
- 结果列表**虚拟滚动**：行高 **44px**，两行 = 路径（命中高亮）+ 匹配说明（键名/值）+ 值预览/类型；spacer = `size × 44`。
- 树上命中的行 `is-hit`（琥珀底 + `<mark>`，能力已存在），当前命中行 `is-current`（边框）。
- 跳转 = 展开祖先（`expandTo`）→ 选中该行 → 树滚到该行 → 结果列表滚到该行。
- 边界：空查询清空；无命中态；`truncated` 提示；`seq` 过期丢弃；`docRevision` 不匹配 → 清空并提示重搜。
- 全部文本走 `textContent` / `createElement` / `replaceChildren`，**禁 `innerHTML`**。
- 范围裁定：本 slice **不做** Aa / `.*` 开关（大小写走 core 默认不敏感；正则不在 v1），`direction.md` §6 的三开关已注记延后；键名/值过滤由 all/key/value 承担。
  - **后续（2026-11-09）**：该裁定已被 **ADR-0014** 解禁——`Aa`（区分大小写）与 `.*`（正则）落地，语义矩阵 / `BAD_PATTERN` / ReDoS 安全边界 / 不持久化见 ADR-0014。本文件其余契约（`SearchState` / 面板 / 跳转 / 过滤 / 50k 截断）不变。

## 2. `src/viewmodel/search-state.ts`（owner: search-vm-dev）

纯 TS 状态机，除 `Hit` 类型外不 import 任何东西；不 import DOM/core。

```ts
import type { Hit } from '../protocol/types';

export type SearchFilter = 'all' | 'key' | 'value';
export type SearchPhase = 'idle' | 'searching' | 'ready' | 'stale';

export const SEARCH_RESULT_ROW_HEIGHT = 44;
export const SEARCH_RESULT_OVERSCAN = 4;

export interface SearchCounts { all: number; key: number; value: number; }

/** core.search 回包里与视图相关的最小形状 */
export interface SearchReplyInput {
  seq: number;
  docRevision: number;
  hits: Hit[];
  /** 回包命中数（core 当前返回 hits.length；截断时即 SEARCH_LIMIT，raw 需放开上限另算） */
  total: number;
  truncated: boolean;
}

export interface SearchWindow { start: number; count: number; }

/** 交给 SearchPanel.render() 的只读快照 */
export interface SearchPanelView {
  query: string;
  phase: SearchPhase;
  /** 过滤后的命中（current 索引指向这个数组） */
  hits: readonly Hit[];
  counts: SearchCounts;
  /** 回包 total（未过滤） */
  total: number;
  /** 过滤后数量 = hits.length */
  size: number;
  /** -1 = 没有当前命中 */
  current: number;
  filter: SearchFilter;
  truncated: boolean;
}

export interface SearchStateOptions {
  rowHeight?: number;   // 默认 SEARCH_RESULT_ROW_HEIGHT
  overscan?: number;    // 默认 SEARCH_RESULT_OVERSCAN
  filter?: SearchFilter; // 默认 'all'
}

export function computeResultWindow(
  size: number,
  scrollTop: number,
  viewportRows: number,
  opts?: { rowHeight?: number; overscan?: number },
): SearchWindow;

export class SearchState {
  readonly rowHeight: number;
  readonly overscan: number;
  constructor(opts?: SearchStateOptions);

  get seq(): number;            // 最近一次 begin 返回的 seq；初始 0
  get query(): string;          // 最近一次 begin 的查询（已 trim 由调用方保证）
  get stale(): boolean;
  get pending(): boolean;
  get filter(): SearchFilter;
  get hits(): readonly Hit[];   // 过滤后
  get allHits(): readonly Hit[];// 未过滤（回包原序）
  get counts(): SearchCounts;
  get total(): number;          // 回包 total
  get size(): number;           // 过滤后数量
  get truncated(): boolean;
  get current(): number;        // 过滤后索引；-1 = 无

  currentHit(): Hit | null;
  hitPaths(): ReadonlySet<string>; // 全部命中（未过滤）的 path 集，树高亮用；同一批内返回同一 Set 实例
  indexOfPath(path: string): number; // 未过滤命中里的下标，找不到 -1

  /** 开始一次搜索：seq += 1、清空旧结果、pending=true；query==='' 时 pending=false（idle）。 */
  begin(query: string): number;
  /**
   * 采纳回包。返回 true 表示已采纳：
   *  - reply.seq !== 当前 seq → 忽略，返回 false（不改任何状态）
   *  - reply.docRevision !== 入参 docRevision → 清空结果 + stale=true + pending=false，返回 false
   *  - 其它：写入 hits/total/truncated，重算 counts/过滤/hitPaths，current=首条或 -1，pending=false，stale=false，返回 true
   */
  apply(reply: SearchReplyInput, docRevision: number): boolean;
  /** 文档已变更：清空结果 + stale=true；返回是否发生变化。 */
  markStale(): boolean;
  /** 清空 query/结果/current/stale（seq 不变）。 */
  clear(): void;
  /** 切换过滤；重建过滤列表、重算 counts、current 夹到 [0, size-1]（size 为 0 → -1）。 */
  setFilter(filter: SearchFilter): void;
  /** 选中过滤后下标（向下取整 + 夹紧）；返回 current；size 为 0 → -1。 */
  select(index: number): number;
  /** 环状导航：size 0 → -1；current<0 时 next→0 / prev→size-1；否则 +1/-1 取模。返回 current。 */
  next(): number;
  prev(): number;
  view(): SearchPanelView;
  contentHeight(): number;      // size * rowHeight
  window(scrollTop: number, viewportRows: number): SearchWindow;
}
```

`computeResultWindow` 语义：`rowHeight = opts?.rowHeight ?? 44`，`overscan = opts?.overscan ?? 4`；
`viewportRows` 向下取整且 ≥0；`start = clamp(floor(scrollTop/rowHeight) - overscan, 0, size)`；
`count = min(viewportRows + 2*overscan, size - start)`；`size<=0` → `{start:0,count:0}`；scrollTop 负值按 0。

计数：`counts.all = hits.length`、`counts.key = field==='key'` 数、`counts.value = field==='value'` 数（对未过滤的 `allHits` 统计）。

## 3. `src/view/panels/search-panel.ts`（owner: search-view-dev）

```ts
import type { SearchFilter, SearchPanelView } from '../../viewmodel/search-state';

export interface SearchPanelOptions {
  rowHeight?: number;   // 默认 SEARCH_RESULT_ROW_HEIGHT
  overscan?: number;    // 默认 SEARCH_RESULT_OVERSCAN
  onQueryChange(query: string): void;
  onFilterChange(filter: SearchFilter): void;
  onSelect(index: number): void; // 点击结果行（过滤后下标）
  onPrev(): void;
  onNext(): void;
  onSubmit(): void;      // 输入框 Enter
}

export class SearchPanel {
  constructor(host: HTMLElement, opts: SearchPanelOptions);
  mount(): void;          // 在 host 内建 DOM（host 由 page.html 提供）
  render(view: SearchPanelView): void;
  focusInput(): void;
  scrollTo(index: number): void;  // 把过滤后第 index 行滚进列表视口（夹紧）
  resetScroll(): void;
  renderedCount(): number;        // 当前可见（非 hidden）结果行数
  listScrollTop(): number;
  scrollListTo(px: number): void;
  destroy(): void;
}
```

- 只依赖 viewmodel 的类型 + 常量，不 import core、不发请求、不读全局时钟。
- 内部滚动 → 用 `computeResultWindow` 重画窗口；行节点池复用（隐藏多余节点）。
- `render(view)`：`view.hits` 引用变化时列表滚回顶部；同一命中集只更新状态/高亮（导航时不丢滚动位置）。
- `scrollTo(index)` 之后再 `render` 一帧窗口（同步即可）。
- `mount()` 时建 `#searchInput`、`#searchPrev`、`#searchNext`；活动栏 `⌘K` 由 app 调 `focusInput()`。

### 3.1 DOM 契约（app / smoke 脚本依赖，不要改名）

```
<cpanel host> .panel.panel--search#searchPanel
  .csearch
    .csearch__box            （32px，focus ring 由 CSS 给）
      input#searchInput.csearch__input  placeholder="搜索键名或字符串值…"
      span.csearch__count#searchCount   （`<b>37,189</b>`，truncated 时 `<b>50,000+</b>`）
    .csearch__row
      #searchPrev / #searchNext（iconbtn，size===0 时 disabled）
      span.csearch__pos#searchPos       （`3 / 140` = current+1 / **过滤后数量**；顶部 #searchCount 才是未过滤 total / `50,000+`）
  .results__filters
    button.filter[data-filter="all"]   （全部 <span class="filter__count">）
    button.filter[data-filter="key"]   （键名 …）
    button.filter[data-filter="value"] （值 …；is-on + aria-pressed 表示当前过滤）
  .results__scroll#resultsScroll       （role=listbox，tabindex=0，overflow:auto）
    .results__spacer                    （height = size*44）
      .results__window                  （absolute inset 0）
        button.result[data-index][data-path][role=option]  （absolute，height 44）
          span.result__path               （命中高亮 <mark class="result__hit">）
          span.result__meta
            span.result__field            （匹配说明：`键名` / `值`）
            span.result__value            （预览，命中高亮）
            span.result__kind             （类型标签：object/array/string/…）
        当前行 class="is-selected"
    .results__empty                     （idle/searching/stale/无命中时显示；列表为空/隐藏）
  .results__foot#resultsFoot            （size===0 时 hidden）
    `虚拟滚动 · 已渲染 <span id="resultsRendered">N</span> / <span id="resultsTotal">M</span>`
    truncated 时追加 `已截断（上限 50,000）`
```

状态文案（`.results__empty`）：`idle` → `输入关键词搜索键名或字符串值`；`searching` → `搜索中…`；
`stale` → `文档已修改，请重新搜索`；`ready` 且 `size===0` → `没有命中「<query>」`。

## 4. `src/app/main.ts`（owner: lead）

- `searchState = new SearchState()`、`searchPanel = new SearchPanel(el('searchPanel'), callbacks)`；
  `runSearch(query)` 由输入 250ms debounce 与 dev hook 共用；成功后
  `tree.setSearch({ term, hitPaths: searchState.hitPaths(), currentPath })`。
- prev/next/Enter/`⌘G`/`F3` 跳转 = `core.expandTo` → `tree.scrollToPx`（当前行居中）→ `setSelection`；
  跳转后 `searchPanel.scrollTo(index)`。
- `onLoaded` 清空搜索（`searchState.begin('')` + `tree.setSearch(null)` + `resetScroll`），
  使在途旧回包因 seq 变化被忽略。
- 过滤切换：`searchState.setFilter` → `tree.setSearch` 更新 currentPath。
- 键盘：面板输入 Enter → `onSubmit`（首次 = 跳到当前/第一条，之后 = 下一条）；`⌘G`/`⇧⌘G`、`F3`/`⇧F3`。
- 树视图小改：`TreeView.setSearch` 收到已是 `Set` 的 `hitPaths` 时不复制（同一 Set 实例复用，避免 37k 每次导航重拷贝）。

## 5. dev hook（仅 `!isExtension`，`scripts/smoke-search.mjs` 依赖）

在现有 `window.__tjv`（`loadText/scrollToPx/togglePath/state`）上追加：

```ts
search(term: string): Promise<{ ms, ok, phase, total, size, current, filter, truncated, stale, rendered, treeCurrentVisible }>;
searchNext(): Promise<{ ms, current, path: string | null, treeCurrentVisible }>;
searchPrev(): Promise<{ ms, current, path: string | null, treeCurrentVisible }>;
searchJump(index: number): Promise<{ ms, index, path: string | null, treeCurrentVisible }>;
setSearchFilter(filter: 'all' | 'key' | 'value'): { filter, size, current, counts };
searchMarkStale(): { changed, phase, stale, size, current }; // dev-only：模拟 docRevision 过期（slice 5 前仅测试用）
searchPanel(): { phase, total, size, current, rendered, scrollTop, scrollHeight, countText, posText, footText };
searchListScrollTo(px: number): { scrollTop, rendered };
```

> 实现可多返回诊断字段（`query/counts/scrollTop/scrollHeight/listScrollTop/listScrollHeight/path` 等），smoke 只依赖上面列出的键。

`treeCurrentVisible = Boolean(document.querySelector('.row.is-current'))`。
`ms` 用 `performance.now()` 包住整个异步动作（含 worker 往返 + 渲染）。

## 6. 验收（owner: search-verifier，dist 冻结后执行）

| 项 | 门槛 |
|---|---|
| `.mock/1.json` 搜索（`hotel`，**186 命中 = 140 key + 46 value**） | `__tjv.search` ms < 100 |
| 10MB 全量搜索 walk（`hotel`，raw **74,378** → 截断 50,000） | hook 43–120ms，无 >50ms 长任务 |
| 跳转 `__tjv.searchJump(0)` | 实际毫秒数报告（目标 ≤1 帧；含 worker 往返，如实记录） |
| 37k 命中结果列表滚动 | 渲染行数恒定 ≤ 40；滚动过程 0 长任务 |
| 过滤 all/key/value | `size` 之和 = `total`；列表只显示对应 field |
| truncated | 大词 >50k 命中时 `truncated=true` 且 foot 有提示 |
| 空查询 / 无命中 / 重载清空 | 状态正确（`.results__empty` 文案） |
| stale（`searchMarkStale()`） | 清空结果 + `.results__empty` =「文档已修改，请重新搜索」+ 树高亮清空（编辑接入前仅 dev hook 可达） |
| `npm run check` | 全绿（typecheck + 全部单测 + build） |
| `npm run smoke` / `npm run smoke:ext` | 不回归 |
| 扩展里真实驱动搜索（输入 → 结果 → Enter 跳转 → 树 `is-current`） | 通过 + 截图 `.spike/smoke/extension-search.png` |

样本：`.mock/1.json`（0.93MB）、`.spike/samples/10mb.json`（gitignore，已存在）。
