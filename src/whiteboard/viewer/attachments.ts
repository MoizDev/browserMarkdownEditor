import type { Affine, Rect, ViewState } from '../../platform/types';
import { inverse, transformPoint } from '../geom/affine';
import type { Vec2 } from '../geom/path';
import type { InputKind } from '../geom/types';
import type { BoardRuntime } from '../host/runtime';
import type { NodeId } from '../model/ids';
import type { Attachment } from '../model/nodes';
import type { createBoardPointQuery } from './pointQuery';
import { yieldToHost } from '../../platform/yieldToHost';

export interface BoardAttachmentOptions {
    readonly runtime: BoardRuntime;
    readonly render: { readonly text: { readonly fonts: { readonly epoch: number } } };
    readonly point: Pick<ReturnType<typeof createBoardPointQuery>, 'hitTarget'>;
    readonly camera: () => ViewState;
    readonly current: () => boolean;
}
export interface AttachmentRequest {
    readonly precise?: boolean | ((target: NodeId) => boolean);
    readonly exact?: boolean;
    readonly route?: 'arc' | 'elbow';
    readonly input?: InputKind;
}

const ELBOW_SNAP = { centre: 24, edgePoint: 24, axis: 16, edge: 20 } as const;

export function createBoardAttachmentResolver(options: BoardAttachmentOptions): {
    resolve(point: Vec2, signal: AbortSignal, request?: AttachmentRequest): Promise<Attachment | null>;
} {
    return {
        async resolve(point, signal, request = {}) {
            signal.throwIfAborted();
            if (!Number.isFinite(point.x) || !Number.isFinite(point.y)
                || (request.precise !== undefined && typeof request.precise !== 'boolean' && typeof request.precise !== 'function')
                || (request.exact !== undefined && typeof request.exact !== 'boolean')) throw new TypeError('Invalid attachment request');
            const input = request.input ?? 'mouse', route = request.route ?? 'arc';
            if (!['mouse', 'pen', 'touch'].includes(input) || !['arc', 'elbow'].includes(route)) throw new TypeError('Invalid attachment input or route');
            const { runtime } = options, doc = runtime.session.doc, revision = doc.rev, owner = runtime.session.owner;
            const state = runtime.selection.getSnapshot(), view = options.camera(), camera = { ...view.camera }, viewport = { ...view.viewport };
            const epoch = options.render.text.fonts.epoch;
            const check = () => {
                signal.throwIfAborted();
                const now = options.camera(), selection = runtime.selection.getSnapshot();
                if (!options.current() || runtime.session.doc !== doc || doc.rev !== revision || runtime.session.owner !== owner
                    || options.render.text.fonts.epoch !== epoch || selection.sheet !== state.sheet || selection.focus !== state.focus
                    || now.epoch !== view.epoch || now.camera.x !== camera.x || now.camera.y !== camera.y || now.camera.z !== camera.z
                    || now.viewport.width !== viewport.width || now.viewport.height !== viewport.height || now.viewport.dpr !== viewport.dpr) {
                    throw new DOMException('Attachment query became stale', 'AbortError');
                }
            };
            check();
            const scene = runtime.scene ?? await runtime.ready;
            while (!scene.ready) {
                check();
                scene.step(64, performance.now() + 3);
                await yieldToHost();
            }
            check();
            const hit = await options.point.hitTarget(point, input, signal);
            check();
            if (runtime.scene !== scene || !scene.ready || scene.revision !== revision) throw new DOMException('Attachment scene became stale', 'AbortError');
            if (!hit) return null;
            const target = doc.nodes.get(hit.id);
            if (!target || target.kind === 'connector' || target.kind === 'group' || target.kind === 'opaque') {
                throw new DOMException('Attachment target changed', 'AbortError');
            }
            const matrix = inverse(hit.localToWorld, 1e12);
            if (!matrix) throw new Error('Attachment target transform is not invertible');
            const local = transformPoint(matrix, point), box = hit.logicalBox;
            if (![box.x, box.y, box.width, box.height, local.x, local.y].every(Number.isFinite) || box.width < 0 || box.height < 0) {
                throw new Error('Invalid attachment surface');
            }
            const exact = request.exact ?? false;
            const open = target.kind === 'polyline';
            const precise = exact || open || (typeof request.precise === 'function' ? request.precise(hit.id) : request.precise ?? false);
            const coordinate = (value: number, start: number, size: number): number => {
                if (size === 0) {
                    if (exact && value !== start) throw new Error('Exact attachment cannot be represented on a zero-size target');
                    return 0.5;
                }
                const raw = (value - start) / size;
                if (!Number.isFinite(raw)) throw new RangeError('Attachment anchor overflows');
                if (exact && (raw < -1e-12 || raw > 1 + 1e-12)) throw new Error('Exact attachment point is outside the target anchor box');
                return Math.max(0, Math.min(1, raw));
            };
            const raw = { x: coordinate(local.x, box.x, box.width), y: coordinate(local.y, box.y, box.height) };
            const snapped = precise && !exact && (open || route === 'elbow') ? elbowSnap(hit, point, view.camera.z, box) : null;
            const anchor = precise || exact ? snapped?.anchor ?? raw : { x: 0.5, y: 0.5 };
            check();
            return { target: hit.id, anchor, exact, precise, snap: snapped?.snap ?? 'none' };
        },
    };
}

