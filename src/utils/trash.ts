import type { TrashItem } from '../types';

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

export function sortTrashRoot(items: TrashItem[]): TrashItem[] {
    return [...items].sort((a, b) =>
        b.deletedAt - a.deletedAt ||
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

export function sortTrashChildren(items: TrashItem[]): TrashItem[] {
    return [...items].sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
}

const DELETED_AT_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function formatDeletedAt(ms: number): string {
    if (!ms) return '';
    try {
        return DELETED_AT_FORMAT.format(ms);
    } catch {
        return '';
    }
}

export function formatTrashSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} byte${bytes === 1 ? '' : 's'}`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
