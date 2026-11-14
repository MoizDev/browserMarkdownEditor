import type { Node } from '../model/nodes';
import type { Op } from '../change/ops';
import type { Vec2 } from './path';
import type { ResizePlanServices } from './resizePlan.types';
import type { RotationPlanServices } from './rotationPlan.types';

export interface TransformCommandServices {
    readonly resize: ResizePlanServices;
    readonly rotation: RotationPlanServices;
    /** Reflect around the selection centre, preserving each kind's representation. */
    reflect(node: Readonly<Node>, centre: Vec2, axis: 'x' | 'y'): readonly Op[];
}
