import { serve } from '../../platform/workers';
import { layout } from '../text/layoutWorkerHandler';
import { boardHandlers } from './protocol';

serve({ protocol: 1, buildId: 'whiteboard-parse-1', handlers: boardHandlers({ layout }) });
