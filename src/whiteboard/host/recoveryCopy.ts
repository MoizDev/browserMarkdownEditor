import { registerRecoveryCopySerializer } from '../../utils/recoveryCopy';
import { materializeBoardRecoveryRecipe } from '../format/recoveryRecipe';

// PDF ink needs its containing PDF assembled separately; board bytes alone are not a PDF.
registerRecoveryCopySerializer('drawing', materializeBoardRecoveryRecipe);
registerRecoveryCopySerializer('notebook', materializeBoardRecoveryRecipe);
