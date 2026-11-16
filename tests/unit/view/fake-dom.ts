/**
 * tests/unit/view/fake-dom — 单测用的**极简 DOM 基座**（仓库不引 jsdom / happy-dom）。
 *
 * 只覆盖 view 组件在单测里实际用到的 API：元素/文本节点、树结构、classList、dataset、
 * 属性、style、事件、focus、`querySelector(All)`（支持 `#id` / `.class` / `[data-x="v"]` / tag）。
 * 不是通用 DOM 实现：遇到没覆盖的方法就补在这里，不要在产品代码里为测试做兼容分支。
 */

export type FakeListener = (event: FakeEvent) => void;

export interface FakeEvent {
  type: string;
  target: FakeNode;
  defaultPrevented: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

class FakeClassList {
  private readonly names = new Set<string>();

  constructor(initial = '') {
    for (const name of initial.split(/\s+/)) if (name) this.names.add(name);
  }

  add(...names: string[]): void {
    for (const name of names) if (name) this.names.add(name);
  }

  remove(...names: string[]): void {
    for (const name of names) this.names.delete(name);
  }

  contains(name: string): boolean {
    return this.names.has(name);
  }

  clear(): void {
    this.names.clear();
  }

  toggle(name: string, force?: boolean): boolean {
    const next = force === undefined ? !this.names.has(name) : force;
    if (next) this.names.add(name);
    else this.names.delete(name);
    return next;
  }

  toString(): string {
    return [...this.names].join(' ');
  }
}

export class FakeStyle {
  [key: string]: unknown;
  readonly props = new Map<string, string>();

  setProperty(name: string, value: string): void {
    this.props.set(name, value);
  }

  removeProperty(name: string): void {
    this.props.delete(name);
  }

  getPropertyValue(name: string): string {
    return this.props.get(name) ?? '';
  }
}

export class FakeNode {
  readonly nodeType: number;
  parentNode: FakeNode | null = null;
  readonly childNodes: FakeNode[] = [];
  readonly ownerDocument: FakeDocument;

  constructor(nodeType: number, document: FakeDocument) {
    this.nodeType = nodeType;
    this.ownerDocument = document;
  }

  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }

  get lastChild(): FakeNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }

  get children(): FakeElement[] {
    return this.childNodes.filter((node): node is FakeElement => node instanceof FakeElement);
  }

  get isConnected(): boolean {
    let node: FakeNode | null = this;
    while (node?.parentNode) node = node.parentNode;
    return node === this.ownerDocument.body || node instanceof FakeElement;
  }

  get textContent(): string {
    return this.childNodes.map((node) => node.textContent).join('');
  }

  set textContent(value: string) {
    this.replaceChildren(...(value === '' ? [] : [new FakeText(value, this.ownerDocument)]));
  }

  append<T extends FakeNode>(...nodes: T[]): void {
    for (const node of nodes) this.appendChild(node);
  }

  appendChild<T extends FakeNode>(node: T): T {
    node.parentNode?.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  insertBefore<T extends FakeNode>(node: T, before: FakeNode | null): T {
    if (!before) return this.appendChild(node);
    node.parentNode?.removeChild(node);
    node.parentNode = this;
    const index = this.childNodes.indexOf(before);
    this.childNodes.splice(index < 0 ? this.childNodes.length : index, 0, node);
    return node;
  }

  removeChild<T extends FakeNode>(node: T): T {
    const index = this.childNodes.indexOf(node);
    if (index >= 0) this.childNodes.splice(index, 1);
    node.parentNode = null;
    return node;
  }

  replaceChildren(...nodes: FakeNode[]): void {
    for (const node of [...this.childNodes]) this.removeChild(node);
    for (const node of nodes) {
      // DocumentFragment 语义：插入的是它的子节点，不是 fragment 本身
      if (node instanceof FakeElement && node.tagName === '#FRAGMENT') {
        for (const child of [...node.childNodes]) this.appendChild(child);
      } else {
        this.appendChild(node);
      }
    }
  }

  remove(): void {
    this.parentNode?.removeChild(this);
  }

  contains(node: FakeNode | null): boolean {
    for (let current = node; current; current = current.parentNode) {
      if (current === this) return true;
    }
    return false;
  }

  addEventListener(_type: string, _listener: FakeListener): void {
    /* 单测只手动 emit，事件委托不参与 */
  }

  removeEventListener(_type: string, _listener: FakeListener): void {
    /* no-op */
  }

  /** 手动触发事件（直接回调本节点上登记的监听器，冒泡到祖先）。 */
  emit(type: string, init: Partial<FakeEvent> = {}): FakeEvent {
    const event: FakeEvent = {
      type,
      target: this,
      defaultPrevented: false,
      preventDefault() {
        event.defaultPrevented = true;
      },
      stopPropagation() {
        /* no-op */
      },
      ...init,
    };
    let node: FakeNode | null = this;
    while (node) {
      const listeners = node.listeners.get(type) ?? [];
      for (const listener of listeners) listener(event);
      node = node.parentNode;
    }
    return event;
  }

  protected readonly listeners = new Map<string, FakeListener[]>();
}

