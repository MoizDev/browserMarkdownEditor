import { decodeDocumentText } from './diskVersion';
import { IndexSessionGuard } from './indexSessionGuard';
import type { ReadOnlyFileSnapshot } from '../types/reading';
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

import { mapPool } from './pool';
import { localMarkdownTarget } from './linkClassify';
import { baseName, getNoteResolver } from './noteResolver';
export { baseName, collectMarkdownFiles } from './noteResolver';
import type {
    FileTreeNode,
    FileTreeFileNode,
    GraphNode,
    GraphLink,
    GraphAdjacency,
    GraphData,
} from '../types';

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
        const target = localMarkdownTarget(m[1]);
        if (target !== null) targets.push(target);
    }

    return targets;
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

// URL-derived targets from the old extractor are not local-note references.
// Cold reads and own-save priming must invalidate the same extraction revision.
const LINK_SCHEMA = 2;

interface LinkCacheEntry {
    schema: number;
    mtime: number;
    size: number;
    targets: string[];
}

export interface GraphBuildToken {
    activation: number;
    generation: number;
    treeRevision: number;
    indexRevision: number;
    request: number;
}

/** A directory can return after a switch; an activation and its maps cannot. */
export class LinkIndexSession extends IndexSessionGuard {
    readonly cache = new Map<string, LinkCacheEntry>();
    readonly lifetime = new AbortController();
    treeRevision = 0;
    indexRevision = 0;
    requestedGeneration = 0;
    completedGeneration = 0;
    fileTree: FileTreeNode[] = [];
    members = new Set<string>();

    commitTree(tree: FileTreeNode[]): void {
        if (tree === this.fileTree) return;
        this.fileTree = tree;
        this.treeRevision++;
        this.indexRevision++;
        const members = new Set(getNoteResolver(tree).files.map(file => file.path));
        for (const path of this.members) if (!members.has(path)) this.advance(path);
        this.members = members;
        // Only the committed whole tree owns membership, never a finishing build.
        for (const path of this.cache.keys()) if (!members.has(path)) this.cache.delete(path);
    }

    token(): GraphBuildToken {
        return { activation: this.activation, generation: this.generation, treeRevision: this.treeRevision,
            indexRevision: this.indexRevision, request: this.requestedGeneration };
    }

    owns(token: GraphBuildToken): boolean {
        return this.current() && token.activation === this.activation && token.generation === this.generation
            && token.treeRevision === this.treeRevision && token.request === this.requestedGeneration;
    }

    accepts(token: GraphBuildToken): boolean {
        return this.owns(token) && token.indexRevision === this.indexRevision;
    }

    override dispose(): void {
        super.dispose();
        this.lifetime.abort();
        this.cache.clear();
    }
}

/**
 * Put a note's links into the cache from text the app is already holding, and
 * say whether they differ from what was there.
 *
 * This is what makes a save cost no disk at all: `flushTab` has just written
 * the bytes and knows their stat, so the one file a rebuild would have read is
 * primed here, and if the answer is `false` — which is every keystroke that
 * does not add or remove a link, i.e. nearly all of them — the rebuild is not
 * worth running: the graph it would produce is the graph on screen.
 */
export function primeLinks(session: LinkIndexSession, path: string, mtime: number, size: number, text: string): boolean {
    if (!session.current() || !session.members.has(path)) return false;
    let targets: string[];
    try { targets = extractLinks(text); }
    catch { targets = []; }
    const prev = session.cache.get(path);
    const changed = !prev || prev.schema !== LINK_SCHEMA || prev.targets.length !== targets.length
        || targets.some((t, i) => t !== prev.targets[i]);
    session.advance(path);
    session.cache.set(path, { schema: LINK_SCHEMA, mtime, size, targets });
    if (changed) session.indexRevision++;
    return changed;
}

type AcquireSnapshot = (handle: FileSystemFileHandle, signal?: AbortSignal) => Promise<ReadOnlyFileSnapshot>;

async function linksFor(session: LinkIndexSession, node: FileTreeFileNode, revalidate: boolean,
    token: GraphBuildToken, acquire: AcquireSnapshot): Promise<string[] | null> {
    if (!session.owns(token)) return null;
    const pathToken = session.capture(node.path);
    const entry = session.cache.get(node.path);
    const cached = entry?.schema === LINK_SCHEMA ? entry : undefined;
    if (!revalidate && cached) return cached.targets;
    let snapshot: ReadOnlyFileSnapshot | undefined;
    try {
        snapshot = await acquire(node.handle, session.lifetime.signal);
        if (!session.owns(token)) return null;
        if (!session.acceptsPath(pathToken)) return session.cache.get(node.path)?.targets ?? null;
        if (cached && cached.mtime === snapshot.stat.lastModified && cached.size === snapshot.stat.size) return cached.targets;
        const bytes = await snapshot.blob.arrayBuffer(); // IO failures remain retryable.
        if (!session.owns(token)) return null;
        // A save supersedes this read, even if the disk stat happened to match.
        if (!session.acceptsPath(pathToken)) return session.cache.get(node.path)?.targets ?? null;
        let targets: string[];
        try { targets = extractLinks(decodeDocumentText(bytes).replace(/\r\n?/g, '\n')); }
        catch { targets = []; }
        session.cache.set(node.path, { schema: LINK_SCHEMA, mtime: snapshot.stat.lastModified, size: snapshot.stat.size, targets });
        return targets;
    } catch (error) {
        if (!session.owns(token)) return null;
        if (!session.acceptsPath(pathToken)) return session.cache.get(node.path)?.targets ?? null;
        session.cache.delete(node.path);
        throw error;
    } finally { snapshot?.dispose(); }
}

/**
 * Build the link graph over the vault's markdown files.
 *
 * Reads only files whose (lastModified, size) have moved since the last build —
 * see the link cache above — and with `revalidate` false does not even stat the
 * ones it has already extracted, which is what a save after `primeLinks` wants.
 * The context capability acquires one immutable snapshot; the cache hit never reads its payload.
 *
 * @param {Array} fileTree  nested file tree from FileSystemContext
 * @returns {{ nodes, links, backlinks, outlinks }}
 *   nodes:     [{ id, name, label, node, unresolved, degree }]
 *   links:     [{ source, target }]   (ids reference node.id)
 *   backlinks: { [id]: [sourceId, ...] }
 *   outlinks:  { [id]: [targetId, ...] }
 */
export async function buildGraph(session: LinkIndexSession, token: GraphBuildToken,
    acquire: AcquireSnapshot, revalidate = true): Promise<GraphData | null> {
    if (!session.accepts(token)) return null;
    const resolver = getNoteResolver(session.fileTree);
    const files = resolver.files;

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

    // Bounded, and — thanks to the (mtime, size) cache — a stat rather than a
    // read for every file that hasn't changed since the last rebuild. With
    // `revalidate` false it is neither: every note already extracted is taken
    // from the cache, and only a note this build has never seen is opened.
    const targetsPerFile = await mapPool(files, f => linksFor(session, f, revalidate, token, acquire).catch(() => [] as string[]));
    if (!session.accepts(token) || targetsPerFile.some(targets => targets === null)) return null;

    for (let fi = 0; fi < files.length; fi++) {
        const f = files[fi];

        for (const raw of targetsPerFile[fi]!) {
            const key = baseName(raw).toLowerCase();
            if (!key) continue;

            let targetPath = resolver.resolve(raw);
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
