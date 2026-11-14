import { paperPageSize } from '../../utils/paper';
import type { NotebookExportSnapshot } from './notebookExport';
import { pinPagedBoardScene } from './pagedSceneCapture';
import type { BoardRuntime } from './runtime';

/** Pins the notebook's real paper and scene at one revision; the caller owns its release. */
export function pinNativeNotebookExport(runtime: BoardRuntime, revision: number, current: () => boolean, onError: (error: unknown) => void): {
    readonly revision: number; readonly snapshot: NotebookExportSnapshot; release(): void;
} {
    const doc = runtime.session.doc;
    if (!current() || doc.rev !== revision || doc.kind !== 'notebook' || doc.host.kind !== 'notebook') {
        throw new Error('A current notebook revision is required');
    }
    const paper = Object.freeze({ ...doc.host.paper }), pin = pinPagedBoardScene(runtime, revision, current, onError);
    try {
        const { width, height } = paperPageSize(paper);
        if (pin.rects.length !== paper.pageCount || pin.rects.some(rect => rect.width !== width || rect.height !== height)) {
            throw new Error('Notebook page layout differs from its paper');
        }
        return { revision, snapshot: { paper, sheets: pin.sheets, readSheetPage: pin.readSheetPage }, release: pin.release };
    } catch (error) { pin.release(); throw error; }
}
