import type { Affine } from '../../platform/types';
import type { BoardDoc } from '../model/doc';
import type { NodeId, SheetId } from '../model/ids';
import type { SpatialCursor, SpatialRef } from '../pick';
import { BoundsQuality } from './bounds';
import type { Box } from './bounds';
import type { BootstrappedScene } from './bootstrap';
import { QueryBuffer, SpatialQuery } from './query';
import type { NearestVisitor, SpatialQuerySource } from './query';
import type { SceneBounds, SceneQueryOptions } from './types';

/** Read-side adapter over one completely published scene revision. The owner swaps the whole
 * publication only after spatial bounds, order and geometry all correspond to that revision. */
export class LiveSceneView {
    private epochValue = 0;
    constructor(private readonly doc: BoardDoc, private scene: BootstrappedScene) {}
    get revision(): number { return this.scene.revision; }
    get byteLength(): number { return this.scene.index.byteLength + this.scene.columns.byteLength + this.scene.order.byteLength; }
    replace(next: BootstrappedScene): void {
        if (next.revision !== this.doc.rev) throw new Error('Cannot publish stale scene');
        this.scene = next; this.epochValue++;
    }
    private check(): void {
        if (this.scene.revision !== this.doc.rev) throw new Error('Scene revision is not yet published');
    }
    worldBounds(id: NodeId): SceneBounds | null {
        this.check();
        const slot = this.scene.slots.get(id);
        if (slot === undefined || !this.scene.index.alive(slot)) return null;
        const col = this.scene.columns, quality = col.quality[slot] as BoundsQuality;
        if (this.scene.unbounded.has(slot) || quality === BoundsQuality.Pending) return { revision: this.revision, quality, ink: null, selectable: null };
        const box = (data: Float64Array): Box => [data[4 * slot], data[4 * slot + 1], data[4 * slot + 2], data[4 * slot + 3]];
        return { revision: this.revision, quality, ink: box(col.ink), selectable: box(col.hit) };
    }
    query(options: SceneQueryOptions, output?: QueryBuffer, visitor?: NearestVisitor): SpatialQuery {
        this.check();
        const scene = this.scene, sheet = scene.sheets.get(options.sheetId), epoch = this.epochValue, doc = this.doc;
        const source: SpatialQuerySource = {
            index: scene.index,
            unbounded: scene.unbounded,
            epoch: () => scene === this.scene && scene.revision === doc.rev ? this.epochValue : epoch + 1,
            accepts: slot => sheet !== undefined && scene.columns.sheet[slot] === sheet && (options.includeLocked || !scene.columns.locked[slot]),
            bounds: (slot, out) => {
                const data = options.purpose === 'ink' ? scene.columns.ink : scene.columns.hit;
                for (let i = 0; i < 4; i++) out[i] = data[4 * slot + i];
                return true;
            },
            rank: slot => scene.order.rank(slot),
        };
        return new SpatialQuery(output).begin(source, options.request, visitor);
    }
    spatialCursor(options: SceneQueryOptions): SpatialCursor {
        const scene = this.scene, query = this.query(options), epoch = this.epochValue, indexEpoch = scene.index.epoch;
        let position = 0, stale = false;
        const current = () => scene === this.scene && scene.revision === this.doc.rev && this.epochValue === epoch && scene.index.epoch === indexEpoch;
        return {
            resume: (budget, visit) => {
                if (!Number.isSafeInteger(budget.maxVisits) || budget.maxVisits <= 0 || !Number.isFinite(budget.deadline)) throw new RangeError('Invalid cursor budget');
                if (stale) return 'stale';
                let remaining = budget.maxVisits;
                while (remaining > 0 && performance.now() < budget.deadline) {
                    if (!current()) { stale = true; query.cancel(); return 'stale'; }
                    if (query.status === 'stale' || query.status === 'cancelled') return query.status;
                    // Unordered results may stream as discovered; ordered requests must finish
                    // their sort before exposure so progressive erasing never changes z semantics.
                    const output = query.output;
                    if (position < output.length && (!options.request.order || query.status === 'complete')) {
                        const slot = output.slots[position], generation = output.generations[position++];
                        if (!scene.index.alive(slot) || scene.index.generation(slot) !== generation) { stale = true; query.cancel(); return 'stale'; }
                        const i = slot * 6, world = scene.columns.world;
                        const matrix: Affine = [world[i], world[i + 1], world[i + 2], world[i + 3], world[i + 4], world[i + 5]];
                        const ref: SpatialRef = { slot, generation, localToWorld: matrix }; visit(ref);
                        if (!current()) { stale = true; query.cancel(); return 'stale'; }
                        remaining--;
                    } else if (query.status === 'complete') return 'complete';
                    else { query.step(1); remaining--; }
                }
                return query.status === 'complete' && position === query.output.length ? 'complete' : 'pending';
            },
            cancel: () => query.cancel(),
        };
    }
    id(slot: number, generation: number): NodeId | undefined {
        this.check();
        return this.scene.index.alive(slot) && this.scene.index.generation(slot) === generation ? this.scene.ids[slot] : undefined;
    }
    sheetSize(sheet: SheetId): number {
        this.check();
        const id = this.scene.sheets.get(sheet);
        return id === undefined ? 0 : this.scene.order.size(id);
    }
}
