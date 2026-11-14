import type { FileRecord, IndexFile, IndexGraph, IndexSession } from './types';

function baseName(path: string): string {
    return (path.split('/').pop() ?? '').replace(/\.md$/i, '');
}

/** Tree order chooses the same duplicate name as opening a wikilink. */
export function assembleGraph(session: IndexSession, graphGen: number, files: readonly IndexFile[],
    records: ReadonlyMap<string, FileRecord>, stale: boolean): IndexGraph {
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
    const seen = new Set<string>();
    for (let source = 0; source < paths.length; source++) {
        const facts = records.get(paths[source])?.facts;
        if (!facts) continue;
        for (const raw of [...facts.wikilinks, ...facts.mdLinks]) {
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
        }
    }
    return { session, graphGen, paths, names, unresolved, edges: new Int32Array(edges), stale };
}
