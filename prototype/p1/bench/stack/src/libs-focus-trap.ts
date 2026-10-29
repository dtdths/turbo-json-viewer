/** Size probe: focus-trap (declarative focus containment fallback). */
import { createFocusTrap } from 'focus-trap';
export const makeTrap = (el: HTMLElement) => createFocusTrap(el, { escapeDeactivates: true });
