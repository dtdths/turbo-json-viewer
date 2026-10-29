/** Size probe: @floating-ui/dom (menu / tooltip positioning). */
import { computePosition, flip, shift, offset, autoUpdate } from '@floating-ui/dom';
export const place = async (ref: Element, floating: HTMLElement) => {
  const cleanup = autoUpdate(ref, floating, () => {
    void computePosition(ref, floating, { placement: 'bottom-start', middleware: [offset(4), flip(), shift()] }).then(
      ({ x, y }) => {
        floating.style.left = x + 'px';
        floating.style.top = y + 'px';
      },
    );
  });
  return cleanup;
};
