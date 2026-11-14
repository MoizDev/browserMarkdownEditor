import { writeStoredValue } from '../../../utils/storage';

const key = 'canvasStylePanelCollapsed';
const listeners = new Set<() => void>();
let collapsed = read();

function read(): boolean {
    try { return localStorage.getItem(key) === 'true'; } catch { return false; }
}

export function getPenPanelCollapsed(): boolean { return collapsed; }
export function subscribePenPanel(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
export function setPenPanelCollapsed(value: boolean): void {
    if (collapsed === value) return;
    collapsed = value;
    writeStoredValue(key, String(value));
    for (const listener of listeners) listener();
}

window.addEventListener('storage', event => {
    if (event.key !== key) return;
    const value = event.newValue === 'true';
    if (value === collapsed) return;
    collapsed = value;
    for (const listener of listeners) listener();
});
