import type { FrameBudget } from '../../platform/render/types';
import type { PaintFrame, PaintNodeSource } from './paintStream';
import type { PaintFrameSource } from './resources';

/** A scene supplies a pinned source and owns its leases until release. The assembler never reads
 * mutable model data after admission; cancellation drops the partial frame rather than publishing. */
export interface PinnedPaintSource {
    readonly source: PaintNodeSource;
    release(): void;
}
export interface PaintFrameAssembler extends PaintFrameSource {
    /** Superseding a request cancels and releases only the incomplete staging source. */
    request(source: PinnedPaintSource): void;
    prepare(budget: FrameBudget): void;
    needsFrame(): boolean;
    /** Presentation uses the frame actually drawn, not the newest requested scene revision. */
    presented(frame: PaintFrame): void;
    /** Called when the backend no longer holds this frame, including cancelled staging. */
    retire(frame: PaintFrame): void;
    dispose(): void;
}
