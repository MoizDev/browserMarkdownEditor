import { authorizePdfRole, rememberPdfOuter, type PdfRole } from './pdfRole';
import { isAppReplaced, loadChunk } from '../platform/chunkLoad';

/** Metadata inspection is lazy and independent of every renderer. Refusals stay tagged. */
export async function readPdfRole(bytes: Uint8Array, generation = ''): Promise<PdfRole> {
    try {
        const { inspectPdfRoleAsync } = await loadChunk(() => import('./pdfBuildClient'));
        const role = await inspectPdfRoleAsync(bytes, generation);
        rememberPdfOuter(role, bytes);
        authorizePdfRole(role);
        return role;
    } catch (error) {
        // Not this PDF's fault: the inventory's code is gone from the server, and only a reload brings it back. Called an
        // unreadable PDF, Annotate said the file's embedded annotations "could not be read" — or nothing at all.
        if (isAppReplaced(error)) throw error;
        return { kind: 'unreadable', generation, alreadyAnnotated: true, attachment: 'attachment inventory',
            reason: error instanceof Error && error.message.includes('timed out') ? 'timeout' : 'workerDeath' };
    }
}
