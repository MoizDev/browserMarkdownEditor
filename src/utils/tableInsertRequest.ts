// "Insert a table here", raised from outside the editor.
//
// The top bar's table button lives in EditorPane, which holds no EditorViews:
// those are private to each DocumentPane. So a pick is broadcast as a one-shot
// request naming the document it is for, and the pane FOCUSED on that document
// answers it by inserting at its caret, exactly as the editor menu's
// "Insert table…" row does. An event rather than a stored value, because nothing
// about it should still be pending for a pane that mounts later.

/** The size picker's extent: 10 columns by 8 rows, Google Docs' own shape.
 *  Shared by the editor menu's grid and the top bar's, so the two can never
 *  offer different tables. */
export const TABLE_GRID_ROWS = 8;
export const TABLE_GRID_COLS = 10;

export interface TableInsertRequest {
    path: string;
    /** Includes the header row; always >= 2. */
    rows: number;
    cols: number;
}

const listeners = new Set<(request: TableInsertRequest) => void>();

export function requestTableInsert(path: string, rows: number, cols: number): void {
    for (const listener of listeners) listener({ path, rows, cols });
}

export function onTableInsertRequest(listener: (request: TableInsertRequest) => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
