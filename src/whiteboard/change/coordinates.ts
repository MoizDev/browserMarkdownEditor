import { pageAt, type PageStack } from '../../platform/render/pageStack';
import { boardPageStack, pageOrigin as modelPageOrigin } from '../model/pages';
import { isSheetParent, type BoardDoc } from '../model/doc';
import type { ParentId } from '../model/ids';
import type { ConnectorNode, Node, Point } from '../model/nodes';
import { ApplyFailed, refuseChange } from './errors';

// Geometry queries must read the STAGED values, not cache solely by doc.rev:
// rev does not change between a builder's pushes. Hidden sessions need these
// semantic queries too; neither requires tessellation, a view, or painted pixels.
export interface ChangeGeometry {
    resolvedTip(doc: BoardDoc, connector: ConnectorNode, terminal: 'start' | 'end'): Point; // World, last painted tip including clipping/gap.
    worldBoundsCenter(doc: BoardDoc, node: Node): Point; // Unclipped geometric world bounds.
}
export interface WorldPose extends Point { readonly rotation: number }
export interface LocalPose extends WorldPose { readonly page: number }
const ZERO: WorldPose = { x: 0, y: 0, rotation: 0 };
function layout(doc: BoardDoc): Readonly<PageStack> {
    const stack = boardPageStack(doc.host);
    if (!stack?.rects.length) refuseChange('V-7', 'A paged board needs page geometry');
    return stack;
}
export function pageOrigin(doc: BoardDoc, page: number): Point {
    if (doc.kind === 'whiteboard') return ZERO;
    if (!Number.isSafeInteger(page) || page < 0) refuseChange('V-7', 'A paged root requires a page index');
    const rect = modelPageOrigin(layout(doc), page);
    if (!rect) refuseChange('V-7', 'Page geometry is unavailable');
    return { x: rect.x, y: rect.y };
}
export function normalizedRotation(angle: number): number {
    const turn = Math.PI * 2;
    const value = angle % turn;
    return value < 0 ? value + turn : value === 0 ? 0 : value;
}
export function worldPose(doc: BoardDoc, id: ParentId): WorldPose {
    const chain: Node[] = [];
    let current = id;
    for (let depth = 0; ; depth++) {
        if (isSheetParent(doc, current)) break;
        if (depth >= 64) refuseChange('V-2', 'Parent chain exceeds 64 links', id);
        const node = doc.nodes.get(current);
        if (!node) refuseChange('V-2', 'Parent transform is missing', id);
        chain.push(node);
        current = node.parent;
    }
    if (!chain.length) return ZERO;
    const origin = pageOrigin(doc, chain[chain.length - 1].page);
    let x = origin.x, y = origin.y, rotation = 0;
    for (let i = chain.length - 1; i >= 0; i--) {
        const node = chain[i], c = Math.cos(rotation), s = Math.sin(rotation);
        x += c * node.x - s * node.y;
        y += s * node.x + c * node.y;
        rotation += node.rotation;
    }
    return { x, y, rotation: normalizedRotation(rotation) };
}
export function worldToLocal(doc: BoardDoc, node: Node, point: Point): Point {
    const pose = worldPose(doc, node.id), dx = point.x - pose.x, dy = point.y - pose.y;
    const c = Math.cos(pose.rotation), s = Math.sin(pose.rotation);
    return { x: c * dx + s * dy, y: -s * dx + c * dy };
}
export function requireGeometry(geometry: ChangeGeometry | undefined): ChangeGeometry {
    if (!geometry) throw new ApplyFailed('geometry-required', 'This change requires the session geometry reader');
    return geometry;
}
export function finitePoint(point: Point): Point {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new ApplyFailed('geometry', 'Geometry returned a non-finite point');
    return { x: point.x, y: point.y };
}
export function poseInParent(doc: BoardDoc, node: Node, parent: ParentId, pose: WorldPose, geometry?: ChangeGeometry): LocalPose {
    if (isSheetParent(doc, parent)) {
        const page = doc.kind === 'whiteboard' ? -1
            : pageAt(layout(doc), finitePoint(requireGeometry(geometry).worldBoundsCenter(doc, node)).y);
        const origin = pageOrigin(doc, page);
        return { x: pose.x - origin.x, y: pose.y - origin.y, rotation: pose.rotation, page };
    }
    const container = worldPose(doc, parent), dx = pose.x - container.x, dy = pose.y - container.y;
    const c = Math.cos(container.rotation), s = Math.sin(container.rotation);
    return { x: c * dx + s * dy, y: -s * dx + c * dy, rotation: normalizedRotation(pose.rotation - container.rotation), page: -1 };
}
