import type { Op, Transaction } from '../change/ops';
import type { Modifiers, RealSample } from '../input/tool';

export interface TransformDriver {
    preview(sample: RealSample, modifiers: Modifiers): readonly Op[];
    /** Snap/reparent preflight may be asynchronous; document apply itself never is. */
    finish(sample: RealSample, modifiers: Modifiers, signal: AbortSignal): Transaction | Promise<Transaction>;
    cancel(): void;
}
export interface TransformGestureServices {
    hold(): () => void;
    registerPending(cancel: () => void): () => void;
    isCurrent(): boolean;
    showPreview(ops: readonly Op[]): void;
    clearPreview(): void;
    /** Applies through BoardSession and releases the returned receipt. */
    apply(transaction: Transaction): void;
    error(error: unknown): void;
}
