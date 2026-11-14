import type { PdfReadingBinding } from '../../types/reading';
import type { PdfSelectionState } from '../text/selectionState';
import type { OpenTiledDocument, PdfTiledDocumentSession } from './documentSession';
import type { PdfSessionMirrors } from '../layer/tileMirror';
import type { PdfSessionCapturer } from './sessionCapture';

/** One App-session-owned source, never a component/pane lifetime. */
export interface PdfTiledSource {
    readonly session: PdfTiledDocumentSession;
    readonly document: OpenTiledDocument;
    readonly mirror: PdfSessionMirrors;
    readonly capturer: PdfSessionCapturer;
    readonly selection: PdfSelectionState;
}

/** Implemented in the lazy PDF route; the caller supplies only the app's
 * snapshot capability and its full reader/session identity. */
export interface PdfTiledSourceFactory {
    open(reading: PdfReadingBinding, signal: AbortSignal): Promise<PdfTiledSource>;
}
