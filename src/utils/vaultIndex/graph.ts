import type { FileRecord, IndexFile, IndexGraph, IndexSession } from './types';

function baseName(path: string): string {
    return (path.split('/').pop() ?? '').replace(/\.md$/i, '');
}

/** Tree order chooses the same duplicate name as opening a wikilink. */
export async function assembleGraph(session: IndexSession, graphGen: number, treeGen: number, files: readonly IndexFile[],
    records: ReadonlyMap<string, FileRecord>, stale: boolean, slice: () => Promise<void>): Promise<IndexGraph> {
    const notes = files.filter(file => /\.md$/i.test(file.path));
    const paths = notes.map(file => file.path);
    const names = paths.map(baseName);
    const byName = new Map<string, number>();
    for (let i = 0; i < names.length; i++) {
        const key = names[i].toLowerCase();
        if (!byName.has(key)) byName.set(key, i);
    }
    const unresolved: string[] = [];
    const missing = new Map<string, number>();
    const edges: number[] = [];
    const links: { source: string; target: string }[] = [];
    const backlinks: Record<string, string[]> = Object.create(null);
    const outlinks: Record<string, string[]> = Object.create(null);
    const seen = new Set<string>();
    let lastYield = performance.now();
    let work = 0;
    for (let source = 0; source < paths.length; source++) {
        if ((++work & 127) === 0 && performance.now() - lastYield >= 8) { await slice(); lastYield = performance.now(); }
        const facts = records.get(paths[source])?.facts;
        if (!facts) continue;
        for (const raw of [...facts.wikilinks, ...facts.mdLinks]) {
            if ((++work & 127) === 0 && performance.now() - lastYield >= 8) { await slice(); lastYield = performance.now(); }
            const name = baseName(raw);
            const key = name.toLowerCase();
            if (!key) continue;
            let target = byName.get(key);
            if (target === undefined) {
                target = missing.get(key);
                if (target === undefined) {
                    target = paths.length + unresolved.length;
                    missing.set(key, target);
                    unresolved.push(name);
                }
            }
            if (target === source) continue;
            const edge = `${source}:${target}`;
            if (seen.has(edge)) continue;
            seen.add(edge);
            edges.push(source, target);
            const sourceId = paths[source];
            const targetId = target < paths.length ? paths[target] : `unresolved:${key}`;
            links.push({ source: sourceId, target: targetId });
            (backlinks[targetId] ||= []).push(sourceId);
            (outlinks[sourceId] ||= []).push(targetId);
        }
    }
    const degrees = new Int32Array(paths.length + unresolved.length);
    for (const index of edges) {
        degrees[index]++;
        if ((++work & 127) === 0 && performance.now() - lastYield >= 8) { await slice(); lastYield = performance.now(); }
    }
    return { session, graphGen, treeGen, paths, names, unresolved, edges: new Int32Array(edges), degrees, links, backlinks, outlinks, stale };
}
