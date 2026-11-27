export interface ContextMenuCommand {
    kind: 'command';
    id: string;
    /**
     * Never note CONTENTS and never markup: the menu is not an HTML sink and
     * must not become one by accident. This origin holds the vault's handle
     * with permission granted, so a hole here is read/write over the whole
     * vault (see AGENTS.md on the two deliberate innerHTML sinks).
     */
    label: string;
    shortcut?: string;
    run: () => void | Promise<void>;
    danger?: boolean;
    checked?: boolean;
    disabled?: boolean;
    reason?: string;
    keepOpen?: boolean;
}

export interface ContextMenuGrid {
    kind: 'grid';
    id: string;
    label: string;
    maxRows: number;
    maxCols: number;
    pick: (rows: number, cols: number) => void;
    disabled?: boolean;
    reason?: string;
}

export interface ContextMenuEntryStyle {
    kind: 'entry-style';
    id: string;
    label: string;
    icon?: string;
    color?: string;
    pick: (icon: string | undefined, color: string | undefined, nodes?: unknown) => void;
    disabled?: boolean;
    reason?: string;
}

export interface ContextMenuSeparator {
    kind: 'separator';
    id: string;
}

export interface ContextMenuLabel {
    kind: 'label';
    id: string;
    label: string;
    tooltip?: string;
}

export interface ContextMenuSubmenu {
    kind: 'submenu';
    id: string;
    label: string;
    entries: (ContextMenuCommand | ContextMenuSeparator | ContextMenuSubmenu)[];
    disabled?: boolean;
    reason?: string;
}

export type ContextMenuEntry =
    | ContextMenuSubmenu
    | ContextMenuCommand
    | ContextMenuGrid
    | ContextMenuEntryStyle
    | ContextMenuSeparator
    | ContextMenuLabel;

export interface ContextMenuRequest {
    x: number;
    y: number;
    entries: ContextMenuEntry[];
    label: string;
    className?: string;
    lang?: string;
    dir?: 'ltr' | 'rtl';
    opener: HTMLElement | null;
    anchor?: HTMLElement | null;
    above?: boolean;
    onClose?: () => void;
}

let current: ContextMenuRequest | null = null;
const listeners = new Set<() => void>();

export function openContextMenu(request: ContextMenuRequest): boolean {
    if (current && request.anchor && current.anchor === request.anchor) {
        closeContextMenu();
        return false;
    }
    const previous = current;
    current = request;
    if (previous && previous !== request) previous.onClose?.();
    for (const listener of listeners) listener();
    return true;
}

export function replaceContextMenuEntries(anchor: HTMLElement, entries: ContextMenuEntry[]): void {
    if (!current || current.anchor !== anchor) return;
    current = { ...current, entries };
    for (const listener of listeners) listener();
}

export function closeContextMenu(): void {
    const closing = current;
    if (!closing) return;
    // Clear FIRST, then notify the raiser: onClose reaches out of the store (it
    // clears a tree row's highlight, i.e. it setStates), and a raiser that
    // re-entered here would otherwise see a menu that is still open.
    current = null;
    closing.onClose?.();
    for (const listener of listeners) listener();
}

export function subscribeContextMenu(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export function getContextMenu(): ContextMenuRequest | null {
    return current;
}
