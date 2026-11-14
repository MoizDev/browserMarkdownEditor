import { serve } from '../../platform/workers';
import { IncrementalEmitter } from './incrementalEmit';

const emitter = new IncrementalEmitter();
serve({ protocol: 1, buildId: 'pdf-incremental-1', handlers: {
    async step(value, context) {
        await context.slice();
        const result = await emitter.run(value);
        if (result) context.transfer(result.bytes.buffer);
        return result;
    },
} });
