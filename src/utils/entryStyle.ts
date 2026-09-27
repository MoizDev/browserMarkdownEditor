// How things in a vault look: an icon and a colour per file or folder, kept in
// one file at the vault root.
//
//   <vault>/.appearance.json
//   {
//     "version": 1,
//     "entries": {
//       "Math": { "icon": "sigma", "color": "blue" },
//       "Math/Assignment 3.notebook": { "color": "amber" }
//     },
//     "icons": { "sigma": [["path", { "d": "M18 7V5H6l6 7-6 7h12v-2" }]] },
//     "order": { "": ["Inbox", "a.md", "Math"], "Math": ["b.md", "Sub"] }
//   }
//
// KEYED BY VAULT PATH, and a file's path is one just as much as a folder's — so
// nothing here distinguishes the two, and the one place that has to (a folder
// rename carries its descendants, a file's cannot have any) says so where it
// matters, in `renameEntry`.
//
// ONE FILE AT THE VAULT ROOT, not a dot-file inside each folder. `.Assets` and
// `.Garbage` are per-folder because they hold that folder's own content and must
// travel with it; this is a lookup table read once per tree walk, and the walk
// runs after EVERY save (see AGENTS.md). A file per folder would turn that walk
// into one read per customized folder; this makes it one read, full stop. The
// cost is that a moved or renamed folder has to be re-keyed — `renameEntry`
// below is that, and it rides the same hook `movePdfRenderData` already uses.
//
// WHY THE ARTWORK IS STORED TOO. `icons` holds the Lucide node data for exactly
// the icons in use, deduplicated by name. The full set is 1,818 icons — 91KB
// gzipped — and is loaded only while the picker is open; without the artwork
// here the file tree would have to pull all of it on every cold start just to
// draw a handful of folders, and would show default icons until it landed. It
// also makes the vault self-describing: the icons survive being opened by a
// build with a different version of Lucide, or none.
//
// THE TREE'S CUSTOM ORDER LIVES HERE TOO (`order`, shown only under the sort
// menu's Custom). It is per vault and has to travel with it — cleared site data
// or another machine must not lose an arrangement the user built by hand — and
// this file already is exactly that: read once per vault open, written by one
// serialized writer in App, and re-keyed on every rename, move and trash by the
// hooks below. Keyed by FOLDER path ('' = the vault root), valued by child
// NAMES rather than paths, so renaming a folder re-keys one map key instead of
// rewriting every list beneath it. A name no longer on disk is simply ignored;
// a child with no place in its folder's list shows after the listed ones.
//
// WHAT MAY BE STORED HERE is a user decision, not an implementation detail:
// the entries' looks, their artwork, and the custom order. App-wide settings
// (theme, fonts, sizes…) stay in browser storage. A NEW kind of key in this
// file needs the user's permission first — see the entry-styles skill.

import { parentVaultPath } from './paths';

/** A single SVG element of an icon: its tag and its attributes. Lucide's own
 *  `icon-nodes.json` shape, stored verbatim so nothing has to be translated. */
export type IconNode = [tag: string, attrs: Record<string, string | number>];

export interface EntryStyle {
    /** Lucide icon name, or undefined to keep the default folder icon. */
    icon?: string;
    /** A key of ENTRY_COLORS, or undefined for the default. */
    color?: string;
}

/** The file tree's custom order: keyed by FOLDER path ('' = the vault root),
 *  each value that folder's child names — files and folders interleaved — in
 *  display order. A folder never reordered has no key. */
export type EntryOrder = Record<string, string[]>;

/* Its keys are FOLDER PATHS, and a top-level folder may be called `constructor`,
   `toString` or `__proto__` — on a plain object `order['constructor']` is Object
   itself. Measured: renaming or trashing a note inside such a folder threw in
   renameEntry/forgetEntry (`siblings.includes is not a function`) under EVERY
   sort order, and Custom's sort threw on render, blanking the app. So every map
   this module builds has no prototype (a `__proto__` key is then just a key),
   and every read from outside goes through `orderListFor`'s own-key lookup. */
