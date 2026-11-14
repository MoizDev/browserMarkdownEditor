import type { RecoveryEntry } from './recoveryJournal';

export interface RecoveryOffer {
    /** The only entry eligible for in-place recovery at this path. */
    newest: RecoveryEntry;
    /** Other windows' edits are never discarded or applied to the live file. */
    copies: RecoveryEntry[];
}

/** A path can only have one in-place offer; equal timestamps break ties deterministically. */
export function groupRecovery(entries: readonly RecoveryEntry[]): Map<string, RecoveryOffer> {
    const sorted = [...entries].sort((a, b) => b.updatedAt - a.updatedAt || b.journalId.localeCompare(a.journalId));
    const groups = new Map<string, RecoveryOffer>();
    for (const entry of sorted) {
        const group = groups.get(entry.path);
        if (group) group.copies.push(entry);
        else groups.set(entry.path, { newest: entry, copies: [] });
    }
    return groups;
}

/** Both the path and the raw-byte baseline must agree before applying anything in place. */
export function matchesRecovery(entry: RecoveryEntry, path: string, fingerprint: string): boolean {
    return entry.path === path && entry.fingerprint === fingerprint;
}
