// File-tree traversal helpers shared by the link graph and vault search.

import type { FileTreeFileNode, FileTreeNode } from '../types';

/** Flatten the nested file tree into file nodes, depth-first in tree order. */
export function collectFiles(fileTree: FileTreeNode[]): FileTreeFileNode[] {
    const files: FileTreeFileNode[] = [];
    const walk = (nodes: FileTreeNode[]) => {
        for (const node of nodes) {
            if (node.kind === 'file') files.push(node);
            else walk(node.children);
        }
    };
    walk(fileTree);
    return files;
}
