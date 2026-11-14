/** Pure note-link extraction and backlinks lookup. Index acquisition, ownership
 * and assembly live in context/vaultIndex and utils/vaultIndex. */
import { localMarkdownTarget } from './linkClassify';
import type { GraphData, GraphNode } from '../types';
export { baseName, collectMarkdownFiles } from './noteResolver';

/** Extract local note targets, excluding image embeds and external URLs. */
export function extractLinks(text: string): string[] {
    const targets: string[] = [];
    if (!text) return targets;
    let m: RegExpExecArray | null;
    const wikiRegex = /(!?)\[\[([^\]\n]+?)\]\]/g;
    while ((m = wikiRegex.exec(text)) !== null) {
        if (m[1] === '!') continue;
        const target = m[2].split('|')[0].split('#')[0].trim();
        if (target) targets.push(target);
    }
    const mdRegex = /\[[^\]]*\]\(([^)]+?\.md)\)/g;
    while ((m = mdRegex.exec(text)) !== null) {
        const target = localMarkdownTarget(m[1]);
        if (target !== null) targets.push(target);
    }
    return targets;
}

/** Resolve linked mentions using current tree nodes attached by the index host. */
export function getBacklinkNodes(
    graph: GraphData | null | undefined,
    activeFilePath: string | null | undefined,
): GraphNode[] {
    if (!activeFilePath) return [];
    const sourceIds = graph?.backlinks?.[activeFilePath] || [];
    // A note with no backlinks must not scan every node merely to answer none.
    if (sourceIds.length === 0) return [];
    const wanted = new Set(sourceIds);
    const byId = new Map<string, GraphNode>();
    for (const n of graph?.nodes || []) {
        if (wanted.has(n.id)) byId.set(n.id, n);
    }
    return sourceIds.map(id => byId.get(id)).filter(Boolean) as GraphNode[];
}
