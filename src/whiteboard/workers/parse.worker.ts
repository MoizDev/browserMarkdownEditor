import { serve } from '../../platform/workers';
import { layout } from '../text/layoutWorkerHandler';
import { boardHandlers } from './protocol';
import { decodePoints, encodePoints, inspectPoints } from './pointHandlers';
import { nativeLoad } from './nativeLoad';
import { parseNative } from './nativeParseHandler';
import { legacyScan } from './legacyScan';
import { legacyPrepare } from './legacyPrepare';
import { clipboardDecode } from './clipboardDecode';
import { legacyClipboard } from './legacyClipboard';
import { clipboardJsonKind } from './clipboardJsonKind';
import { excalidrawClipboard } from './excalidrawClipboard';

serve({ protocol: 1, buildId: 'whiteboard-parse-1', handlers: boardHandlers({ layout, inspectPoints, decodePoints, encodePoints, nativeLoad, parseNative, legacyScan, legacyPrepare, clipboardDecode, legacyClipboard, clipboardJsonKind, excalidrawClipboard }) });
