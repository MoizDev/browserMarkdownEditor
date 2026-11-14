import { serve } from '../../platform/workers';
import { pngRow, pngStart } from '../export/pngWorkerHandler';
import { svgCancel, svgChunk, svgFinish, svgStart } from '../export/svgWorkerHandler';
import { boardHandlers } from './protocol';

serve({ protocol: 1, buildId: 'whiteboard-export-1', handlers: boardHandlers({ pngStart, pngRow, svgStart, svgChunk, svgFinish, svgCancel }) });
