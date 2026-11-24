import type { NativeCanvasHost, NativeCanvasIdentity } from '../../types/nativeCanvas';
import type { BoardSessionPort, HostedBoardAdapter } from './boardSessionAdapter';
import type { NativeBoardAcquisitionOptions } from './nativeBoardAcquisitionTypes';

export function createNativeAcquisitionOptions<S extends BoardSessionPort>(
    options: Omit<NativeBoardAcquisitionOptions<S>, 'documentId' | 'vaultActivation' | 'bytesGeneration' | 'kind' | 'existing' | 'currentOwner' | 'sourceAuthorized' | 'editingAuthorized'> & {
        host: NativeCanvasHost;
        identity: NativeCanvasIdentity;
        emergencyReadOnly: () => boolean;
    },
): NativeBoardAcquisitionOptions<S> {
    const { host, identity, emergencyReadOnly, prepare, attachCanvasSession, onNativeCanvasReady, onError, emergencyReadOnlyReason } = options;
    return {
        documentId: identity.documentId,
        vaultActivation: identity.vaultActivation,
        bytesGeneration: identity.bytesGeneration,
        kind: identity.kind,
        currentOwner: () => host.isCurrent(identity),
        sourceAuthorized: () => host.canWriteSource(identity),
        editingAuthorized: () => host.canWrite(identity),
        prepare, attachCanvasSession, onNativeCanvasReady, onError, emergencyReadOnlyReason,
        acceptConvertedSource: (source, digest) => host.acceptConvertedSource(identity, source, digest),
        existing() {
            if (!host.isCurrent(identity)) return undefined;
            const candidate = host.session(identity.documentId);
            if (!candidate) return undefined;
            if (!('board' in candidate) || !('owner' in candidate) || typeof candidate.dispose !== 'function') {
                throw new Error('Canvas session is not a hosted board');
            }
            const adapter = candidate as HostedBoardAdapter<S>;
            const board = adapter.board, owner = adapter.owner;
            if (!owner || !board || !board.owner || typeof board.isReadOnly !== 'boolean'
                || typeof board.hasPendingEdits !== 'function' || typeof board.checkpoint !== 'function'
                || typeof board.acknowledge !== 'function' || typeof board.onChange !== 'function'
                || owner.documentId !== identity.documentId || owner.session !== identity.session
                || board.owner.documentId !== identity.documentId || board.owner.session !== identity.session) {
                throw new Error('Canvas session owner or board is invalid');
            }
            const readOnly = emergencyReadOnly();
            if (readOnly && !board.isReadOnly) throw new Error('Board session did not enforce read-only policy');
            return { adapter, emergencyReadOnly: readOnly };
        },
    };
}