export class FakeText extends FakeNode {
  constructor(
    public data: string,
    document: FakeDocument,
  ) {
    super(3, document);
  }

  override get textContent(): string {
    return this.data;
  }

  override set textContent(value: string) {
    this.data = value;
  }

  get nodeValue(): string {
    return this.data;
  }

  set nodeValue(value: string) {
    this.data = value;
  }
}

const SELECTOR_ID = /^#(.+)$/;
const SELECTOR_CLASS = /^\.([\w-]+)$/;
const SELECTOR_DATA_ONLY = /^\[([\w-]+)\]$/;
const SELECTOR_DATA = /^\[([\w-]+)="([^"]*)"\]$/;

/** `data-foo-bar` → dataset 键 `fooBar`。 */
function datasetKey(attribute: string): string {
  return attribute.replace(/^data-/, '').replace(/-([a-z])/g, (_whole, char: string) => char.toUpperCase());
}

export class FakeElement extends FakeNode {
  readonly tagName: string;
  id = '';
  private classNameValue = '';
  readonly classList: FakeClassList;
  readonly dataset: Record<string, string> = {};
  readonly style = new FakeStyle();
  readonly attributes = new Map<string, string>();
  hidden = false;
  disabled = false;
  tabIndex = 0;
  type = '';
  title = '';
  value = '';
  checked = false;
  placeholder = '';
  spellcheck = true;
  autocomplete = '';
  draggable = false;
  htmlFor = '';
  private readonly domListeners = new Map<string, FakeListener[]>();

  constructor(tagName: string, document: FakeDocument) {
    super(1, document);
    this.tagName = tagName.toUpperCase();
    this.classList = new FakeClassList();
  }

  get className(): string {
    return this.classNameValue;
  }

  set className(value: string) {
    this.classNameValue = value;
    this.classList.clear();
    this.classList.add(...value.split(/\s+/));
  }

  focus(): void {
    this.ownerDocument.activeElement = this;
  }

  blur(): void {
    if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null;
  }

  select(): void {
    /* no-op */
  }

  click(): void {
    this.emit('click');
  }

  override addEventListener(type: string, listener: FakeListener): void {
    const list = this.domListeners.get(type) ?? [];
    list.push(listener);
    this.domListeners.set(type, list);
  }

  override removeEventListener(type: string, listener: FakeListener): void {
    const list = this.domListeners.get(type);
    if (!list) return;
    this.domListeners.set(
      type,
      list.filter((entry) => entry !== listener),
    );
  }

  override emit(type: string, init: Partial<FakeEvent> = {}): FakeEvent {
    const event: FakeEvent = {
      type,
      target: this,
      defaultPrevented: false,
      preventDefault() {
        event.defaultPrevented = true;
      },
      stopPropagation() {
        /* no-op */
      },
      ...init,
    };
    for (const listener of this.domListeners.get(type) ?? []) listener(event);
    return event;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  /** `#id` / `.class` / `[data-x]` / `[data-x="v"]` / tag 名。 */
  matches(selector: string): boolean {
    let match = SELECTOR_ID.exec(selector);
    if (match) return this.id === match[1];
    match = SELECTOR_CLASS.exec(selector);
    if (match) return this.classList.contains(match[1] as string);
    match = SELECTOR_DATA.exec(selector);
    if (match) return this.dataset[datasetKey(match[1] as string)] === match[2];
    match = SELECTOR_DATA_ONLY.exec(selector);
    if (match) return this.dataset[datasetKey(match[1] as string)] !== undefined;
    return this.tagName.toLowerCase() === selector.toLowerCase();
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const found: FakeElement[] = [];
    const visit = (node: FakeNode): void => {
      for (const child of node.children) {
        if (child.matches(selector)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
}

export class FakeDocument {
  readonly body: FakeElement;
  activeElement: FakeElement | null = null;

  constructor() {
    this.body = new FakeElement('body', this);
  }

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName, this);
  }

  createTextNode(text: string): FakeText {
    return new FakeText(text, this);
  }

  createElementNS(_namespace: string, tagName: string): FakeElement {
    return new FakeElement(tagName, this);
  }

  createDocumentFragment(): FakeElement {
    return new FakeElement('#fragment', this);
  }

  addEventListener(_type: string, _listener: FakeListener): void {
    /* no-op（单测不驱动 document 级监听） */
  }

  removeEventListener(_type: string, _listener: FakeListener): void {
    /* no-op */
  }
}

export interface FakeDomHandle {
  document: FakeDocument;
  restore(): void;
}

/** 安装全局 `document`；返回 restore 供 afterEach/afterAll 复位。 */
export function installFakeDom(existingDocument?: unknown): FakeDomHandle {
  const document = new FakeDocument();
  const previous = existingDocument ?? (globalThis as { document?: unknown }).document;
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    writable: true,
    value: document,
  });
  return {
    document,
    restore(): void {
      if (previous === undefined) {
        delete (globalThis as { document?: unknown }).document;
      } else {
        Object.defineProperty(globalThis, 'document', {
          configurable: true,
          writable: true,
          value: previous,
        });
      }
    },
  };
}
