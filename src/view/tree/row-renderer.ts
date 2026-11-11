/**
 * view/tree/row-renderer — S3：行渲染器。
 *
 * TreeView 与「一行 DOM」之间的唯一接缝；这是「逻辑不动调渲染」的开关。
 * 契约见 docs/architecture/seams.md §4。
 *
 * 硬约束：
 *   - 固定行高：行内容单行（nowrap + ellipsis），不得 wrap、不得由内容撑高；
 *     缩进用 padding-left，不嵌套容器。
 *   - 全部文本写入走 textContent / replaceChildren，**禁用 innerHTML**（XSS 面 + 性能）。
 *   - 行节点池复用：update() 拿 null 分配空闲槽位，否则原地更新。
 */
import { writeMarkedText } from '../highlight';
import type { JsonKind, Row } from '../../protocol/types';

export interface RowHandle {
  /** DOM 适配器里是行池槽位索引 */
  readonly key: number;
}

export interface RowContext {
  selected: boolean;
  hit: boolean;
  /** 搜索的「当前命中」行 */
  current: boolean;
  searchTerm?: string;
  typeColumn: boolean;
  showActions: boolean;
  /** 是否显示「在原文中定位」按钮（#30 / ADR-0019）：表达式结果视图 / plain 模式不显示 */
  locateRaw: boolean;
}

export interface RowRenderer {
  /** 固定行高；来源 RowMetrics，不自行测量 */
  readonly rowHeight: number;
  /** 预建视口 + overscan 行池（host 由 factory 在构造时注入） */
  create(): void;
  update(handle: RowHandle | null, row: Row, ctx: RowContext): RowHandle;
  setSelected(handle: RowHandle | null): void;
  destroy(): void;

  /**
   * S3 扩展：TreeView 负责窗口定位，需要把「行池槽位」摆到绝对 top。
   * DOM 适配器实现为 style.top；其它适配器可空实现（canvas 自绘时位置由绘制循环给定）。
   */
  setTop(handle: RowHandle, topPx: number): void;
  /** S3 扩展：窗口收窄后回收多余行池槽位（隐藏，不销毁） */
  setVisible(handle: RowHandle, visible: boolean): void;
}

/** S3 装配缝：app 注入 adapter，由 TreeView 在 mount 时提供行容器。 */
export type RowRendererFactory = (host: HTMLElement) => RowRenderer;

export interface DomRowPoolOptions {
  /** 固定行高；必须与 RowMetrics.rowHeight 一致 */
  rowHeight?: number;
  /** 预建槽位数；不足时按需扩容 */
  poolSize?: number;
}

const TYPE_LABEL: Record<JsonKind, string> = {
  object: 'object',
  array: 'array',
  string: 'string',
  number: 'number',
  boolean: 'bool',
  null: 'null',
};

const VALUE_CLASS: Record<JsonKind, string> = {
  object: 'tok-punct',
  array: 'tok-punct',
  string: 'tok-str',
  number: 'tok-num',
  boolean: 'tok-bool',
  null: 'tok-null',
};

const SVG_NS = 'http://www.w3.org/2000/svg';

function createChevron(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'm6.3 4.2 4 3.8-4 3.8');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.5');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  return svg;
}

const ACTION_LABEL: Record<'copy' | 'edit' | 'raw', string> = {
  copy: '复制子树 JSON',
  edit: '编辑此节点 JSON',
  raw: '在原文中定位',
};

const ACTION_GLYPH: Record<'copy' | 'edit' | 'raw', string> = {
  copy: '⧉',
  edit: '✎',
  raw: '⇠',
};

function createAction(action: 'copy' | 'edit' | 'raw'): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  // 鼠标快路径：不进 Tab 序列（键盘用户走 F2 编辑 / 右键菜单），见 ADR-0010 修订
  el.tabIndex = -1;
  el.className = 'row__action';
  el.dataset.action = action;
  el.setAttribute('aria-label', ACTION_LABEL[action]);
  el.textContent = ACTION_GLYPH[action];
  return el;
}

/**
 * 写入文本；有搜索词时把命中片段包进 `<mark class="row__hit">`。
 * 匹配由 shared/highlight 计算、DOM 写入由 view/highlight 统一承担（下标基于原串，全部走 textContent）。
 */
