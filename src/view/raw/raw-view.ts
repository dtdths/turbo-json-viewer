/**
 * view/raw/raw-view — 原始文本视图（ADR-0003 修订 2026-11-03 §5）。
 *
 * 职责边界（docs/architecture/seams.md §3/S3）：
 *   - 只消费 RawSnapshot；**不自己请求窗口**——滚动只回调 onScroll(px)，由 app 层转给 RawWindowSource。
 *   - 滚动容器 + spacer（min(totalLines × rowHeight, MAX_SCROLL_PX)）+ 行池渲染；
 *     行绝对定位 top = (start + i) × rowHeight，`data-line` 写 1-based **绝对**行号。
 *   - 行号 gutter（.raw-row__ln）+ 横向滚动（行 white-space: pre、width: max-content，gutter sticky 左固定）。
 *   - 高亮只对屏内行做：shared/json-lex 的 lexLine → span.tk-*；缩进空白用文本节点逐字保留。
 *   - flashLine：修复摘要 `at` 跳行（#8）——滚到该行并加 .is-flash 900ms。
 *
 * 硬约束：
 *   - `.raw-row__code` 的 textContent 必须逐字等于该行文本（不加省略号、不丢缩进/尾随空白）；
 *   - 禁止 innerHTML 拼数据：只用 createElement / createTextNode / textContent；
 *   - 固定行高：行内容单行不换行（白空间 pre），行高由 CSS 变量 --row-h 锁死。
 */
import { CH, JsonLexer, TOK } from '../../shared/json-lex';
import { clampRowHeight } from '../../shared/num';
import { MAX_SCROLL_PX } from '../../protocol/versions';
import type { RawSnapshot } from '../../viewmodel/raw-window-source';

export interface RawViewOptions {
  rowHeight: number;
  onScroll(scrollTopPx: number): void;
  /**
   * 行号 gutter 的「跳到树视图」按钮点击（#30 / ADR-0019）：参数 = 1-based 绝对行号。
   * 未提供时不显示按钮（plain 模式同理）。
   */
  onLocate?(line: number): void;
  /** 行右键（#30）：参数 = 1-based 绝对行号 + 屏幕坐标；未提供则不拦系统菜单。 */
  onContextMenu?(line: number, x: number, y: number): void;
}

export const FLASH_MS = 900;

/** 单行高亮 run 上限：超长行（≤4096 字符）极端情况下退回纯文本，保 DOM 节点数有界。 */
const MAX_HIGHLIGHT_RUNS = 512;

const TOKEN_CLASS: Record<number, string> = {
  [TOK.OBJ]: 'tk-punct',
  [TOK.ARR]: 'tk-punct',
  [TOK.OBJ_END]: 'tk-punct',
  [TOK.ARR_END]: 'tk-punct',
  [TOK.STR]: 'tk-str',
  [TOK.NUM]: 'tk-num',
  [TOK.LIT]: 'tk-lit',
  [TOK.COLON]: 'tk-punct',
  [TOK.COMMA]: 'tk-punct',
  [TOK.BAD]: 'tk-bad',
};

interface RawSlot {
  readonly key: number;
  readonly el: HTMLDivElement;
  readonly ln: HTMLSpanElement;
  readonly num: HTMLSpanElement;
  readonly locate: HTMLButtonElement;
  readonly code: HTMLSpanElement;
  visible: boolean;
  /** 槽位当前显示的绝对行号（1-based；隐藏时为 0） */
  lineNo: number;
}

/** 行首 token 是结构行（没有节点锚点）的字符：`}` / `]` / `,` / `:` */
const STRUCTURAL_CHARS = new Set<number>([CH.RBRACE, CH.RBRACK, CH.COMMA, CH.COLON]);

/** 行首非空白字符（与「锚点粒度」同口径，ADR-0019 §3）；空行 → -1 */
function firstTokenChar(line: string): number {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9 && c !== 13) return c;
  }
  return -1;
}

/**
 * 把一行文本写进 `.raw-row__code`：token 用 span.tk-*，其余（缩进/空白）用文本节点逐字保留。
 * `highlight=false`（plain 模式）→ 整行一个文本节点，仍逐字。
 */
