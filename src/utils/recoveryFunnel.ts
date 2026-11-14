import type { createRecoveryJournal } from './recoveryJournalCoordinator';
import { newJournalId } from './recoveryJournal';

/** C-20 supplies an immutable snapshot of the adapter's current dirty revision.
 *  `copy` is a self-contained file, never a delta against a possibly missing file. */
export interface JournalCapture {
    payload: unknown;
    copy: string | Uint8Array | Blob;
    mediaRefs: string[];
}
export type JournalEvent =
    | { type: 'change'; documentId: string; vaultId: string; path: string; fingerprint: string; kind: string; revision: number; capture(): JournalCapture }
    | { type: 'written'; documentId: string; revision: number; fingerprint: string }
    | { type: 'checkpoint' }
    | { type: 'retarget'; vaultId: string; from: string; to: string; folder: boolean }
    | { type: 'release'; documentId: string };

type Change = Extract<JournalEvent, { type: 'change' }>;
interface Session { journalId: string; saved: number; change?: Change }

/** One App-lifetime funnel bridge; no document or pane owns a timer or IDB store. */
export function createRecoveryFunnel(journal: ReturnType<typeof createRecoveryJournal>, failed: (error: unknown) => void) {
    const sessions = new Map<string, Session>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const checkpoint = () => {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        for (const session of sessions.values()) {
            const change = session.change;
            if (!change || change.revision <= session.saved) continue;
            try {
                const data = change.capture();
                journal.record({ vaultId: change.vaultId, journalId: session.journalId, path: change.path,
                    fingerprint: change.fingerprint, kind: change.kind, revision: change.revision,
                    updatedAt: Date.now(), ...data });
            } catch (error) { failed(error); }
        }
        void journal.flush().catch(() => {});
    };
    return (event: JournalEvent): void | Promise<void> => {
        if (event.type === 'checkpoint') { checkpoint(); return; }
        if (event.type === 'retarget') {
            const move = (path: string) => path === event.from ? event.to : event.folder && path.startsWith(`${event.from}/`) ? event.to + path.slice(event.from.length) : path;
            for (const session of sessions.values()) {
                const change = session.change;
                if (!change || change.vaultId !== event.vaultId) continue;
                const capture = change.capture;
                session.change = { ...change, path: move(change.path), capture: () => {
                    const data = capture();
                    return { ...data, mediaRefs: data.mediaRefs.map(move) };
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