function setText(el: HTMLElement, text: string, term?: string): void {
  writeMarkedText(el, text, term, 'row__hit');
}

interface RowSlot {
  readonly key: number;
  readonly el: HTMLDivElement;
  readonly guides: HTMLSpanElement;
  readonly caret: HTMLSpanElement;
  readonly keyEl: HTMLSpanElement;
  readonly colon: HTMLSpanElement;
  readonly value: HTMLSpanElement;
  readonly count: HTMLSpanElement;
  readonly preview: HTMLSpanElement;
  readonly type: HTMLSpanElement;
  readonly actions: HTMLSpanElement;
  readonly locateRaw: HTMLButtonElement;
  visible: boolean;
}

/** DOM 行池适配器：行节点池 + textContent 复用（ADR-0005 实测 0.03–0.09ms/帧）。 */
export class DomRowPool implements RowRenderer {
  readonly rowHeight: number;

  private readonly host: HTMLElement;
  private readonly slots: RowSlot[] = [];
  private readonly initialPoolSize: number;
  private selectedKey: number | null = null;
  private created = false;

  /** host 由 factory 在构造时注入（main.ts：`new DomRowPool(host, { rowHeight })`）。 */
  constructor(host: HTMLElement, opts: DomRowPoolOptions = {}) {
    this.host = host;
    this.rowHeight = opts.rowHeight ?? 24;
    this.initialPoolSize = Math.max(0, Math.floor(opts.poolSize ?? 64));
  }

  create(): void {
    if (this.created) return;
    this.created = true;
    for (let i = 0; i < this.initialPoolSize; i++) this.allocSlot();
  }

  update(handle: RowHandle | null, row: Row, ctx: RowContext): RowHandle {
    const slot = handle ? this.slots[handle.key] : this.takeFreeSlot();
    const target = slot ?? this.allocSlot();
    this.fill(target, row, ctx);
    return { key: target.key };
  }

  setSelected(handle: RowHandle | null): void {
    if (this.selectedKey !== null) {
      this.slots[this.selectedKey]?.el.classList.remove('is-selected');
    }
    this.selectedKey = handle ? handle.key : null;
    if (handle) this.slots[handle.key]?.el.classList.add('is-selected');
  }

  setTop(handle: RowHandle, topPx: number): void {
    const slot = this.slots[handle.key];
    if (slot) slot.el.style.top = `${topPx}px`;
  }

  setVisible(handle: RowHandle, visible: boolean): void {
    const slot = this.slots[handle.key];
    if (!slot) return;
    slot.el.hidden = !visible;
    slot.visible = visible;
    if (!visible) {
      slot.el.classList.remove('is-selected', 'is-hit', 'is-current');
      slot.el.removeAttribute('data-path');
      // 隐藏槽位清空文本：否则上一批查询的 <mark> 会留在池里，
      // 「无命中行时 mark 数为 0」这类审计/测试会看到幽灵高亮。
      slot.keyEl.textContent = '';
      slot.value.textContent = '';
      slot.count.textContent = '';
      // 隐藏槽位也清掉项数标的可点态（#9）：池复用后不会残留 title / is-clickable
      slot.count.className = 'row__count';
      slot.count.removeAttribute('title');
      slot.preview.textContent = '';
      slot.type.textContent = '';
      if (this.selectedKey === slot.key) this.selectedKey = null;
    }
  }

  destroy(): void {
    for (const slot of this.slots) slot.el.remove();
    this.slots.length = 0;
    this.selectedKey = null;
    this.created = false;
  }

  // ---------------------------------------------------------------- internal

  private takeFreeSlot(): RowSlot | null {
    for (const slot of this.slots) if (!slot.visible) return slot;
    return null;
  }

