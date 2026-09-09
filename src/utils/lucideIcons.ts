// The Lucide icon set, loaded only when the picker is opened.
//
// 1,818 icons of node data (~91KB gzipped) plus their search keywords (~43KB).
// That is a lot to carry for a feature most sessions never touch, so BOTH JSON
// files are behind a dynamic `import()` and Vite splits them into their own
// chunk. Nothing here may be imported from a module the main bundle reaches —
// the same import discipline the PDF/tldraw split runs on (see AGENTS.md).
//
// The FILE TREE never waits on this: `.folders.json` stores the chosen icon's
// node data alongside the folder that uses it, so a row draws its icon from the
// vault file. This module is the picker's business alone.

import type { IconNode } from './entryStyle';

export interface LucideIcon {
    name: string;
    nodes: IconNode[];
    /** Lucide's own search keywords, plus the words of the name itself. */
    keywords: string[];
}

/**
 * What the picker shows before anything is typed.
 *
 * Lucide's set is alphabetical, so the first screen of it is `a-arrow-down`,
 * `airplay` and thirty alignment glyphs — a wall of things nobody labels a
 * folder with. These are the ones people actually reach for, grouped by the kind
 * of folder they suit (study, code, work, media, life), and search still reaches
 * all 1,818 the moment a key is pressed.
 */
export const SUGGESTED_ICONS = [
    'folder', 'folder-open', 'folder-git-2', 'archive', 'inbox', 'files', 'paperclip', 'bookmark', 'tag', 'pin',
    'book', 'book-open', 'book-marked', 'library', 'graduation-cap', 'school', 'notebook-pen', 'file-text', 'clipboard-list', 'presentation',
    'flask-conical', 'atom', 'microscope', 'brain', 'sigma', 'square-function', 'calculator', 'binary', 'chart-line', 'chart-pie',
    'code', 'terminal', 'braces', 'database', 'server', 'cpu', 'git-branch', 'bug', 'settings', 'wrench',
    'briefcase', 'building-2', 'calendar', 'receipt', 'trending-up', 'dollar-sign', 'wallet', 'shopping-cart', 'mail', 'phone',
    'image', 'camera', 'video', 'film', 'music', 'mic', 'palette', 'brush', 'pen-tool', 'gamepad-2',
    'heart', 'star', 'flag', 'target', 'lightbulb', 'rocket', 'sparkles', 'zap', 'flame', 'clock',
    'globe', 'map', 'plane', 'car', 'house', 'users', 'user', 'message-square', 'bell', 'shield',
    'dumbbell', 'utensils', 'coffee', 'leaf', 'sun', 'moon', 'cloud', 'lock', 'key', 'trash',
];

let loading: Promise<LucideIcon[]> | null = null;

/**
 * Every Lucide icon, sorted by name. Cached: the second call is free, so the
 * picker can be opened and closed without re-parsing 700KB of JSON.
 */
export function loadLucideIcons(): Promise<LucideIcon[]> {
    loading ??= (async () => {
        const [nodes, tags] = await Promise.all([
            import('lucide-static/icon-nodes.json'),
            import('lucide-static/tags.json'),
        ]);
        // Through `unknown`: TypeScript infers the literal shape of a 700KB
        // JSON file, and `[string, object]` pairs widen to `(string|object)[]`
        // — an array type it cannot see as the fixed-length tuple IconNode is.
        const iconNodes = nodes.default as unknown as Record<string, IconNode[]>;
        const iconTags = tags.default as unknown as Record<string, string[]>;

        return Object.keys(iconNodes).sort().map(name => ({
            name,
            nodes: iconNodes[name],
            // The name's own words are keywords too: Lucide's tag list for
            // "folder-open" does not contain "folder", so searching the obvious
            // word would otherwise miss the obvious icon.
            keywords: [...new Set([...name.split('-'), ...(iconTags[name] ?? [])])],
        }));
    })().catch(err => {
        // Let a failed load be retried rather than cached forever — this is a
        // network fetch of a chunk, and offline-then-online is a real sequence.
        loading = null;
        throw err;
    });
    return loading;
}

/**
 * Rank icons against a query.
 *
 * Ordering matters more than filtering here: searching "book" should put `book`
 * first and `bookmark`, `book-open`, `notebook` after it, not scatter them
 * through 40 alphabetical matches. So exact name beats name-prefix beats
 * name-substring beats keyword, and ties fall back to the alphabetical order the
 * list already carries.
 */
export function searchIcons(icons: LucideIcon[], query: string): LucideIcon[] {
    const q = query.trim().toLowerCase();
    // Nothing typed: lead with the suggestions rather than the alphabet, then
    // let the rest follow so scrolling still reaches everything.
    if (!q) {
        const byName = new Map(icons.map(i => [i.name, i]));
        const suggested = SUGGESTED_ICONS.map(n => byName.get(n)).filter((i): i is LucideIcon => !!i);
        const seen = new Set(suggested.map(i => i.name));
        return [...suggested, ...icons.filter(i => !seen.has(i.name))];
    }

    const scored: Array<{ icon: LucideIcon; rank: number }> = [];
    for (const icon of icons) {
        const name = icon.name;
        let rank: number;
        if (name === q) rank = 0;
        else if (name.startsWith(q)) rank = 1;
        else if (name.includes(q)) rank = 2;
        else if (icon.keywords.some(k => k === q)) rank = 3;
        else if (icon.keywords.some(k => k.startsWith(q))) rank = 4;
        else continue;
        scored.push({ icon, rank });
    }
    // A stable sort, so equal ranks keep the alphabetical order they arrived in.
    scored.sort((a, b) => a.rank - b.rank);
    return scored.map(s => s.icon);
}
