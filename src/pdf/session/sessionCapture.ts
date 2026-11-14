import { createPlatformCapturer } from '../../platform/render/captureRuntime';
import type { PageStack } from '../../platform/render';
import { createPdfCaptureSnapshot } from '../layer/captureSnapshot';
import type { PdfTiledDocumentSession } from './documentSession';

const slot = Symbol('PDF session capturer');
export type PdfSessionCapturer = ReturnType<typeof createPlatformCapturer>;

/** One capture queue participant per App document session, never per pane.
 * Closing the session cancels captures only after its source leases settle. */
export function pdfSessionCapturer(session: PdfTiledDocumentSession, stack: Readonly<PageStack>): PdfSessionCapturer {
    const previous = session.getSlot<PdfSessionCapturer>(slot);
    if (previous) return previous;
    const capturer = createPlatformCapturer({
        paneId: `pdf:${session.token.documentId}:${session.token.session}`,
        owner: session.token,
        snapshot: (request, memory) => createPdfCaptureSnapshot({ token: session.token, source: session.source,
            variant: 'plain', revision: String(session.token.bytesGeneration), stack,
            retain: () => session.acquireCapture() }, request, memory),
    });
    try { session.setSlot(slot, capturer, () => capturer.dispose()); }
    catch (error) { capturer.dispose(); throw error; }
    return capturer;
}
