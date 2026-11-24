import type { ContextMenuCommand, ContextMenuEntry, ContextMenuSubmenu } from '../../../utils/contextMenu';

/** One titled group of the palette's root list. The groups keep the order they are built in; an empty one is not shown. */
export interface PaletteGroup {
    readonly id: string;
    readonly label: string;
    readonly entries: readonly ContextMenuEntry[];
}

/** A command the palette can run, addressed by the path of ids that reaches it. The key is stable across openings, so Recent can keep it. */
export interface PaletteLeaf {
    readonly key: string;
    readonly label: string;
    /** The groups and submenus it sits in, joined for display and for the search. */
    readonly crumb: string;
    readonly command: ContextMenuCommand;
}

/** Recent shows five rows (the preferences keep twenty). */
export const RECENT_SHOWN = 5;
const MAX_RESULTS = 60;

export function paletteLeaves(groups: readonly PaletteGroup[]): PaletteLeaf[] {
    const leaves: PaletteLeaf[] = [];
    const visit = (entries: readonly ContextMenuEntry[], path: string, crumbs: readonly string[]): void => {
        for (const entry of entries) {
            if (entry.kind === 'command') {
                leaves.push({ key: `${path}/${entry.id}`, label: entry.label, crumb: crumbs.join(' › '), command: entry });
            } else if (entry.kind === 'submenu') {
                // A level never repeats the one above it: "Arrange › Arrange" names nothing new.
                const next = crumbs[crumbs.length - 1] === entry.label ? crumbs : [...crumbs, entry.label];
                visit(entry.entries, `${path}/${entry.id}`, next);
            }
        }
    };
    for (const group of groups) visit(group.entries, group.id, [group.label]);
    return leaves;
}

/** Drops separators that would open, close or double a run of rows. */
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

/**
 * A read-only board offers only what can run there: a disabled row is dropped, and so is any submenu left empty.
 * An editable board keeps the disabled rows, each with its reason, so the palette says why a row cannot run.
 */
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

/** Each query word must appear in order inside the text; a match scores higher at a word's start and in an unbroken run. */
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

/** The leaves that match every word of the query, best first. A word may match the row's label or only its path. */
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

/** The Recent rows: the stored keys that still name a runnable row, newest first. */
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

/** The newest-first list after running `key`: it moves to the front, and the list keeps at most `limit` keys. */
export function rememberRecent(keys: readonly string[], key: string, limit: number): string[] {
    return [key, ...keys.filter(item => item !== key)].slice(0, limit);
}
