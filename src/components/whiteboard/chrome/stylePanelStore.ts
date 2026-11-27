import { writeStoredValue } from '../../../utils/storage';

// The collapse key and the last pen scale keep their names: every file's saved look and fold state carries over.
const collapsedKey = 'canvasStylePanelCollapsed';
const listeners = new Set<() => void>();
let collapsed = read();
const focusers = new Set<() => boolean>();

function read(): boolean {
    try { return localStorage.getItem(collapsedKey) === 'true'; } catch { return false; }
}

export function getStylePanelCollapsed(): boolean { return collapsed; }
export function subscribeStylePanel(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
export function readLastPenScale(): number | null {
    try {
        const raw = localStorage.getItem('penScale');
        if (raw === null || !raw.trim()) return null;
        const value = Number(raw);
        return Number.isFinite(value) && value > 0 ? value : null;
    } catch { return null; }
}

export function persistLastPenScale(value: number): void {
    if (Number.isFinite(value) && value > 0) writeStoredValue('penScale', String(value));
}

export function setStylePanelCollapsed(value: boolean): void {
    if (collapsed === value) return;
    collapsed = value;
    writeStoredValue(collapsedKey, String(value));
    for (const listener of listeners) listener();
}

export function registerStylePanelFocus(focus: () => boolean): () => void {
    focusers.add(focus);
    return () => { focusers.delete(focus); };
}
export function focusStylePanel(): boolean {
    for (const focus of focusers) if (focus()) return true;
    return false;
}

window.addEventListener('storage', event => {
    if (event.key !== collapsedKey) return;
    const value = event.newValue === 'true';
    if (value === collapsed) return;
    collapsed = value;
    for (const listener of listeners) listener();
});
