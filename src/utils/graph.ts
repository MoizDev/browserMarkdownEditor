/**
 * Graph utilities — parse note-to-note links and build a graph
 * (nodes + edges + backlinks) for the Neural Brain view and the
 * Backlinks panel.
 *
 * Supported link syntaxes:
 *   - Obsidian wikilinks:   [[Note]], [[Note|alias]], [[Note#heading]]
 *   - Markdown links:       [text](Some Note.md)
 *
 * Image embeds (![[file.png]]) are intentionally ignored.
 */

import { collectFiles } from './tree';
import type {
    FileTreeNode,
    FileTreeFileNode,
    GraphNode,
    GraphLink,
    GraphAdjacency,
    GraphData,
} from '../types';

/** Strip directory + .md extension to get a note's display name. */
export function baseName(pathOrName: string): string {
    const seg = String(pathOrName).split('/').pop() || '';
    return seg.replace(/\.md$/i, '');
}

/**
 * Extract all outgoing link targets from a markdown document.
 * Returns an array of raw target strings (note names or relative paths).
 */
export function extractLinks(text: string): string[] {
    const targets: string[] = [];
    if (!text) return targets;
    let m: RegExpExecArray | null;

    // Wikilinks — the leading (!?) lets us skip image embeds ![[...]]
    const wikiRegex = /(!?)\[\[([^\]\n]+?)\]\]/g;
    while ((m = wikiRegex.exec(text)) !== null) {
        if (m[1] === '!') continue; // image embed, not a note link
        const target = m[2].split('|')[0].split('#')[0].trim();
        if (target) targets.push(target);
    }

    // Markdown links pointing at a .md file
    const mdRegex = /\[[^\]]*\]\(([^)]+?\.md)\)/g;
    while ((m = mdRegex.exec(text)) !== null) {
        let target = m[1];
        try { target = decodeURIComponent(target); } catch { /* keep raw */ }
        targets.push(target);
    }

    return targets;
}

/** Flatten the file tree into a list of markdown file nodes. */
export function collectMarkdownFiles(fileTree: FileTreeNode[]): FileTreeFileNode[] {
    return collectFiles(fileTree).filter(f => /\.md$/i.test(f.name));
}

/**
 * Build the link graph by reading every markdown file in the vault.
 *
 * @param {Array} fileTree  nested file tree from FileSystemContext
 * @param {Function} readFile  async (handle) => string
 * @returns {{ nodes, links, backlinks, outlinks }}
 *   nodes:     [{ id, name, label, node, unresolved, degree }]
 *   links:     [{ source, target }]   (ids reference node.id)
 *   backlinks: { [id]: [sourceId, ...] }
 *   outlinks:  { [id]: [targetId, ...] }
 */
export async function buildGraph(
    fileTree: FileTreeNode[],
    readFile: (fileHandle: FileSystemFileHandle) => Promise<string>,
): Promise<GraphData> {
    const files = collectMarkdownFiles(fileTree);

    // Index note name -> path for link resolution (case-insensitive).
    const index = new Map<string, string>();
    for (const f of files) {
        index.set(baseName(f.name).toLowerCase(), f.path);
    }

    const nodesMap = new Map<string, GraphNode>();
    for (const f of files) {
        nodesMap.set(f.path, {
            id: f.path,
            name: baseName(f.name),
            label: f.name,
            node: f,
            unresolved: false,
            degree: 0,
        });
    }

    const links: GraphLink[] = [];
    const backlinks: GraphAdjacency = {};
    const outlinks: GraphAdjacency = {};
    const seen = new Set<string>(); // dedupe identical source->target edges

    // Read all note contents concurrently — the reads are independent, so this
    // avoids N serialized File System round-trips per rebuild.
    const contents = await Promise.all(files.map(f => readFile(f.handle).catch(() => '')));
    for (let fi = 0; fi < files.length; fi++) {
        const f = files[fi];
        const content = contents[fi];

        for (const raw of extractLinks(content)) {
            const key = baseName(raw).toLowerCase();
            if (!key) continue;

            let targetPath = index.get(key);
            if (!targetPath) {
                // Unresolved link — create a faint placeholder node (like Obsidian).
                targetPath = `unresolved:${key}`;
                if (!nodesMap.has(targetPath)) {
                    nodesMap.set(targetPath, {
                        id: targetPath,
                        name: baseName(raw),
                        label: baseName(raw),
                        node: null,
                        unresolved: true,
                        degree: 0,
                    });
                }
            }

            if (targetPath === f.path) continue; // ignore self-links

            const edgeKey = `${f.path}\n${targetPath}`;
            if (seen.has(edgeKey)) continue;
            seen.add(edgeKey);

            links.push({ source: f.path, target: targetPath });
            (backlinks[targetPath] ||= []).push(f.path);
            (outlinks[f.path] ||= []).push(targetPath);
        }
    }

    // Compute degree (total connections) for node sizing.
    for (const l of links) {
        const s = nodesMap.get(l.source);
        const t = nodesMap.get(l.target);
        if (s) s.degree++;
        if (t) t.degree++;
    }

    return { nodes: [...nodesMap.values()], links, backlinks, outlinks };
}

/**
 * Resolve the "linked mentions" for a note — the graph nodes of every note
 * that links to `activeFilePath`. Shared by the backlinks button (count) and
 * the backlinks popover (list).
 */
export function getBacklinkNodes(
    graph: GraphData | null | undefined,
    activeFilePath: string | null | undefined,
): GraphNode[] {
    if (!activeFilePath) return [];
    const sourceIds = graph?.backlinks?.[activeFilePath] || [];
    const byId = new Map((graph?.nodes || []).map((n): [string, GraphNode] => [n.id, n]));
    return sourceIds.map(id => byId.get(id)).filter(Boolean) as GraphNode[];
}
