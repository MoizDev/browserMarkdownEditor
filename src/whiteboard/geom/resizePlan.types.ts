import type { Op } from '../change/ops';
import type { Node } from '../model/nodes';
import type { Vec2 } from './path';
import type { KindResizeContext, KindResizeFactors } from './resizeKinds.types';

export interface ResizeTargetSnapshot {
    readonly node: Readonly<Node>;
    readonly centreWorld: Vec2;
    readonly cornersWorld: readonly Vec2[];
    readonly relevantRotations: readonly number[];
    readonly forceAspect?: boolean;
    readonly worldRotation: number;
}
export interface ResizePlanTarget {
    readonly snapshot: ResizeTargetSnapshot;
    readonly centre: Vec2;
    readonly factors: KindResizeFactors;
}
interface ResizePlanCommon {
    capture(node: Readonly<Node>): ResizeTargetSnapshot;
    isCurrent(): boolean;
}
export type ResizePlanServices = ResizePlanCommon & ({
    readonly kinds: KindResizeContext;
    place(snapshot: ResizeTargetSnapshot, centreWorld: Vec2, kindOps: readonly Op[]): readonly Op[];
    resizeKindAsync?(node: Readonly<Node>, factors: KindResizeFactors, signal: AbortSignal): Promise<readonly Op[]>;
    placeAsync?(snapshot: ResizeTargetSnapshot, centreWorld: Vec2, kindOps: readonly Op[], signal: AbortSignal): Promise<readonly Op[]>;
    planAllAsync?: never;
} | {
    planAllAsync(targets: readonly ResizePlanTarget[], frame: import('./transforms').ResizePreview, signal: AbortSignal): Promise<readonly Op[]>;
    readonly kinds?: never;
    readonly place?: never;
    readonly resizeKindAsync?: never;
    readonly placeAsync?: never;
});
