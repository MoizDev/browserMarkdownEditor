import { readJSON, writeJSON } from './storage';

const KEY = 'expandedPaths';

// Shape-checked: the value is the user's to edit, and a non-array here (measured: `42`, `{"a":1}`) threw at import —
// before React could mount anything — leaving a blank page. Anything but a list of strings reads as "none open".
const stored: unknown = readJSON<unknown>(KEY, []);
let paths = new Set<string>(Array.isArray(stored) ? stored.filter((path): path is string => typeof path === 'string') : []);
const listeners = new Set<() => void>();
const rowListeners = new Map<string, Set<() => void>>();

export function getExpandedPaths(): ReadonlySet<string> {
    return paths;
}

export function subscribeExpandedPaths(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export function isExpanded(path: string): boolean {
    return paths.has(path);
}

export function subscribeExpanded(path: string, listener: () => void): () => void {
    let set = rowListeners.get(path);
    if (!set) rowListeners.set(path, (set = new Set()));
    set.add(listener);
    return () => {
        set.delete(listener);
        if (!set.size) rowListeners.delete(path);
    };
}

function commit(next: Set<string>, touched: Iterable<string>): void {
    const woken = new Set<() => void>();
    for (const path of touched) {
        if (paths.has(path) === next.has(path)) continue;
        const rows = rowListeners.get(path);
        if (rows) for (const row of rows) woken.add(row);
    }
    paths = next;
    writeJSON(KEY, [...next]);
    for (const row of woken) row();
    for (const listener of listeners) listener();
}

export function toggleExpanded(path: string): void {
    const next = new Set(paths);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    commit(next, [path]);
}

export function expandPaths(wanted: readonly string[]): void {
    if (wanted.every(p => paths.has(p))) return;
    const next = new Set(paths);
    for (const p of wanted) next.add(p);
    commit(next, wanted);
}

export function collapsePaths(wanted: readonly string[]): void {
    if (!wanted.some(p => paths.has(p))) return;
    const next = new Set(paths);
    for (const p of wanted) next.delete(p);
    commit(next, wanted);
}

export function retargetExpandedPaths(fromPath: string, newPath: string): void {
    if (newPath === fromPath) return;
    const prefix = `${fromPath}/`;
    const next = new Set<string>();
    const touched: string[] = [];
    let moved = false;
    for (const path of paths) {
        if (path === fromPath || path.startsWith(prefix)) {
            const to = newPath + path.slice(fromPath.length);
            next.add(to);
            touched.push(path, to);
            moved = true;
        } else {
            next.add(path);
        }
    }
    if (!moved) return;
    commit(next, touched);
}
