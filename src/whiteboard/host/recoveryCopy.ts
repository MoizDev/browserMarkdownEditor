import { registerRecoveryCopySerializer } from '../../utils/recoveryCopy';
import { boardRecoveryMedia, materializeBoardRecoveryRecipe } from '../format/recoveryRecipe';

registerRecoveryCopySerializer('drawing', materializeBoardRecoveryRecipe, boardRecoveryMedia);
registerRecoveryCopySerializer('notebook', materializeBoardRecoveryRecipe, boardRecoveryMedia);
// Only the full PDF assembly may serve a PDF copy; native board JSON is an attachment.
registerRecoveryCopySerializer('pdf', async (payload, signal, files) =>
    (await import('./pdfRecovery')).materializePdfRecoveryRecipe(payload, signal, files), payload => {
    if (!payload || typeof payload !== 'object' || !('board' in payload)) throw new TypeError('Invalid PDF recovery media recipe');
    return boardRecoveryMedia(payload.board);
});
