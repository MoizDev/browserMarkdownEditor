import type { TabPane, TabLayout } from '../types';

export const MAX_PANES = 5;

export const EMPTY_LAYOUT: TabLayout = { panes: [], activeId: null };

let idSeq = 0;
export function newPaneId(): string {
    return `tp${(++idSeq).toString(36)}`;
}

const MAX_HISTORY = 32;

const MIN_PANE_PCT = 2;

function equalSizes(count: number): number[] {
    return new Array<number>(count).fill(100 / count);
}

function isEven(sizes: number[]): boolean {
    const even = 100 / sizes.length;
    return sizes.every(s => Math.abs(s - even) < 1e-4);
}

export function normalizeSizes(value: unknown, count: number): number[] | undefined {
    if (count < 2 || count > 100 / MIN_PANE_PCT) return undefined;
    if (!Array.isArray(value) || value.length !== count) return undefined;
    let sum = 0;
    for (const v of value) {
        if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return undefined;
        sum += v;
    }
    if (!Number.isFinite(sum) || sum <= 0) return undefined;

    let sizes = (value as number[]).map(v => (v * 100) / sum);
    const short = sizes.reduce((d, s) => d + Math.max(0, MIN_PANE_PCT - s), 0);
    if (short > 0) {
        const spare = sizes.reduce((t, s) => t + Math.max(0, s - MIN_PANE_PCT), 0);
        sizes = spare > 0
            ? sizes.map(s => (s <= MIN_PANE_PCT
                ? MIN_PANE_PCT
                : s - (s - MIN_PANE_PCT) * (short / spare)))
            : equalSizes(count);
    }
    const out = sizes.map(s => Math.round(s * 1e4) / 1e4);
    let acc = 0;
    for (let i = 0; i < count - 1; i++) acc += out[i];
    out[count - 1] = Math.round((100 - acc) * 1e4) / 1e4;
    return isEven(out) ? undefined : out;
}

export function paneSizes(layout: TabLayout): number[] {
    const n = layout.panes.length;
    const s = layout.sizes;
    return (s && s.length === n ? s : undefined) ?? equalSizes(n);
}

function sameSizes(a: number[] | undefined, b: number[] | undefined): boolean {
    if (a === b) return true;
    if (!a || !b || a.length !== b.length) return false;
    return a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
}

function keepSizes(sizes: number[] | undefined, keep: number[]): number[] | undefined {
    if (!sizes) return undefined;
    return normalizeSizes(keep.map(i => sizes[i]), keep.length);
}

function insertSize(layout: TabLayout, at: number): number[] | undefined {
    if (!layout.sizes) return undefined;
    const n = layout.panes.length;
    const kept = paneSizes(layout).map(s => (s * n) / (n + 1));
    return normalizeSizes([...kept.slice(0, at), 100 / (n + 1), ...kept.slice(at)], n + 1);
}

export function paneOf(layout: TabLayout, path: string): TabPane | null {
    return layout.panes.find(p => p.paths.includes(path)) ?? null;
}

export function paneById(layout: TabLayout, id: string | null): TabPane | null {
    return id === null ? null : layout.panes.find(p => p.id === id) ?? null;
}

export function focusedPane(layout: TabLayout): TabPane | null {
    return paneById(layout, layout.activeId);
}

export function focusedPath(layout: TabLayout): string | null {
    return focusedPane(layout)?.activePath ?? null;
}

export function visiblePaths(layout: TabLayout): string[] {
    return layout.panes.map(p => p.activePath);
}

function showInPane(pane: TabPane, path: string): TabPane {
    if (pane.history[pane.historyIndex] === path) {
        return pane.activePath === path ? pane : { ...pane, activePath: path };
    }
    const history = pane.history.slice(0, pane.historyIndex + 1);
    history.push(path);
    if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
    return { ...pane, activePath: path, history, historyIndex: history.length - 1 };
}

function forgetInHistory(pane: TabPane, path: string): TabPane {
    if (!pane.history.includes(path)) return pane;
    const history: string[] = [];
    let index = -1;
    pane.history.forEach((p, i) => {
        if (p === path) {
            if (i === pane.historyIndex) index = history.length - 1;
            return;
        }
        history.push(p);
        if (i <= pane.historyIndex) index = history.length - 1;
    });
    return { ...pane, history, historyIndex: Math.max(0, Math.min(index, history.length - 1)) };
}

