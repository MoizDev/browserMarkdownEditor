import type { ViewState } from '../../platform/types';
import { inverse, transformPoint } from '../geom/affine';
import type { Vec2 } from '../geom/path';
import type { InputKind } from '../geom/types';
import type { BoardRuntime } from '../host/runtime';
import type { Attachment } from '../model/nodes';
import type { createBoardPointQuery } from './pointQuery';

export interface BoardAttachmentOptions {
    readonly runtime: BoardRuntime;
    readonly render: { readonly text: { readonly fonts: { readonly epoch: number } } };
    readonly point: Pick<ReturnType<typeof createBoardPointQuery>, 'hitTarget'>;
    readonly camera: () => ViewState;
    readonly current: () => boolean;
}
export interface AttachmentRequest {
    readonly precise?: boolean;
    readonly exact?: boolean;
    readonly snap?: Attachment['snap'];
    readonly input?: InputKind;
}

/** The point service supplies the actual clipped, generation-checked attachment
 * surface, so a group's promoted selection or an AABB is never an attachment. */
export function createBoardAttachmentResolver(options: BoardAttachmentOptions): {
    resolve(point: Vec2, signal: AbortSignal, request?: AttachmentRequest): Promise<Attachment | null>;
} {
    return {
        async resolve(point, signal, request = {}) {
            signal.throwIfAborted();
            if (!Number.isFinite(point.x) || !Number.isFinite(point.y)
                || (request.precise !== undefined && typeof request.precise !== 'boolean')
                || (request.exact !== undefined && typeof request.exact !== 'boolean')) throw new TypeError('Invalid attachment request');
            const snap = request.snap ?? 'edge', input = request.input ?? 'mouse';
            if (!['none', 'center', 'edge-point', 'edge'].includes(snap) || !['mouse', 'pen', 'touch'].includes(input)) {
                throw new TypeError('Invalid attachment snap or input');
            }
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
            const hit = await options.point.hitTarget(point, input, signal);
            check();
            if (!runtime.scene?.ready || runtime.scene.revision !== revision) throw new DOMException('Attachment scene became stale', 'AbortError');
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
            const precise = request.precise ?? false, exact = request.exact ?? false;
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
            const anchor = precise || exact
                ? { x: coordinate(local.x, box.x, box.width), y: coordinate(local.y, box.y, box.height) }
                : { x: 0.5, y: 0.5 };
            check();
            return { target: hit.id, anchor, exact, precise, snap };
        },
    };
}
