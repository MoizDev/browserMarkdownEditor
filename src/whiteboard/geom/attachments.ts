import type { BoardDoc } from '../model/doc';
import type { NodeId } from '../model/ids';
import type { NodeSetOp } from '../change/ops';
import type { Attachment, FigureNode, Point, PolylineNode } from '../model/nodes';
import type { FigureShape } from '../model/styles';
import type { IncidentEnd } from './connectorTypes';
import { figureOutline } from './figures';
import { contourPolylines, nearestOnPolylines, type OutlinePolyline } from './outlineSnap';
import type { Vec2 } from './path';

/** The model's target index is authoritative; a self-targeted pair has two distinct ends. */
/** Default, calibration cut by owner: a reflected target mirrors normalized attached anchors. */
export function reflectedTargetAnchors(doc: Readonly<BoardDoc>, target: NodeId, flipX: boolean, flipY: boolean): readonly NodeSetOp[] {
    if (!flipX && !flipY) return [];
    const ops: NodeSetOp[] = [];
    const reflect = (attachment: Attachment): Attachment => ({ ...attachment, anchor: {
        x: flipX ? 1 - attachment.anchor.x : attachment.anchor.x,
        y: flipY ? 1 - attachment.anchor.y : attachment.anchor.y,
    } });
    for (const id of doc.attachedTo.get(target) ?? []) {
        const node = doc.nodes.get(id); if (!node) throw new Error('Attached node disappeared');
        if (node.kind === 'connector') {
            for (const side of ['start', 'end'] as const) {
                const end = node[side]; if (end.attach?.target !== target) continue;
                ops.push({ t: 'set', id, key: side, value: { ...end, attach: reflect(end.attach) } });
            }
        } else if (node.kind === 'polyline') {
            const line = node as Readonly<PolylineNode> & { readonly startAttach?: Attachment | null; readonly endAttach?: Attachment | null };
            for (const key of ['startAttach', 'endAttach'] as const) {
                const value = line[key]; if (value?.target === target) ops.push({ t: 'set', id, key, value: reflect(value) } as unknown as NodeSetOp);
            }
        } else throw new Error('Invalid attachment index entry');
    }
    return ops;
}

/** A figure that changes shape keeps each precise end on its outline: an anchor the new outline leaves outside moves to the nearest
 * outline point (catalogue a.5, ArrowBindingUtil.ts:86-98). Anchors are fractions of the box, so they are re-read against it.
 * Every figure is closed; an anchor already inside, and every imprecise end, stays where it is. */
export function resnappedShapeAnchors(doc: Readonly<BoardDoc>, figure: Readonly<FigureNode>, shape: FigureShape): NodeSetOp[] {
    const height = figure.h + figure.growY;
    if (!(figure.w > 0) || !(height > 0)) return [];
    const pieces = contourPolylines(figureOutline(shape, figure.w, height, figure.flipX, figure.flipY).primary);
    const landing = (attachment: Attachment): Point | null => {
        if (attachment.target !== figure.id || !attachment.precise) return null;
        const at = { x: attachment.anchor.x * figure.w, y: attachment.anchor.y * height };
        if (insideClosed(at, pieces)) return null;
        const near = nearestOnPolylines(at, pieces); if (!near) return null;
        return { x: clamp01(near.point.x / figure.w), y: clamp01(near.point.y / height) };
    };
    const ops: NodeSetOp[] = [];
    for (const id of doc.attachedTo.get(figure.id) ?? []) {
        const node = doc.nodes.get(id); if (!node) throw new Error('Attached node disappeared');
        if (node.kind === 'connector') {
            for (const side of ['start', 'end'] as const) {
                const end = node[side]; if (!end.attach) continue;
                const anchor = landing(end.attach); if (!anchor) continue;
                ops.push({ t: 'set', id, key: side, value: { ...end, attach: { ...end.attach, anchor } } });
            }
        } else if (node.kind === 'polyline') {
            const line = node as Readonly<PolylineNode> & { readonly startAttach?: Attachment | null; readonly endAttach?: Attachment | null };
            for (const key of ['startAttach', 'endAttach'] as const) {
                const value = line[key]; if (!value) continue;
                const anchor = landing(value); if (!anchor) continue;
                ops.push({ t: 'set', id, key, value: { ...value, anchor } } as unknown as NodeSetOp);
            }
        } else throw new Error('Invalid attachment index entry');
    }
    return ops;
}

function clamp01(value: number): number { return Math.min(1, Math.max(0, value)); }

/** Even-odd containment against the closed pieces, with the same flattened outline the snapping uses. */
function insideClosed(point: Vec2, pieces: readonly OutlinePolyline[]): boolean {
    let inside = false;
    for (const piece of pieces) {
        if (!piece.closed) continue;
        const n = piece.points.length;
        for (let i = 0, j = n - 1; i < n; j = i++) {
            const a = piece.points[i]!, b = piece.points[j]!;
            if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
        }
    }
    return inside;
}

export function incidentEnds(doc: Readonly<BoardDoc>, target: NodeId): readonly IncidentEnd[] {
    const ends: IncidentEnd[] = [];
    for (const id of doc.attachedTo.get(target) ?? []) {
        const node = doc.nodes.get(id);
        if (!node) throw new Error('Invalid connector attachment index');
        if (node.kind === 'polyline') {
            const line = node as Readonly<PolylineNode> & { readonly startAttach?: Attachment | null; readonly endAttach?: Attachment | null };
            if (line.startAttach?.target !== target && line.endAttach?.target !== target) throw new Error('Stale polyline attachment index');
            continue;
        }
        if (node.kind !== 'connector') throw new Error('Invalid connector attachment index');
        if (node.start.attach?.target === target) ends.push({ connector: id, terminal: 'start' });
        if (node.end.attach?.target === target) ends.push({ connector: id, terminal: 'end' });
        if (node.start.attach?.target !== target && node.end.attach?.target !== target) throw new Error('Stale connector attachment index');
    }
    return ends;
}

