// How things in a vault look: an icon and a colour per file or folder, kept in
// an `.appearance.json` inside each folder that has any.
//
// The MERGED view this module's helpers take and return — every customized
// entry in the open vault, keyed by vault path:
//
//   { version: 2,
//     entries: { "Math": {icon: "sigma"}, "Math/A3.notebook": {color: "amber"} },
//     icons:   { "sigma": [["path", { "d": "M18 7V5H6l6 7-6 7h12v-2" }]] },
//     order:   { "": ["Inbox", "a.md", "Math"], "Math": ["b.md", "Sub"] } }
//
// and the two files on disk it is cut into (`shardEntryStyles`), each keyed by
// its own folder's child names and carrying its own artwork:
//
//   <vault>/.appearance.json
//   { "version": 2, "entries": { "Math": { "icon": "sigma" } },
//     "icons": { "sigma": […] }, "order": { "": ["Inbox", "a.md", "Math"] } }
//
//   <vault>/Math/.appearance.json
//   { "version": 2, "entries": { "A3.notebook": { "color": "amber" } },
//     "icons": {}, "order": { "": ["b.md", "Sub"] } }
//
// KEYED BY VAULT PATH in the merged view, and a file's path is one just as much
// as a folder's — so nothing here distinguishes the two, and the one place that
// has to (a folder rename carries its descendants, a file's cannot have any)
// says so where it matters, in `renameEntry`.
//
// ONE FILE PER CUSTOMIZED FOLDER, each describing ITS OWN CHILDREN — the shape
// above is the MERGED view the app works in, keyed by vault path; on disk it is
// cut into shards (`shardEntryStyles`), one `.appearance.json` per folder that
// has anything to say, holding its children by NAME and its own custom order.
//
// A LOOK BELONGS WITH THE THING IT DESCRIBES. With everything in one file at the
// vault root, opening a folder from Finder — `Vault/Math` rather than `Vault` —
// opened a vault whose styles sat in a file above the root, which the File System
// Access API cannot reach at all: every icon, colour and arrangement vanished,
// and the first pick wrote a fresh file that the outer vault would never see.
// Sharded, the data for `Math/Deep` lives in `Math/.appearance.json`, which is
// inside whichever of those two roots you opened, so the same icons show from
// either one and a change made in one is read by the other. That is what makes
// these keys ABSOLUTE in the only sense a browser has: anchored to the folder
// itself rather than to whichever ancestor happened to be the root.
//
// It also makes moves free: `.Assets` and `.Garbage` are per-folder because they
// hold that folder's own content and must travel with it, and a folder's looks
// are now exactly that — a renamed or trashed folder carries its shards with it
// on disk, and only its ENTRY in its parent's shard has to be re-keyed.
//
// The cost is the read: one per customized folder instead of one, full stop.
// It is still once per vault OPEN, never per tree walk (the walk runs after
// every save — see AGENTS.md): the tree walk already enumerates every folder, so
// it hands App the handle of each `.appearance.json` it passed (`FileTreeDirNode.
// styleFile`) and nothing is opened speculatively. A vault with no icons reads
// nothing at all.
//
// MIGRATION IS AUTOMATIC AND ONE-WAY. A pre-shard file (deep keys like
// `Math/Deep`, or an order keyed by anything but the root) is read whole — that
// is exactly the merged view — and fanned back out the moment the tree lands.
// Nobody loses an icon to a storage change we chose.
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

/** 2 is the sharded layout: `entries` keyed by this folder's own child NAMES
 *  and `order` holding at most the key `''`. 1 was one file at the vault root,
 *  keyed by path all the way down — read forward by `needsFanOut` below. */
const FILE_VERSION = 2;

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
    // `order` is left out entirely while this folder has not been arranged, so
    // a folder that only ever had icons writes no empty key for it.
    const order = Object.keys(file.order).length ? { order: file.order } : {};
    return JSON.stringify({ version: FILE_VERSION, entries: file.entries, icons, ...order }, null, 2);
}

/* ── Shards: the merged view, and the files it is cut into ──────────────────
 * One `.appearance.json` per folder that has anything to say, describing that
 * folder's own children by NAME and its own place in the custom order. The two
 * functions below are inverses: `shardEntryStyles` cuts the merged view up for
 * the writer, `mergeShard` folds one file back in as the reader meets it.
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * Every shard this merged view implies, keyed by the folder it belongs in
 * (`''` = the vault root). A folder with no entries and no order of its own
 * gets no shard at all, so a vault with three icons has three files, not one
 * per folder.
 *
 * The artwork is handed to every shard whole; `serializeEntryStyles` prunes it
 * to what that one file still refers to, which is what keeps each file's icons
 * its own — a folder opened as a vault must draw its icons without the root's.
 */
export function shardEntryStyles(file: EntryStyleFile): Map<string, EntryStyleFile> {
    const shards = new Map<string, EntryStyleFile>();
    const at = (folder: string): EntryStyleFile => {
        let shard = shards.get(folder);
        if (!shard) {
            shard = { version: FILE_VERSION, entries: {}, icons: file.icons, order: newOrder() };
            shards.set(folder, shard);
        }
        return shard;
    };
    for (const [path, style] of Object.entries(file.entries)) {
        if (isDefaultStyle(style)) continue;
        at(parentVaultPath(path)).entries[lastSegment(path)] = style;
    }
    for (const [folder, list] of Object.entries(file.order)) {
        if (list.length) at(folder).order[''] = list;
    }
    return shards;
}

/**
 * Fold the file found in `folder` into the merged view — a NEW merged view, or
 * the same one when it added nothing.
 *
 * WHAT IS ALREADY HELD WINS. Shards are read as the tree reaches their folders,
 * which can be after the reader has already given something in there a look;
 * the store is the newer truth, and a shard read late must not put back an icon
 * that was just cleared.
 *
 * A key with a separator in it is folded in verbatim. That is not a shard — it
 * is a pre-shard file at the root, whose keys are already full vault paths —
 * and reading it is exactly this, which is why migration needs no second
 * parser.
 */
export function mergeShard(file: EntryStyleFile, folder: string, shard: EntryStyleFile): EntryStyleFile {
    const under = (key: string) => (folder ? (key ? `${folder}/${key}` : folder) : key);
    let changed = false;

    const entries = { ...file.entries };
    for (const [name, style] of Object.entries(shard.entries)) {
        const path = under(name);
        if (path in entries || isDefaultStyle(style)) continue;
        entries[path] = style;
        changed = true;
    }

    let order = file.order;
    for (const [key, list] of Object.entries(shard.order)) {
        const target = under(key);
        if (!list.length || orderListFor(order, target)) continue;
        if (order === file.order) order = newOrder(file.order);
        order[target] = list;
        changed = true;
    }

    const icons = { ...file.icons };
    for (const [name, nodes] of Object.entries(shard.icons)) {
        if (name in icons) continue;
        icons[name] = nodes;
        changed = true;
    }

    return changed ? { version: FILE_VERSION, entries, icons, order } : file;
}

/**
 * Was this file written before the looks were sharded — one file at the vault
 * root, keyed by path all the way down?
 *
 * Read off the SHAPE rather than off `version`, because the shape is what
 * actually has to be fanned out and a hand-edited file may say anything: a key
 * with a separator in it, or an order keyed by a folder that is not this one.
 * A root file that only ever styled things at the top level is already a valid
 * shard and is left exactly as it is.
 */
export function needsFanOut(file: EntryStyleFile): boolean {
    return Object.keys(file.entries).some(path => path.includes('/'))
        || Object.keys(file.order).some(folder => folder !== '');
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
