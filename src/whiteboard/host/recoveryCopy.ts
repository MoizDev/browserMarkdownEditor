import { registerRecoveryCopySerializer } from '../../utils/recoveryCopy';
import { boardRecoveryMedia, materializeBoardRecoveryRecipe } from '../format/recoveryRecipe';
import { pdfRecoveryMedia } from './pdfRecoveryRecipe';

registerRecoveryCopySerializer('drawing', materializeBoardRecoveryRecipe, boardRecoveryMedia);
registerRecoveryCopySerializer('notebook', materializeBoardRecoveryRecipe, boardRecoveryMedia);
// Only the full PDF assembly may serve a PDF copy; native board JSON is an attachment.
registerRecoveryCopySerializer('pdf', async (payload, signal, files) =>
    (await import('./pdfRecovery')).materializePdfRecoveryRecipe(payload, signal, files), pdfRecoveryMedia);
