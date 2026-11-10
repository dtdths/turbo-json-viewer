/**
 * view/menu — 菜单交互控制器（DOM；ADR-0015）。
 *
 * 收口原先在 `app/main.ts` 手写两遍的四件事：**定位 / 键盘 / 外部关闭与失焦 / 焦点归还**，
 * 外加单活（同一时刻只有一个菜单打开）与 `aria-expanded` 同步。纯几何与导航在 `shared/menu`，
 * 本模块只做 DOM 事件编排（不引 jsdom，DOM 行为由冒烟兜底）。
 *
 * 关闭原因（`MenuCloseReason`）决定是否归还焦点（ADR-0015 §2.4）：
 *   escape → 归还；select → 归还；outside → 视 `returnFocusOnOutside`；
 *   blur / resize / scroll / programmatic → 不归还（焦点已被接管或不再有归属）。
 */
import {
  MENU_ANCHOR_GAP,
  MENU_VIEWPORT_MARGIN,
  computeMenuPosition,
  isMenuNavKey,
  nextMenuIndex,
  type MenuAnchor,
} from '../shared/menu';

export type MenuCloseReason = 'escape' | 'select' | 'outside' | 'blur' | 'resize' | 'scroll' | 'programmatic';

export interface MenuConfig {
  /** 菜单容器（`role="menu"`，初始 `hidden`） */
  element: HTMLElement;
  /** 菜单项选择器：右键菜单 `[data-act]`、导出菜单 `[data-export-mode]` */
  itemSelector: string;
  /** 触发按钮：同步 `aria-expanded`，并作为默认焦点归还目标 */
  trigger?: HTMLElement;
  /** 焦点归还覆盖（右键菜单用 `focusTree`，而不是某个会被回收的行元素） */
  returnFocus?: () => void;
  /** 选中项（click / Enter / Space 原生激活）——先回调、再关闭菜单 */
  onSelect: (item: HTMLElement) => void;
  onOpen?: () => void;
  onClose?: (reason: MenuCloseReason) => void;
  /** 内层滚动时关闭（右键菜单 true；导出菜单锚在固定工具栏，false） */
  closeOnScroll?: boolean;
  /** 外部 pointerdown 关闭时归还焦点（右键菜单 true，保持旧行为；导出菜单 false） */
  returnFocusOnOutside?: boolean;
}

export interface MenuController {
  readonly isOpen: boolean;
  open(anchor: MenuAnchor, preferredItem?: HTMLElement | null): void;
  close(reason?: MenuCloseReason): void;
}

/** 单活 registry：打开一个菜单先关掉另一个（ADR-0015 §2.5）。 */
let activeMenu: MenuController | null = null;

export function createMenu(config: MenuConfig): MenuController {
  const { element } = config;
  let open = false;

  const items = (): HTMLElement[] => Array.from(element.querySelectorAll<HTMLElement>(config.itemSelector));
  const enabledItems = (): HTMLElement[] => items().filter((item) => !(item as HTMLButtonElement).disabled);
  const focusOpener = (): void => {
    if (config.returnFocus) config.returnFocus();
    else config.trigger?.focus();
  };
  const syncExpanded = (expanded: boolean): void => {
    config.trigger?.setAttribute('aria-expanded', String(expanded));
  };

  const place = (anchor: MenuAnchor): void => {
    const rect = element.getBoundingClientRect();
    const placement = computeMenuPosition(
      anchor,
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight },
      { margin: MENU_VIEWPORT_MARGIN, gap: MENU_ANCHOR_GAP },
    );
    element.style.left = `${placement.left}px`;
    element.style.top = `${placement.top}px`;
    if (placement.maxHeight === null) {
      element.style.maxHeight = '';
      element.style.overflowY = '';
    } else {
      element.style.maxHeight = `${placement.maxHeight}px`;
      element.style.overflowY = 'auto';
    }
  };

  const onClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement | null;
    const item = target?.closest<HTMLElement>(config.itemSelector) ?? null;
    if (!item || !element.contains(item) || (item as HTMLButtonElement).disabled) return;
    // 先回调再关闭：回调里可能还要读打开时记下的上下文（如右键菜单的 ctxPath），
    // 关闭会触发 onClose 清理；动作本身是异步的，视觉上同一 tick。
    config.onSelect(item);
    controller.close('select');
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      controller.close('escape');
      return;
    }
    if (event.key === 'Tab') {
      // 关闭菜单、焦点回 opener；不 preventDefault——浏览器默认 Tab 会从 opener 继续移动，
      // 因此不会把用户困在「菜单已关但焦点停在 body」的状态。
      controller.close('blur');
      focusOpener();
      return;
    }
    if (!isMenuNavKey(event.key)) return;
    event.preventDefault();
    const list = enabledItems();
    const current = document.activeElement instanceof HTMLElement ? list.indexOf(document.activeElement) : -1;
    const next = nextMenuIndex(list.length, current, event.key);
    if (next >= 0) list[next]?.focus();
  };

  const onDocumentPointerDown = (event: PointerEvent): void => {
    if (!open) return;
    const target = event.target as Node | null;
    if (!target) return;
    if (element.contains(target) || config.trigger?.contains(target)) return;
    controller.close('outside');
  };

  const onWindowResize = (): void => {
    if (open) controller.close('resize');
  };

  const onDocumentScroll = (event: Event): void => {
    if (!open) return;
    const target = event.target as Node | null;
    // 菜单自身滚动（超高时 overflow:auto）不算「外部滚动」
    if (target && element.contains(target)) return;
    controller.close('scroll');
  };

  const onFocusOut = (event: FocusEvent): void => {
    if (!open) return;
    const next = event.relatedTarget as Node | null;
    if (next && element.contains(next)) return;
    controller.close('blur');
  };

  const controller: MenuController = {
    get isOpen(): boolean {
      return open;
    },
    open(anchor: MenuAnchor, preferredItem: HTMLElement | null = null): void {
      if (activeMenu && activeMenu !== controller) activeMenu.close('programmatic');
      if (open) controller.close('programmatic');
      activeMenu = controller;
      element.hidden = false;
      open = true;
      syncExpanded(true);
      place(anchor);
      const list = enabledItems();
      const target = preferredItem && list.includes(preferredItem) ? preferredItem : (list[0] ?? null);
      target?.focus();
      config.onOpen?.();
    },
    close(reason: MenuCloseReason = 'programmatic'): void {
      if (!open) return;
      open = false;
      element.hidden = true;
      element.style.maxHeight = '';
      element.style.overflowY = '';
      syncExpanded(false);
      if (activeMenu === controller) activeMenu = null;
      const wantsFocus =
        reason === 'escape' ||
        reason === 'select' ||
        (reason === 'outside' && config.returnFocusOnOutside === true);
      if (wantsFocus) focusOpener();
      config.onClose?.(reason);
    },
  };

  element.addEventListener('click', onClick);
  element.addEventListener('keydown', onKeyDown);
  document.addEventListener('pointerdown', onDocumentPointerDown, true);
  window.addEventListener('resize', onWindowResize);
  if (config.closeOnScroll === true) document.addEventListener('scroll', onDocumentScroll, true);
  element.addEventListener('focusout', onFocusOut);

  return controller;
}