function newOrder(from?: Readonly<EntryOrder>): EntryOrder {
    return Object.assign(Object.create(null) as EntryOrder, from);
}

/** One folder's custom list, or undefined — an OWN-key read, whatever the
 *  folder is called (see `newOrder`). */
export function orderListFor(order: Readonly<EntryOrder>, folderPath: string): readonly string[] | undefined {
    return Object.hasOwn(order, folderPath) ? order[folderPath] : undefined;
}

export interface EntryStyleFile {
    version: number;
    /** Keyed by vault path — files and folders alike. */
    entries: Record<string, EntryStyle>;
    icons: Record<string, IconNode[]>;
    /** Identity-stable while no list changes: the explorer subscribes to it
     *  under Custom, so an icon pick handing out a new one would re-sort the
     *  whole tree for nothing. Every helper below preserves it. */
    order: EntryOrder;
}

export const ENTRY_STYLE_FILE = '.appearance.json';

/**
 * What this file was called when it held folders only.
 *
 * Read once, if the current name is absent, and rewritten under the new one —
 * losing someone's icons to a rename we chose would be inexcusable. The old file
 * is left where it is rather than deleted: it costs a few hundred bytes, and
 * this app does not remove things from a vault to tidy up.
 */
export const LEGACY_STYLE_FILE = '.folders.json';

const FILE_VERSION = 1;

/**
 * The colours a file or folder can take.
 *
 * A NAME is stored, never a hex — because the same row is looked at on a dark
 * sidebar and a light one, and one hex cannot be legible on both. The actual
 * values are two per colour and live in `index.css` as `--folder-<key>`, which
 * is where the theme picks between them; this list is the names, their order,
 * and what to call them out loud.
 */
export const ENTRY_COLORS: Record<string, { label: string }> = {
    red: { label: 'Red' },
    orange: { label: 'Orange' },
    amber: { label: 'Amber' },
    green: { label: 'Green' },
    teal: { label: 'Teal' },
    blue: { label: 'Blue' },
    violet: { label: 'Violet' },
    pink: { label: 'Pink' },
};

/** The CSS variable a colour key resolves through, so both themes get their
 *  own value from one stored name. Unknown keys fall back to the normal text
 *  colour rather than to nothing at all. */
export function entryColorVar(key: string | undefined): string | undefined {
    return key && key in ENTRY_COLORS ? `var(--folder-${key}, currentColor)` : undefined;
}

export function emptyEntryStyles(): EntryStyleFile {
    return { version: FILE_VERSION, entries: {}, icons: {}, order: newOrder() };
}

/** True when this style says nothing — the folder is back to its default and
 *  its entry should be dropped rather than stored as `{}`. */
export function isDefaultStyle(style: EntryStyle | undefined): boolean {
    return !style || (!style.icon && !style.color);
}

/**
 * Read the file's JSON, defensively.
 *
 * `.folders.json` is ordinary text in the user's vault: they can edit it, and an
 * older or newer build of the app can have written it. Anything unreadable
 * yields empty styles — losing an icon is a cosmetic disappointment, throwing
 * here would take the whole file tree down with it.
 */
