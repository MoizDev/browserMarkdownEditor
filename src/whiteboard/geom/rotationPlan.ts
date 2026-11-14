import type { Op, Transaction } from '../change/ops';
import type { Node } from '../model/nodes';
import type { Vec2 } from './path';
import type { RotationPlanServices, RotationTargetSnapshot } from './rotationPlan.types';
import { rotatePoint, snapRotation, unwrapRotation } from './transforms';
import { TransformInvalidated } from './translation';

export interface RotationPreview { readonly angle: number; readonly ops: readonly Op[] }
export class RotationPlan {
    private readonly targets: readonly RotationTargetSnapshot[];
    private lastPointerAngle: number;
    private delta = 0;
    private cancelled = false;
    constructor(nodes: readonly Readonly<Node>[], private readonly centre: Vec2, down: Vec2,
        private readonly orientation: number, private readonly services: RotationPlanServices) {
        if (!nodes.length || nodes.some(node => node.kind === 'opaque' || node.locked)
            || ![centre.x, centre.y, down.x, down.y, orientation].every(Number.isFinite)
            || (centre.x === down.x && centre.y === down.y)) throw new RangeError('Invalid rotation gesture');
        this.centre = { ...centre };
        this.targets = nodes.map(node => {
            const target = services.capture(node);
            return { ...target, node: { ...target.node }, centreWorld: { ...target.centreWorld } };
        });
        this.lastPointerAngle = Math.atan2(down.y - centre.y, down.x - centre.x);
    }
    preview(pointer: Vec2, shift: boolean): RotationPreview {
        if (this.cancelled || !this.services.isCurrent()) { this.cancelled = true; throw new TransformInvalidated(); }
        if (![pointer.x, pointer.y].every(Number.isFinite) || (pointer.x === this.centre.x && pointer.y === this.centre.y)) throw new RangeError('Invalid rotation pointer');
        const angle = Math.atan2(pointer.y - this.centre.y, pointer.x - this.centre.x);
        this.delta = unwrapRotation(this.delta, this.lastPointerAngle, angle); this.lastPointerAngle = angle;
        const resolved = snapRotation(this.orientation + this.delta, shift) - this.orientation;
        const ops: Op[] = [];
        for (const target of this.targets) {
            const centre = rotatePoint(target.centreWorld, this.centre, resolved);
            ops.push(...this.services.place(target, centre, target.rotationWorld + resolved));
        }
        return { angle: resolved, ops };
    }
    transaction(pointer: Vec2, shift: boolean): Transaction {
        return { origin: 'tool', label: 'Rotate selection', ops: this.preview(pointer, shift).ops };
    }
    cancel(): void { this.cancelled = true; }
}
