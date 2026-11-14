import type { Transaction, TransactionOrigin } from '../change/ops';
import type { Node } from '../model/nodes';
import type { Vec2 } from './path';
import { ResizePlan } from './resizePlan';
import { rotatePoint } from './transforms';
import type { TransformCommandServices } from './transformCommands.types';

function eligible(nodes: readonly Readonly<Node>[]): void {
    if (!nodes.length || nodes.some(node => node.kind === 'opaque' || node.locked)) throw new RangeError('Selection cannot be transformed');
}
export function rotateSelection(nodes: readonly Readonly<Node>[], centre: Vec2, clockwise: boolean, fine: boolean,
    services: TransformCommandServices, origin: TransactionOrigin = 'tool'): Transaction {
    eligible(nodes);
    const delta = (clockwise ? 1 : -1) * Math.PI / (fine ? 192 : 12);
    if (!services.rotation.isCurrent()) throw new Error('Selection geometry is stale');
    const ops = nodes.flatMap(node => {
        const snapshot = services.rotation.capture(node), target = rotatePoint(snapshot.centreWorld, centre, delta);
        return [...services.rotation.place(snapshot, target, snapshot.rotationWorld + delta)];
    });
    return { origin, label: 'Rotate selection', ops };
}
export function scaleSelection(nodes: readonly Readonly<Node>[], enlarge: boolean,
    services: TransformCommandServices, origin: TransactionOrigin = 'tool'): Transaction {
    eligible(nodes);
    const plan = new ResizePlan(nodes, { x: 0, y: 0 }, { x: 1, y: 1 }, services.resize);
    const box = plan.startBox, amount = ((enlarge ? 1.1 : 1 / 1.1) - 1) / 2;
    const c = Math.cos(box.rotation), s = Math.sin(box.rotation), x = box.width * amount, y = box.height * amount;
    const preview = plan.preview({ x: c * x - s * y, y: s * x + c * y }, { shift: true, alt: true });
    return { origin, label: enlarge ? 'Enlarge selection' : 'Shrink selection', ops: preview.ops };
}
export function flipSelection(nodes: readonly Readonly<Node>[], centre: Vec2, axis: 'x' | 'y',
    services: TransformCommandServices, origin: TransactionOrigin = 'tool'): Transaction {
    eligible(nodes);
    if (![centre.x, centre.y].every(Number.isFinite) || !services.resize.isCurrent()) throw new RangeError('Invalid reflection centre');
    return { origin, label: axis === 'x' ? 'Flip horizontal' : 'Flip vertical', ops: nodes.flatMap(node => [...services.reflect(node, centre, axis)]) };
}
