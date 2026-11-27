import type { RenderToken } from '../../platform/render/types';
import type { BoardClipboardPasteHost } from '../clipboard/paste';
import type { BoardJobIdentity } from '../workers/protocol';
import { createExternalClipboardAdmitter } from './externalClipboardAdmitter';

export interface BoardClipboardPasteHostOptions extends Omit<BoardClipboardPasteHost, 'admitExternal' | 'resolveBinding'> {
    readonly token: RenderToken;
    readonly zMax: number;
    readAsset?(src: string, signal: AbortSignal): Promise<Blob | null>;
    isCurrent(identity: BoardJobIdentity): boolean;
}

export function createBoardClipboardPasteHost(options: BoardClipboardPasteHostOptions): BoardClipboardPasteHost {
    const admitter = createExternalClipboardAdmitter({ token: options.token, zMax: options.zMax, memory: options.memory,
        readBlob: options.readBlob, ...(options.readAsset ? { readAsset: options.readAsset } : {}),
        isCurrent: options.isCurrent, ...(options.cooperate ? { cooperate: options.cooperate } : {}) });
    const { token: _token, zMax: _zMax, readAsset: _readAsset, isCurrent: _isCurrent, ...host } = options;
    return { ...host, admitExternal: admitter.admitExternal, resolveBinding: admitter.resolveBinding };
}
