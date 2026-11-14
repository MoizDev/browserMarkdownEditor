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
    private readonly forceAspect: boolean;
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
        // Default, calibration cut by owner: one aspect-locked participant locks the whole selection.
        this.forceAspect = this.mixed || this.snapshots.some(target => target.forceAspect || target.node.kind === 'clip'
            || target.node.kind === 'sticky' || (target.node.kind === 'text' && !!handle.x && !!handle.y));
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
    private check(signal?: AbortSignal): void {
        signal?.throwIfAborted();
        if (this.cancelled || !this.services.isCurrent()) { this.cancelled = true; throw new TransformInvalidated(); }
    }
    private *targets(frame: ResizePreview, zeroSignX: -1 | 1, zeroSignY: -1 | 1): Generator<{
        snapshot: ResizeTargetSnapshot; centre: Vec2; factors: KindResizeFactors;
    }> {
        const angle = this.startBox.rotation, c = Math.cos(angle), s = Math.sin(angle), anchor = frame.anchor;
        for (const snapshot of this.snapshots) {
            const dx = snapshot.centreWorld.x - anchor.x, dy = snapshot.centreWorld.y - anchor.y;
            const u = c * dx + s * dy, v = -s * dx + c * dy;
            const centre = { x: anchor.x + c * u * frame.scaleX - s * v * frame.scaleY,
                y: anchor.y + s * u * frame.scaleX + c * v * frame.scaleY };
            const quarterTurns = Math.round((snapshot.worldRotation - angle) / (Math.PI / 2));
            const swap = !this.mixed && Math.abs(quarterTurns % 2) === 1;
            const turn = this.mixed ? 0 : (quarterTurns % 4 + 4) % 4;
            const hx = this.handle.x, hy = this.handle.y;
            const localX = (turn === 0 ? hx : turn === 1 ? hy : turn === 2 ? -hx : -hy) as -1 | 0 | 1;
            const localY = (turn === 0 ? hy : turn === 1 ? -hx : turn === 2 ? -hy : hx) as -1 | 0 | 1;
            const factors: KindResizeFactors = { x: swap ? frame.scaleY : frame.scaleX, y: swap ? frame.scaleX : frame.scaleY,
                zeroSignX: swap ? zeroSignY : zeroSignX, zeroSignY: swap ? zeroSignX : zeroSignY,
                handleX: localX, handleY: localY, handle: hx && hy ? 'corner' : 'side',
                scope: this.scopeOverride ?? (this.snapshots.length === 1 ? 'single' : 'multi') };
            yield { snapshot, centre, factors };
        }
    }
    preview(pointer: Vec2, modifiers: ResizeModifiers, zeroSignX: -1 | 1 = 1, zeroSignY: -1 | 1 = 1): SelectionResizePreview {
        this.check();
        if (!this.services.kinds || !this.services.place) throw new Error('This resize plan requires asynchronous geometry');
        const frame = resizeBox(this.startBox, this.handle, this.down, pointer, modifiers, this.forceAspect), ops: Op[] = [];
        if (frame.scaleX === 1 && frame.scaleY === 1) return { frame, ops };
        for (const { snapshot, centre, factors } of this.targets(frame, zeroSignX, zeroSignY)) {
            const patch = resizeKind(snapshot.node, factors, this.services.kinds);
            for (const op of patch) ops.push(op);
            for (const op of this.services.place(snapshot, centre, patch)) ops.push(op);
        }
        return { frame, ops };
    }
    async previewAsync(pointer: Vec2, modifiers: ResizeModifiers, signal: AbortSignal,
        zeroSignX: -1 | 1 = 1, zeroSignY: -1 | 1 = 1): Promise<SelectionResizePreview> {
        this.check(signal);
        const frame = resizeBox(this.startBox, this.handle, this.down, pointer, modifiers, this.forceAspect), ops: Op[] = [];
        if (frame.scaleX === 1 && frame.scaleY === 1) return { frame, ops };
        if (this.services.planAllAsync) {
            const all = await this.services.planAllAsync([...this.targets(frame, zeroSignX, zeroSignY)], frame, signal);
            this.check(signal); return { frame, ops: all };
        }
        for (const { snapshot, centre, factors } of this.targets(frame, zeroSignX, zeroSignY)) {
            const patch = this.services.resizeKindAsync
                ? await this.services.resizeKindAsync(snapshot.node, factors, signal) : resizeKind(snapshot.node, factors, this.services.kinds);
            this.check(signal);
            const placement = this.services.placeAsync
                ? await this.services.placeAsync(snapshot, centre, patch, signal) : this.services.place(snapshot, centre, patch);
            this.check(signal);
            for (const op of patch) ops.push(op);
            for (const op of placement) ops.push(op);
        }
        this.check(signal); return { frame, ops };
    }
    transaction(pointer: Vec2, modifiers: ResizeModifiers, zeroSignX: -1 | 1 = 1, zeroSignY: -1 | 1 = 1): Transaction {
        return { origin: 'tool', label: 'Resize selection', ops: this.preview(pointer, modifiers, zeroSignX, zeroSignY).ops };
    }
    async transactionAsync(pointer: Vec2, modifiers: ResizeModifiers, signal: AbortSignal,
        zeroSignX: -1 | 1 = 1, zeroSignY: -1 | 1 = 1): Promise<Transaction> {
        const result = await this.previewAsync(pointer, modifiers, signal, zeroSignX, zeroSignY);
        this.check(signal); return { origin: 'tool', label: 'Resize selection', ops: result.ops };
    }
    cancel(): void { this.cancelled = true; }
}
