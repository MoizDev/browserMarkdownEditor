import { serve } from '../../platform/workers';
import { layout } from '../text/layoutWorkerHandler';
import { boardHandlers } from './protocol';
import { decodePoints, encodePoints, inspectPoints } from './pointHandlers';
import { nativeLoad } from './nativeLoad';

serve({ protocol: 1, buildId: 'whiteboard-parse-1', handlers: boardHandlers({ layout, inspectPoints, decodePoints, encodePoints, nativeLoad }) });
