import { useEffect, useState } from 'react';
import RecoveryBar from './RecoveryBar';
import { createRecoveryJournal } from '../utils/recoveryJournalCoordinator';
import type { RecoveryEntry } from '../utils/recoveryJournal';

export type RecoveryInspection = 'match' | 'equal' | 'copy' | 'unavailable';
interface Props {
    vaultId: string;
    activePath: string | null;
    inspect(entry: RecoveryEntry): Promise<RecoveryInspection>;
    recover(entry: RecoveryEntry): Promise<void>;
    saveCopy(entry: RecoveryEntry): Promise<void>;
    status(message: string): void;
}

/** The scan is bounded by the number of journals, not the size of the vault. */
export default function RecoverySurface({ vaultId, activePath, inspect, recover, saveCopy, status }: Props) {
    const [journal] = useState(() => createRecoveryJournal({
        refused: () => status('Recovery storage may be evicted by the browser.'),
        failed: () => status('Could not access recovery storage.'),
    }));
    const [entries, setEntries] = useState<Array<{ entry: RecoveryEntry; result: RecoveryInspection }>>([]);
    const [applied, setApplied] = useState<Set<string>>(() => new Set());
    useEffect(() => {
        let live = true;
        setEntries([]);
        void (async () => {
            const found = await journal.list(vaultId);
            const classified: Array<{ entry: RecoveryEntry; result: RecoveryInspection }> = [];
            for (const entry of found) {
                const result = await inspect(entry);
                if (!live) return;
                if (result === 'equal') { await journal.discard(vaultId, entry.journalId); continue; }
                classified.push({ entry, result: entry.copyOnly && result === 'match' ? 'copy' : result });
            }
            if (live) setEntries(classified);
        })().catch(error => { console.error('Could not read recovery journal:', error); if (live) status('Could not read recovery storage.'); });
        return () => { live = false; };
    }, [vaultId, activePath, inspect, journal, status]);
    const matching = entries.find(item => item.result === 'match' && item.entry.path === activePath && !applied.has(item.entry.journalId))?.entry;
    const copies = entries.filter(item => item.result === 'copy' && !applied.has(item.entry.journalId)).map(item => item.entry);
    const remove = (entry: RecoveryEntry) => setEntries(current => current.filter(item => item.entry.journalId !== entry.journalId));
    return <RecoveryBar matching={matching} copies={copies}
        onRecover={async entry => { await recover(entry); setApplied(current => new Set(current).add(entry.journalId)); }}
        onDiscard={async entry => { await journal.discard(vaultId, entry.journalId); remove(entry); }}
        onSaveCopy={async entry => { await saveCopy(entry); await journal.discard(vaultId, entry.journalId); remove(entry); }} />;
}