function writeLine(lex: JsonLexer, code: HTMLSpanElement, line: string, highlight: boolean): void {
  if (!highlight) {
    code.textContent = line;
    return;
  }
  const runs = lex.lexLine(line);
  if (runs.length === 0 || runs.length > MAX_HIGHLIGHT_RUNS) {
    code.textContent = line;
    return;
  }

  const fragment = document.createDocumentFragment();
  let cursor = 0;
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    if (run.s > cursor) {
      fragment.appendChild(document.createTextNode(line.slice(cursor, run.s)));
    }
    // 键判定：字符串 token 后紧跟 COLON（`"key":`），其余字符串是值
    const isKey = run.t === TOK.STR && runs[i + 1]?.t === TOK.COLON;
    const span = document.createElement('span');
    span.className = isKey ? 'tk-key' : (TOKEN_CLASS[run.t] ?? 'tk-bad');
    span.textContent = line.slice(run.s, run.e);
    fragment.appendChild(span);
    cursor = run.e;
  }
  if (cursor < line.length) {
    fragment.appendChild(document.createTextNode(line.slice(cursor)));
  }
  code.replaceChildren(fragment);
}

export class RawView {
  private readonly host: HTMLElement;
  /** 本视图独占的 lexer（shared 无模块状态） */
  private readonly lex = new JsonLexer();
  private readonly opts: RawViewOptions;

  private scroller: HTMLDivElement | null = null;
  private spacer: HTMLDivElement | null = null;
  private rowsHost: HTMLDivElement | null = null;
  private mounted = false;

  /** 行高真值（RawMetrics，ADR-0011 §6）：构造时取 opts.rowHeight，设置变化后 setRowHeight 同步 */
  private rowHeight: number;
  private readonly slots: RawSlot[] = [];
  private lastSnapshot: RawSnapshot | null = null;
  private totalLines = 0;

  private flashLineNo: number | null = null;
  private flashTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly onScrollBound = (): void => {
    if (!this.scroller) return;
    this.opts.onScroll(this.scroller.scrollTop);
  };

  /** 行号 gutter 按钮（行池复用下按行号定位，不绑死在槽位上）。 */
  private readonly onClickBound = (event: MouseEvent): void => {
    const target = event.target as HTMLElement | null;
    const button = target?.closest<HTMLElement>('.raw-row__locate');
    if (!button) return;
    const row = button.closest<HTMLElement>('.raw-row');
    const line = Number(row?.dataset.line);
    if (!Number.isFinite(line) || line <= 0) return;
    event.preventDefault();
    this.opts.onLocate?.(line);
  };

  /** 行右键（#30）：交给 app 弹菜单（键盘等价入口，ADR-0015）。 */
  private readonly onContextMenuBound = (event: MouseEvent): void => {
    if (!this.opts.onContextMenu) return;
    const target = event.target as HTMLElement | null;
    const row = target?.closest<HTMLElement>('.raw-row');
    const line = Number(row?.dataset.line);
    if (!Number.isFinite(line) || line <= 0) return;
    event.preventDefault();
    this.opts.onContextMenu(line, event.clientX, event.clientY);
  };

  constructor(host: HTMLElement, opts: RawViewOptions) {
    this.host = host;
    this.opts = opts;
    this.rowHeight = clampRowHeight(opts.rowHeight);
  }

  mount(): void {
    if (this.mounted) return;
    this.mounted = true;

    const scroller = document.createElement('div');
    scroller.className = 'tjv-raw';
    scroller.tabIndex = 0;
    scroller.setAttribute('role', 'document');
    scroller.setAttribute('aria-label', '原始文本视图');
    scroller.style.setProperty('--row-h', `${this.rowHeight}px`);

    const spacer = document.createElement('div');
    spacer.className = 'tjv-raw__spacer';

    const rowsHost = document.createElement('div');
    rowsHost.className = 'tjv-raw__rows';
    spacer.appendChild(rowsHost);

    scroller.appendChild(spacer);
    this.host.appendChild(scroller);

    this.scroller = scroller;
    this.spacer = spacer;
    this.rowsHost = rowsHost;

    scroller.addEventListener('scroll', this.onScrollBound, { passive: true });
    scroller.addEventListener('click', this.onClickBound);
    scroller.addEventListener('contextmenu', this.onContextMenuBound);
    if (this.lastSnapshot) this.render(this.lastSnapshot);
  }

