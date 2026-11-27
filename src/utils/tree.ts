import type { FileTreeFileNode, FileTreeNode } from '../types';

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
