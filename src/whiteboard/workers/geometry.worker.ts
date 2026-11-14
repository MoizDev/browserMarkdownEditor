import { serve } from '../../platform/workers';
import { boardHandlers } from './protocol';
import { buildPacked } from './packedHandler';

serve({ protocol: 1, buildId: 'whiteboard-geometry-1', handlers: boardHandlers({ buildPacked }) });
