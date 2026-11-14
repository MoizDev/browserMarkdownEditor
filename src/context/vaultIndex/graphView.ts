import { collectFiles } from '../../utils/tree';
import type { FileTreeNode, GraphData, GraphNode } from '../../types';
import type { IndexGraph } from '../../utils/vaultIndex/types';

/** Attach the app's tree nodes to the worker's already-assembled graph. */
export function graphForTree(snapshot: IndexGraph, tree: FileTreeNode[]): GraphData | null {
    const files = new Map(collectFiles(tree).map(file => [file.path, file]));
    const nodes: GraphNode[] = [];
    for (let i = 0; i < snapshot.paths.length; i++) {
        const file = files.get(snapshot.paths[i]);
        if (!file) return null;
        nodes.push({ id: file.path, name: snapshot.names[i], label: file.name, node: file,
            unresolved: false, degree: snapshot.degrees[i] });
    }
    for (let i = 0; i < snapshot.unresolved.length; i++) {
        const name = snapshot.unresolved[i];
        nodes.push({ id: `unresolved:${name.toLowerCase()}`, name, label: name, node: null,
            unresolved: true, degree: snapshot.degrees[snapshot.paths.length + i] });
    }
    return { nodes, links: snapshot.links, backlinks: snapshot.backlinks, outlinks: snapshot.outlinks };
}
