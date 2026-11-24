import { collectFiles } from './tree';
import { isMarkdownFile, noteDisplayName } from './fileTypes';
import type { FileTreeFileNode, FileTreeNode } from '../types';

/** Display/lookup normalization only, never a name passed to a disk write. */
export function baseName(pathOrName: string): string {
    const segment = String(pathOrName).split('/').pop() || '';
    return noteDisplayName(segment);
}

/** Canonical provider order, not the sidebar's independently sorted copy. */
export function collectMarkdownFiles(fileTree: FileTreeNode[]): FileTreeFileNode[] {
    return collectFiles(fileTree).filter(file => isMarkdownFile(file.name));
}

export interface NoteResolver {
    readonly files: readonly FileTreeFileNode[];
    resolve(target: string): string | undefined;
    resolveNode(target: string): FileTreeFileNode | undefined;
}

const byTree = new WeakMap<FileTreeNode[], NoteResolver>();

/** The same resolver revision for graph publication and the stable App callback.
 *  A save or a presentation-only sort must not rebuild or retarget this index. */
export function getNoteResolver(fileTree: FileTreeNode[]): NoteResolver {
    const cached = byTree.get(fileTree);
    if (cached) return cached;

    const files = collectMarkdownFiles(fileTree);
    const pathsByName = new Map<string, string[]>();
    const nodesByPath = new Map<string, FileTreeFileNode>();
    for (const file of files) {
        const key = baseName(file.name).toLowerCase();
        let paths = pathsByName.get(key);
        if (!paths) pathsByName.set(key, paths = []);
        paths.push(file.path);
        nodesByPath.set(file.path, file);
    }
    // The click has always used the first canonical match. Keeping every path
    // in order makes that policy explicit instead of an accidental last Map.set.
    const resolve = (target: string) => pathsByName.get(baseName(target).toLowerCase())?.[0];
    const resolver: NoteResolver = {
        files,
        resolve,
        resolveNode: target => {
            const path = resolve(target);
            return path === undefined ? undefined : nodesByPath.get(path);
        },
    };
    byTree.set(fileTree, resolver);
    return resolver;
}