  private allocSlot(): RowSlot {
    const host = this.host;
    const el = document.createElement('div');
    el.className = 'row';
    el.setAttribute('role', 'treeitem');
    el.hidden = true;

    const guides = document.createElement('span');
    guides.className = 'row__guides';
    guides.setAttribute('aria-hidden', 'true');

    const caret = document.createElement('span');
    caret.className = 'row__caret';
    caret.setAttribute('aria-hidden', 'true');
    caret.appendChild(createChevron());

    const keyEl = document.createElement('span');
    keyEl.className = 'row__key';

    const colon = document.createElement('span');
    colon.className = 'row__colon';
    colon.textContent = ':';
    colon.setAttribute('aria-hidden', 'true');

    const value = document.createElement('span');
    value.className = 'row__value';

    const count = document.createElement('span');
    count.className = 'row__count';

    const preview = document.createElement('span');
    preview.className = 'row__preview';

    const type = document.createElement('span');
    type.className = 'row__type';

    const actions = document.createElement('span');
    actions.className = 'row__actions';
    actions.appendChild(createAction('copy'));
    actions.appendChild(createAction('edit'));
    // 「在原文中定位」（#30 / ADR-0019）：没有源文本的根（表达式结果）/ plain 模式按 ctx 隐藏
    const locateRaw = createAction('raw');
    actions.appendChild(locateRaw);

    el.append(guides, caret, keyEl, colon, value, count, preview, type, actions);
    host.appendChild(el);

    const slot: RowSlot = {
      key: this.slots.length,
      el,
      guides,
      caret,
      keyEl,
      colon,
      value,
      count,
      preview,
      type,
      actions,
      locateRaw,
      visible: false,
    };
    this.slots.push(slot);
    return slot;
  }

  private fill(slot: RowSlot, row: Row, ctx: RowContext): void {
    const el = slot.el;
    el.hidden = false;
    slot.visible = true;

    el.dataset.path = row.path;
    el.dataset.kind = row.kind;
    el.setAttribute('aria-level', String(row.depth + 1));
    if (row.hasChildren) {
      el.setAttribute('aria-expanded', row.open ? 'true' : 'false');
    } else {
      el.removeAttribute('aria-expanded');
    }

    // 缩进引导线（每级 1 条 1px 竖线；缩进本身由 CSS padding-left 承担）
    if (slot.guides.childElementCount !== row.depth) {
      const fragment = document.createDocumentFragment();
      for (let i = 0; i < row.depth; i++) fragment.appendChild(document.createElement('i'));
      slot.guides.replaceChildren(fragment);
    }

    slot.caret.className =
      'row__caret' + (row.open ? ' is-open' : '') + (row.hasChildren ? '' : ' is-leaf');

    slot.keyEl.className = 'row__key' + (row.idx ? ' row__key--idx' : '');
    setText(slot.keyEl, row.key, ctx.searchTerm);

    if (row.hasChildren) {
      slot.value.className = 'row__value tok-punct';
      setText(slot.value, row.kind === 'array' ? '[…]' : '{…}');
    } else {
      slot.value.className = 'row__value ' + (VALUE_CLASS[row.kind] ?? 'tok-punct');
      setText(slot.value, row.preview, ctx.searchTerm);
    }

    if (row.hasChildren) {
      // 项数标是展开/收起的第二入口（#9 / direction §5）：可点、带 title；
      // 容器行的 count 只在这一支出现，空容器 hasChildren=false 走下面的标量分支。
      slot.count.hidden = false;
      slot.count.className =
        'row__count' +
        (row.kind === 'array' ? ' row__count--arr' : '') +
        ' is-clickable';
      slot.count.textContent =
        row.kind === 'array' ? `[${row.count}]` : `${row.count} 项`;
      slot.count.title = row.open ? '点击收起' : '点击展开';
    } else {
      // 标量行没有项数标：清文本的同时必须清 class/title，否则行池复用到标量行会留可点态
      slot.count.hidden = true;
      slot.count.className = 'row__count';
      slot.count.textContent = '';
      slot.count.removeAttribute('title');
    }

    const previewText = row.hasChildren ? row.preview : '';
    if (previewText) {
      slot.preview.hidden = false;
      setText(slot.preview, previewText, ctx.searchTerm);
    } else {
      slot.preview.hidden = true;
      slot.preview.textContent = '';
    }

    slot.type.hidden = !ctx.typeColumn;
    slot.type.textContent = ctx.typeColumn ? (TYPE_LABEL[row.kind] ?? '?') : '';

    slot.actions.hidden = !ctx.showActions;
    slot.locateRaw.hidden = !ctx.locateRaw;

    el.classList.toggle('is-selected', ctx.selected);
    el.classList.toggle('is-hit', ctx.hit);
    el.classList.toggle('is-current', ctx.current);

    if (ctx.selected) {
      this.selectedKey = slot.key;
    } else if (this.selectedKey === slot.key) {
      this.selectedKey = null;
    }
  }
}
