import type { FrameBudget } from '../../platform/render/types';
import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { PaintNodeSource, PaintSource } from './paintStream';
import type { PaintFrameSource } from './resources';
import type { ScenePaintNodeStream } from './scenePaintStream';
import type { ResolvedNodeCache } from './resolvedNodeCache';
import type { Rect } from '../../platform/types';

export interface PinnedPaintSource {
    readonly source: PaintNodeSource;
    release(): void | Promise<void>;
}
export interface PinnedPaintStream {
    readonly stream: ScenePaintNodeStream;
    isCurrent(): boolean;
    release(): void | Promise<void>;
    open?(world: Readonly<Rect>, signal: AbortSignal, resolved?: ResolvedNodeCache | null): Promise<ScenePaintNodeStream>;
    readonly liveOnly?: true;
}
export interface PaintFrameAssembler extends PaintFrameSource {
    bindMemory?(allocator: MemoryAllocator): void;
    cpuWorkingSet?(): number;
    memoryBytes?(): number;
    request(source: PinnedPaintSource): void;
    requestStream(pin: PinnedPaintStream): void;
    prepare(budget: FrameBudget): void;
    needsFrame(): boolean;
    blocked?(): boolean;
    replacing?(): boolean;
    presented(frame: PaintSource): void;
    /** Retains this exact frame's source/metadata through asynchronous presentation-fact work.
     * Release only after its physical worker work retires; hide/dispose cannot reclaim it early. */
    retain(frame: PaintSource): () => void;
    retire(frame: PaintSource): void;
    clear(): void;
    whenRetired(): Promise<void>;
    dispose(): void;
}
