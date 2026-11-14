import type { FrameBudget } from '../../platform/render/types';
import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { PaintFrame, PaintNodeSource } from './paintStream';
import type { PaintFrameSource } from './resources';
import type { ScenePaintNodeStream } from './scenePaintStream';
import type { Rect } from '../../platform/types';

/** A scene supplies a pinned source and owns its leases until release. The assembler never reads
 * mutable model data after admission; cancellation drops the partial frame rather than publishing. */
export interface PinnedPaintSource {
    readonly source: PaintNodeSource;
    release(): void | Promise<void>;
}
/** A bounded async stream of one pinned scene. The assembler pulls one node at a time, so a
 * whole scene's nodes never exist as one array. `release` releases the owning snapshot; the
 * assembler drains and releases the stream itself before calling it. */
export interface PinnedPaintStream {
    readonly stream: ScenePaintNodeStream;
    release(): void | Promise<void>;
    /** Opens another bounded stream of this same pin over `world`, with this frame's request
     * identity (precision, sensitivity). Dense tiles use it; the pin stays owned by the frame. */
    open?(world: Readonly<Rect>, signal: AbortSignal): Promise<ScenePaintNodeStream>;
    /** The frame holds only the live nodes named by `sensitiveNodes` (a dense frame). */
    readonly liveOnly?: true;
}
export interface PaintFrameAssembler extends PaintFrameSource {
    bindMemory?(allocator: MemoryAllocator): void;
    cpuWorkingSet?(): number;
    memoryBytes?(): number;
    /** Superseding a request cancels and releases only the incomplete staging source. */
    request(source: PinnedPaintSource): void;
    /** Same staging and atomic publication as `request`, fed by a bounded stream. */
    requestStream(pin: PinnedPaintStream): void;
    prepare(budget: FrameBudget): void;
    needsFrame(): boolean;
    /** Presentation uses the frame actually drawn, not the newest requested scene revision. */
    presented(frame: PaintFrame): void;
    /** Retains this exact frame's source/metadata through asynchronous presentation-fact work.
     * Release only after its physical worker work retires; hide/dispose cannot reclaim it early. */
    retain(frame: PaintFrame): () => void;
    /** Called when the backend no longer holds this frame, including cancelled staging. */
    retire(frame: PaintFrame): void;
    /** Retire pins on hide; outstanding presentation-fact borrows still own their source. */
    clear(): void;
    /** Resolves after retired sources, including outstanding borrows, physically release. */
    whenRetired(): Promise<void>;
    dispose(): void;
}
