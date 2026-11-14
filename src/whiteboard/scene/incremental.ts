import { childrenOf, type BoardDoc } from '../model/doc';
import type { NodeId, ParentId, SheetId } from '../model/ids';
import { compareOrder } from '../model/orderKey';
import { boardPageStack, pageOrigin } from '../model/pages';
import { BoundsQuality, localBounds, multiplyAffine, placement, transformBox, unionBox, type BoundsProvider } from './bounds';
import type { SceneBounds } from './types';
import type { BootstrappedScene } from './bootstrap';
import { SceneDirtyFlag as Flag, type SceneDirty } from './dirty';

const PLACEMENT = Flag.Placement | Flag.Inherited | Flag.Structure;
const GEOMETRY = Flag.Geometry | Flag.Text | Flag.Structure;
const BOUNDS = GEOMETRY | Flag.Bounds | Flag.Placement | Flag.Inherited;
export class StaleSceneUpdate extends Error {
    constructor() { super('The document changed during scene publication'); }
}

function* sort<T>(values: T[], compare: (a: T, b: T) => number): Generator<void> {
    let source = values, target = new Array<T>(values.length), steps = 0;
    for (let width = 1; width < values.length; width *= 2) {
        for (let start = 0; start < values.length; start += width * 2) {
            const middle = Math.min(start + width, values.length), end = Math.min(start + width * 2, values.length);
            let a = start, b = middle;
            for (let i = start; i < end; i++) {
                target[i] = b >= end || (a < middle && compare(source[a], source[b]) <= 0) ? source[a++] : source[b++];
                if ((++steps & 255) === 0) yield;
            }
        }
        [source, target] = [target, source];
    }
    if (source !== values) for (let i = 0; i < values.length; i++) { values[i] = source[i]; if ((++steps & 255) === 0) yield; }
}

/** Mutable work is private until the returned revision is published. The owner
 * must keep all dirty flags if a later document edit interrupts this generator:
 * an interrupted order splice is completed before starting the newer revision. */
