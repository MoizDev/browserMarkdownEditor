import { createNativeViewLease, type NativePdfBackdrop, type NativeViewLease } from './nativeViewLease';
import type { NativePdfViewerSource } from './NativePdfViewer';
import { getPdfInkSourceState } from '../../whiteboard/host/preparePdfInkSession';

type ViewOptions = Parameters<typeof createNativeViewLease>[0];
type PdfSource = ReturnType<NativePdfViewerSource['getSnapshot']>['source'];

/** A PDF editing view borrows the actual source/backdrop; the document owner retains both. */
export async function createNativePdfEditingLease(options: {
    readonly board: ViewOptions['board'];
    readonly host: ViewOptions['host'];
    readonly identity: ViewOptions['identity'];
    readonly sourceState: NativePdfViewerSource;
    readonly parameters: Omit<ViewOptions['parameters'], 'mode'>;
    readonly limits: ViewOptions['limits'];
    readonly insets: ViewOptions['insets'];
    readonly editing: NonNullable<ViewOptions['editing']>;
    readonly signal: AbortSignal;
    isVisible(): boolean;
    isFocused(): boolean;
    emphasisEnabled(): boolean;
    onUpdating(updating: boolean): void;
    onError(error: unknown): void;
    onNotice(message: string): void;
}): Promise<NativeViewLease> {
    const { host, identity, sourceState, signal } = options;
    signal.throwIfAborted();
    if (identity.kind !== 'pdfInk' || getPdfInkSourceState(identity.documentId) !== sourceState || !host.canWriteSource(identity)) {
        throw new Error('The PDF source is not eligible for editing');
    }
    const snapshot = sourceState.getSnapshot(), source: PdfSource = snapshot.source;
    const current = () => {
        const state = sourceState.getSnapshot(), outer = host.outerIdentity(identity.documentId), token = source.source.token;
        return getPdfInkSourceState(identity.documentId) === sourceState && state.status === 'ready' && state.source === source
            && source.isCurrent() && host.isCurrent(identity)
            && !!outer && host.isCurrent(outer) && outer.documentId === token.documentId && outer.session === token.session
            && outer.vaultActivation === token.vaultEpoch && outer.bytesGeneration === token.bytesGeneration;
    };
    if (!current()) throw new DOMException('PDF source changed', 'AbortError');
    const backdrop = await source.createBackdrop({ readOnly: false, isVisible: options.isVisible, isFocused: options.isFocused,
        emphasisEnabled: options.emphasisEnabled, signal, onError: options.onError,
        onUpdating(value) { if (current()) options.onUpdating(value); } });
    let transferred = false;
    try {
        signal.throwIfAborted();
        if (!current() || !host.canWriteSource(identity)) throw new DOMException('PDF source changed', 'AbortError');
        const paired: NativePdfBackdrop & { readonly sourceToken: typeof source.source.token; isCurrentSource(): boolean } = {
            ...backdrop, sourceToken: source.source.token, isCurrentSource: current,
            assertCaptureCurrent() { if (!current()) throw new DOMException('PDF source changed', 'AbortError'); },
        };
        const lease = createNativeViewLease({ board: options.board, host, identity, pdfBackdrop: paired,
            readPdfMedia: (id, mediaSignal) => sourceState.readMedia(id, mediaSignal), editing: options.editing,
            parameters: { ...options.parameters, mode: 'edit' }, limits: options.limits, insets: options.insets,
            onError: options.onError, onNotice: options.onNotice });
        transferred = true;
        if (signal.aborted || !current() || !host.canWriteSource(identity)) { lease.dispose(); throw new DOMException('PDF source changed', 'AbortError'); }
        return lease;
    } finally { if (!transferred) backdrop.dispose(); }
}
