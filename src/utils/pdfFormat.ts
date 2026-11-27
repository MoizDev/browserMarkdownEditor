export const ORIGINAL_ATTACHMENT = 'original.pdf';

export const SNAPSHOT_ATTACHMENT = 'tldraw-snapshot.json';

/** Today's writer must never downgrade ink from this or a future marked format. */
export const BOARD_ATTACHMENT = 'board.json';
export const PDF_APP_MARKER_NAMESPACE = 'local-vault-pdf/';

export const NOTEBOOK_SOURCE_ATTACHMENT = 'notebook-source.json';

export interface NotebookSource {
    path: string;
    exportedAt: number;
}
