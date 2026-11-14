import { serve } from '../../platform/workers';
import { pngRow, pngStart } from '../export/pngWorkerHandler';
import { boardHandlers } from './protocol';

serve({ protocol: 1, buildId: 'whiteboard-export-1', handlers: boardHandlers({ pngStart, pngRow }) });
