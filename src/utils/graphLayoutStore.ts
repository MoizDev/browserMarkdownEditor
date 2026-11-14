export interface StoredGraphPosition { path: string; x: number; y: number }
export interface StoredGraphLayout { positions: StoredGraphPosition[]; topologySignature: string; alpha?: number }
export interface GraphTopology { nodes: string[]; edges: [string, string][] }

// Session memory is keyed by vault identity, never by the common note paths.
const layouts = new Map<string, StoredGraphLayout>();
export function getGraphLayout(vaultId: string): StoredGraphLayout | undefined { return layouts.get(vaultId); }
export function putGraphLayout(vaultId: string, layout: StoredGraphLayout): void { layouts.set(vaultId, layout); }
export function graphTopology(ids: readonly string[], links: readonly { source: string; target: string }[]): GraphTopology {
    return { nodes: [...ids], edges: links.map(link => [link.source, link.target]) };
}
export function graphTopologySignature(topology: GraphTopology): string { return JSON.stringify(topology); }
export function parseGraphTopology(signature: string): GraphTopology | null {
    try {
        const value: unknown = JSON.parse(signature);
        if (!value || typeof value !== 'object') return null;
        const { nodes, edges } = value as GraphTopology;
        if (!Array.isArray(nodes) || !nodes.every(id => typeof id === 'string') || !Array.isArray(edges) ||
            !edges.every(edge => Array.isArray(edge) && edge.length === 2 && edge.every(id => typeof id === 'string'))) return null;
        return { nodes, edges };
    } catch { return null; }
}
export function graphReheat(previous: GraphTopology | null, next: GraphTopology): number {
    if (!previous) return 1;
    const oldNodes = new Set(previous.nodes), newNodes = new Set(next.nodes);
    const oldEdges = new Set(previous.edges.map(edge => JSON.stringify(edge)));
    const newEdges = new Set(next.edges.map(edge => JSON.stringify(edge)));
    let changed = 0;
    for (const id of oldNodes) if (!newNodes.has(id)) changed++;
    for (const id of newNodes) if (!oldNodes.has(id)) changed++;
    for (const edge of oldEdges) if (!newEdges.has(edge)) changed++;
    for (const edge of newEdges) if (!oldEdges.has(edge)) changed++;
    return changed ? Math.min(1, 0.05 + 2 * changed / Math.max(1, newNodes.size + newEdges.size)) : 0;
}
