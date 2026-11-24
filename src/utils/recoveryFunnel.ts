import type { createRecoveryJournal } from './recoveryJournalCoordinator';
import { newJournalId, type RecoveryCopy } from './recoveryJournal';

/** C-20 supplies an immutable snapshot of the adapter's current dirty revision.
 *  `copy` is a self-contained file or recipe, never dependent on a live session or baseline. */
export interface JournalCapture {
    payload: unknown;
    copy: RecoveryCopy;
    mediaRefs: string[];
}
export type JournalEvent =
    | { type: 'change'; documentId: string; vaultId: string; path: string; fingerprint: string; kind: string; revision: number; capture(): JournalCapture | undefined }
    | { type: 'written'; documentId: string; revision: number; fingerprint: string }
    | { type: 'checkpoint'; documentId?: string }
    | { type: 'retarget'; vaultId: string; from: string; to: string; folder: boolean }
    | { type: 'release'; documentId: string };

type Change = Extract<JournalEvent, { type: 'change' }>;
interface Session { journalId: string; saved: number; change?: Change }

/** One App-lifetime funnel bridge; no document or pane owns a timer or IDB store. */
export function createRecoveryFunnel(journal: ReturnType<typeof createRecoveryJournal>, failed: (error: unknown) => void) {
    const sessions = new Map<string, Session>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const checkpoint = (onlyDocumentId?: string) => {
        if (onlyDocumentId === undefined) {
            if (timer !== undefined) clearTimeout(timer);
            timer = undefined;
        }
        for (const [documentId, session] of [...sessions]) {
            if (onlyDocumentId !== undefined && documentId !== onlyDocumentId) continue;
            let settled = false;
            for (let attempt = 0; attempt < 8; attempt++) {
                const change = session.change;
                if (sessions.get(documentId) !== session || !change || change.revision <= session.saved) { settled = true; break; }
                let data: JournalCapture | undefined;
                try { data = change.capture(); }
                catch (error) {
                    if (sessions.get(documentId) !== session || session.change !== change) continue;
                    failed(error); settled = true; break;
                }
                if (sessions.get(documentId) !== session || session.change !== change) continue;
                if (change.revision <= session.saved) { settled = true; break; }
                // Nothing past the session's baseline (a just-converted legacy board): no work to lose.
                if (!data) { settled = true; break; }
                try {
                    journal.record({ vaultId: change.vaultId, journalId: session.journalId, path: change.path,
                        fingerprint: change.fingerprint, kind: change.kind, revision: change.revision,
                        updatedAt: Date.now(), ...data });
                } catch (error) { failed(error); }
                settled = true; break;
            }
            if (!settled && sessions.get(documentId) === session && session.change && session.change.revision > session.saved) {
                failed(new Error(`Recovery checkpoint kept changing for ${documentId}`));
                if (timer === undefined) timer = setTimeout(checkpoint, 500);
            }
        }
        // Scoped callers await the journal flush themselves, so its failure reaches them.
        if (onlyDocumentId === undefined) void journal.flush().catch(() => {});
    };
    return (event: JournalEvent): void | Promise<void> => {
        if (event.type === 'checkpoint') { checkpoint(event.documentId); return; }
        if (event.type === 'retarget') {
            const move = (path: string) => path === event.from ? event.to : event.folder && path.startsWith(`${event.from}/`) ? event.to + path.slice(event.from.length) : path;
            for (const session of sessions.values()) {
                const change = session.change;
                if (!change || change.vaultId !== event.vaultId) continue;
                const capture = change.capture;
                session.change = { ...change, path: move(change.path), capture: () => {
                    const data = capture();
                    return data && { ...data, mediaRefs: data.mediaRefs.map(move) };
                } };
            }
            return journal.retarget(event.vaultId, event.from, event.to, event.folder);
        }
        if (event.type === 'release') {
            // The closing barrier has settled; an existing failed entry stays in IDB.
            sessions.delete(event.documentId);
            return;
        }
        if (event.type === 'change') {
            let session = sessions.get(event.documentId);
            if (!session) { session = { journalId: newJournalId(), saved: -1 }; sessions.set(event.documentId, session); }
            if (event.revision <= session.saved || (session.change && session.change.revision > event.revision)) return;
            session.change = event;
            if (timer === undefined) timer = setTimeout(checkpoint, 500);
            return;
        }
        const session = sessions.get(event.documentId);
        if (!session) return;
        session.saved = Math.max(session.saved, event.revision);
        const change = session.change;
        if (change) void journal.acknowledge(change.vaultId, session.journalId, event.revision).catch(() => {});
        // If a newer edit exists, C-20 emits a fresh change after the adapter has
        // acknowledged this baseline. Never relabel an older pinned delta.
    };
}
