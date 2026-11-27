import type { ContextMenuCommand, ContextMenuEntry, ContextMenuSubmenu } from '../../../utils/contextMenu';

export interface PaletteGroup {
    readonly id: string;
    readonly label: string;
    readonly entries: readonly ContextMenuEntry[];
}

export interface PaletteLeaf {
    readonly key: string;
    readonly label: string;
    readonly crumb: string;
    readonly command: ContextMenuCommand;
}

export const RECENT_SHOWN = 5;
const MAX_RESULTS = 60;

export function paletteLeaves(groups: readonly PaletteGroup[]): PaletteLeaf[] {
    const leaves: PaletteLeaf[] = [];
    const visit = (entries: readonly ContextMenuEntry[], path: string, crumbs: readonly string[]): void => {
        for (const entry of entries) {
            if (entry.kind === 'command') {
                leaves.push({ key: `${path}/${entry.id}`, label: entry.label, crumb: crumbs.join(' › '), command: entry });
            } else if (entry.kind === 'submenu') {
                const next = crumbs[crumbs.length - 1] === entry.label ? crumbs : [...crumbs, entry.label];
                visit(entry.entries, `${path}/${entry.id}`, next);
            }
        }
    };
    for (const group of groups) visit(group.entries, group.id, [group.label]);
    return leaves;
}

function tidy<T extends ContextMenuEntry>(entries: readonly T[]): T[] {
    const result: T[] = [];
    for (const entry of entries) {
        if (entry.kind === 'separator' && (result.length === 0 || result[result.length - 1].kind === 'separator')) continue;
        result.push(entry);
    }
    while (result.length && result[result.length - 1].kind === 'separator') result.pop();
    return result;
}

type SubmenuRows = ContextMenuSubmenu['entries'];

function runnableSubmenu(entries: SubmenuRows): SubmenuRows {
    const result: SubmenuRows = [];
    for (const entry of entries) {
        if (entry.kind === 'command') {
            if (!entry.disabled) result.push(entry);
        } else if (entry.kind === 'submenu') {
            const inner = runnableSubmenu(entry.entries);
            if (inner.length) result.push({ ...entry, entries: inner, disabled: undefined, reason: undefined });
        } else result.push(entry);
    }
    return tidy(result);
}

export function runnableEntries(entries: readonly ContextMenuEntry[]): ContextMenuEntry[] {
    const result: ContextMenuEntry[] = [];
    for (const entry of entries) {
        if (entry.kind === 'command') {
            if (!entry.disabled) result.push(entry);
        } else if (entry.kind === 'submenu') {
            const inner = runnableSubmenu(entry.entries);
            if (inner.length) result.push({ ...entry, entries: inner, disabled: undefined, reason: undefined });
        } else result.push(entry);
    }
    return tidy(result);
}

export function runnableGroups(groups: readonly PaletteGroup[], readOnly: boolean): PaletteGroup[] {
    return groups
        .map(group => readOnly ? { ...group, entries: runnableEntries(group.entries) } : { ...group, entries: tidy(group.entries) })
        .filter(group => group.entries.some(entry => entry.kind !== 'separator' && entry.kind !== 'label'));
}

function wordScore(word: string, text: string): number | null {
    let at = 0, score = 0, previous = -2;
    for (const character of word) {
        const found = text.indexOf(character, at);
        if (found < 0) return null;
        score += found === previous + 1 ? 3 : 1;
        if (found === 0 || /[\s›(/-]/.test(text[found - 1])) score += 2;
        previous = found;
        at = found + 1;
    }
    return score;
}

export function searchLeaves(leaves: readonly PaletteLeaf[], query: string): PaletteLeaf[] {
    const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const scored: { leaf: PaletteLeaf; score: number }[] = [];
    for (const leaf of leaves) {
        const label = leaf.label.toLocaleLowerCase(), path = leaf.crumb.toLocaleLowerCase();
        let total = 0;
        for (const word of words) {
            const inLabel = wordScore(word, label), inPath = inLabel === null ? wordScore(word, path) : null;
            if (inLabel === null && inPath === null) { total = -1; break; }
            total += inLabel !== null ? inLabel + 10 : inPath ?? 0;
        }
        if (total >= 0) scored.push({ leaf, score: total });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, MAX_RESULTS).map(item => item.leaf);
}

export function recentLeaves(keys: readonly string[], leaves: readonly PaletteLeaf[]): PaletteLeaf[] {
    const byKey = new Map(leaves.map(leaf => [leaf.key, leaf] as const));
    const result: PaletteLeaf[] = [];
    for (const key of keys) {
        const leaf = byKey.get(key);
        if (leaf && !result.includes(leaf)) result.push(leaf);
        if (result.length === RECENT_SHOWN) break;
    }
    return result;
}

export function rememberRecent(keys: readonly string[], key: string, limit: number): string[] {
    return [key, ...keys.filter(item => item !== key)].slice(0, limit);
}