function stepTarget(pane: TabPane, dir: -1 | 1): number | null {
    if (pane.history[pane.historyIndex] !== pane.activePath) return null;
    const open = new Set(pane.paths);
    let i = pane.historyIndex + dir;
    while (i >= 0 && i < pane.history.length && !open.has(pane.history[i])) i += dir;
    return i >= 0 && i < pane.history.length ? i : null;
}

export function canGoBack(pane: TabPane): boolean {
    return stepTarget(pane, -1) !== null;
}

export function canGoForward(pane: TabPane): boolean {
    return stepTarget(pane, 1) !== null;
}

function step(layout: TabLayout, paneId: string, dir: -1 | 1): TabLayout {
    const pane = paneById(layout, paneId);
    if (!pane) return layout;
    const at = stepTarget(pane, dir);
    if (at === null) return layout;
    const next: TabPane = { ...pane, historyIndex: at, activePath: pane.history[at] };
    return {
        ...layout,
        activeId: paneId,
        panes: layout.panes.map(p => (p.id === paneId ? next : p)),
    };
}

export function goBack(layout: TabLayout, paneId: string): TabLayout {
    return step(layout, paneId, -1);
}

export function goForward(layout: TabLayout, paneId: string): TabLayout {
    return step(layout, paneId, 1);
}

export function focusTab(layout: TabLayout, path: string): TabLayout {
    const pane = paneOf(layout, path);
    if (!pane) return layout;
    const next = showInPane(pane, path);
    if (next === pane && layout.activeId === pane.id) return layout;
    return {
        ...layout,
        activeId: pane.id,
        panes: next === pane ? layout.panes : layout.panes.map(p => (p.id === pane.id ? next : p)),
    };
}

export function openTab(layout: TabLayout, path: string): TabLayout {
    if (paneOf(layout, path)) return focusTab(layout, path);
    const target = focusedPane(layout) ?? layout.panes[0] ?? null;
    if (!target) {
        const id = newPaneId();
        return { panes: [{ id, paths: [path], activePath: path, history: [path], historyIndex: 0 }], activeId: id };
    }
    const next = showInPane({ ...target, paths: [...target.paths, path] }, path);
    return {
        ...layout,
        activeId: target.id,
        panes: layout.panes.map(p => (p.id === target.id ? next : p)),
    };
}

export function selectTab(layout: TabLayout, paneId: string, path: string): TabLayout {
    const pane = paneById(layout, paneId);
    if (!pane || !pane.paths.includes(path)) return layout;
    const next = showInPane(pane, path);
    if (next === pane && layout.activeId === paneId) return layout;
    return {
        ...layout,
        activeId: paneId,
        panes: next === pane ? layout.panes : layout.panes.map(p => (p.id === paneId ? next : p)),
    };
}

function neighbourId(panes: TabPane[], index: number): string | null {
    return panes[index]?.id ?? panes[index - 1]?.id ?? null;
}

export function closePane(layout: TabLayout, paneId: string): TabLayout {
    const index = layout.panes.findIndex(p => p.id === paneId);
    if (index === -1) return layout;
    const keep: number[] = [];                     // by index — the widths are positional
    layout.panes.forEach((p, i) => { if (p.id !== paneId) keep.push(i); });
    const panes = keep.map(i => layout.panes[i]);
    return {
        panes,
        activeId: layout.activeId === paneId ? neighbourId(panes, index) : layout.activeId,
        sizes: keepSizes(layout.sizes, keep),
    };
}

export function closePath(layout: TabLayout, path: string): TabLayout {
    const pane = paneOf(layout, path);
    if (!pane) return layout;

    const index = pane.paths.indexOf(path);
    const paths = pane.paths.filter(p => p !== path);
    if (paths.length === 0) return closePane(layout, pane.id);

    let next = forgetInHistory({ ...pane, paths }, path);
    if (pane.activePath === path) next = showInPane(next, paths[Math.min(index, paths.length - 1)]);
    return { ...layout, panes: layout.panes.map(p => (p.id === pane.id ? next : p)) };
}

