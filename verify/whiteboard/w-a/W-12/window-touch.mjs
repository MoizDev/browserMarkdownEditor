// Driver-only registration ledger. Native callbacks remain registered normally;
// the app has no observer hook, internal getter or alternate event path.
export function observeWindowTouchListeners() {
  const proto = EventTarget.prototype;
  const add = proto.addEventListener, remove = proto.removeEventListener;
  const kinds = new Set(['touchstart', 'touchmove', 'touchend', 'touchcancel']);
  const ids = new WeakMap(); let nextId = 0;
  const state = window.__w12WindowTouch = { active: new Map(), history: [] };
  function descriptor(type, listener, options) {
    if (!listener || !kinds.has(type)) return null;
    if (!ids.has(listener)) ids.set(listener, ++nextId);
    const capture = typeof options === 'boolean' ? options : !!options?.capture;
    return { key: `${type}:${ids.get(listener)}:${capture}`, type, capture,
      passive: options && typeof options === 'object' ? options.passive ?? null : null,
      source: new Error().stack, at: performance.now() };
  }
  proto.addEventListener = function (type, listener, options) {
    const target = this ?? window;
    if (target === window) {
      const entry = descriptor(type, listener, options);
      // Native add ignores a duplicate callback/capture pair; it does not
      // change the original passive flag. The ledger must do the same.
      if (entry && !state.active.has(entry.key)) {
        state.active.set(entry.key, entry); state.history.push({ action: 'add', ...entry });
      }
    }
    return add.call(target, type, listener, options);
  };
  proto.removeEventListener = function (type, listener, options) {
    const target = this ?? window;
    if (target === window) {
      const entry = descriptor(type, listener, options);
      if (entry && state.active.has(entry.key)) {
        state.active.delete(entry.key); state.history.push({ action: 'remove', ...entry });
      }
    }
    return remove.call(target, type, listener, options);
  };
}

export async function windowTouchState(page) {
  return page.evaluate(() => {
    const active = [...window.__w12WindowTouch.active.values()], history = window.__w12WindowTouch.history;
    // Playwright itself installs three non-passive touch hit-target interceptors.
    // Preserve their raw records, but do not call their anonymous injected stack
    // an app callback. The arming control proves the real served-module stack is caught.
    const app = entry => entry.source?.includes(location.origin);
    return { active, history, appActive: active.filter(app), appHistory: history.filter(app) };
  });
}
