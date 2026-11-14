import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { ClipboardCopy } from '../clipboard/copy';
import { acquireBoardClipboard } from '../host/clipboardAcquisition';
import { decodeBoardClipboard } from '../host/clipboardDecode';
import type { BoardJobIdentity } from '../workers/protocol';
import type { RichFragment } from './richText';

export interface PrivateTextClipboardOptions {
    readonly identity: BoardJobIdentity;
    readonly memory: MemoryAllocator;
    readonly cache: ClipboardCopy;
    isCurrent(identity: BoardJobIdentity): boolean;
}

/** All private text takes the same worker bounds and C5 admission as a board paste. */
export async function readPrivateClipboardText(encoded: string, plain: string | null, signal: AbortSignal,
    options: PrivateTextClipboardOptions): Promise<RichFragment | null> {
    signal.throwIfAborted();
    const identity = { ...options.identity };
    const decoded = await decodeBoardClipboard({ encoded: new Blob([encoded]), identity, memory: options.memory,
        isCurrent: options.isCurrent, signal });
    try {
        const cached = plain === null ? null : options.cache.match(encoded, plain);
        const acquired = await acquireBoardClipboard({ decoded, identity, isCurrent: options.isCurrent, signal,
            ...(cached && plain !== null ? { cache: { match: cached, encoded, plain } } : {}) });
        try {
            signal.throwIfAborted();
            const doc = acquired.load.doc, roots = doc.children.get(acquired.payload.from.sheet) ?? [];
            if (roots.length !== 1 || doc.nodes.size !== 1 || roots[0].kind !== 'text') return null;
            return structuredClone(roots[0].text);
        } finally { acquired.dispose(); }
    } finally { decoded.release(); }
}
