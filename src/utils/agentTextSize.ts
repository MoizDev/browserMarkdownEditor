// Settings → Agent text size: the agent panel's base size in px, from which
// every size in the panel follows. An import-free store, like agentReplyFont:
// SettingsPanel (main chunk) writes it and the lazy panel chunk applies it, and
// neither may import the other.
//
// Applied as `--agent-text-scale` on <html> (base ÷ the default 14, absent at
// the default), which the panel's tokens.css multiplies into each font-size —
// so the panel and its popovers resize live with no React render, and the main
// chunk carries no knowledge of the panel's CSS.
//
// Clamped on READ: localStorage is the user's to edit, and a NaN here would
// reach a calc() and drop every font-size in the panel to the inherited one.

const KEY = 'agentTextSize';
const PROP = '--agent-text-scale';

/** The panel root's base size (frame.css): the number the user is shown. */
export const AGENT_TEXT_SIZE_DEFAULT = 14;
export const AGENT_TEXT_SIZE_MIN = 12;
export const AGENT_TEXT_SIZE_MAX = 20;

function clean(raw: unknown): number {
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (raw === null || raw === '' || !Number.isFinite(n)) return AGENT_TEXT_SIZE_DEFAULT;
    return Math.min(AGENT_TEXT_SIZE_MAX, Math.max(AGENT_TEXT_SIZE_MIN, Math.round(n)));
}

function read(): number {
    try {
        return clean(localStorage.getItem(KEY));
    } catch {
        return AGENT_TEXT_SIZE_DEFAULT;
    }
}

let current: number | null = null;
const listeners = new Set<() => void>();

export function getAgentTextSize(): number {
    return (current ??= read());
}

export function subscribeAgentTextSize(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/** Puts the stored size on <html>. The panel chunk calls it as it loads;
 *  every change below calls it too. */
export function applyAgentTextSize(): void {
    const size = getAgentTextSize();
    const style = document.documentElement.style;
    if (size === AGENT_TEXT_SIZE_DEFAULT) style.removeProperty(PROP);
    else style.setProperty(PROP, String(size / AGENT_TEXT_SIZE_DEFAULT));
}

function commit(size: number, store: (storage: Storage) => void): void {
    try { store(localStorage); } catch { /* storage blocked — the size holds for this page only */ }
    current = size;
    applyAgentTextSize();
    for (const listener of listeners) listener();
}

export function setAgentTextSize(size: number): void {
    const n = clean(size);
    commit(n, storage => storage.setItem(KEY, String(n)));
}

/** Settings → Reset to Defaults. */
export function resetAgentTextSize(): void {
    commit(AGENT_TEXT_SIZE_DEFAULT, storage => storage.removeItem(KEY));
}
