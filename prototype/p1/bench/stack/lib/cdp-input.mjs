/** Small CDP input helpers shared by the UI driver. Trusted input path. */
export const VK = {
  Tab: 9,
  Enter: 13,
  Escape: 27,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Home: 36,
  End: 35,
  PageDown: 34,
  PageUp: 33,
};

export async function key(chrome, sessionId, name) {
  const code = VK[name];
  if (code === undefined) throw new Error('unknown key ' + name);
  await chrome.browser.send(
    'Input.dispatchKeyEvent',
    { type: 'keyDown', key: name, code: name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code },
    sessionId,
  );
  await chrome.browser.send(
    'Input.dispatchKeyEvent',
    { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code },
    sessionId,
  );
}

export async function click(chrome, sessionId, x, y) {
  await chrome.browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sessionId);
  await chrome.browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sessionId);
  await chrome.browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sessionId);
}

export async function drag(chrome, sessionId, x1, y1, x2, y2, steps = 6) {
  await chrome.browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1 }, sessionId);
  await chrome.browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', clickCount: 1 }, sessionId);
  for (let i = 1; i <= steps; i++) {
    const x = x1 + ((x2 - x1) * i) / steps;
    const y = y1 + ((y2 - y1) * i) / steps;
    await chrome.browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 }, sessionId);
  }
  await chrome.browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', clickCount: 1 }, sessionId);
}

/** Role→count summary + a few interesting AX properties. */
export async function axSummary(chrome, sessionId) {
  await chrome.browser.send('Accessibility.enable', {}, sessionId);
  const { nodes } = await chrome.browser.send('Accessibility.getFullAXTree', {}, sessionId);
  const roles = {};
  const interesting = [];
  for (const n of nodes) {
    const role = n.role?.value;
    if (!role) continue;
    roles[role] = (roles[role] || 0) + 1;
    if (['tree', 'treeitem', 'toolbar', 'menuitem', 'separator', 'listbox', 'option', 'dialog'].includes(role)) {
      const props = Object.fromEntries((n.properties || []).map((p) => [p.name, p.value?.value]));
      interesting.push({ role, name: n.name?.value, focused: props.focused, selected: props.selected, expanded: props.expanded });
    }
  }
  return { roles, interesting: interesting.slice(0, 60) };
}
