import type { FrameToken } from '../../platform/render';
import type { DiskVersion } from '../../utils/diskVersion';
import type { PdfReadingBinding } from '../../types/reading';
import type { PdfSelectionState } from '../text/selectionState';
import type { OpenTiledDocument, PdfTiledDocumentSession } from './documentSession';
import type { PdfSessionMirrors } from '../layer/tileMirror';
import type { PdfSessionCapturer } from './sessionCapture';
import type { PdfVersionTransitionOwner } from './versionOwner';
import type { PdfVersionBridge } from '../layer/versionBridge';

export interface PdfTiledPresentation {
    readonly token: FrameToken;
    readonly resultHash: string;
    readonly frameId: number;
    readonly viewEpoch: number;
    readonly pages: readonly number[];
    readonly complete: true;
    readonly sharp: true;
    readonly staleVersion: false;
}

export interface PdfTiledSource {
    readonly session: PdfTiledDocumentSession;
    readonly version: Promise<DiskVersion>;
    readonly document: OpenTiledDocument;
    readonly mirror: PdfSessionMirrors;
    readonly capturer: PdfSessionCapturer;
    readonly selection: PdfSelectionState;
    readonly transition: PdfVersionTransitionOwner;
    readonly bridge: PdfVersionBridge | null;
}

export interface PdfTiledSourceFactory {
    open(reading: PdfReadingBinding, signal: AbortSignal): Promise<PdfTiledSource>;
}
