import type { PdfSelectionState } from '../text/selectionState';
import type { PdfTextInputBinding } from './textInput';
import type { PdfTextKeyboardBinding } from './textKeyboard';

export interface PdfTextVisibilityHost {
    /** Includes the find scan and its 60-second hidden-index timer. */
    setReaderVisible(visible: boolean): void;
    /** Remove mirrored page text, preserving the page landmark owner. */
    clearMirrorPages(): void;
    /** Release overlay GPU resources and zero its canvas synchronously. */
    releaseGpu(reason: 'hidden'): void;
    rebuildVisible(): void;
}

/** One per mounted pane; agent reads use their own signals, never this one. */
export class PdfTextVisibility {
    private visible = true;
    private disposed = false;
    private work = new AbortController();
    constructor(private readonly host: PdfTextVisibilityHost, private readonly selection: PdfSelectionState,
        private readonly input?: PdfTextInputBinding, private readonly keyboard?: PdfTextKeyboardBinding) {}
    get signal(): AbortSignal { return this.work.signal; }
    setVisible(next: boolean): void {
        if (this.disposed || this.visible === next) return;
        this.visible = next;
        if (!next) {
            this.work.abort();
            this.input?.setVisible(false);
            this.keyboard?.setVisible(false);
            this.selection.setVisible(false);
            this.host.setReaderVisible(false);
            this.host.clearMirrorPages();
            this.host.releaseGpu('hidden');
        } else {
            this.work = new AbortController();
            this.selection.setVisible(true);
            this.host.setReaderVisible(true);
            this.input?.setVisible(true);
            this.keyboard?.setVisible(true);
            this.host.rebuildVisible();
        }
    }
    dispose(): void {
        if (this.disposed) return;
        this.setVisible(false);
        this.disposed = true;
        this.work.abort();
    }
}
