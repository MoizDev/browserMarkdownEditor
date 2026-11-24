import { serve, type WorkerContext } from '../../platform/workers';
import { boardHandlers, type BoardWorkerHandler } from './protocol';
import { buildPackedWithMemory } from './geometryHandler';
import { inkCoverage } from './inkCoverageHandler';
import { inkLod } from './inkLodHandler';

const handlers = boardHandlers({ buildPacked: buildPackedWithMemory, 'ink.coverage': inkCoverage, 'ink.lod': inkLod });
const unwrapped: Record<string, BoardWorkerHandler> = {};
for (const [name, handler] of Object.entries(handlers)) {
    unwrapped[name] = (args, context) => {
        const scoped: WorkerContext = {
            get cancelled() { return context.cancelled; }, signal: context.signal,
            slice: () => context.slice(), heartbeat: () => context.heartbeat(),
            transfer: (...items) => context.transfer(...items),
            emit: (event, data, transfer) => context.emit(event,
                event === 'mem' && data && typeof data === 'object' && 'payload' in data ? data.payload : data, transfer),
        };
        return handler(args, scoped);
    };
}
serve({ protocol: 1, buildId: 'whiteboard-geometry-1', handlers: unwrapped });