export interface SceneUpdateResult extends BootstrappedScene { readonly boundsChanges: ReadonlyMap<NodeId, SceneBounds | null> }
export function* updateScene(doc: BoardDoc, state: BootstrappedScene, dirty: SceneDirty, provider: BoundsProvider,
    zoom = 1): Generator<void, SceneUpdateResult> {
    const revision = doc.rev, slots = state.slots as Map<NodeId, number>, ids = state.ids as NodeId[];
    const sheets = state.sheets as Map<SheetId, number>, unbounded = state.unbounded as Set<number>;
    const { columns: col, index, order } = state;
    const boundsChanges = new Map<NodeId, SceneBounds | null>();
    const captureBounds = (id: NodeId, slot: number) => {
        const quality = col.quality[slot] as BoundsQuality;
        const pending = unbounded.has(slot) || quality === BoundsQuality.Pending || quality === BoundsQuality.ColdLayout;
        const copy = (values: Float64Array): readonly [number, number, number, number] =>
            [values[slot * 4], values[slot * 4 + 1], values[slot * 4 + 2], values[slot * 4 + 3]];
        boundsChanges.set(id, { revision, quality, ink: pending ? null : copy(col.ink), selectable: pending ? null : copy(col.hit) });
    };
    const flags = new Map<NodeId, number>(), aggregate = new Set<NodeId>(), queue: NodeId[] = [];
    let work = 0;
    const add = (id: NodeId, bits: number) => {
        const before = flags.get(id) ?? 0;
        if ((before | bits) !== before) { flags.set(id, before | bits); queue.push(id); }
    };
    const ancestors = (id: NodeId) => {
        let slot = slots.get(id);
        for (let depth = 0; slot !== undefined && depth <= 64; depth++) {
            const parent = col.parent[slot];
            if (parent < 0) break;
            aggregate.add(ids[parent]); slot = parent;
        }
        let parent: ParentId | undefined = doc.nodes.get(id)?.parent;
        for (let depth = 0; parent && depth <= 64; depth++) {
            const node = doc.nodes.get(parent as NodeId);
            if (!node) break;
            aggregate.add(node.id); parent = node.parent;
        }
    };
    for (const [id, bits] of dirty.nodes) { add(id, bits); ancestors(id); if ((++work & 255) === 0) yield; }
    if (dirty.pages) for (const sheet of doc.sheetOrder) for (const root of childrenOf(doc, sheet.id)) {
        add(root.id, Flag.Placement | Flag.Bounds); if ((++work & 255) === 0) yield;
    }
    for (let cursor = 0; cursor < queue.length; cursor++) {
        const id = queue[cursor], bits = flags.get(id)!;
        if (bits & PLACEMENT) for (const child of childrenOf(doc, id)) {
            add(child.id, (bits & (Flag.Placement | Flag.Inherited))
                | (bits & Flag.Structure ? Flag.Placement | Flag.Inherited : 0) | Flag.Bounds | Flag.Paint);
            if ((++work & 255) === 0) yield;
        }
        if (bits & BOUNDS) ancestors(id);
        if ((++work & 255) === 0) yield;
    }
    // Existing sheet numbers never change when a sheet's order changes. Spatial
    // columns refer to stable numbers, not the sheetOrder array's current index.
    let nextSheet = 0;
    for (const value of sheets.values()) { nextSheet = Math.max(nextSheet, value + 1); if ((++work & 255) === 0) yield; }
    for (const sheet of doc.sheetOrder) if (!sheets.has(sheet.id)) sheets.set(sheet.id, nextSheet++);
    const paths = new Map<NodeId, readonly Readonly<{ id: string; order: string }>[] >();
    const path = (id: NodeId) => {
        const found = paths.get(id);
        if (found) return found;
        const result: Readonly<{ id: string; order: string }>[] = [];
        let node = doc.nodes.get(id);
        for (let depth = 0; node && depth <= 64; depth++) {
            result.push(node); node = doc.nodes.get(node.parent as NodeId);
        }
        const root = result[result.length - 1];
        const rootNode = root ? doc.nodes.get(root.id as NodeId) : undefined;
        const sheet = rootNode ? doc.sheets.get(rootNode.parent as SheetId) : undefined;
        if (sheet) result.push(sheet);
        result.reverse(); paths.set(id, result);
        return result;
    };
    const changed: NodeId[] = [];
    for (const id of flags.keys()) {
        const node = doc.nodes.get(id), slot = slots.get(id);
        if (!node) {
            if (slot !== undefined) {
                if (order.has(slot)) yield* order.spliceSteps(order.sheet(slot), order.rank(slot), 1, []);
                let parent = col.parent[slot];
                for (let depth = 0; parent >= 0 && depth <= 64; depth++) { col.count[parent]--; parent = col.parent[parent]; }
                index.release(slot); unbounded.delete(slot); slots.delete(id); boundsChanges.set(id, null);
            }
        } else changed.push(id);
        if ((++work & 255) === 0) yield;
    }
    yield* sort(changed, (a, b) => {
        const left = path(a), right = path(b), length = Math.min(left.length, right.length);
        for (let i = 0; i < length; i++) {
            if (left[i].id !== right[i].id) return compareOrder(left[i], right[i]);
        }
        return left.length - right.length;
    });
    const local = new Float64Array(6), box = new Float64Array(4), stack = boardPageStack(doc.host);
    for (const id of changed) {
        const node = doc.nodes.get(id)!, bits = flags.get(id)!;
        let slot = slots.get(id), fresh = false;
        if (slot === undefined) {
            slot = index.allocate(); col.reserve(slot + 1); slots.set(id, slot); ids[slot] = id;
            col.count[slot] = 1; col.geometry[slot] = col.paint[slot] = 0; fresh = true;
        }
        const parent = slots.get(node.parent as NodeId), root = doc.sheets.has(node.parent as SheetId);
        if (!root && parent === undefined) throw new Error('Scene parent was not realized before its child');
        const parentSlot = root ? -1 : parent!, sheet = root ? sheets.get(node.parent as SheetId)! : col.sheet[parentSlot];
        const previousParent = fresh ? -1 : col.parent[slot];
        if (fresh || bits & PLACEMENT) {
            col.parent[slot] = parentSlot; col.sheet[slot] = sheet;
            col.page[slot] = root ? node.page : col.page[parentSlot];
            const origin = root && stack && node.page >= 0 ? pageOrigin(stack, node.page) : undefined;
            placement(local, 0, node, origin?.x ?? 0, origin?.y ?? 0);
            if (root) col.world.set(local, slot * 6);
            else multiplyAffine(col.world, slot * 6, col.world, parentSlot * 6, local, 0);
            col.opacity[slot] = node.opacity * (root ? 1 : col.opacity[parentSlot]);
            col.locked[slot] = Number(node.locked || (!root && !!col.locked[parentSlot]));
            col.clip[slot] = root ? -1 : doc.nodes.get(ids[parentSlot])?.kind === 'frame' ? parentSlot : col.clip[parentSlot];
        }
        if (fresh || bits & GEOMETRY) col.geometry[slot]++;
        if (fresh || bits & Flag.Paint) col.paint[slot]++;
        col.nodeRevision[slot] = revision;
        if (fresh || bits & (Flag.Order | Flag.Structure)) {
            // Previous sibling's subtree end is the insertion anchor. Binary
            // lookup avoids scanning a million unaffected siblings for one move.
            const siblings = childrenOf(doc, node.parent);
            let lo = 0, hi = siblings.length;
            while (lo < hi) { const mid = (lo + hi) >>> 1; if (compareOrder(siblings[mid], node) < 0) lo = mid + 1; else hi = mid; }
            const previous = lo > 0 ? slots.get(siblings[lo - 1].id) : undefined;
            const to = previous !== undefined && order.has(previous) && order.sheet(previous) === sheet
                ? order.rank(previous) + col.count[previous] : root ? 0 : order.rank(parentSlot) + 1;
            if (order.has(slot)) {
                const fromSheet = order.sheet(slot), from = order.rank(slot), count = col.count[slot];
                if (fromSheet !== sheet || (to !== from && to !== from + count)) yield* order.moveSteps(fromSheet, from, count, sheet, to);
            } else yield* order.spliceSteps(sheet, to, 0, [slot]);
            if (fresh || previousParent !== parentSlot) {
                const count = col.count[slot];
                for (const [first, delta] of [[previousParent, fresh ? 0 : -count], [parentSlot, count]]) {
                    let ancestor = first;
                    for (let depth = 0; ancestor >= 0 && depth <= 64; depth++) { col.count[ancestor] += delta; ancestor = col.parent[ancestor]; }
                }
            }
        }
        if (fresh || bits & BOUNDS) {
            const quality = localBounds(node, provider, box); col.quality[slot] = quality;
            if (node.kind === 'group' || quality === BoundsQuality.Pending || quality === BoundsQuality.ColdLayout) {
                index.removeBounds(slot); unbounded.add(slot);
            } else {
                transformBox(col.hit, slot * 4, box, 0, col.world, slot * 6);
                const exact = provider.local(node);
                if (exact) transformBox(col.ink, slot * 4, exact.ink, 0, col.world, slot * 6);
                else for (let k = 0; k < 4; k++) col.ink[slot * 4 + k] = col.hit[slot * 4 + k];
                unbounded.delete(slot); index.upsert(slot, col.hit.subarray(slot * 4, slot * 4 + 4), zoom);
            }
        }
        captureBounds(id, slot);
        if (childrenOf(doc, id).length || node.kind === 'group') aggregate.add(id);
        if ((++work & 127) === 0) yield;
    }
    const aggregates = [...aggregate];
    yield* sort(aggregates, (a, b) => path(b).length - path(a).length);
    for (const id of aggregates) {
        const slot = slots.get(id), node = doc.nodes.get(id);
        if (slot === undefined || !node) continue;
        let count = 1, bounded = false, unknown = false, quality = BoundsQuality.Exact;
        for (const child of childrenOf(doc, id)) {
            const childSlot = slots.get(child.id);
            if (childSlot === undefined) throw new Error('Scene child is missing');
            count += col.count[childSlot];
            if (node.kind === 'group') {
                if (unbounded.has(childSlot) || col.quality[childSlot] === BoundsQuality.Pending) unknown = true;
                else {
                    if (!bounded) for (let k = 0; k < 4; k++) { col.ink[slot * 4 + k] = col.ink[childSlot * 4 + k]; col.hit[slot * 4 + k] = col.hit[childSlot * 4 + k]; }
                    else { unionBox(col.ink, slot * 4, col.ink, slot * 4, col.ink, childSlot * 4); unionBox(col.hit, slot * 4, col.hit, slot * 4, col.hit, childSlot * 4); }
                    quality = Math.min(quality, col.quality[childSlot]); bounded = true;
                }
            }
            if ((++work & 255) === 0) yield;
        }
        col.count[slot] = count;
        if (node.kind === 'group') {
            if (unknown || !bounded) { col.quality[slot] = BoundsQuality.Pending; unbounded.add(slot); index.removeBounds(slot); }
            else { col.quality[slot] = quality; unbounded.delete(slot); index.upsert(slot, col.hit.subarray(slot * 4, slot * 4 + 4), zoom); }
        }
        captureBounds(id, slot);
        if ((++work & 255) === 0) yield;
    }
    if (doc.rev !== revision) throw new StaleSceneUpdate();
    return { ...state, revision, boundsChanges };
}
