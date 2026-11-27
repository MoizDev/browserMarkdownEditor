import type { GraphData, GraphNode } from '../types';
export { baseName, collectMarkdownFiles } from './noteResolver';

export function getBacklinkNodes(
    graph: GraphData | null | undefined,
    activeFilePath: string | null | undefined,
): GraphNode[] {
    if (!activeFilePath) return [];
    const sourceIds = graph?.backlinks?.[activeFilePath] || [];
    if (sourceIds.length === 0) return [];
    const wanted = new Set(sourceIds);
    const byId = new Map<string, GraphNode>();
    for (const node of graph?.nodes || []) {
        if (wanted.has(node.id)) byId.set(node.id, node);
    }
    return sourceIds.map(id => byId.get(id)).filter(Boolean) as GraphNode[];
}
