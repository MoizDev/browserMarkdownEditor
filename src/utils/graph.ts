import type { GraphData, GraphNode } from '../types';
export { baseName, collectMarkdownFiles } from './noteResolver';

/** Resolve linked mentions from the worker's published graph snapshot. */
export function getBacklinkNodes(
    graph: GraphData | null | undefined,
    activeFilePath: string | null | undefined,
): GraphNode[] {
    if (!activeFilePath) return [];
    const sourceIds = graph?.backlinks?.[activeFilePath] || [];
    // Most notes have no backlinks; do not scan the graph for an empty answer.
    if (sourceIds.length === 0) return [];
    const wanted = new Set(sourceIds);
    const byId = new Map<string, GraphNode>();
    for (const node of graph?.nodes || []) {
        if (wanted.has(node.id)) byId.set(node.id, node);
    }
    return sourceIds.map(id => byId.get(id)).filter(Boolean) as GraphNode[];
}
