// The on-disk format for a `.notebook` file.
//
//   Assignment 3.notebook
//   ├── "paper"   ← the ruling, page size and page count: what the pages ARE
//   ├── "ui"      ← current tool + style pickers (tldraw's snapshots omit these)
//   └── the tldraw snapshot: everything written on those pages
//
// It is ordinary JSON text, so it rides readFile/writeFile/autosave exactly as a
// `.tldraw` drawing does — and, like a drawing, must never be *shown* or indexed
// as text (see fileTypes.ts and vaultSearch's isTextFile).
//
// A notebook is a drawing with paper, and `paper` is the authority on what the
// pages are. They do ride along in the snapshot as ordinary locked image shapes,
// but NotebookPane reconciles them against `paper` by shape id on every open —
// so re-ruling a notebook re-papers the strokes already on it rather than
// rewriting the document, and the pages carry no image data of their own (the
// asset resolves to generated SVG at render time, see NotebookPane's assetStore).

import type { TLEditorSnapshot } from 'tldraw';
import { normalizePaper, type NotebookPaper } from './paper';
import type { CanvasUiState } from '../components/canvasPen';

/** The pen this notebook was last written with. One shape across all three
 *  canvases — see components/canvasPen.ts. */
export type NotebookUiState = CanvasUiState;

export interface NotebookFile {
    paper: NotebookPaper;
    snapshot?: TLEditorSnapshot;
    ui?: NotebookUiState;
}

/**
 * Read a `.notebook`. A new (empty) file yields default paper and no snapshot,
 * which is a blank one-page notebook.
 *
 * NotebookPane guards the envelope before calling this decoder. Unexpected
 * failures must not become editable blanks or empty notebook exports.
 */
export function parseNotebookFile(content: string): NotebookFile {
    if (!content.trim()) return { paper: normalizePaper(undefined) };
    try {
        const { paper, ui, ...snapshot } = JSON.parse(content.trim()) as TLEditorSnapshot & {
            paper?: Partial<NotebookPaper>;
            ui?: NotebookUiState;
        };
        return {
            paper: normalizePaper(paper),
            // A file that carried only `paper` (a notebook created but never
            // written in) has nothing to restore.
            //
            // The key is `document`, NOT `store`: a TLEditorSnapshot is
            // `{ document, session }` and the store lives one level down inside
            // `document`. Testing for `store` here is always false, and the
            // failure is silent and total — the notebook reopens with its paper
            // intact and every stroke gone, while the file on disk still holds
            // them. Verified by reloading the page and reading back the ink.
            snapshot: 'document' in snapshot ? snapshot as TLEditorSnapshot : undefined,
            ui,
        };
    } catch (err) {
        throw new Error('The notebook could not be loaded without losing content.', { cause: err });
    }
}

export function serializeNotebookFile(file: NotebookFile): string {
    return JSON.stringify({ ...file.snapshot, paper: file.paper, ui: file.ui });
}
