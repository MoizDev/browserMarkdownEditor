// Observer records are HINTS: they say where to look, never what is true. Every
// consumer re-checks the disk (a stat, then a hash when the stat moved) before
// acting — see App.checkOpenDocs and FileSystemContext's tree patching.

import { isIgnoredChangePath } from './vaultEntries';
import { joinVaultPath, parentVaultPath } from './paths';

export interface VaultChangeBatch {
    modified: Set<string>;
    appeared: Set<string>;
    disappeared: Set<string>;
    moved: Array<{ from: string; to: string }>;
    rescan: boolean;
}

export const MAX_TRACKED_PATHS = 4096;

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

export function normalizeRecords(records: readonly FileSystemChangeRecord[]): VaultChangeBatch {
    const batch = emptyBatch();
    for (const r of records) {
        if (r.type === 'unknown' || r.type === 'errored') { batch.rescan = true; continue; }
        const comps = r.relativePathComponents;
        if (!comps || comps.length === 0) { batch.rescan = true; continue; }
        const kind = r.changedHandle?.kind;
        const ignored = isIgnoredChangePath(comps, kind);

        if (r.type === 'moved') {
            const fromComps = r.relativePathMovedFrom;
            const fromIgnored = !fromComps || fromComps.length === 0 || isIgnoredChangePath(fromComps, kind);
            const to = ignored ? null : pathOf(comps);
            const from = fromIgnored ? null : pathOf(fromComps!);
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

export function mergeBatches(a: VaultChangeBatch, b: VaultChangeBatch): VaultChangeBatch {
    return mergeInto(mergeInto(emptyBatch(), a), b);
}

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
    flush(): void;
    cancel(): void;
}

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
