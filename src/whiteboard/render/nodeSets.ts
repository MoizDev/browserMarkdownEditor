const empty: ReadonlySet<string> = new Set();

abstract class NodeSet implements ReadonlySet<string> {
    readonly [Symbol.toStringTag] = 'NodeSet';
    abstract has(id: string): boolean;
    abstract values(): SetIterator<string>;
    get size(): number { let count = 0; for (const _ of this) count++; return count; }
    keys(): SetIterator<string> { return this.values(); }
    *entries(): SetIterator<[string, string]> { for (const id of this) yield [id, id]; }
    [Symbol.iterator](): SetIterator<string> { return this.values(); }
    forEach(fn: (value: string, value2: string, set: ReadonlySet<string>) => void, thisArg?: unknown): void {
        for (const id of this) fn.call(thisArg, id, id, this);
    }
}

export class FilteredInk extends NodeSet {
    constructor(private readonly source: ReadonlySet<string>, private readonly mask: ReadonlySet<string> = empty,
        private readonly include = false) { super(); }
    has(id: string): boolean { return this.source.has(id) && this.mask.has(id) === this.include; }
    *values(): SetIterator<string> {
        for (const id of this.include ? this.mask : this.source) if (this.has(id)) yield id;
    }
}

export class LiveNodeUnion extends NodeSet {
    private readonly sets: readonly ReadonlySet<string>[];
    constructor(...sets: readonly (ReadonlySet<string> | null | undefined)[]) {
        super(); this.sets = sets.filter((set): set is ReadonlySet<string> => !!set);
    }
    has(id: string): boolean { for (const set of this.sets) if (set.has(id)) return true; return false; }
    *values(): SetIterator<string> {
        for (let index = 0; index < this.sets.length; index++) for (const id of this.sets[index]) {
            let duplicate = false;
            for (let earlier = 0; earlier < index; earlier++) if (this.sets[earlier].has(id)) { duplicate = true; break; }
            if (!duplicate) yield id;
        }
    }
}