  /** 渲染一帧窗口：只做定位 / 行文本 / 高亮，不发请求。 */
  render(snapshot: RawSnapshot): void {
    this.lastSnapshot = snapshot;
    this.totalLines = snapshot.totalLines;

    const scroller = this.scroller;
    const spacer = this.spacer;
    if (!this.mounted || !scroller || !spacer) return;

    const rowHeight = this.rowHeight;
    spacer.style.height = `${Math.min(this.totalLines * rowHeight, MAX_SCROLL_PX)}px`;
    scroller.classList.toggle('is-stale', snapshot.stale);
    scroller.dataset.mode = snapshot.mode;

    const highlight = snapshot.mode !== 'plain';
    // 双向定位只在「解析成功」的原文上有意义：plain（修复文档）不显示按钮
    const canLocate = this.opts.onLocate !== undefined && snapshot.mode !== 'plain';
    const lines = snapshot.lines;
    for (let i = 0; i < lines.length; i++) {
      const slot = this.slots[i] ?? this.allocSlot();
      const text = lines[i] as string;
      this.fill(
        slot,
        snapshot.start + i + 1,
        text,
        snapshot.truncated[i] ?? 0,
        highlight,
        canLocate && !STRUCTURAL_CHARS.has(firstTokenChar(text)),
      );
      slot.el.style.top = `${(snapshot.start + i) * rowHeight}px`;
    }
    for (let i = lines.length; i < this.slots.length; i++) {
      const slot = this.slots[i];
      if (slot) this.hide(slot);
    }
    // 行池复用后按绝对行号重打 is-flash（滚出再滚回、隐藏槽位复用到别的行都不留旧 class）
    this.applyFlashClass();
  }

  /** 用最近一帧快照重绘（行高 / flash 定时器到期等只改渲染态的变化，不重新请求窗口）。 */
  refresh(): void {
    if (this.lastSnapshot) this.render(this.lastSnapshot);
  }

  /**
   * 行高变化（设置面板 / shared RowMetrics，ADR-0011 §6）：更新 CSS 变量、spacer 高度并按当前快照重排。
   * 只影响渲染与滚动几何，不改行号。
   */
  setRowHeight(px: number): void {
    const next = clampRowHeight(px);
    if (next === this.rowHeight) return;
    this.rowHeight = next;
    this.scroller?.style.setProperty('--row-h', `${next}px`);
    if (this.spacer) {
      this.spacer.style.height = `${Math.min(this.totalLines * next, MAX_SCROLL_PX)}px`;
    }
    this.refresh();
  }

  rowHeightPx(): number {
    return this.rowHeight;
  }

  /** 直接设置滚动容器的 scrollTop；浏览器随后触发 scroll 事件，由 app 层请求窗口。 */
  scrollToPx(top: number): void {
    const scroller = this.scroller;
    if (!scroller) return;
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    scroller.scrollTop = Math.min(Math.max(0, top), max);
  }

  scrollTopPx(): number {
    return this.scroller?.scrollTop ?? 0;
  }

  /** 当前视口可容纳的行数（供 RawWindowSource.setMetrics）。 */
  viewportRows(): number {
    return Math.max(1, Math.floor(this.clientHeightPx() / this.rowHeight));
  }

  clientHeightPx(): number {
    return this.scroller?.clientHeight ?? 0;
  }

