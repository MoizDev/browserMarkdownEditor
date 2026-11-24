// What the bin's list does once the crawl has built it — ordering, pruning a
// row that has left, and the two formats the rows print. Pure: no File System
// Access calls live here (those are FileSystemContext's, per AGENTS.md).
//
// The pruning is what lets an operation NOT re-crawl: the panel is told an
// item's `sourcePath` has gone and keeps its own list honest from that alone,
// rather than walking every `.Garbage` in the vault again to learn it.

import type { TrashItem } from '../types';

/**
 * The list with `sourcePath` — and everything under it — gone, at every depth.
 *
 * Restoring or erasing a trashed FOLDER takes its nested `.Garbage` with it,
 * and the crawl hoisted every one of those rows to the bin root, so they are
 * dangling the moment the folder moves. Same `path/` prefix rule the tab
 * handlers use, for the same reason: `notes` must not match `notesolder`.
 *
 * Returns the array it was given when nothing matched, so an operation that
 * touched nothing does not re-render the list.
 */
export function dropTrashSubtree(items: TrashItem[], sourcePath: string): TrashItem[] {
    const prefix = `${sourcePath}/`;
    let changed = false;
    const kept: TrashItem[] = [];

    for (const item of items) {
        if (item.sourcePath === sourcePath || item.sourcePath.startsWith(prefix)) {
            changed = true;
            continue;
        }
        if (item.children) {
            const children = dropTrashSubtree(item.children, sourcePath);
            if (children !== item.children) {
                changed = true;
                kept.push({ ...item, children });
                continue;
            }
        }
        kept.push(item);
    }

    return changed ? kept : items;
}

/** The bin's root list: newest deletion first, ties broken by name. */
export function sortTrashRoot(items: TrashItem[]): TrashItem[] {
    return [...items].sort((a, b) =>
        b.deletedAt - a.deletedAt ||
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

/** What one trashed folder shows when you open it: folders first, then files,
 *  alphabetical within each — buildFileTree's order. Deliberately NOT by time:
 *  everything inside a folder was copied by the one deletion, so their times
 *  differ only by how long the copy took. */
export function sortTrashChildren(items: TrashItem[]): TrashItem[] {
    return [...items].sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
}

const DELETED_AT_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** When it was deleted, for the row. Empty for 0 — nothing in the item was
 *  readable, and a made-up "1 Jan 1970" would be worse than saying nothing. */
export function formatDeletedAt(ms: number): string {
    if (!ms) return '';
    try {
        return DELETED_AT_FORMAT.format(ms);
    } catch {
        return '';
    }
}

/** A size for the preview pane. Rounded hard: this is the "which of these two
 *  notes.md is mine" glance, not an accounting of the disk. */
export function formatTrashSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} byte${bytes === 1 ? '' : 's'}`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
