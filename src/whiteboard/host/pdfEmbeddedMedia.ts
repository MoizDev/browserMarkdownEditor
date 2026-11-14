import type { NativeCanvasHost, NativeCanvasIdentity } from '../../types/nativeCanvas';
import type { RenderToken } from '../../platform/render/types';
import type { CurrentDocumentBytes, MediaStorageIssuer, StoreVerifiedMedia } from '../media/storage.types';
import type { BoardRuntime } from './runtime';
import { getBoardRuntime } from './runtime';
import { getPdfInkSourceState } from './preparePdfInkSession';

const stale = () => new DOMException('PDF ink source changed', 'AbortError');
const matches = (identity: NativeCanvasIdentity, token: RenderToken) => identity.documentId === token.documentId
    && identity.session === token.session && identity.vaultActivation === token.vaultEpoch && identity.bytesGeneration === token.bytesGeneration;

/** Binds the real receipt issuer to one owned PDF source and canonical board runtime. */
export function createPdfEmbeddedMediaStorage(options: {
    readonly runtime: BoardRuntime;
    readonly host: NativeCanvasHost;
    readonly identity: NativeCanvasIdentity;
    readonly issue: MediaStorageIssuer;
}): StoreVerifiedMedia {
    const { runtime, host, identity } = options, board = runtime.session;
    if (identity.kind !== 'pdfInk' || board.doc.kind !== 'pdf-ink'
        || board.owner.documentId !== identity.documentId || board.owner.session !== identity.session
        || getBoardRuntime(board) !== runtime) throw new Error('PDF media requires the actual owned ink runtime');
    const sourceState = getPdfInkSourceState(identity.documentId);
    if (!sourceState) throw new Error('PDF ink source is not owned by this session');
    const isCurrent = (source: ReturnType<typeof sourceState.getSnapshot>['source']) => {
        const state = sourceState.getSnapshot(), outer = host.outerIdentity(identity.documentId);
        return host.isCurrent(identity) && getBoardRuntime(board) === runtime && getPdfInkSourceState(identity.documentId) === sourceState
            && board.doc.kind === 'pdf-ink' && board.owner.documentId === identity.documentId && board.owner.session === identity.session
            && state.status === 'ready' && state.source === source && source.isCurrent()
            && !!outer && outer.kind === 'pdfInk' && host.isCurrent(outer) && matches(outer, source.source.token);
    };
    return async (entry, blob, signal, proof) => {
        signal.throwIfAborted();
        if (proof.runtime !== runtime || entry.file !== null) throw new TypeError('PDF media has a foreign runtime or file location');
        runtime.jobs.assertContext(proof.context);
        proof.context.assertCurrent();
        proof.context.signal.throwIfAborted();
        if (!host.canWrite(identity)) throw stale();
        const lease = sourceState.retainSource(), source = lease.source;
        let transferred = false;
        try {
            const token = Object.freeze({ ...source.source.token });
            const assertWritable = () => {
                proof.context.signal.throwIfAborted();
                if (!isCurrent(source) || !host.canWrite(identity)) throw stale();
            };
            signal.throwIfAborted();
            assertWritable();
            const captureCurrentBytes = async (captureSignal: AbortSignal): Promise<CurrentDocumentBytes> => {
                captureSignal.throwIfAborted();
                proof.context.signal.throwIfAborted();
                if (!isCurrent(source)) throw stale();
                // checkpoint() captures the real PDF build, including the current embedded media;
                // the caller may already hold runtime.jobs, so this must never enqueue another job.
                const checkpoint = board.checkpoint();
                if (typeof checkpoint === 'string' || checkpoint.owner.documentId !== board.owner.documentId
                    || checkpoint.owner.session !== board.owner.session || !checkpoint.retain) throw new Error('PDF checkpoint cannot be retained');
                const revision = checkpoint.revision, held = checkpoint.retain();
                let returned = false;
                try {
                    const build = checkpoint.read();
                    if (!build || typeof build !== 'object' || !('kind' in build) || build.kind !== 'build'
                        || build.revision !== revision) throw new Error('PDF checkpoint has no matching build');
                    if (!isCurrent(source) || board.doc.rev !== revision) throw stale();
                    const result = await build.run(AbortSignal.any([captureSignal, proof.context.signal]));
                    captureSignal.throwIfAborted();
                    proof.context.signal.throwIfAborted();
                    if (!isCurrent(source) || board.doc.rev !== revision) throw stale();
                    const bytes = result instanceof Blob ? result : result.slice();
                    let released = false;
                    returned = true;
                    return { owner: Object.freeze({ ...checkpoint.owner }), revision, bytes,
                        release() { if (!released) { released = true; held.release(); } } };
                } finally { if (!returned) held.release(); }
            };
            const receipt = options.issue({ entry, blob, runtime: proof.runtime, context: proof.context, inspection: proof.inspection }, { kind: 'embedded', token, source: lease,
                assertWritable, captureCurrentBytes });
            transferred = true;
            return receipt;
        } finally { if (!transferred) lease.release(); }
    };
}