  /**
   * 修复摘要 `at` 跳行（#8 → #11）：滚到该行并短暂高亮 900ms。
   * 该行不在当前窗口时：只负责滚动（app 的 scroll→窗口重取链路会带来下一帧），
   * 下一次 render 按行号补 `.is-flash`（行池复用安全）。
   */
  flashLine(line1Based: number): void {
    if (!this.mounted) return;
    const total = this.totalLines;
    const line = Number.isFinite(line1Based) ? Math.round(line1Based) : 1;
    const target = total > 0 ? Math.min(Math.max(1, line), total) : Math.max(1, line);

    const scroller = this.scroller;
    if (scroller) {
      const rowHeight = this.rowHeight;
      const top = (target - 1) * rowHeight;
      const viewTop = scroller.scrollTop;
      const viewBottom = viewTop + scroller.clientHeight;
      if (top < viewTop || top + rowHeight > viewBottom) {
        // 居中偏上（给上下文留出空间），落在末尾时由 scrollToPx 自己夹取
        this.scrollToPx(top - Math.floor(scroller.clientHeight / 3));
      }
    }

    this.flashLineNo = target;
    this.applyFlashClass();

    if (this.flashTimer !== null) clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => {
      this.flashTimer = null;
      this.flashLineNo = null;
      this.applyFlashClass();
    }, FLASH_MS);
  }

  /** 可见行的行号与文本（dev hook 用；行池自报，不查全局 DOM）。 */
  renderedLines(): Array<{ line: number; text: string }> {
    return this.slots
      .filter((slot) => slot.visible)
      .map((slot) => ({ line: slot.lineNo, text: slot.code.textContent ?? '' }));
  }

  /** 当前 flash 行（1-based；无 → null）；与 `flashLine(line)` 设置动作区分命名。 */
  flashedLine(): number | null {
    return this.flashLineNo;
  }

  destroy(): void {
    if (!this.mounted) return;
    this.mounted = false;
    if (this.flashTimer !== null) {
      clearTimeout(this.flashTimer);
      this.flashTimer = null;
    }
    this.flashLineNo = null;
    const scroller = this.scroller;
    if (scroller) {
      scroller.removeEventListener('scroll', this.onScrollBound);
      scroller.removeEventListener('click', this.onClickBound);
      scroller.removeEventListener('contextmenu', this.onContextMenuBound);
      scroller.remove();
    }
    this.scroller = null;
    this.spacer = null;
    this.rowsHost = null;
    this.slots.length = 0;
    this.lastSnapshot = null;
    this.totalLines = 0;
  }

  // ---------------------------------------------------------------- internal

  private allocSlot(): RawSlot {
    const host = this.rowsHost;
    if (!host) throw new Error('RawView: row pool has no host element');

    const el = document.createElement('div');
    el.className = 'raw-row';
    el.hidden = true;

    const ln = document.createElement('span');
    ln.className = 'raw-row__ln';
    ln.setAttribute('aria-hidden', 'true');

    const num = document.createElement('span');
    num.className = 'raw-row__num';
    ln.appendChild(num);

    // 行号 gutter 的跳树按钮（#30）：覆盖整个 gutter，hover 行时显示（不改变布局/gutter 宽度）
    const locate = document.createElement('button');
    locate.type = 'button';
    locate.className = 'raw-row__locate';
    locate.tabIndex = -1;
    locate.hidden = true;
    locate.textContent = '⇢';
    ln.appendChild(locate);

    const code = document.createElement('span');
    code.className = 'raw-row__code';

    el.append(ln, code);
    host.appendChild(el);

    const slot: RawSlot = {
      key: this.slots.length,
      el,
      ln,
      num,
      locate,
      code,
      visible: false,
      lineNo: 0,
    };
    this.slots.push(slot);
    return slot;
  }

  private fill(
    slot: RawSlot,
    lineNo: number,
    text: string,
    truncated: number,
    highlight: boolean,
    anchorable: boolean,
  ): void {
    slot.visible = true;
    slot.lineNo = lineNo;
    slot.el.hidden = false;
    slot.el.dataset.line = String(lineNo);
    slot.num.textContent = String(lineNo);
    slot.locate.hidden = !anchorable;
    if (anchorable) {
      const label = `在树视图中定位（第 ${lineNo} 行）`;
      slot.locate.title = label;
      slot.locate.setAttribute('aria-label', label);
    }
    writeLine(this.lex, slot.code, text, highlight);

    if (truncated > 0) {
      slot.el.dataset.truncated = String(truncated);
      slot.el.setAttribute(
        'title',
        `该行还有 ${truncated} 个字符未显示（「复制原文」可见全文）`,
      );
    } else {
      delete slot.el.dataset.truncated;
      slot.el.removeAttribute('title');
    }
  }

  private hide(slot: RawSlot): void {
    if (!slot.visible) return;
    slot.visible = false;
    slot.lineNo = 0;
    slot.el.hidden = true;
    slot.el.classList.remove('is-flash');
    delete slot.el.dataset.line;
    delete slot.el.dataset.truncated;
    slot.el.removeAttribute('title');
    // 隐藏槽位清空文本，否则上一批窗口的行文本会留在池里被审计看到
    slot.locate.hidden = true;
    slot.num.textContent = '';
    slot.code.replaceChildren();
  }

  /** 按绝对行号给行池打 `.is-flash`（先按当前槽位重算，槽位复用安全）。 */
  private applyFlashClass(): void {
    const target = this.flashLineNo;
    for (const slot of this.slots) {
      const on = slot.visible && target !== null && slot.lineNo === target;
      slot.el.classList.toggle('is-flash', on);
    }
  }
}
