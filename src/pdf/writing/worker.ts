import { serve } from '../../platform/workers/serve';
import { assembleDisplayPdf } from './assemble';
import type { DisplayPdfInput, InkPageInput, InkPackage } from './types';
import { emitDocument } from './emit';

serve({
    protocol: 1,
    buildId: 'display-pdf-1',
    handlers: {
        async build(args, context) {
            const bytes = await assembleDisplayPdf(args as DisplayPdfInput, context);
            context.transfer(bytes.buffer as ArrayBuffer);
            return bytes;
        },
        async emitInk(args, context): Promise<InkPackage> {
            const pages = args as InkPageInput[];
            if (!Array.isArray(pages) || pages.length === 0) throw new RangeError('Ink package needs at least one page');
            const seen = new Set<number>();
            const mapped = pages.map((page, inkPage) => {
                if (!Number.isSafeInteger(page.sourcePage) || page.sourcePage < 0 || seen.has(page.sourcePage) || page.displayList?.page !== page.sourcePage) throw new Error('Invalid ink page mapping');
                seen.add(page.sourcePage);
                return { width: page.width, height: page.height, displayList: { ...page.displayList, page: inkPage } };
            });
            const bytes = await emitDocument(mapped, context);
            context.transfer(bytes.buffer as ArrayBuffer);
            return { schema: 1, bytes, pages: pages.map((p, inkPage) => ({ sourcePage: p.sourcePage, inkPage, width: p.width, height: p.height })) };
        },
    },
});
