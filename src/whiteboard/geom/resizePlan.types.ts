import type { Op } from '../change/ops';
import type { Node } from '../model/nodes';
import type { Vec2 } from './path';
import type { KindResizeContext } from './resizeKinds.types';

export interface ResizeTargetSnapshot {
    readonly node: Readonly<Node>;
    readonly centreWorld: Vec2;
    readonly cornersWorld: readonly Vec2[];
    /** Relevant world rotations, including group descendants actually resized. */
    readonly relevantRotations: readonly number[];
    readonly worldRotation: number;
}
export interface ResizePlanServices {
    readonly kinds: KindResizeContext;
    capture(node: Readonly<Node>): ResizeTargetSnapshot;
    /** Resolve new local origin/page from the resized geometry and mapped world centre. */
    place(snapshot: ResizeTargetSnapshot, centreWorld: Vec2, kindOps: readonly Op[]): readonly Op[];
    /** Root/ancestor revisions and session/gesture identity still match pointer-down. */
    isCurrent(): boolean;
}
