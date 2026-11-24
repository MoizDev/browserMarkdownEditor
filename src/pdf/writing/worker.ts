import { serve } from '../../platform/workers/serve';
import { finishGeneratedNotebook, type GeneratedNotebookRequest } from './assemble';

serve({
    protocol: 1,
    buildId: 'generated-notebook-2',
    handlers: {
        async finishNotebook(args, context) {
            const bytes = await finishGeneratedNotebook(args as GeneratedNotebookRequest, context);
            context.transfer(bytes.buffer as ArrayBuffer);
            return bytes;
        },
    },
});
