import type { Affine, PathCommand } from '../../platform/types';
import type { ConnectorGeometry } from '../geom/connectorTypes';
import type { PathOp, Vec2 } from '../geom/path';
import type { ConnectorNode } from '../model/nodes';
import type { FaceTable } from '../text/paint';
import { resolveSwatch } from './colour';
import type { PaintPalette } from './colour';
import { pathMaterial } from './material';
import type { PaintClip, PaintItem, PaintNode } from './paintStream';
import { textPaintMaterial } from './textGeometry';

// Provenance: connector world geometry, head and shared paint material contracts;
// independent paint conversion, no third-party source.
const IDENTITY: Affine = Object.freeze([1, 0, 0, 1, 0, 0]);
function matrix(value: Affine): void {
    if (value.length !== 6 || !value.every(Number.isFinite)) throw new RangeError('Invalid connector paint transform');
}
function worldPath(path: readonly PathOp[], transform: Affine): PathCommand[] {
    matrix(transform);
    const point = (p: Vec2): [number, number] => {
        const x = transform[0] * p.x + transform[2] * p.y + transform[4];
        const y = transform[1] * p.x + transform[3] * p.y + transform[5];
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new RangeError('Invalid connector exclusion path');
        return [x, y];
    };
    const result: PathCommand[] = [];
    for (const op of path) {
        if (op.op === 'Z') result.push(['Z']);
        else if (op.op === 'C') {
            const a = point(op.c1), b = point(op.c2), p = point(op.p);
            result.push(['C', a[0], a[1], b[0], b[1], p[0], p[1]]);
        } else {
            const p = point(op.p); result.push([op.op, p[0], p[1]]);
        }
    }
    return result;
}

export function paintConnector(node: ConnectorNode, geometry: ConnectorGeometry,
    context: { clips: readonly PaintClip[]; opacity: number }, palette: PaintPalette, faces: FaceTable): PaintNode {
    for (const clip of context.clips) matrix(clip.localToWorld);
    const color = resolveSwatch(palette, node.color, 'stroke')!;
    const stroke = { color, width: node.width, cap: 'round' as const, join: 'round' as const, miterLimit: 4 };
    const outline = pathMaterial(undefined, stroke, context.opacity);
    const filled = pathMaterial(color, stroke, context.opacity);
    const content: PaintItem[] = [];
    const base = (part: string) => ({ key: `${geometry.key}:${part}:${palette.revision}`,
        nodeId: node.id, geometryKey: `${geometry.key}:${part}`, localToWorld: IDENTITY, clips: context.clips });
    let bodyClips = context.clips;
    if (geometry.bodyExclusions.length) {
        const r = geometry.inkBoundsWorld, right = r.x + r.width, bottom = r.y + r.height;
        if (![r.x, r.y, r.width, r.height, right, bottom].every(Number.isFinite) || r.width < 0 || r.height < 0) throw new RangeError('Invalid connector ink bounds');
        const path: PathCommand[] = [['M', r.x, r.y], ['L', right, r.y], ['L', right, bottom], ['L', r.x, bottom], ['Z']];
        for (const exclusion of geometry.bodyExclusions) for (const command of worldPath(exclusion.outline, exclusion.localToWorld)) path.push(command);
        bodyClips = [...context.clips, { key: `${geometry.key}:body-exclusions`, d: path, fillRule: 'evenodd', localToWorld: IDENTITY }];
    }
    if (node.dash !== 'none' && geometry.body.length) content.push({ ...base('body'), clips: bodyClips,
        kind: 'path', d: worldPath(geometry.body, IDENTITY), fillRule: 'nonzero', material: outline });
    const kinds = [node.headStart, node.headEnd].filter(kind => kind !== 'none');
    if (geometry.heads.length !== kinds.length) throw new TypeError('Connector head geometry does not match its terminals');
    for (let i = 0; i < geometry.heads.length; i++) {
        const kind = kinds[i];
        const closed = kind !== 'arrow' && kind !== 'pipe' && kind !== 'bar';
        const path = geometry.heads[i];
        if (closed && path[path.length - 1]?.op !== 'Z') throw new TypeError('Closed connector head has an open path');
        content.push({ ...base(`head-${i}`), kind: 'path', d: worldPath(path, IDENTITY), fillRule: 'nonzero', material: closed ? filled : outline });
    }
    if (geometry.label) {
        matrix(geometry.label.localToWorld);
        content.push({ ...base('label'), localToWorld: geometry.label.localToWorld, kind: 'text',
            paint: geometry.label.paint, faces, material: textPaintMaterial(geometry.label.paint, palette, context.opacity) });
    }
    return { content };
}
