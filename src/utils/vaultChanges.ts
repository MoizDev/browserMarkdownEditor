// Outside-change records from FileSystemObserver, normalized into one batch.
//
// Observer records are HINTS: they say where to look, never what is true. Every
// consumer re-checks the disk (a stat, then a hash when the stat moved) before
// acting — see App.checkOpenDocs and FileSystemContext's tree patching.
//
// What is NOT verified (no real-disk FSEvents can be driven from the test
// harness; only OPFS can): whether macOS/Linux report a folder move as one
// 'moved' record for the folder and none for its descendants (assumed, and
// handled either way — a missing 'moved' just degrades to disappeared+appeared,
// which the tree handles identically and open documents handle by a conservative
// content match); whether Windows ever reports a cross-directory 'moved' (it does
// not — there it is always disappeared+appeared); whether `relativePathMovedFrom`
// can be null on a 'moved' (treated as a plain 'appeared'); and whether 'modified'
// is ever reported for a directory (dropped if so — the tree never looks at
// modified, and a directory has no content to reload).

import { isIgnoredChangePath } from './vaultEntries';
import { joinVaultPath, parentVaultPath } from './paths';

/** One coalesced, de-noised batch of outside changes. All paths are
 *  vault-root-relative, `utils/paths.ts`-joined, and never hidden/ignored ones. */
export interface VaultChangeBatch {
    /** Contents changed (files only; the tree ignores these). */
    modified: Set<string>;
    appeared: Set<string>;
    disappeared: Set<string>;
    /** Explicit renames/moves the platform reported (not on Windows). */
    moved: Array<{ from: string; to: string }>;
    /** Something unknown happened (an 'unknown'/'errored' record, a polling
     *  tick, too many dirs): treat every path as possibly changed. */
    rescan: boolean;
}

/** Past this many distinct paths a batch is a rescan: tracking each one further
 *  buys nothing (the tree does one full walk beyond 64 dirty directories, and a
 *  rescan makes App re-verify every open document), and the sets would only
 *  grow. Bounds a runaway burst's memory and every merge's cost. */
export const MAX_TRACKED_PATHS = 4096;

/** More dirty directories than this and one full walk is cheaper than that many
 *  separate listings (each is a round trip, and each splices a spine). */
export const MAX_DIRTY_DIRS = 64;

export function emptyBatch(): VaultChangeBatch {
    return { modified: new Set(), appeared: new Set(), disappeared: new Set(), moved: [], rescan: false };
}

export function rescanBatch(): VaultChangeBatch {
    return { ...emptyBatch(), rescan: true };
}

export function isEmptyBatch(b: VaultChangeBatch): boolean {
    return !b.rescan && !b.modified.size && !b.appeared.size && !b.disappeared.size && !b.moved.length;
}

function pathOf(components: readonly string[]): string {
    let path = '';
    for (const name of components) path = joinVaultPath(path, name);
    return path;
}

/**
 * Observer records → one batch. Paths are joined the app's way, records about
 * hidden/ignored entries (`.git`, `.Assets`, `*.crswap`, …) are dropped here so
 * nothing downstream ever sees them, and 'unknown'/'errored' (the platform
 * saying "I lost track") become `rescan`.
 *
 * Linear in the number of records and allocation-light: a `git checkout` of
 * hundreds of files arrives as thousands of records, most of them `.git`.
 */
export function normalizeRecords(records: readonly FileSystemChangeRecord[]): VaultChangeBatch {
    const batch = emptyBatch();
    for (const r of records) {
        if (r.type === 'unknown' || r.type === 'errored') { batch.rescan = true; continue; }
        const comps = r.relativePathComponents;
        // The observed root itself (or a record with no path): we cannot say what
        // changed, only that something did.
        if (!comps || comps.length === 0) { batch.rescan = true; continue; }
        const kind = r.changedHandle?.kind;
        const ignored = isIgnoredChangePath(comps, kind);

        if (r.type === 'moved') {
            const fromComps = r.relativePathMovedFrom;
            const fromIgnored = !fromComps || fromComps.length === 0 || isIgnoredChangePath(fromComps, kind);
            const to = ignored ? null : pathOf(comps);
            const from = fromIgnored ? null : pathOf(fromComps!);
            // One end hidden: from the tree's point of view the entry appeared
            // (moved out of .Garbage) or disappeared (moved into .git).
            if (to !== null && from !== null) batch.moved.push({ from, to });
            else if (to !== null) batch.appeared.add(to);
            else if (from !== null) batch.disappeared.add(from);
            continue;
        }

        if (ignored) continue;
        const path = pathOf(comps);
        if (r.type === 'appeared') batch.appeared.add(path);
        else if (r.type === 'disappeared') batch.disappeared.add(path);
        else if (r.type === 'modified' && kind !== 'directory') batch.modified.add(path);
    }
    capBatch(batch);
    return batch;
}

function capBatch(b: VaultChangeBatch): void {
    if (b.modified.size + b.appeared.size + b.disappeared.size + b.moved.length <= MAX_TRACKED_PATHS) return;
    b.modified.clear();
    b.appeared.clear();
    b.disappeared.clear();
    b.moved.length = 0;
    b.rescan = true;
}

/** Fold `source` into `target` (mutating `target`). Sets only grow — a path that
 *  appears and then disappears inside one window stays in both, and every
 *  consumer re-checks the disk rather than trusting an order the batch does not
 *  keep. A chain of moves (a→b, then b→c) collapses to a→c. */
