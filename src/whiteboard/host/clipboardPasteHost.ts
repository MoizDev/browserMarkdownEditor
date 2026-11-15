import type { RenderToken } from '../../platform/render/types';
import type { BoardClipboardPasteHost } from '../clipboard/paste';
import type { BoardJobIdentity } from '../workers/protocol';
import { createExternalClipboardAdmitter } from './externalClipboardAdmitter';

// Provenance: per-paste host composition over existing runtime, ingestor and admitter seams;
// the render owner token and zoom are bound once here, so no caller can mismatch them.

export interface BoardClipboardPasteHostOptions extends Omit<BoardClipboardPasteHost, 'admitExternal' | 'resolveBinding'> {
    /** The exact owner token the board runtime was created with (render identity). */
    readonly token: RenderToken;
    /** Host's maximum CSS-px/world-unit scale for the encoder and legacy preparation. */
    readonly zMax: number;
    /** App alone resolves relative legacy resources; absent means relative resources are refused. */
    readAsset?(src: string, signal: AbortSignal): Promise<Blob | null>;
    isCurrent(identity: BoardJobIdentity): boolean;
}

/** One paste's host. The external source admitter is built from the same token, memory and media
 * reader as the rest of the host, so admission and insertion share one owner and one allocator. */
export function createBoardClipboardPasteHost(options: BoardClipboardPasteHostOptions): BoardClipboardPasteHost {
    const admitter = createExternalClipboardAdmitter({ token: options.token, zMax: options.zMax, memory: options.memory,
        readBlob: options.readBlob, ...(options.readAsset ? { readAsset: options.readAsset } : {}),
        isCurrent: options.isCurrent, ...(options.cooperate ? { cooperate: options.cooperate } : {}) });
    const { token: _token, zMax: _zMax, readAsset: _readAsset, isCurrent: _isCurrent, ...host } = options;
    return { ...host, admitExternal: admitter.admitExternal, resolveBinding: admitter.resolveBinding };
}
