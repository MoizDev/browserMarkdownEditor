import type { Op } from '../change/ops';
import type { Node, PictureNode } from '../model/nodes';
import type { KindResizeContext, KindResizeFactors } from './resizeKinds.types';

function extent(value: number): number { return Math.min(1_000_000, Math.max(1, value)); }
function scale(value: number): number { return Math.min(100, Math.max(0.01, value)); }
function reflected(value: number, zeroSign: -1 | 1): boolean { return value < 0 || (value === 0 && zeroSign < 0); }
function signedNonzero(value: number, zeroSign: -1 | 1): number {
    if (value === 0) return zeroSign * Number.MIN_VALUE;
    return Math.max(-1_000_000, Math.min(1_000_000, value));
}
function pictureReflection(node: Readonly<PictureNode>, flipX: boolean, flipY: boolean): Op[] {
    const ops: Op[] = [];
    if (flipX) ops.push({ t: 'set', id: node.id, key: 'flipX', value: !node.flipX });
    if (flipY) ops.push({ t: 'set', id: node.id, key: 'flipY', value: !node.flipY });
    if ((flipX || flipY) && node.crop) {
        const c = node.crop;
        ops.push({ t: 'set', id: node.id, key: 'crop', value: {
            x0: flipX ? 1 - c.x1 : c.x0, x1: flipX ? 1 - c.x0 : c.x1,
            y0: flipY ? 1 - c.y1 : c.y0, y1: flipY ? 1 - c.y0 : c.y1, circle: c.circle,
        } });
    }
    return ops;
}
// x/y placement and parent/page anchoring are supplied by the gesture plan;
// these patches alter only the kind's representable geometry and never its paint width.
export function resizeKind(node: Readonly<Node>, factors: KindResizeFactors, context: KindResizeContext): readonly Op[] {
    const { x, y, zeroSignX, zeroSignY } = factors;
    if (!Number.isFinite(x) || !Number.isFinite(y) || node.locked || node.kind === 'opaque') throw new RangeError('Node cannot be resized');
    const ax = Math.abs(x), ay = Math.abs(y), flipX = reflected(x, zeroSignX), flipY = reflected(y, zeroSignY);
    const ops: Op[] = [];
    switch (node.kind) {
        case 'stroke':
            ops.push({ t: 'set', id: node.id, key: 'sx', value: signedNonzero(node.sx * x, (node.sx < 0) !== flipX ? -1 : 1) },
                { t: 'set', id: node.id, key: 'sy', value: signedNonzero(node.sy * y, (node.sy < 0) !== flipY ? -1 : 1) });
            return ops;
        case 'figure': {
            const width = extent(node.w * ax), height = extent((node.h + node.growY) * ay);
            const layout = context.layoutFigure(node, width, height);
            if (!Number.isFinite(layout.h) || !Number.isFinite(layout.growY) || layout.h < 1 || layout.h > 1_000_000 || layout.growY < 0) throw new RangeError('Invalid resized figure layout');
            ops.push({ t: 'set', id: node.id, key: 'w', value: width }, { t: 'set', id: node.id, key: 'h', value: layout.h },
                { t: 'set', id: node.id, key: 'growY', value: layout.growY });
            if (flipX) ops.push({ t: 'set', id: node.id, key: 'flipX', value: !node.flipX });
            if (flipY) ops.push({ t: 'set', id: node.id, key: 'flipY', value: !node.flipY });
            return ops;
        }
        case 'text':
            if (factors.handle === 'side') {
                if (ax !== 1) ops.push({ t: 'set', id: node.id, key: 'w', value: extent(node.w * ax) }, { t: 'set', id: node.id, key: 'autoSize', value: false });
            } else ops.push({ t: 'set', id: node.id, key: 'scale', value: scale(node.scale * Math.max(ax, ay)) });
            return ops;
        case 'sticky':
            if (factors.scope === 'single') return [];
            ops.push({ t: 'set', id: node.id, key: 'scale', value: scale(node.scale * Math.max(ax, ay)) });
            return ops;
        case 'picture':
            ops.push({ t: 'set', id: node.id, key: 'w', value: extent(node.w * ax) }, { t: 'set', id: node.id, key: 'h', value: extent(node.h * ay) });
            return [...ops, ...pictureReflection(node, flipX, flipY)];
        case 'polyline':
            ops.push({ t: 'set', id: node.id, key: 'points', value: node.points.map(p => ({ x: p.x * x, y: p.y * y })) });
            return ops;
        case 'frame': return context.resizeFrame(node, extent(node.w * ax), extent(node.h * ay), factors);
        case 'group': return context.resizeGroup(node, factors);
        case 'connector': return context.resizeConnector(node, factors);
        case 'clip': case 'linkcard': case 'embed': return context.resizeMedia(node, factors);
    }
}
