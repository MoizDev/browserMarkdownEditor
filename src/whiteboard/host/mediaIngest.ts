import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import { MediaIngestor } from '../media/ingest';
import type { MediaIngestOptions, MediaSource } from '../media/ingest';
import { inspectMedia } from '../media/inspect';
import type { MediaEntry, MediaId } from '../model/media';
import type { NodeId } from '../model/ids';
import type { MediaLease } from '../media/store';
import type { TransactionOrigin } from '../change/ops';
import type { BoardRuntime } from './runtime';
import type { JobContext } from '../security/admission';

// Provenance: session job authority, SEC-W4 inspection and atomic media-ingest
// contracts; independent host wiring, no third-party source.
export interface BoardMediaIngestOptions {
    readonly runtime: BoardRuntime;
    /** Shared, app-governed CPU allocator; this view does not create another governor. */
    readonly memory: MemoryAllocator;
    current(): boolean;
    finishGesture(): void;
    storeMedia(entry: MediaEntry, blob: Blob, signal: AbortSignal): Promise<string | null>;
    noticeRefused(files: readonly { readonly name: string; readonly reason: string }[]): void;
}
function snapshot(source: MediaSource): MediaSource {
    if (!source || !(source.blob instanceof Blob) || typeof source.name !== 'string') throw new TypeError('Invalid media source');
    return { blob: new Blob([source.blob], { type: source.blob.type }), name: source.name,
        ...(source.pixelsPerWorldUnit === undefined ? {} : { pixelsPerWorldUnit: source.pixelsPerWorldUnit }) };
}
/** Uses the session's authority and media store; disposing this view never disposes either. */
export function createBoardMediaIngestor(options: BoardMediaIngestOptions): MediaIngestor & { dispose(): void } {
    const { runtime } = options, lifetime = new AbortController(), leases = new Map<MediaId, MediaLease>();
    let disposed = false, inFlight = 0;
    const release = () => {
        if (inFlight) return;
        for (const lease of leases.values()) lease.release();
        leases.clear();
    };
    const host = {
        inspectMedia: (blob: Blob, request: Parameters<ConstructorParameters<typeof MediaIngestor>[1]['inspectMedia']>[1]) =>
            inspectMedia(blob, { ...request, memory: options.memory }),
        storeMedia: (entry: MediaEntry, blob: Blob, signal: AbortSignal) => options.storeMedia(entry, blob, signal),
        rememberMedia(id: MediaId, blob: Blob) {
            if (!leases.has(id)) leases.set(id, runtime.media.retain(id, 'snapshot'));
            runtime.media.put(id, blob);
        },
        finishGesture: () => options.finishGesture(),
        isCurrent: () => !disposed && options.current(),
        select: (ids: readonly NodeId[]) => runtime.selection.replace(ids),
        noticeRefused: (files: readonly { readonly name: string; readonly reason: string }[]) => options.noticeRefused(files),
    };
    const signal = (external?: AbortSignal) => external ? AbortSignal.any([lifetime.signal, external]) : lifetime.signal;
    class ViewIngestor extends MediaIngestor {
        constructor() { super(runtime.session, host, runtime.jobs, runtime.media); }
        override ingest(sources: readonly MediaSource[], request: MediaIngestOptions): Promise<readonly NodeId[]> {
            if (disposed) return Promise.reject(new DOMException('Media view disposed', 'AbortError'));
            let owned: MediaSource[];
            try { owned = sources.map(snapshot); } catch (error) { return Promise.reject(error); }
            inFlight++;
            try { return super.ingest(owned, { ...request, signal: signal(request.signal) }).finally(() => { inFlight--; release(); }); }
            catch (error) { inFlight--; release(); throw error; }
        }
        override ingestInJob(sources: readonly MediaSource[], request: MediaIngestOptions, context: JobContext): Promise<readonly NodeId[]> {
            if (disposed) return Promise.reject(new DOMException('Media view disposed', 'AbortError'));
            let owned: MediaSource[];
            try { owned = sources.map(snapshot); } catch (error) { return Promise.reject(error); }
            inFlight++;
            try { return super.ingestInJob(owned, request, context).finally(() => { inFlight--; release(); }); }
            catch (error) { inFlight--; release(); throw error; }
        }
        override replaceInJob(id: NodeId, source: MediaSource, request: { readonly signal?: AbortSignal; readonly origin: TransactionOrigin }, context: JobContext): Promise<void> {
            if (disposed) return Promise.reject(new DOMException('Media view disposed', 'AbortError'));
            let owned: MediaSource;
            try { owned = snapshot(source); } catch (error) { return Promise.reject(error); }
            inFlight++;
            try { return super.replaceInJob(id, owned, request, context).finally(() => { inFlight--; release(); }); }
            catch (error) { inFlight--; release(); throw error; }
        }
        override replace(id: NodeId, source: MediaSource, request: { readonly signal?: AbortSignal; readonly origin: TransactionOrigin }): Promise<void> {
            if (disposed) return Promise.reject(new DOMException('Media view disposed', 'AbortError'));
            let owned: MediaSource;
            try { owned = snapshot(source); } catch (error) { return Promise.reject(error); }
            inFlight++;
            try { return super.replace(id, owned, { ...request, signal: signal(request.signal) }).finally(() => { inFlight--; release(); }); }
            catch (error) { inFlight--; release(); throw error; }
        }
        dispose(): void { if (!disposed) { disposed = true; lifetime.abort(); release(); } }
    }
    return new ViewIngestor();
}
