export const TABLE_GRID_ROWS = 8;
export const TABLE_GRID_COLS = 10;

export interface TableInsertRequest {
    path: string;
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
