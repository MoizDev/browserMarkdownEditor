import type { NativeCanvasHost, NativeCanvasIdentity } from '../../types/nativeCanvas';
import { acquireNativeBoard, type NativeBoardAcquisition } from './nativeAcquisition';
import { createNativeMediaPorts } from './mediaPorts';

export async function acquireNativeBoardFromHost(
    host: NativeCanvasHost, identity: NativeCanvasIdentity,
    options: { signal: AbortSignal; deadlineMs: number; boardBytes?: Blob; pdfPages?: readonly (readonly [number, number])[] },
): Promise<{ bytes: Blob; acquisition: NativeBoardAcquisition; media: ReturnType<typeof createNativeMediaPorts>; dispose(): void }> {
    const assertCurrent = () => {
        options.signal.throwIfAborted();
        if (!host.isCurrent(identity)) throw new DOMException('Canvas session ended', 'AbortError');
    };
    assertCurrent();
    if (identity.kind === 'pdfInk' && !options.boardBytes) throw new Error('PDF ink requires extracted board bytes');
    let bytes = options.boardBytes;
    if (!bytes) {
        try { bytes = await host.acquireBytes(identity, options.signal); }
        catch (error) { assertCurrent(); throw error; }
        assertCurrent();
    }
    const kind = identity.kind === 'drawing' ? 'whiteboard' : identity.kind === 'pdfInk' ? 'pdf-ink' : 'notebook';
    let acquisition: NativeBoardAcquisition;
    assertCurrent();
    try {
        acquisition = await acquireNativeBoard({ bytes, kind, signal: options.signal, deadlineMs: options.deadlineMs,
            pdfPages: options.pdfPages, identity: { session: `${identity.documentId}:${identity.session}`,
                epoch: identity.vaultActivation, generation: identity.bytesGeneration } });
    } catch (error) { assertCurrent(); throw error; }
    try { assertCurrent(); } catch (error) { acquisition.dispose(); throw error; }
    let disposed = false;
    return { bytes, acquisition, media: createNativeMediaPorts(host, identity), dispose() {
        if (disposed) return;
        disposed = true;
        acquisition.dispose();
    } };
}
