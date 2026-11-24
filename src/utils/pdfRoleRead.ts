import { authorizePdfRole, rememberPdfOuter, type PdfRole } from './pdfRole';
import { loadChunk } from '../platform/chunkLoad';

/** Metadata inspection is lazy and independent of every renderer. Refusals stay tagged. */
export async function readPdfRole(bytes: Uint8Array, generation = ''): Promise<PdfRole> {
    try {
        const { inspectPdfRoleAsync } = await loadChunk(() => import('./pdfBuildClient'));
        const role = await inspectPdfRoleAsync(bytes, generation);
        rememberPdfOuter(role, bytes);
        authorizePdfRole(role);
        return role;
    } catch (error) {
        return { kind: 'unreadable', generation, alreadyAnnotated: true, attachment: 'attachment inventory',
            reason: error instanceof Error && error.message.includes('timed out') ? 'timeout' : 'workerDeath' };
    }
}
