import type { Editor, TLShape } from 'tldraw';

/** Page images are implementation details, not editable canvas content. */
export function protectPageBackdrops(editor: Editor, isBackdrop: (shape: TLShape) => boolean) {
    let permitted = 0;
    const allow = <T,>(fn: () => T): T => {
        permitted++;
        try { return fn(); } finally { permitted--; }
    };
    const isPage = (id: TLShape['id']) => {
        const shape = editor.getShape(id);
        return !!shape && isBackdrop(shape);
    };
    const unchange = editor.sideEffects.registerBeforeChangeHandler('shape', (before, after, source) =>
        source === 'user' && !permitted && isBackdrop(before) ? before : after);
    const undelete = editor.sideEffects.registerBeforeDeleteHandler('shape', (shape, source) => {
        if (source === 'user' && !permitted && isBackdrop(shape)) return false;
    });
    const unselect = editor.sideEffects.registerBeforeChangeHandler('instance_page_state', (_before, after) => {
        const selectedShapeIds = after.selectedShapeIds.filter(id => !isPage(id));
        return selectedShapeIds.length === after.selectedShapeIds.length ? after : { ...after, selectedShapeIds };
    });
    // Notebook page removal is itself undoable. History must be allowed to
    // replay that explicit operation, but ordinary commands must not delete it.
    const undo = editor.undo;
    const redo = editor.redo;
    editor.undo = (...args) => allow(() => undo.apply(editor, args));
    editor.redo = (...args) => allow(() => redo.apply(editor, args));
    return {
        allow,
        dispose() {
            unchange(); undelete(); unselect();
            editor.undo = undo; editor.redo = redo;
        },
    };
}
