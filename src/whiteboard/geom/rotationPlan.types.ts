import type { Op } from '../change/ops';
import type { Node } from '../model/nodes';
import type { Vec2 } from './path';

export interface RotationTargetSnapshot {
    readonly node: Readonly<Node>;
    readonly centreWorld: Vec2;
    readonly rotationWorld: number;
}
export interface RotationPlanServices {
    capture(node: Readonly<Node>): RotationTargetSnapshot;
    /** Resolve new parent-local pose and page after rotating the captured geometry. */
    place(snapshot: RotationTargetSnapshot, centreWorld: Vec2, rotationWorld: number): readonly Op[];
    /** Input token and every touched node/ancestor still match the start snapshot. */
    isCurrent(): boolean;
}
