import { isLocked } from '../change/commands';
import { worldPose } from '../change/coordinates';
import type { BoardRuntime } from '../host/runtime';
import type { BoardDoc } from '../model/doc';
import type { NodeId, ParentId, SheetId } from '../model/ids';
import type { StickyNode } from '../model/nodes';
import type { SpatialRef } from '../pick';
import { selectableAtFocus } from '../selection';
import { boardFrameAncestors } from './ancestorFrames';
import { pointInTransformedFrame } from './frameContainment';
import type { Vec2 } from './path';

export interface StickyCentre extends Vec2 { readonly rotation: number }
export function stickyWorldCentre(doc: BoardDoc, node: Readonly<StickyNode>): StickyCentre {
    const pose = worldPose(doc, node.id), c = Math.cos(pose.rotation), s = Math.sin(pose.rotation);
    const x = 100 * node.scale, y = (100 + node.growY / 2) * node.scale;
    const result = { x: pose.x + c * x - s * y, y: pose.y + s * x + c * y, rotation: pose.rotation };
    if (![result.x, result.y, result.rotation].every(Number.isFinite)) throw new RangeError('Sticky centre overflows');
    return result;
}
function visibleCentre(doc: BoardDoc, node: Readonly<StickyNode>, point: Vec2): boolean {
    for (const frame of boardFrameAncestors(doc, node)) {
        const pose = worldPose(doc, frame.id), c = Math.cos(pose.rotation), s = Math.sin(pose.rotation);
        if (!pointInTransformedFrame(point, { x: 0, y: 0, width: frame.w, height: frame.h }, [c, s, -s, c, pose.x, pose.y])) return false;
    }
    return true;
}

/** Directional reuse reads one complete Scene revision and never promotes a
 * hidden child, a locked note or a candidate in a different container. */
export async function findStickyNeighbour(options: {
    readonly runtime: BoardRuntime; readonly doc: BoardDoc; readonly source: Readonly<StickyNode>; readonly target: StickyCentre;
    readonly sheet: SheetId; readonly focus: ParentId; readonly radius: number; readonly signal: AbortSignal;
    readonly current: () => boolean; readonly cooperate?: () => Promise<void>;
}): Promise<NodeId | null> {
    const { runtime, doc, source, target, signal } = options, revision = doc.rev, scene = runtime.scene;
    const cooperate = options.cooperate ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
    if (!scene?.ready || scene.revision !== revision) throw new Error('Scene is not ready for sticky neighbour lookup');
    if (![target.x, target.y, target.rotation, options.radius].every(Number.isFinite) || options.radius < 0) throw new RangeError('Invalid sticky neighbour lookup');
    const box: [number, number, number, number] = [target.x - options.radius, target.y - options.radius, target.x + options.radius, target.y + options.radius];
    if (!box.every(Number.isFinite)) throw new RangeError('Sticky neighbour bounds overflow');
    const check = () => {
        signal.throwIfAborted();
        if (!options.current() || runtime.scene !== scene || !scene.ready || scene.revision !== revision || doc.rev !== revision)
            throw new DOMException('Sticky neighbour lookup became stale', 'AbortError');
    };
    const cursor = scene.spatialCursor({ sheetId: options.sheet, purpose: 'selectable', request: { kind: 'box', box, order: 'forward' } });
    let best: { id: NodeId; distance: number; rank: number } | undefined, complete = false, index = 0, work = 0, started = performance.now();
    const refs: SpatialRef[] = [];
    try {
        while (!complete || index < refs.length) {
            check();
            if (index === refs.length && !complete) {
                refs.length = 0; index = 0;
                const state = cursor.resume({ deadline: performance.now() + 3, maxVisits: 128 }, ref => refs.push(ref));
                if (state === 'stale' || state === 'cancelled') throw new DOMException('Sticky neighbour traversal expired', 'AbortError');
                complete = state === 'complete';
            }
            const ref = index < refs.length ? refs[index++] : undefined;
            if (ref) {
                const item = scene.resolveSpatial(ref); if (!item) throw new DOMException('Sticky neighbour candidate expired', 'AbortError');
                const node = doc.nodes.get(item.id); if (!node) throw new DOMException('Sticky neighbour candidate disappeared', 'AbortError');
                if (node.id !== source.id && node.kind === 'sticky' && node.parent === source.parent && node.scale === source.scale
                    && !isLocked(doc, node) && selectableAtFocus(doc, node.id, options.focus, options.sheet) === node.id) {
                    const position = stickyWorldCentre(doc, node), turns = (position.rotation - target.rotation) / (2 * Math.PI);
                    const rotationMatches = Number.isFinite(turns) && Math.abs(turns - Math.round(turns)) <= 8 * Number.EPSILON * Math.max(1, Math.abs(turns));
                    const distance = Math.hypot(position.x - target.x, position.y - target.y);
                    if (rotationMatches && Number.isFinite(distance) && distance <= options.radius && visibleCentre(doc, node, position)
                        && (!best || distance < best.distance || (distance === best.distance && (item.rank > best.rank
                            || (item.rank === best.rank && node.id < best.id))))) best = { id: node.id, distance, rank: item.rank };
                }
            }
            if (++work >= 256 || performance.now() - started >= 3 || (!ref && !complete)) {
                await cooperate(); check(); work = 0; started = performance.now();
            }
        }
    } finally { cursor.cancel(); }
    check(); return best?.id ?? null;
}
