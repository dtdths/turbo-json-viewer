/** Modal dialog using the native <dialog> element: top layer + inert background +
 *  Esc handling + focus containment come from the platform (~45 LOC). */
export interface DialogHandle {
  el: HTMLDialogElement;
  open(title: string, body: string): Promise<'ok' | 'cancel'>;
  close(ok: boolean): void;
}

export function createDialog(): DialogHandle {
  const el = document.createElement('dialog');
  el.className = 'dlg';
  el.innerHTML =
    '<form method="dialog" class="dlg-body">' +
    '<h2 class="dlg-title"></h2><p class="dlg-text"></p>' +
    '<menu class="dlg-actions"><button value="cancel" class="btn">Cancel</button>' +
    '<button value="ok" class="btn primary">OK</button></menu></form>';
  document.body.appendChild(el);
  let resolveFn: ((v: 'ok' | 'cancel') => void) | null = null;
  el.addEventListener('close', () => {
    resolveFn?.(el.returnValue === 'ok' ? 'ok' : 'cancel');
    resolveFn = null;
  });
  return {
    el,
    open(title, body) {
      (el.querySelector('.dlg-title') as HTMLElement).textContent = title;
      (el.querySelector('.dlg-text') as HTMLElement).textContent = body;
      return new Promise<'ok' | 'cancel'>((resolve) => {
        resolveFn = resolve;
        el.returnValue = '';
        el.showModal();
      });
    },
    close(ok) {
      el.returnValue = ok ? 'ok' : 'cancel';
      el.close();
    },
  };
}
