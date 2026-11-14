import { useState } from 'react';
import type { RecoveryEntry } from '../utils/recoveryJournal';

interface RecoveryBarProps {
    /** Only a path-and-baseline match may be applied to an open document. */
    matching?: RecoveryEntry;
    /** Missing, changed and older-window entries are copy-only. */
    copies: readonly RecoveryEntry[];
    onRecover(entry: RecoveryEntry): Promise<void>;
    onDiscard(entry: RecoveryEntry): Promise<void>;
    onSaveCopy(entry: RecoveryEntry): Promise<void>;
}

/** The app's own bar: an interrupted edit never opens a native confirmation. */
export default function RecoveryBar({ matching, copies, onRecover, onDiscard, onSaveCopy }: RecoveryBarProps) {
    const [busy, setBusy] = useState(false);
    const run = async (action: (entry: RecoveryEntry) => Promise<void>, entry: RecoveryEntry) => {
        if (busy) return;
        setBusy(true);
        try { await action(entry); } finally { setBusy(false); }
    };
    if (!matching && !copies.length) return null;
    return <section className="recovery-bar" aria-label="Recovered changes">
        {matching && <div className="disk-bar" role="status">
            <span className="disk-bar-message">Unsaved changes were found for <strong>{matching.path}</strong>.</span>
            <span className="disk-bar-actions">
                <button type="button" className="disk-bar-btn" disabled={busy} onClick={() => void run(onDiscard, matching)}>Discard</button>
                <button type="button" className="disk-bar-btn is-primary" disabled={busy} onClick={() => void run(onRecover, matching)}>Recover</button>
            </span>
        </div>}
        {copies.length > 0 && <details className="recovery-copies">
            <summary>Recovered changes available as copies ({copies.length})</summary>
            {copies.map(entry => <div className="recovery-copy" key={entry.journalId}>
                <span>{entry.path}</span>
                <button type="button" className="disk-bar-btn" disabled={busy} onClick={() => void run(onSaveCopy, entry)}>Save a copy</button>
            </div>)}
        </details>}
    </section>;
}
