import { authorizePdfRole, rememberPdfOuter, type PdfRole } from './pdfRole';
import { isAppReplaced, loadChunk } from '../platform/chunkLoad';

export async function readPdfRole(bytes: Uint8Array, generation = ''): Promise<PdfRole> {
    try {
        const { inspectPdfRoleAsync } = await loadChunk(() => import('./pdfBuildClient'));
        const role = await inspectPdfRoleAsync(bytes, generation);
        rememberPdfOuter(role, bytes);
        authorizePdfRole(role);
        return role;
    } catch (error) {
        if (isAppReplaced(error)) throw error;
        return { kind: 'unreadable', generation, alreadyAnnotated: true, attachment: 'attachment inventory',
            reason: error instanceof Error && error.message.includes('timed out') ? 'timeout' : 'workerDeath' };
    }
}
