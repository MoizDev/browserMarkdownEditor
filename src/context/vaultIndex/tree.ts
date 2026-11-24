import { collectFiles } from '../../utils/tree';
import type { FileTreeNode } from '../../types';
import type { IndexTreeDelta, IndexTreeFile } from './client';

export function indexTree(tree: FileTreeNode[]): IndexTreeFile[] {
    return collectFiles(tree).map(file => ({ path: file.path, kind: file.kind, handle: file.handle }));
}

/** Preserve the provider's order; a sidebar presentation sort is not identity. */
export function indexTreeDelta(before: readonly IndexTreeFile[], after: readonly IndexTreeFile[],
    moves: readonly { from: string; to: string }[] = []): IndexTreeDelta | null {
    const old = new Map(before.map(file => [file.path, file]));
    const next = new Map(after.map(file => [file.path, file]));
    const renamed: IndexTreeDelta['renamed'] = [];
    const consumedOld = new Set<string>(), consumedNew = new Set<string>();
    for (const move of moves) {
        const target = next.get(move.to);
        if (!old.has(move.from) || !target || next.has(move.from) || old.has(move.to)) continue;
        renamed.push({ from: move.from, to: move.to, kind: target.kind, handle: target.handle });
        consumedOld.add(move.from); consumedNew.add(move.to);
    }
    const removed = before.filter(file => !consumedOld.has(file.path) && !next.has(file.path)).map(file => file.path);
    const added = after.filter(file => {
        const prior = old.get(file.path);
        return !consumedNew.has(file.path) && (!prior || prior.handle !== file.handle || prior.kind !== file.kind);
    });
    const changedOrder = before.length !== after.length || before.some((file, i) => file.path !== after[i]?.path);
    if (!removed.length && !added.length && !renamed.length && !changedOrder) return null;
    return { added, removed, renamed, ...(changedOrder ? { order: after.map(file => file.path) } : {}) };
}
