import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { ClipboardCachePin } from '../clipboard/copy';
import { acquireBoardClipboard } from '../host/clipboardAcquisition';
import { decodeBoardClipboard } from '../host/clipboardDecode';
import type { BoardJobIdentity } from '../workers/protocol';
import type { RichFragment } from './richText';
import { admitRichFragmentCooperative } from './admitFragment';
import { yieldToHost } from './cooperative';

export interface PrivateTextClipboardOptions {
    readonly identity: BoardJobIdentity;
    readonly memory: MemoryAllocator;
    readonly cache: ClipboardCachePin | null;
    readonly cooperate?: () => Promise<void>;
    isCurrent(identity: BoardJobIdentity): boolean;
}

export async function readPrivateClipboardText(encoded: string, plain: string | null, signal: AbortSignal,
    options: PrivateTextClipboardOptions): Promise<RichFragment | null> {
    signal.throwIfAborted();
    if (encoded.length > 2 + 4 * Math.ceil(64 * 1024 * 1024 / 3) || !/^[ud]\.[A-Za-z0-9_-]+$/.test(encoded))
        throw new TypeError('Invalid private clipboard envelope');
    const identity = { ...options.identity };
    const decoded = await decodeBoardClipboard({ encoded: new Blob([encoded]), identity, memory: options.memory,
        isCurrent: options.isCurrent, signal });
    try {
        const matched = plain === null ? null : options.cache?.match(encoded, plain) ?? null;
        const cached = matched && matched.encoded === encoded && matched.plain === plain ? matched : null;
        const acquired = await acquireBoardClipboard({ decoded, identity, isCurrent: options.isCurrent, signal,
            ...(cached && plain !== null ? { cache: { match: cached, encoded, plain } } : {}) });
        try {
            signal.throwIfAborted();
            const doc = acquired.load.doc, roots = doc.children.get(acquired.payload.from.sheet) ?? [];
            if (roots.length !== 1 || doc.nodes.size !== 1 || roots[0].kind !== 'text') return null;
            return await admitRichFragmentCooperative(roots[0].text, { signal, cooperate: options.cooperate ?? yieldToHost,
                current: () => options.isCurrent(identity) });
        } finally { acquired.dispose(); }
    } finally { decoded.release(); }
}
