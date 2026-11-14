import {
    acknowledgeRecovery, discardRecovery, forgetRecoveryVault, listRecovery, markRecoveryCopies,
    retargetRecovery, writeRecoveryEntry,
} from './recoveryJournal';
import type { RecoveryEntry } from './recoveryJournal';
import { groupRecovery } from './recoveryOffers';

/** The one bridge C-20 calls from the funnel. No pane owns a journal timer. */
export function createRecoveryJournal(options: { refused(): void; failed(error: unknown): void }) {
    const pending = new Map<string, RecoveryEntry>();
    const acknowledged = new Map<string, number>();
    const owned = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let tail: Promise<void> = Promise.resolve();
    const key = (vaultId: string, journalId: string) => JSON.stringify([vaultId, journalId]);
    const enqueue = (job: () => Promise<void>): Promise<void> => {
        const run = tail.then(job);
        tail = run.catch(error => { try { options.failed(error); } catch { /* A notice cannot poison the queue. */ } });
        return run;
    };
    const flush = (): Promise<void> => {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        const entries = [...pending.entries()];
        pending.clear();
        return enqueue(async () => {
            for (let i = 0; i < entries.length; i++) {
                const [id, entry] = entries[i];
                if ((acknowledged.get(id) ?? -1) >= entry.revision) continue;
                try { await writeRecoveryEntry(entry, options.refused); }
                catch (error) {
                    // Keep every uncommitted capture for the next checkpoint.
                    for (const [remainingId, remaining] of entries.slice(i)) {
                        if ((acknowledged.get(remainingId) ?? -1) >= remaining.revision) continue;
                        const newer = pending.get(remainingId);
                        if (!newer || newer.revision < remaining.revision) pending.set(remainingId, remaining);
                    }
                    throw error;
                }
            }
        });
    };
    return {
        /** Capture synchronously: an adapter may mutate its own arrays after returning. */
        record(entry: RecoveryEntry): void {
            const id = key(entry.vaultId, entry.journalId);
            owned.add(id);
            if ((acknowledged.get(id) ?? -1) >= entry.revision) return;
            const previous = pending.get(id);
            if (previous && previous.revision > entry.revision) return;
            try { pending.set(id, structuredClone(entry)); }
            catch (error) { options.failed(error); return; }
            if (timer === undefined) timer = setTimeout(() => { void flush().catch(() => {}); }, 500);
        },
        /** Called on hide/pagehide as well as by the timer. */
        flush,
        acknowledge(vaultId: string, journalId: string, revision: number): Promise<void> {
            const id = key(vaultId, journalId);
            acknowledged.set(id, Math.max(acknowledged.get(id) ?? -1, revision));
            if ((pending.get(id)?.revision ?? Infinity) <= revision) pending.delete(id);
            return enqueue(() => acknowledgeRecovery(vaultId, journalId, revision));
        },
        retarget(vaultId: string, from: string, to: string, folder: boolean): Promise<void> {
            // Flush the old names first; the transaction changes every existing record together.
            void flush().catch(() => {});
            return enqueue(() => retargetRecovery(vaultId, from, to, folder));
        },
        async list(vaultId: string): Promise<RecoveryEntry[]> {
            await tail;
            const entries = (await listRecovery(vaultId)).filter(entry => !owned.has(key(entry.vaultId, entry.journalId)));
            const copies = [...groupRecovery(entries).values()].flatMap(group => group.copies);
            await enqueue(() => markRecoveryCopies(vaultId, copies.map(entry => entry.journalId)));
            const copyIds = new Set(copies.map(entry => entry.journalId));
            return entries.map(entry => copyIds.has(entry.journalId) ? { ...entry, copyOnly: true } : entry);
        },
        discard(vaultId: string, journalId: string, revision?: number): Promise<void> {
            const id = key(vaultId, journalId);
            if ((pending.get(id)?.revision ?? -1) > (revision ?? Number.MAX_SAFE_INTEGER)) return Promise.reject(new Error('Newer recovered changes exist; refresh before discarding.'));
            return enqueue(async () => {
                await discardRecovery(vaultId, journalId, revision);
                if ((pending.get(id)?.revision ?? -1) <= (revision ?? Number.MAX_SAFE_INTEGER)) pending.delete(id);
                acknowledged.set(id, Math.max(acknowledged.get(id) ?? -1, revision ?? Number.MAX_SAFE_INTEGER));
            });
        },
        forget(vaultId: string): Promise<void> {
            for (const [id, entry] of pending) if (entry.vaultId === vaultId) pending.delete(id);
            return enqueue(() => forgetRecoveryVault(vaultId));
        },
    };
}
