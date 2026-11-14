import type { Sheet } from '../../whiteboard/model/doc';
import type { SheetId } from '../../whiteboard/model/ids';

export interface SheetShortcutActions {
    readonly sheets: readonly Sheet[];
    readonly current: SheetId;
    readonly readOnly: boolean;
    readonly hasContent: (sheet: SheetId) => boolean;
    readonly select: (sheet: SheetId) => void;
    readonly create: () => void;
}

/** Call on the focused board only; text and rename fields keep their own arrows. */
export function handleSheetShortcut(event: KeyboardEvent, actions: SheetShortcutActions): boolean {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing) return false;
    const target = event.target;
    if (target instanceof Element && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return false;
    const previous = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
    const next = event.key === 'ArrowRight' || event.key === 'ArrowDown';
    if (!previous && !next) return false;
    const index = actions.sheets.findIndex(sheet => sheet.id === actions.current);
    if (index < 0) return false;
    event.preventDefault();
    if (previous && index > 0) actions.select(actions.sheets[index - 1].id);
    else if (next && index + 1 < actions.sheets.length) actions.select(actions.sheets[index + 1].id);
    else if (next && !actions.readOnly && actions.sheets.length < 40 && actions.hasContent(actions.current)) actions.create();
    return true;
}
