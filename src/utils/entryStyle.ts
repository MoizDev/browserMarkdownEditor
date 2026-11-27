// WHAT MAY BE STORED HERE is a user decision, not an implementation detail:
// the entries' looks, their artwork, and the custom order. App-wide settings
// (theme, fonts, sizes…) stay in browser storage. A NEW kind of key in this
// file needs the user's permission first — see the entry-styles skill.

import { parentVaultPath } from './paths';

export type IconNode = [tag: string, attrs: Record<string, string | number>];

export interface EntryStyle {
    icon?: string;
    color?: string;
}

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

export function orderListFor(order: Readonly<EntryOrder>, folderPath: string): readonly string[] | undefined {
    return Object.hasOwn(order, folderPath) ? order[folderPath] : undefined;
}

export interface EntryStyleFile {
    version: number;
    entries: Record<string, EntryStyle>;
    icons: Record<string, IconNode[]>;
    order: EntryOrder;
}

export const ENTRY_STYLE_FILE = '.appearance.json';

export const LEGACY_STYLE_FILE = '.folders.json';

const FILE_VERSION = 2;

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

export function entryColorVar(key: string | undefined): string | undefined {
    return key && key in ENTRY_COLORS ? `var(--folder-${key}, currentColor)` : undefined;
}

export function emptyEntryStyles(): EntryStyleFile {
    return { version: FILE_VERSION, entries: {}, icons: {}, order: newOrder() };
}

export function isDefaultStyle(style: EntryStyle | undefined): boolean {
    return !style || (!style.icon && !style.color);
}

export function parseEntryStyles(text: string): EntryStyleFile {
    if (!text.trim()) return emptyEntryStyles();
    try {
        const raw = JSON.parse(text) as Partial<EntryStyleFile> & { folders?: Record<string, EntryStyle> };
        const entries: Record<string, EntryStyle> = {};
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

export function serializeEntryStyles(file: EntryStyleFile): string {
    const used = new Set(Object.values(file.entries).map(s => s.icon).filter(Boolean));
    const icons: Record<string, IconNode[]> = {};
    for (const name of used) {
        const nodes = file.icons[name as string];
        if (nodes) icons[name as string] = nodes;
    }
    const order = Object.keys(file.order).length ? { order: file.order } : {};
    return JSON.stringify({ version: FILE_VERSION, entries: file.entries, icons, ...order }, null, 2);
}

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

export function needsFanOut(file: EntryStyleFile): boolean {
    return Object.keys(file.entries).some(path => path.includes('/'))
        || Object.keys(file.order).some(folder => folder !== '');
}

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

export function withEntryOrder(file: EntryStyleFile, folderPath: string, names: readonly string[] | null): EntryStyleFile {
    const list = names ? cleanNames(names) : [];
    const current = orderListFor(file.order, folderPath);
    if (list.length ? current && sameNames(current, list) : !current) return file;
    const order = newOrder(file.order);
    if (list.length) order[folderPath] = list;
    else delete order[folderPath];
    return { ...file, order };
}

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