function elbowSnap(hit: { readonly localToWorld: Affine }, point: Vec2, zoom: number, box: Rect): { anchor: Vec2; snap: Attachment['snap'] } | null {
    const scale = zoom > 0 ? zoom : 1, world = (p: Vec2) => transformPoint(hit.localToWorld, p);
    const distance = (p: Vec2, radius: number) => Math.hypot(world(p).x - point.x, world(p).y - point.y) * scale <= radius;
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    const local = inverse(hit.localToWorld, 1e12);
    if (!local) return null;
    const at = transformPoint(local, point);
    const fraction = (p: Vec2) => ({ x: (p.x - box.x) / box.width, y: (p.y - box.y) / box.height });
    const centre = { x: cx, y: cy };
    if (distance(centre, ELBOW_SNAP.centre)) return { anchor: fraction(centre), snap: 'center' };
    const points: Vec2[] = [{ x: cx, y: box.y }, { x: box.x + box.width, y: cy }, { x: cx, y: box.y + box.height }, { x: box.x, y: cy }];
    const nearestPoint = points.find(p => distance(p, ELBOW_SNAP.edgePoint));
    if (nearestPoint) return { anchor: fraction(nearestPoint), snap: 'edge-point' };
    if (Math.abs(at.x - cx) * scale <= ELBOW_SNAP.axis && Math.abs(world({ x: cx, y: at.y }).x - point.x) * scale <= ELBOW_SNAP.axis) {
        return { anchor: fraction({ x: cx, y: Math.max(box.y, Math.min(box.y + box.height, at.y)) }), snap: 'center' };
    }
    if (Math.abs(at.y - cy) * scale <= ELBOW_SNAP.axis && Math.abs(world({ x: at.x, y: cy }).y - point.y) * scale <= ELBOW_SNAP.axis) {
        return { anchor: fraction({ x: Math.max(box.x, Math.min(box.x + box.width, at.x)), y: cy }), snap: 'center' };
    }
    let best: { anchor: Vec2; d: number } | null = null;
    const edges: [Vec2, Vec2][] = [[{ x: box.x, y: box.y }, { x: box.x + box.width, y: box.y }], [{ x: box.x + box.width, y: box.y }, { x: box.x + box.width, y: box.y + box.height }],
        [{ x: box.x + box.width, y: box.y + box.height }, { x: box.x, y: box.y + box.height }], [{ x: box.x, y: box.y + box.height }, { x: box.x, y: box.y }]];
    for (const [a, b] of edges) {
        const dx = b.x - a.x, dy = b.y - a.y, length2 = dx * dx + dy * dy;
        const t = length2 ? Math.max(0, Math.min(1, ((at.x - a.x) * dx + (at.y - a.y) * dy) / length2)) : 0;
        const p = { x: a.x + dx * t, y: a.y + dy * t };
        if (!distance(p, ELBOW_SNAP.edge)) continue;
        const d = Math.hypot(world(p).x - point.x, world(p).y - point.y);
        if (!best || d < best.d) best = { anchor: fraction(p), d };
    }
    return best ? { anchor: best.anchor, snap: 'edge' } : null;
}
