import type { Op, Transaction } from '../change/ops';
import type { Node } from '../model/nodes';
import { resizeKind } from './resizeKinds';
import type { KindResizeFactors } from './resizeKinds.types';
import type { ResizePlanServices, ResizeTargetSnapshot } from './resizePlan.types';
import type { Vec2 } from './path';
import { commonResizeRotation, resizeBox } from './transforms';
import type { OrientedBox, ResizeHandle, ResizeModifiers, ResizePreview } from './transforms';
import { TransformInvalidated } from './translation';

export interface SelectionResizePreview { readonly frame: ResizePreview; readonly ops: readonly Op[] }
export class ResizePlan {
    readonly startBox: OrientedBox;
    private readonly snapshots: readonly ResizeTargetSnapshot[];
    private readonly mixed: boolean;
    private cancelled = false;
    constructor(nodes: readonly Readonly<Node>[], private readonly down: Vec2, private readonly handle: ResizeHandle,
        private readonly services: ResizePlanServices, private readonly scopeOverride?: 'single' | 'multi') {
        if (!nodes.length || nodes.some(node => node.kind === 'opaque' || node.locked)) throw new RangeError('Invalid resize selection');
        this.snapshots = nodes.map(node => {
            const value = services.capture(node);
            return { ...value, node: { ...value.node }, centreWorld: { ...value.centreWorld },
                cornersWorld: value.cornersWorld.map(point => ({ ...point })), relevantRotations: [...value.relevantRotations] };
        });
        const rotations = this.snapshots.flatMap(target => target.relevantRotations.length ? target.relevantRotations : [target.worldRotation]);
        const common = commonResizeRotation(rotations);
        this.mixed = common === null;
        const rotation = common ?? 0, c = Math.cos(rotation), s = Math.sin(rotation);
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const target of this.snapshots) {
            if (!target.cornersWorld.length) throw new RangeError('Resize target lacks selection bounds');
            for (const p of target.cornersWorld) {
                const x = c * p.x + s * p.y, y = -s * p.x + c * p.y;
                x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
            }
        }
        if (![x0, y0, x1, y1, down.x, down.y].every(Number.isFinite) || x1 <= x0 || y1 <= y0) throw new RangeError('Invalid resize bounds');
        this.startBox = { origin: { x: c * x0 - s * y0, y: s * x0 + c * y0 }, width: x1 - x0, height: y1 - y0, rotation };
    }
    preview(pointer: Vec2, modifiers: ResizeModifiers, zeroSignX: -1 | 1 = 1, zeroSignY: -1 | 1 = 1): SelectionResizePreview {
        if (this.cancelled || !this.services.isCurrent()) { this.cancelled = true; throw new TransformInvalidated(); }
        const frame = resizeBox(this.startBox, this.handle, this.down, pointer, modifiers, this.mixed);
        const angle = this.startBox.rotation, c = Math.cos(angle), s = Math.sin(angle), anchor = frame.anchor;
        const ops: Op[] = [];
        for (const snapshot of this.snapshots) {
            const dx = snapshot.centreWorld.x - anchor.x, dy = snapshot.centreWorld.y - anchor.y;
            const u = c * dx + s * dy, v = -s * dx + c * dy;
            const centre = { x: anchor.x + c * u * frame.scaleX - s * v * frame.scaleY,
                y: anchor.y + s * u * frame.scaleX + c * v * frame.scaleY };
            const quarterTurns = Math.round((snapshot.worldRotation - angle) / (Math.PI / 2));
            const swap = !this.mixed && Math.abs(quarterTurns % 2) === 1;
            const factors: KindResizeFactors = { x: swap ? frame.scaleY : frame.scaleX, y: swap ? frame.scaleX : frame.scaleY,
                zeroSignX: swap ? zeroSignY : zeroSignX, zeroSignY: swap ? zeroSignX : zeroSignY,
                handle: this.handle.x && this.handle.y ? 'corner' : 'side', scope: this.scopeOverride ?? (this.snapshots.length === 1 ? 'single' : 'multi') };
            const patch = resizeKind(snapshot.node, factors, this.services.kinds);
            ops.push(...patch, ...this.services.place(snapshot, centre, patch));
        }
        return { frame, ops };
    }
    transaction(pointer: Vec2, modifiers: ResizeModifiers, zeroSignX: -1 | 1 = 1, zeroSignY: -1 | 1 = 1): Transaction {
        return { origin: 'tool', label: 'Resize selection', ops: this.preview(pointer, modifiers, zeroSignX, zeroSignY).ops };
    }
    cancel(): void { this.cancelled = true; }
}