export function mergeInto(target: VaultChangeBatch, source: VaultChangeBatch): VaultChangeBatch {
    for (const p of source.modified) target.modified.add(p);
    for (const p of source.appeared) target.appeared.add(p);
    for (const p of source.disappeared) target.disappeared.add(p);
    for (const m of source.moved) {
        const chained = target.moved.find(t => t.to === m.from);
        if (chained) chained.to = m.to;
        else target.moved.push({ from: m.from, to: m.to });
    }
    if (source.rescan) target.rescan = true;
    capBatch(target);
    return target;
}

/** A batch with `a` and `b` folded together; neither is mutated. */
export function mergeBatches(a: VaultChangeBatch, b: VaultChangeBatch): VaultChangeBatch {
    return mergeInto(mergeInto(emptyBatch(), a), b);
}

/**
 * The directories whose LISTING may have changed: the parent of everything that
 * appeared, disappeared or moved (both ends). '' is the vault root. `modified`
 * never contributes — a file's contents changing does not change any listing,
 * which is why the app's own autosaves cost the tree nothing.
 */
export function dirtyDirs(batch: VaultChangeBatch): Set<string> {
    const dirs = new Set<string>();
    for (const p of batch.appeared) dirs.add(parentVaultPath(p));
    for (const p of batch.disappeared) dirs.add(parentVaultPath(p));
    for (const m of batch.moved) {
        dirs.add(parentVaultPath(m.from));
        dirs.add(parentVaultPath(m.to));
    }
    return dirs;
}

/** Every path the batch says appeared, disappeared or arrived by a move — a
 *  directory among them must be walked afresh, never reused from the old tree:
 *  `mv other a` replaces `a` with ONE record and its old subtree is stale. */
export function touchedPaths(batch: VaultChangeBatch): Set<string> {
    const out = new Set(batch.appeared);
    for (const m of batch.moved) out.add(m.to);
    for (const p of batch.disappeared) out.add(p);
    return out;
}

/** Where `path` is now, if the batch moved it (or a folder above it); else null.
 *  Only an explicit 'moved' record counts — a guess is never a move. */
export function movedPathOf(batch: VaultChangeBatch, path: string): string | null {
    for (const { from, to } of batch.moved) {
        if (path === from) return to;
        if (path.startsWith(`${from}/`)) return to + path.slice(from.length);
    }
    return null;
}

export interface PathSize {
    path: string;
    size: number;
}

/**
 * Candidate renames for documents whose file vanished, when the platform gave
 * no 'moved' record (Windows; polling; a copy-then-delete mover): a file that
 * APPEARED with the same size.
 *
 * Deliberately conservative: a pairing is returned only when it is UNIQUE in
 * both directions — exactly one appeared file has that size, and no other
 * missing document does. Two same-sized candidates are an ambiguity the caller
 * must read as "deleted", never a coin flip. Size is only the cheap filter:
 * the caller (App.checkOpenDocs) must confirm with the content hash before
 * moving anything, since a move done on a guess re-points a user's tab at
 * somebody else's file.
 *
 * Returns missing path → candidate path.
 */
export function pairMoveCandidates(
    missing: readonly PathSize[],
    appeared: readonly PathSize[],
): Map<string, string> {
    const appearedBySize = new Map<number, PathSize[]>();
    for (const a of appeared) {
        const list = appearedBySize.get(a.size);
        if (list) list.push(a); else appearedBySize.set(a.size, [a]);
    }
    const missingCountBySize = new Map<number, number>();
    for (const m of missing) missingCountBySize.set(m.size, (missingCountBySize.get(m.size) ?? 0) + 1);

    const out = new Map<string, string>();
    for (const m of missing) {
        const candidates = appearedBySize.get(m.size);
        if (candidates?.length === 1 && missingCountBySize.get(m.size) === 1) {
            out.set(m.path, candidates[0].path);
        }
    }
    return out;
}

export interface BatchCoalescer {
    push(batch: VaultChangeBatch): void;
    /** Deliver whatever is pending now. */
    flush(): void;
    /** Drop whatever is pending and stop the timers. */
    cancel(): void;
}

/**
 * Coalesce a stream of batches into few: deliver `debounceMs` after the LAST
 * push (a burst settles into one batch), but never later than `maxWaitMs` after
 * the FIRST (a continuous stream, such as a long build, must still reach the
 * tree). One burst of a few hundred files is one delivery.
 */
export function createBatchCoalescer(
    onFlush: (batch: VaultChangeBatch) => void,
    debounceMs = 100,
    maxWaitMs = 500,
): BatchCoalescer {
    let pending: VaultChangeBatch | null = null;
    let trailing: ReturnType<typeof setTimeout> | null = null;
    let ceiling: ReturnType<typeof setTimeout> | null = null;

    const stop = () => {
        if (trailing !== null) clearTimeout(trailing);
        if (ceiling !== null) clearTimeout(ceiling);
        trailing = ceiling = null;
    };
    const flush = () => {
        stop();
        const batch = pending;
        pending = null;
        if (batch && !isEmptyBatch(batch)) onFlush(batch);
    };
    return {
        push(batch) {
            if (isEmptyBatch(batch)) return;
            pending = pending ? mergeInto(pending, batch) : batch;
            if (trailing !== null) clearTimeout(trailing);
            trailing = setTimeout(flush, debounceMs);
            if (ceiling === null) ceiling = setTimeout(flush, maxWaitMs);
        },
        flush,
        cancel() { stop(); pending = null; },
    };
}
