// Settings → Agent replies: the face the agent panel sets replies in, serif
// (the default) or the app's sans. An import-free store, like
// terminalSettings: SettingsPanel (main chunk) writes it and the lazy panel
// chunk applies it, and neither may import the other.
//
// Applied as `data-agent-reply-font="sans"` on <html> (absent = serif, as an
// absent data-theme is dark), which the panel's tokens.css turns into
// --va-reply-font — so the face changes live with no React render, and the
// main chunk carries no knowledge of the panel's CSS.
//
// Clamped on READ: localStorage is the user's to edit, and anything but 'sans'
// is the default.

export type AgentReplyFont = 'serif' | 'sans';

const KEY = 'agentReplyFont';
const ATTR = 'data-agent-reply-font';

function read(): AgentReplyFont {
    try {
        return localStorage.getItem(KEY) === 'sans' ? 'sans' : 'serif';
    } catch {
        return 'serif';
    }
}

let current: AgentReplyFont | null = null;
const listeners = new Set<() => void>();

export function getAgentReplyFont(): AgentReplyFont {
    return (current ??= read());
}

export function subscribeAgentReplyFont(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/** Puts the stored choice on <html>. The panel chunk calls it as it loads;
 *  every change below calls it too. */
export function applyAgentReplyFont(): void {
    if (getAgentReplyFont() === 'sans') document.documentElement.setAttribute(ATTR, 'sans');
    else document.documentElement.removeAttribute(ATTR);
}

function commit(font: AgentReplyFont, store: (storage: Storage) => void): void {
    try { store(localStorage); } catch { /* storage blocked — the choice holds for this page only */ }
    current = font;
    applyAgentReplyFont();
    for (const listener of listeners) listener();
}

export function setAgentReplyFont(font: AgentReplyFont): void {
    const clean: AgentReplyFont = font === 'sans' ? 'sans' : 'serif';
    commit(clean, storage => storage.setItem(KEY, clean));
}

/** Settings → Reset to Defaults. */
export function resetAgentReplyFont(): void {
    commit('serif', storage => storage.removeItem(KEY));
}
