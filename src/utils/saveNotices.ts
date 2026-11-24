/**
 * Save failures, told without taking the keyboard.
 *
 * An autosave fails while the person is typing, so its report must not be the modal "Could not continue" dialog: that
 * focused its OK button and the next Space pressed it (measured: "abc more" typed across a failed save landed as
 * "abcmore", the space swallowed by the dialog). A notice here is drawn beside the update notice, announced as an
 * alert, and never focused. One per document (keyed by its tab id): a retry that fails again replaces it, a save
 * that succeeds takes it away. Dismissed, it stays away until that document saves again: every keystroke's retry
 * bringing it back would bury the editor.
 */
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

/** The document saved: its notice goes, and a later failure is told again. */
export function clearSaveNotice(id: string): void {
    dismissed.delete(id);
    const wasFailed = failed.delete(id);
    if (notices.some(notice => notice.id === id)) publish(notices.filter(notice => notice.id !== id));
    else if (wasFailed) publish(notices);
}

/** True from a failed save of this document until one succeeds, whether or not its notice was dismissed. */
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
