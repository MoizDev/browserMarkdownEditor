import { registerRecoveryCopySerializer } from '../../utils/recoveryCopy';
import { boardRecoveryMedia, materializeBoardRecoveryRecipe } from '../format/recoveryRecipe';

// PDF ink needs its containing PDF assembled separately; board bytes alone are not a PDF.
registerRecoveryCopySerializer('drawing', materializeBoardRecoveryRecipe, boardRecoveryMedia);
registerRecoveryCopySerializer('notebook', materializeBoardRecoveryRecipe, boardRecoveryMedia);