export function moveTabToPane(layout: TabLayout, path: string, toPaneId: string, toIndex: number): TabLayout {
    const from = paneOf(layout, path);
    const to = paneById(layout, toPaneId);
    if (!from || !to) return layout;

    if (from.id === to.id) {
        const at = from.paths.indexOf(path);
        const insertAt = Math.max(0, Math.min(toIndex > at ? toIndex - 1 : toIndex, from.paths.length - 1));
        if (insertAt === at) return layout;
        const paths = from.paths.slice();
        paths.splice(at, 1);
        paths.splice(insertAt, 0, path);
        return {
            ...layout,
            activeId: from.id,
            panes: layout.panes.map(p => (p.id === from.id ? { ...p, paths } : p)),
        };
    }

    const at = Math.max(0, Math.min(toIndex, to.paths.length));
    const dst = showInPane({ ...to, paths: [...to.paths.slice(0, at), path, ...to.paths.slice(at)] }, path);
    const srcPaths = from.paths.filter(p => p !== path);

    if (srcPaths.length === 0) {
        const keep: number[] = [];
        layout.panes.forEach((p, i) => { if (p.id !== from.id) keep.push(i); });
        return {
            panes: keep.map(i => (layout.panes[i].id === to.id ? dst : layout.panes[i])),
            activeId: to.id,
            sizes: keepSizes(layout.sizes, keep),
        };
    }

    const index = from.paths.indexOf(path);
    let src = forgetInHistory({ ...from, paths: srcPaths }, path);
    if (from.activePath === path) src = showInPane(src, srcPaths[Math.min(index, srcPaths.length - 1)]);
    return {
        ...layout,
        activeId: to.id,
        panes: layout.panes.map(p => (p.id === from.id ? src : p.id === to.id ? dst : p)),
    };
}

export function canSplitToPane(layout: TabLayout, path: string | null): boolean {
    return !!path && !!paneOf(layout, path) && layout.panes.length < MAX_PANES;
}

export function splitToPane(layout: TabLayout, path: string, at: number): TabLayout {
    if (!canSplitToPane(layout, path)) return layout;
    const from = paneOf(layout, path)!;
    const fromIndex = layout.panes.indexOf(from);
    const solo = from.paths.length === 1;
    if (solo && (at === fromIndex || at === fromIndex + 1)) return layout;

    const base = closePath(layout, path);
    const insertAt = Math.max(0, Math.min(solo && at > fromIndex ? at - 1 : at, base.panes.length));
    const pane: TabPane = { id: newPaneId(), paths: [path], activePath: path, history: [path], historyIndex: 0 };
    return {
        panes: [...base.panes.slice(0, insertAt), pane, ...base.panes.slice(insertAt)],
        activeId: pane.id,
        sizes: insertSize(base, insertAt),
    };
}

export function openInSidePane(layout: TabLayout, path: string): TabLayout {
    const holder = paneOf(layout, path);
    if (holder && holder.activePath === path) return layout;
    if (holder && holder.id !== layout.activeId) {
        const next = showInPane(holder, path);
        return { ...layout, panes: layout.panes.map(p => (p.id === holder.id ? next : p)) };
    }
    // Out of the focused pane first (when it is there), so the path is held once.
    const base = holder ? closePath(layout, path) : layout;
    if (base.panes.length === 0) {
        const id = newPaneId();
        return { panes: [{ id, paths: [path], activePath: path, history: [path], historyIndex: 0 }], activeId: id };
    }
    if (base.panes.length < MAX_PANES) {
        const at = base.panes.length;
        const pane: TabPane = { id: newPaneId(), paths: [path], activePath: path, history: [path], historyIndex: 0 };
        return { ...base, panes: [...base.panes, pane], sizes: insertSize(base, at) };
    }
    const side = [...base.panes].reverse().find(p => p.id !== base.activeId) ?? base.panes[base.panes.length - 1];
    const next = showInPane({ ...side, paths: [...side.paths, path] }, path);
    return { ...base, panes: base.panes.map(p => (p.id === side.id ? next : p)) };
}

export function setPaneSizes(layout: TabLayout, sizes: number[] | null): TabLayout {
    if (sizes && sizes.length !== layout.panes.length) return layout;
    const next = sizes ? normalizeSizes(sizes, layout.panes.length) : undefined;
    if (sameSizes(layout.sizes, next)) return layout;
    return { ...layout, sizes: next };
}

