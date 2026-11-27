import { emptyEntryStyles, type EntryOrder, type EntryStyle, type EntryStyleFile } from './entryStyle';

let styles: EntryStyleFile = emptyEntryStyles();
const listeners = new Set<() => void>();

export function getEntryStyles(): EntryStyleFile {
    return styles;
}

export function setEntryStyles(next: EntryStyleFile): void {
    if (next === styles) return;
    styles = next;
    for (const listener of listeners) listener();
}

export function subscribeEntryStyles(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export function getEntryStyle(path: string): EntryStyle | undefined {
    return styles.entries[path];
}

export function getEntryOrder(): EntryOrder {
    return styles.order;
}
