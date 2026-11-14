import type { ExtBag, RawJson } from '../model/json';
import type { MediaId } from '../model/media';
import { scanRawMedia, visitNodeRaw, visitRichTextRaw, type NodeRawCarrier } from '../model/rawMedia';
import type { Block } from '../text/richText';

export interface PreservedDelta {
    readonly counts: ReadonlyMap<MediaId, number>;
    readonly touched: ReadonlySet<MediaId>;
}
const EMPTY: PreservedDelta = { counts: new Map(), touched: new Set() };

// R-W25/R-W37/R-W40: compare retained carriers, not temporary serialized lines.
// Common geometry edits have no raw changes and allocate neither map nor scan.
// Equal raw strings can occur in several carriers: their multiplicities matter,
// but each id contributes at most once per occurrence of a RawJson value.
export class RawChanges {
    private values: Map<RawJson, number> | undefined;
    constructor(private readonly owningMedia?: MediaId) {}

    add(raw: RawJson, change: number): void {
        if (!this.values) this.values = new Map();
        const count = (this.values.get(raw) ?? 0) + change;
        if (count === 0) this.values.delete(raw);
        else this.values.set(raw, count);
    }
    value(before: RawJson | undefined, after: RawJson | undefined): void {
        if (before === after) return;
        if (before !== undefined) this.add(before, -1);
        if (after !== undefined) this.add(after, 1);
    }
    private map(before: ReadonlyMap<string, RawJson> | undefined, after: ReadonlyMap<string, RawJson> | undefined): void {
        if (before === after) return;
        if (before) for (const [key, raw] of before) if (after?.get(key) !== raw) this.add(raw, -1);
        if (after) for (const [key, raw] of after) if (before?.get(key) !== raw) this.add(raw, 1);
    }
    extension(before: ExtBag | null, after: ExtBag | null): void {
        if (before === after) return;
        this.map(before?.fields, after?.fields);
        this.map(before?.raw, after?.raw);
    }
    node(node: NodeRawCarrier, change: 1 | -1): void {
        visitNodeRaw(node, raw => this.add(raw, change));
    }
    rich(before: readonly Block[], after: readonly Block[]): void {
        if (before === after) return;
        visitRichTextRaw({ blocks: before }, raw => this.add(raw, -1));
        visitRichTextRaw({ blocks: after }, raw => this.add(raw, 1));
    }
    finish(): PreservedDelta {
        if (!this.values?.size) return EMPTY;
        const counts = new Map<MediaId, number>();
        const touched = new Set<MediaId>();
        let multiplier = 0;
        const visit = (id: MediaId) => {
            // A media entry's own ext leaves with it (R-W40). Other carriers,
            // including a node that happens to share that string id, still count.
            if (id === this.owningMedia) return;
            touched.add(id);
            const next = (counts.get(id) ?? 0) + multiplier;
            if (next === 0) counts.delete(id);
            else counts.set(id, next);
        };
        for (const [raw, change] of this.values) {
            multiplier = change;
            scanRawMedia(raw, visit);
        }
        this.values = undefined; // Don't retain removed raw strings behind the delta.
        return touched.size ? { counts, touched } : EMPTY;
    }
}
