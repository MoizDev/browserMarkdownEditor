export interface SaveNotice { readonly id: string; readonly message: string }

let notices: readonly SaveNotice[] = [];
const dismissed = new Set<string>();
/** Documents whose last save failed, told or dismissed: nothing may wait on a save that has already failed. */
const failed = new Set<string>();
const listeners = new Set<() => void>();
const publish = (next: readonly SaveNotice[]) => { notices = next; for (const listener of [...listeners]) listener(); };

export function showSaveNotice(id: string, message: string): void {
    const newlyFailed = !failed.has(id);
    failed.add(id);
    if (dismissed.has(id)) { if (newlyFailed) publish(notices); return; }
    const at = notices.findIndex(notice => notice.id === id);
    if (at >= 0 && notices[at].message === message) return;
    publish(at >= 0 ? notices.map(notice => notice.id === id ? { id, message } : notice) : [...notices, { id, message }]);
}

export function clearSaveNotice(id: string): void {
    dismissed.delete(id);
    const wasFailed = failed.delete(id);
    if (notices.some(notice => notice.id === id)) publish(notices.filter(notice => notice.id !== id));
    else if (wasFailed) publish(notices);
}

export function saveFailed(id: string): boolean { return failed.has(id); }

export function dismissSaveNotice(id: string): void {
    dismissed.add(id);
    if (notices.some(notice => notice.id === id)) publish(notices.filter(notice => notice.id !== id));
}

export function subscribeSaveNotices(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export function getSaveNotices(): readonly SaveNotice[] { return notices; }
