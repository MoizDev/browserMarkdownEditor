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
//     "icons": { "sigma": [["path", { "d": "M18 7V5H6l6 7-6 7h12v-2" }]] }
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

/** A single SVG element of an icon: its tag and its attributes. Lucide's own
 *  `icon-nodes.json` shape, stored verbatim so nothing has to be translated. */
export type IconNode = [tag: string, attrs: Record<string, string | number>];

export interface EntryStyle {
    /** Lucide icon name, or undefined to keep the default folder icon. */
    icon?: string;
    /** A key of ENTRY_COLORS, or undefined for the default. */
    color?: string;
}

export interface EntryStyleFile {
    version: number;
    /** Keyed by vault path — files and folders alike. */
    entries: Record<string, EntryStyle>;
    icons: Record<string, IconNode[]>;
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
    return { version: FILE_VERSION, entries: {}, icons: {} };
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
        return { version: FILE_VERSION, entries, icons };
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
    return JSON.stringify({ version: FILE_VERSION, entries: file.entries, icons }, null, 2);
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
    return { version: FILE_VERSION, entries, icons };
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
    return changed ? { ...file, entries } : file;
}

/** Drop an entry, and everything under it when it is a folder — used when one
 *  is trashed. Same prefix reasoning as `renameEntry`. */
export function forgetEntry(file: EntryStyleFile, path: string): EntryStyleFile {
    const prefix = `${path}/`;
    let changed = false;
    const entries: Record<string, EntryStyle> = {};
    for (const [key, style] of Object.entries(file.entries)) {
        if (key === path || key.startsWith(prefix)) changed = true;
        else entries[key] = style;
    }
    return changed ? { ...file, entries } : file;
}