export function parseEntryStyles(text: string): EntryStyleFile {
    if (!text.trim()) return emptyEntryStyles();
    try {
        const raw = JSON.parse(text) as Partial<EntryStyleFile> & { folders?: Record<string, EntryStyle> };
        const entries: Record<string, EntryStyle> = {};
        // `folders` is what the key was called when only folders could be
        // styled; a file written by that build still reads correctly.
        for (const [path, style] of Object.entries(raw.entries ?? raw.folders ?? {})) {
            if (!style || typeof style !== 'object') continue;
            const icon = typeof style.icon === 'string' ? style.icon : undefined;
            const color = typeof style.color === 'string' && style.color in ENTRY_COLORS
                ? style.color
                : undefined;
            if (icon || color) entries[path] = { icon, color };
        }

        const icons: Record<string, IconNode[]> = {};
        for (const [name, nodes] of Object.entries(raw.icons ?? {})) {
            if (Array.isArray(nodes)) icons[name] = nodes as IconNode[];
        }

        const order = newOrder();
        const rawOrder: unknown = raw.order;
        if (rawOrder && typeof rawOrder === 'object' && !Array.isArray(rawOrder)) {
            for (const [folder, names] of Object.entries(rawOrder)) {
                if (!Array.isArray(names)) continue;
                const list = cleanNames(names);
                if (list.length) order[folder] = list;
            }
        }
        return { version: FILE_VERSION, entries, icons, order };
    } catch (err) {
        console.warn(`Could not read ${ENTRY_STYLE_FILE}; folders will use their default look:`, err);
        return emptyEntryStyles();
    }
}

/** Serialize, dropping any icon artwork no folder still refers to — otherwise
 *  the file only ever grows as the user tries icons out. */
export function serializeEntryStyles(file: EntryStyleFile): string {
    const used = new Set(Object.values(file.entries).map(s => s.icon).filter(Boolean));
    const icons: Record<string, IconNode[]> = {};
    for (const name of used) {
        const nodes = file.icons[name as string];
        if (nodes) icons[name as string] = nodes;
    }
    // `order` is left out entirely while nothing has been reordered, so a vault
    // that only ever had icons keeps writing byte-for-byte the file it did.
    const order = Object.keys(file.order).length ? { order: file.order } : {};
    return JSON.stringify({ version: FILE_VERSION, entries: file.entries, icons, ...order }, null, 2);
}

/** Only non-empty string names, no path separators, each once (first wins) —
 *  the file is user-editable, and a duplicate would give one child two ranks. */
function cleanNames(names: readonly unknown[]): string[] {
    const seen = new Set<string>();
    for (const name of names) {
        if (typeof name === 'string' && name && !name.includes('/')) seen.add(name);
    }
    return [...seen];
}

function sameNames(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && a.every((name, i) => name === b[i]);
}

function lastSegment(path: string): string {
    return path.slice(path.lastIndexOf('/') + 1);
}

/** Set (or clear) one folder's look, returning a NEW file — the store this
 *  feeds is compared by identity. */
export function withEntryStyle(
    file: EntryStyleFile,
    path: string,
    style: EntryStyle,
    iconNodes?: IconNode[],
): EntryStyleFile {
    const entries = { ...file.entries };
    if (isDefaultStyle(style)) delete entries[path];
    else entries[path] = style;

    const icons = { ...file.icons };
    if (style.icon && iconNodes) icons[style.icon] = iconNodes;
    return { version: FILE_VERSION, entries, icons, order: file.order };
}

/** Set one folder's custom order (`null` or `[]` forgets it), returning a NEW
 *  file — or the SAME one when the list is unchanged, so a no-op costs no write. */
export function withEntryOrder(file: EntryStyleFile, folderPath: string, names: readonly string[] | null): EntryStyleFile {
    const list = names ? cleanNames(names) : [];
    const current = orderListFor(file.order, folderPath);
    if (list.length ? current && sameNames(current, list) : !current) return file;
    const order = newOrder(file.order);
    if (list.length) order[folderPath] = list;
    else delete order[folderPath];
    return { ...file, order };
}

/**
 * Follow a rename or a move, taking a folder's descendants with it.
 *
 * Styles are keyed by vault path, so renaming "Math" strands its icon on a path
 * nothing has any more — and every entry inside it too, since their keys all
 * carry the old prefix. The prefix branch simply never matches for a file, which
 * is why one function serves both. Returns the same object when nothing matched,
 * so a rename elsewhere in the vault costs no write.
 */
