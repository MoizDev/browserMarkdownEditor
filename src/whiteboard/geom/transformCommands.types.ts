import type { Node } from '../model/nodes';
import type { Op, Transaction } from '../change/ops';
import type { ChangeGeometry } from '../change/coordinates';
import type { BoardDoc } from '../model/doc';
import type { NodeId } from '../model/ids';
import type { Direction } from '../selectionNavigation';
import type { Vec2 } from './path';
import type { ResizePlanServices } from './resizePlan.types';
import type { RotationPlanServices } from './rotationPlan.types';

export type NudgeTransaction = (doc: BoardDoc, ids: readonly NodeId[], direction: Direction, coarse: boolean, geometry: ChangeGeometry) => Transaction;

export interface TransformCommandServices {
    readonly resize: ResizePlanServices;
    readonly rotation: RotationPlanServices;
    /** Reflect around the selection centre, preserving each kind's representation. */
    reflect(node: Readonly<Node>, centre: Vec2, axis: 'x' | 'y'): readonly Op[];
}
