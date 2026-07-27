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

/* ── Extracted-link cache ──
   buildGraph runs after EVERY completed save (and on every tree change, which
   includes pasting an image). It used to read EVERY markdown file in the vault
   on each of those and hold all of their contents alive at once — measured at
   200 file reads and 2.07MB per keystroke-triggered autosave on a 200-note
   vault, scaling linearly, i.e. the app's largest source of sustained GC
   pressure and disk traffic.

   Only the extracted link targets are ever needed — a handful of short strings
   per note, not its text. Caching those against (lastModified, size) means a
   save re-reads exactly the one file that changed and every other note costs a
   stat. That is the same staleness signal the vault-search index already ships
   with, applied to the same files. */

interface LinkCacheEntry {
    mtime: number;
    size: number;
    targets: string[];
}

let linkCache = new Map<string, LinkCacheEntry>();

/** Forget every cached extraction — a different vault may reuse paths. */
export function clearLinkCache(): void {
    linkCache = new Map();
}

async function linksFor(node: FileTreeFileNode): Promise<string[]> {
    const file = await node.handle.getFile();
    const prev = linkCache.get(node.path);
    if (prev && prev.mtime === file.lastModified && prev.size === file.size) return prev.targets;
    // Normalized exactly as readFile does, so link extraction sees the same
    // text the editor and the search index do.
    const text = (await file.text()).replace(/\r\n?/g, '\n');
    const targets = extractLinks(text);
    linkCache.set(node.path, { mtime: file.lastModified, size: file.size, targets });
    return targets;   // `text` is garbage from here — one file's worth, not the vault's
}

/**
 * Build the link graph over the vault's markdown files.
 *
 * Reads only files whose (lastModified, size) have moved since the last build —
 * see the link cache above. Reads its own text rather than taking a readFile
 * callback, because it needs the File object for that validation anyway.
 *
 * @param {Array} fileTree  nested file tree from FileSystemContext
 * @returns {{ nodes, links, backlinks, outlinks }}
 *   nodes:     [{ id, name, label, node, unresolved, degree }]
 *   links:     [{ source, target }]   (ids reference node.id)
 *   backlinks: { [id]: [sourceId, ...] }
 *   outlinks:  { [id]: [targetId, ...] }
 */
export async function buildGraph(fileTree: FileTreeNode[]): Promise<GraphData> {
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

    // Concurrent, and — thanks to the (mtime, size) cache — a stat rather than a
    // read for every file that hasn't changed since the last rebuild.
    const targetsPerFile = await Promise.all(files.map(f => linksFor(f).catch(() => [] as string[])));

    // Track the vault: drop entries for files that have been deleted or renamed,
    // so the cache can never outgrow the notes it describes.
    if (linkCache.size > files.length) {
        const live = new Set(files.map(f => f.path));
        for (const path of [...linkCache.keys()]) {
            if (!live.has(path)) linkCache.delete(path);
        }
    }

    for (let fi = 0; fi < files.length; fi++) {
        const f = files[fi];

        for (const raw of targetsPerFile[fi]) {
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
    // Bail before touching `nodes`: a note with no backlinks — the common case —
    // used to build a Map over EVERY node in the vault to answer "none".
    if (sourceIds.length === 0) return [];
    const wanted = new Set(sourceIds);
    const byId = new Map<string, GraphNode>();
    for (const n of graph?.nodes || []) {
        if (wanted.has(n.id)) byId.set(n.id, n);
    }
    return sourceIds.map(id => byId.get(id)).filter(Boolean) as GraphNode[];
}