export function renameEntry(file: EntryStyleFile, from: string, to: string): EntryStyleFile {
    const prefix = `${from}/`;
    let changed = false;
    const entries: Record<string, EntryStyle> = {};
    for (const [path, style] of Object.entries(file.entries)) {
        if (path === from) {
            entries[to] = style;
            changed = true;
        } else if (path.startsWith(prefix)) {
            entries[`${to}/${path.slice(prefix.length)}`] = style;
            changed = true;
        } else {
            entries[path] = style;
        }
    }
    const order = renameInOrder(file.order, from, to);
    if (!changed && order === file.order) return file;
    return { ...file, entries: changed ? entries : file.entries, order };
}

/**
 * `renameEntry` for the custom order — the same object back when nothing in it
 * moved. Two things follow a path: the lists KEYED by it (a folder's own, and
 * every descendant folder's), and its NAME in its parent's list.
 *
 * A rename keeps its slot under the new name — and drops any other occurrence
 * of that name, since renameFile deliberately overwrites a taken one. A move
 * only leaves the old parent's list: the destination's is the drop's to set
 * (the explorer writes it before moving), and an ordinary move into a folder
 * leaves the item unlisted there, which shows it after the listed ones.
 */
function renameInOrder(order: EntryOrder, from: string, to: string): EntryOrder {
    const prefix = `${from}/`;
    let changed = false;
    const next = newOrder();
    const carried: [string, string[]][] = [];
    for (const [key, list] of Object.entries(order)) {
        if (key === from) carried.push([to, list]);
        else if (key.startsWith(prefix)) carried.push([`${to}/${key.slice(prefix.length)}`, list]);
        else next[key] = list;
    }
    // A folder moved onto a taken name MERGES into the one there (moveFile), and
    // that folder's own arrangement is the one the user was looking at: the
    // merged-in children are the newcomers, shown after it.
    for (const [key, list] of carried) {
        changed = true;
        if (!(key in next)) next[key] = list;
    }

    const fromParent = parentVaultPath(from);
    const oldName = lastSegment(from);
    const newName = lastSegment(to);
    const siblings = next[fromParent];
    if (siblings?.includes(oldName)) {
        changed = true;
        if (fromParent === parentVaultPath(to)) {
            next[fromParent] = siblings.filter(n => n !== newName).map(n => (n === oldName ? newName : n));
        } else {
            const rest = siblings.filter(n => n !== oldName);
            if (rest.length) next[fromParent] = rest;
            else delete next[fromParent];
        }
    }
    return changed ? next : order;
}

/** Drop an entry, and everything under it when it is a folder — used when one
 *  is trashed. Same prefix reasoning as `renameEntry`; its place in its
 *  parent's custom order goes too, so a later item of that name starts unlisted
 *  instead of inheriting a slot nobody gave it. */
export function forgetEntry(file: EntryStyleFile, path: string): EntryStyleFile {
    const prefix = `${path}/`;
    let changed = false;
    const entries: Record<string, EntryStyle> = {};
    for (const [key, style] of Object.entries(file.entries)) {
        if (key === path || key.startsWith(prefix)) changed = true;
        else entries[key] = style;
    }

    let orderChanged = false;
    const order = newOrder();
    for (const [key, list] of Object.entries(file.order)) {
        if (key === path || key.startsWith(prefix)) orderChanged = true;
        else order[key] = list;
    }
    const parent = parentVaultPath(path);
    const name = lastSegment(path);
    const siblings = order[parent];
    if (siblings?.includes(name)) {
        orderChanged = true;
        const rest = siblings.filter(n => n !== name);
        if (rest.length) order[parent] = rest;
        else delete order[parent];
    }

    if (!changed && !orderChanged) return file;
    return { ...file, entries: changed ? entries : file.entries, order: orderChanged ? order : file.order };
}