export function renamePath(layout: TabLayout, from: string, to: string): TabLayout {
    if (!paneOf(layout, from) || from === to) return layout;

    const keep: number[] = [];
    const panes: TabPane[] = [];
    layout.panes.forEach((pane, i) => {
        if (!pane.paths.includes(from) && !pane.paths.includes(to)) {
            keep.push(i);
            panes.push(pane);
            return;
        }
        const paths = pane.paths.filter(p => p !== to).map(p => (p === from ? to : p));
        if (paths.length === 0) return;
        const wanted = pane.activePath === from ? to : pane.activePath;
        const activePath = paths.includes(wanted) ? wanted : paths[0];
        const forgotten = forgetInHistory(pane, to);
        keep.push(i);
        panes.push(showInPane({
            ...forgotten,
            paths,
            activePath,
            history: forgotten.history.map(p => (p === from ? to : p)),
        }, activePath));
    });
    return {
        panes,
        activeId: panes.some(p => p.id === layout.activeId) ? layout.activeId : panes[0]?.id ?? null,
        sizes: keepSizes(layout.sizes, keep),
    };
}

export function relabelPaths(layout: TabLayout, to: ReadonlyMap<string, string>): TabLayout {
    if (to.size === 0) return layout;
    let changed = false;
    const panes = layout.panes.map(pane => {
        if (!pane.paths.some(p => to.has(p)) && !pane.history.some(p => to.has(p))) return pane;
        changed = true;
        return {
            ...pane,
            paths: pane.paths.map(p => to.get(p) ?? p),
            activePath: to.get(pane.activePath) ?? pane.activePath,
            history: pane.history.map(p => to.get(p) ?? p),
        };
    });
    return changed ? { ...layout, panes } : layout;
}

function isPathMatrix(value: unknown): value is string[][] {
    return Array.isArray(value)
        && value.every(pane => Array.isArray(pane) && pane.every(p => typeof p === 'string'));
}

function isStringList(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(p => typeof p === 'string');
}

export function restoreLayout(
    restored: string[],
    stored: unknown,
    storedFocus: unknown,
    storedSizes: unknown,
    wantActive: string | null,
): TabLayout {
    const available = new Set(restored);
    const placed = new Set<string>();
    const panes: TabPane[] = [];
    const keep: number[] = [];
    const focus = isStringList(storedFocus) ? storedFocus : [];
    const rows = isPathMatrix(stored) ? stored : [];

    for (const [rowIndex, row] of rows.entries()) {
        const paths = row.filter(p => {
            if (!available.has(p) || placed.has(p)) return false;
            placed.add(p);
            return true;
        });
        if (!paths.length) continue;
        const last = panes[panes.length - 1];
        if (last && panes.length >= MAX_PANES) {
            last.paths.push(...paths);
            continue;
        }
        const wanted = focus[rowIndex];
        const activePath = wanted && paths.includes(wanted) ? wanted : paths[0];
        panes.push({ id: newPaneId(), paths, activePath, history: [activePath], historyIndex: 0 });
        keep.push(rowIndex);
    }

    const leftover = restored.filter(p => !placed.has(p));
    if (leftover.length) {
        const last = panes[panes.length - 1];
        if (last) last.paths.push(...leftover);
        else panes.push({
            id: newPaneId(),
            paths: leftover,
            activePath: leftover[0],
            history: [leftover[0]],
            historyIndex: 0,
        });
    }

    const layout: TabLayout = {
        panes,
        activeId: panes[0]?.id ?? null,
        sizes: keepSizes(normalizeSizes(storedSizes, rows.length), keep),
    };
    return wantActive && available.has(wantActive) ? focusTab(layout, wantActive) : layout;
}

export function mergeLayouts(base: TabLayout, opened: TabLayout): TabLayout {
    if (opened.panes.length === 0) return base;
    const wantFocus = focusedPath(opened);
    const held = new Set(base.panes.flatMap(p => p.paths));
    const extra = opened.panes.flatMap(p => p.paths).filter(p => !held.has(p));

    let merged = base;
    if (extra.length) {
        const target = focusedPane(base) ?? base.panes[0] ?? null;
        if (!target) {
            const id = newPaneId();
            merged = {
                panes: [{ id, paths: extra, activePath: extra[0], history: [extra[0]], historyIndex: 0 }],
                activeId: id,
            };
        } else {
            merged = {
                ...base,
                panes: base.panes.map(p => (p.id === target.id ? { ...p, paths: [...p.paths, ...extra] } : p)),
            };
        }
    }
    return wantFocus ? focusTab(merged, wantFocus) : merged;
}
