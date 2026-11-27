interface Entry<Value> { readonly value: Value; readonly weight: number }

export class WeakIdentityLru<Key extends object, Value> {
    private readonly ids = new WeakMap<Key, number>();
    private readonly entries = new Map<number, Entry<Value>>();
    private nextId = 1;
    private currentWeight = 0;

    constructor(readonly maxWeight: number, readonly maxEntries: number) {
        if (!Number.isSafeInteger(maxWeight) || maxWeight < 0 || !Number.isSafeInteger(maxEntries) || maxEntries < 0)
            throw new RangeError('Invalid cache limits');
    }

    get(key: Key): Value | undefined {
        const id = this.ids.get(key), entry = id === undefined ? undefined : this.entries.get(id);
        if (entry === undefined || id === undefined) return undefined;
        this.entries.delete(id); this.entries.set(id, entry);
        return entry.value;
    }

    set(key: Key, value: Value, weight: number): void {
        if (!Number.isSafeInteger(weight) || weight < 0) throw new RangeError('Invalid cache weight');
        let id = this.ids.get(key);
        if (id !== undefined) this.removeId(id);
        if (!this.maxEntries || weight > this.maxWeight) return;
        while (this.entries.size && (this.entries.size >= this.maxEntries || this.currentWeight + weight > this.maxWeight)) {
            this.removeId(this.entries.keys().next().value!);
        }
        if (id === undefined) {
            id = this.nextId++;
            this.ids.set(key, id);
        }
        this.entries.set(id, { value, weight });
        this.currentWeight += weight;
    }

    delete(key: Key): void {
        const id = this.ids.get(key);
        if (id !== undefined) this.removeId(id);
    }

    clear(): void { this.entries.clear(); this.currentWeight = 0; }
    get size(): number { return this.entries.size; }
    get weight(): number { return this.currentWeight; }

    private removeId(id: number): void {
        const previous = this.entries.get(id);
        if (!previous) return;
        this.entries.delete(id);
        this.currentWeight -= previous.weight;
    }
}
