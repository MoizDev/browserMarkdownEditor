import { childrenOf, type BoardDoc } from '../model/doc';
import type { NodeId, ParentId, SheetId } from '../model/ids';
import type { Node } from '../model/nodes';
import { boardPageStack, pageOrigin } from '../model/pages';
import { BoundsQuality, localBounds, multiplyAffine, placement, transformBox, unionBox } from './bounds';
import type { BoundsProvider } from './bounds';
import { SceneColumns } from './columns';
import { HybridIndex, PackedBuildJob, PackedTree } from './index';
import type { PackedSnapshot } from './index';
import { PAINT_ORDER_CHUNK, PaintOrder } from './order';

export interface BootstrappedScene {
    readonly revision: number;
    readonly index: HybridIndex;
    readonly order: PaintOrder;
    readonly columns: SceneColumns;
    readonly slots: ReadonlyMap<NodeId, number>;
    readonly ids: readonly NodeId[];
    readonly sheets: ReadonlyMap<SheetId, number>;
    readonly unbounded: ReadonlySet<number>;
}
type Frame = { children: readonly Node[]; next: number; parent: number; sheet: number };

/** A private, revision-pinned build. No partially constructed index is exposed; if the live
 * document changes, discard and restart rather than combining two model revisions. */
export class SceneBootstrapJob {
    private readonly revision: number;
    private readonly columns = new SceneColumns();
    private readonly index = new HybridIndex();
    private readonly order = new PaintOrder();
    private readonly slots = new Map<NodeId, number>();
    private readonly ids: NodeId[] = [];
    private readonly sheets = new Map<SheetId, number>();
    private readonly unbounded = new Set<number>();
    private readonly local = new Float64Array(6);
    private readonly box = new Float64Array(4);
    private readonly children: Frame[] = [];
    private readonly buffer = new Uint32Array(PAINT_ORDER_CHUNK);
    private buffered = 0;
    private sheet = 0;
    private cursor = 0;
    private bounded = 0;
    private phase: 'walk' | 'aggregate' | 'snapshot' | 'pack' | 'complete' | 'cancelled' | 'stale' = 'walk';
    private packed: PackedSnapshot | undefined;
    private builder: PackedBuildJob | undefined;
    private resultValue: BootstrappedScene | undefined;
    constructor(private readonly doc: BoardDoc, private readonly provider: BoundsProvider) { this.revision = doc.rev; }
    get result(): BootstrappedScene {
        if (!this.resultValue) throw new Error('Scene bootstrap is not complete');
        return this.resultValue;
    }
    cancel(): void { if (this.phase !== 'complete') { this.phase = 'cancelled'; this.builder?.cancel(); } }
    private flush(): void {
        if (this.buffered) { this.order.appendBootstrap(this.sheet, this.buffer, 0, this.buffered); this.buffered = 0; }
    }
    private add(node: Readonly<Node>, parent: number, sheet: number): void {
        const slot = this.index.allocate(), col = this.columns;
        col.reserve(slot + 1); this.slots.set(node.id, slot); this.ids[slot] = node.id;
        col.parent[slot] = parent; col.sheet[slot] = sheet; col.count[slot] = 1;
        col.geometry[slot] = col.paint[slot] = 1; col.nodeRevision[slot] = this.revision;
        const root = parent < 0, stack = boardPageStack(this.doc.host);
        const page = root ? node.page : col.page[parent]; col.page[slot] = page;
        const origin = root && stack && page >= 0 ? pageOrigin(stack, page) : undefined;
        placement(this.local, 0, node, origin?.x ?? 0, origin?.y ?? 0);
        if (root) col.world.set(this.local, 6 * slot);
        else multiplyAffine(col.world, 6 * slot, col.world, 6 * parent, this.local, 0);
        col.opacity[slot] = node.opacity * (root ? 1 : col.opacity[parent]);
        col.locked[slot] = Number(node.locked || (!root && !!col.locked[parent]));
        col.clip[slot] = root ? -1 : this.doc.nodes.get(this.ids[parent])?.kind === 'frame' ? parent : col.clip[parent];
        const quality = localBounds(node, this.provider, this.box); col.quality[slot] = quality;
        if (quality === BoundsQuality.Exact || quality === BoundsQuality.Conservative) {
            transformBox(col.hit, 4 * slot, this.box, 0, col.world, 6 * slot);
            const exact = this.provider.local(node);
            if (exact) transformBox(col.ink, 4 * slot, exact.ink, 0, col.world, 6 * slot);
            else for (let k = 0; k < 4; k++) col.ink[4 * slot + k] = col.hit[4 * slot + k];
        } else if (node.kind !== 'group') this.unbounded.add(slot);
        this.buffer[this.buffered++] = slot;
        if (this.buffered === this.buffer.length) this.flush();
    }
    step(maxWork: number): 'pending' | 'complete' | 'stale' | 'cancelled' {
        if (this.phase === 'complete' || this.phase === 'stale' || this.phase === 'cancelled') return this.phase;
        if (!Number.isSafeInteger(maxWork) || maxWork <= 0) throw new RangeError('Invalid scene bootstrap slice');
        if (this.doc.rev !== this.revision) { this.builder?.cancel(); this.phase = 'stale'; return 'stale'; }
        for (let work = 0; work < maxWork; work++) {
            if (this.doc.rev !== this.revision) { this.builder?.cancel(); this.phase = 'stale'; return 'stale'; }
            if (this.phase === 'walk') {
                if (!this.children.length) {
                    if (this.sheet === this.doc.sheetOrder.length) { this.cursor = this.ids.length; this.phase = 'aggregate'; continue; }
                    const sheet = this.doc.sheetOrder[this.sheet]; this.sheets.set(sheet.id, this.sheet);
                    this.children.push({ children: childrenOf(this.doc, sheet.id as ParentId), next: 0, parent: -1, sheet: this.sheet });
                }
                const frame = this.children[this.children.length - 1];
                if (frame.next === frame.children.length) {
                    this.children.pop();
                    if (!this.children.length) { this.flush(); this.order.sealBootstrap(this.sheet++); }
                    continue;
                }
                const node = frame.children[frame.next++]; this.add(node, frame.parent, frame.sheet);
                const children = childrenOf(this.doc, node.id);
                if (children.length) this.children.push({ children, next: 0, parent: this.slots.get(node.id)!, sheet: frame.sheet });
            } else if (this.phase === 'aggregate') {
                if (!this.cursor) {
                    const n = this.bounded;
                    this.packed = { slots: new Uint32Array(n), generations: new Uint32Array(n), versions: new Uint32Array(n), bounds: new Float64Array(4 * n), revision: 0 };
                    this.cursor = 0; this.bounded = 0; this.phase = 'snapshot'; continue;
                }
                const slot = --this.cursor, parent = this.columns.parent[slot], node = this.doc.nodes.get(this.ids[slot])!;
                if (parent >= 0) {
                    this.columns.count[parent] += this.columns.count[slot];
                    const parentNode = this.doc.nodes.get(this.ids[parent]);
                    if (parentNode?.kind === 'group' && this.columns.quality[slot] !== BoundsQuality.Pending && !this.unbounded.has(slot)) {
                        if (this.columns.quality[parent] === BoundsQuality.Pending) {
                            for (let k = 0; k < 4; k++) { this.columns.ink[4 * parent + k] = this.columns.ink[4 * slot + k]; this.columns.hit[4 * parent + k] = this.columns.hit[4 * slot + k]; }
                            this.columns.quality[parent] = this.columns.quality[slot];
                        } else {
                            unionBox(this.columns.ink, 4 * parent, this.columns.ink, 4 * parent, this.columns.ink, 4 * slot);
                            unionBox(this.columns.hit, 4 * parent, this.columns.hit, 4 * parent, this.columns.hit, 4 * slot);
                            this.columns.quality[parent] = Math.min(this.columns.quality[parent], this.columns.quality[slot]);
                        }
                    }
                    if (parentNode?.kind === 'group' && this.unbounded.has(slot)) this.unbounded.add(parent);
                }
                if (node.kind === 'group' && this.columns.quality[slot] === BoundsQuality.Pending) this.unbounded.add(slot);
                if (!this.unbounded.has(slot) && this.columns.quality[slot] !== BoundsQuality.Pending) this.bounded++;
            } else if (this.phase === 'snapshot') {
                if (this.cursor === this.ids.length) {
                    this.packed = { ...this.packed!, revision: this.index.epoch };
                    this.builder = new PackedBuildJob(this.packed); this.phase = 'pack'; continue;
                }
                const slot = this.cursor++;
                if (this.unbounded.has(slot) || this.columns.quality[slot] === BoundsQuality.Pending) continue;
                const i = this.bounded++, data = this.packed!;
                this.index.seedBounds(slot); data.slots[i] = slot; data.generations[i] = this.index.generation(slot); data.versions[i] = this.index.version(slot);
                for (let k = 0; k < 4; k++) data.bounds[4 * i + k] = this.columns.hit[4 * slot + k];
            } else if (this.phase === 'pack') {
                if (this.builder!.step(1) === 'complete') {
                    if (!this.index.publish(PackedTree.fromData(this.builder!.result))) throw new Error('Could not publish initial scene index');
                    this.resultValue = { revision: this.revision, index: this.index, order: this.order, columns: this.columns, slots: this.slots, ids: this.ids, sheets: this.sheets, unbounded: this.unbounded };
                    this.phase = 'complete'; return 'complete';
                }
            }
        }
        return 'pending';
    }
}
