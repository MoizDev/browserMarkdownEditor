import { getSessionIdentity } from '../../utils/sessionIdentity';
import { createPdfTileProducer } from '../layer/tileProducer';
import type { PdfPool } from '../pool/types';
import { tiledPoolAdapter } from './poolAdapter';
import { createPdfTiledSourceFactory } from './sourceFactory';
import { installPdfTiledSourceFactory } from './sourceRuntime';

/** The contained host installs one pool; opening a source remains lazy. */
export function installTiledPdfPool(pool: PdfPool, isFocused: (documentId: string) => boolean): () => void {
    const factory = createPdfTiledSourceFactory(tiledPoolAdapter(pool, document => createPdfTileProducer({
        document,
        isCurrent: () => {
            const identity = getSessionIdentity(document.token.documentId);
            return !!identity && identity.serial === document.token.session && identity.bytesGeneration === document.token.bytesGeneration;
        },
        isFocused: () => isFocused(document.token.documentId),
        variant: () => ({ variant: 'plain' }), annotations: true, forms: true,
    })));
    return installPdfTiledSourceFactory(factory);
}
