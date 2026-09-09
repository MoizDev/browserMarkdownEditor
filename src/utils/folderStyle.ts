// How a folder looks: its icon and its colour, kept per vault in one file.
//
//   <vault>/.folders.json
//   {
//     "version": 1,
//     "folders": { "Math": { "icon": "sigma", "color": "blue" } },
//     "icons":   { "sigma": [["path", { "d": "M18 7V5H6l6 7-6 7h12v-2" }]] }
//   }
//
// ONE FILE AT THE VAULT ROOT, not a dot-file inside each folder. `.Assets` and
// `.Garbage` are per-folder because they hold that folder's own content and must
// travel with it; this is a lookup table read once per tree walk, and the walk
// runs after EVERY save (see AGENTS.md). A file per folder would turn that walk
// into one read per customized folder; this makes it one read, full stop. The
// cost is that a moved or renamed folder has to be re-keyed — `renameFolder`
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

export interface FolderStyle {
    /** Lucide icon name, or undefined to keep the default folder icon. */
    icon?: string;
    /** A key of FOLDER_COLORS, or undefined for the default. */
    color?: string;
}

export interface FolderStyleFile {
    version: number;
    folders: Record<string, FolderStyle>;
    icons: Record<string, IconNode[]>;
}

export const FOLDER_STYLE_FILE = '.folders.json';

const FILE_VERSION = 1;

/**
 * The colours a folder can take.
 *
 * A NAME is stored, never a hex — because the same folder is looked at on a dark
 * sidebar and a light one, and one hex cannot be legible on both. The actual
 * values are two per colour and live in `index.css` as `--folder-<key>`, which
 * is where the theme picks between them; this list is the names, their order,
 * and what to call them out loud.
 */
export const FOLDER_COLORS: Record<string, { label: string }> = {
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
export function folderColorVar(key: string | undefined): string | undefined {
    return key && key in FOLDER_COLORS ? `var(--folder-${key}, currentColor)` : undefined;
}

export function emptyFolderStyles(): FolderStyleFile {
    return { version: FILE_VERSION, folders: {}, icons: {} };
}

/** True when this style says nothing — the folder is back to its default and
 *  its entry should be dropped rather than stored as `{}`. */
export function isDefaultStyle(style: FolderStyle | undefined): boolean {
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
export function parseFolderStyles(text: string): FolderStyleFile {
    if (!text.trim()) return emptyFolderStyles();
    try {
        const raw = JSON.parse(text) as Partial<FolderStyleFile>;
        const folders: Record<string, FolderStyle> = {};
        for (const [path, style] of Object.entries(raw.folders ?? {})) {
            if (!style || typeof style !== 'object') continue;
            const icon = typeof style.icon === 'string' ? style.icon : undefined;
            const color = typeof style.color === 'string' && style.color in FOLDER_COLORS
                ? style.color
                : undefined;
            if (icon || color) folders[path] = { icon, color };
        }

        const icons: Record<string, IconNode[]> = {};
        for (const [name, nodes] of Object.entries(raw.icons ?? {})) {
            if (Array.isArray(nodes)) icons[name] = nodes as IconNode[];
        }
        return { version: FILE_VERSION, folders, icons };
    } catch (err) {
        console.warn(`Could not read ${FOLDER_STYLE_FILE}; folders will use their default look:`, err);
        return emptyFolderStyles();
    }
}

/** Serialize, dropping any icon artwork no folder still refers to — otherwise
 *  the file only ever grows as the user tries icons out. */
export function serializeFolderStyles(file: FolderStyleFile): string {
    const used = new Set(Object.values(file.folders).map(s => s.icon).filter(Boolean));
    const icons: Record<string, IconNode[]> = {};
    for (const name of used) {
        const nodes = file.icons[name as string];
        if (nodes) icons[name as string] = nodes;
    }
    return JSON.stringify({ version: FILE_VERSION, folders: file.folders, icons }, null, 2);
}

/** Set (or clear) one folder's look, returning a NEW file — the store this
 *  feeds is compared by identity. */
export function withFolderStyle(
    file: FolderStyleFile,
    path: string,
    style: FolderStyle,
    iconNodes?: IconNode[],
): FolderStyleFile {
    const folders = { ...file.folders };
    if (isDefaultStyle(style)) delete folders[path];
    else folders[path] = style;

    const icons = { ...file.icons };
    if (style.icon && iconNodes) icons[style.icon] = iconNodes;
    return { version: FILE_VERSION, folders, icons };
}

/**
 * Follow a folder rename or move, taking its descendants with it.
 *
 * Styles are keyed by vault path, so renaming "Math" strands the icon on a path
 * nothing has any more — and every folder inside it too, since their keys all
 * start with the old prefix. Returns the same object when nothing matched, so a
 * rename elsewhere in the vault costs no write.
 */
export function renameFolder(file: FolderStyleFile, from: string, to: string): FolderStyleFile {
    const prefix = `${from}/`;
    let changed = false;
    const folders: Record<string, FolderStyle> = {};
    for (const [path, style] of Object.entries(file.folders)) {
        if (path === from) {
            folders[to] = style;
            changed = true;
        } else if (path.startsWith(prefix)) {
            folders[`${to}/${path.slice(prefix.length)}`] = style;
            changed = true;
        } else {
            folders[path] = style;
        }
    }
    return changed ? { ...file, folders } : file;
}

/** Drop a folder and everything under it — used when one is trashed. */
export function forgetFolder(file: FolderStyleFile, path: string): FolderStyleFile {
    const prefix = `${path}/`;
    let changed = false;
    const folders: Record<string, FolderStyle> = {};
    for (const [key, style] of Object.entries(file.folders)) {
        if (key === path || key.startsWith(prefix)) changed = true;
        else folders[key] = style;
    }
    return changed ? { ...file, folders } : file;
}
