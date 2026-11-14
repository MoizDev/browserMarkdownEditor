import { ArenaError } from '../resourceArena';

// Validate maximum accessed bytes before submission (rendering-design.md:243).
// Range validation must not rescan an immutable mesh on every camera frame. Blocks
// bound the endpoint work to 126 indices; interior maxima come from an updated tree.
const BLOCK = 64;
function leaves(elements: number): number {
    return 2 ** Math.ceil(Math.log2(Math.max(1, Math.ceil(elements / BLOCK))));
}

class IndexSummary {
    readonly #values: Uint16Array<ArrayBuffer> | Uint32Array<ArrayBuffer>;
    readonly #tree: Uint32Array<ArrayBuffer>;
    readonly #base: number;
    readonly #size: number;

    constructor(data: Uint8Array<ArrayBuffer>, size: 2 | 4) {
        this.#size = size;
        this.#values = size === 2 ? new Uint16Array(data.buffer, 0, Math.floor(data.byteLength / 2)) :
            new Uint32Array(data.buffer, 0, Math.floor(data.byteLength / 4));
        this.#base = leaves(this.#values.length);
        this.#tree = new Uint32Array(this.#base * 2);
    }

    update(startByte: number, endByte: number): void {
        if (startByte === endByte) return;
        const first = Math.floor(Math.floor(startByte / this.#size) / BLOCK);
        const end = Math.ceil(Math.min(this.#values.length, Math.ceil(endByte / this.#size)) / BLOCK);
        for (let block = first; block < end; block++) {
            let value = 0;
            for (let i = block * BLOCK; i < Math.min((block + 1) * BLOCK, this.#values.length); i++) value = Math.max(value, this.#values[i]);
            this.#tree[this.#base + block] = value;
        }
        let lo = (this.#base + first) >> 1, hi = (this.#base + end - 1) >> 1;
        while (lo >= 1 && lo <= hi) {
            for (let node = lo; node <= hi; node++) this.#tree[node] = Math.max(this.#tree[node * 2], this.#tree[node * 2 + 1]);
            if (lo === 1) break;
            lo >>= 1; hi >>= 1;
        }
    }

    maximum(offset: number, length: number): number {
        let first = offset / this.#size, end = first + length, value = -1;
        while (first < end && first % BLOCK) value = Math.max(value, this.#values[first++]);
        while (end > first && end % BLOCK) value = Math.max(value, this.#values[--end]);
        let lo = this.#base + first / BLOCK, hi = this.#base + end / BLOCK;
        while (lo < hi) {
            if (lo & 1) value = Math.max(value, this.#tree[lo++]);
            if (hi & 1) value = Math.max(value, this.#tree[--hi]);
            lo >>= 1; hi >>= 1;
        }
        return value;
    }
}

/** Index-only CPU mirror, charged BEFORE construction. Both formats are summarized because
 * writeBuffer also accepts raw bytes; the draw's index format is not part of BufferUse.
 */
export class Webgl2IndexMirror {
    readonly #data: Uint8Array<ArrayBuffer>;
    readonly #short: IndexSummary;
    readonly #long: IndexSummary;
    #cached: { offset: number; length: number; format: 'uint16' | 'uint32'; value: number } | null = null;

    static bytes(capacity: number): number {
        return capacity + (leaves(Math.floor(capacity / 2)) + leaves(Math.floor(capacity / 4))) * 8;
    }

    static validateTypedUpload(data: Uint8Array<ArrayBuffer>, size: 2 | 4): void {
        const values = size === 2 ? new Uint16Array(data.buffer, 0, data.byteLength / 2) : new Uint32Array(data.buffer, 0, data.byteLength / 4);
        const sentinel = size === 2 ? 0xffff : 0xffffffff;
        if (values.includes(sentinel)) throw new ArenaError('invalid-input');
    }

    constructor(capacity: number) {
        this.#data = new Uint8Array(capacity);
        this.#short = new IndexSummary(this.#data, 2);
        this.#long = new IndexSummary(this.#data, 4);
    }

    write(offset: number, source: Uint8Array<ArrayBuffer>): void {
        this.#data.set(source, offset);
        this.#short.update(offset, offset + source.byteLength);
        this.#long.update(offset, offset + source.byteLength);
        this.#cached = null;
    }

    maximum(offset: number, length: number, format: 'uint16' | 'uint32', maxElement: number): number {
        const cached = this.#cached;
        if (cached && cached.offset === offset && cached.length === length && cached.format === format) return cached.value;
        const size = format === 'uint16' ? 2 : 4;
        if (offset % size || offset > this.#data.byteLength - length * size) throw new ArenaError('invalid-input');
        const value = (size === 2 ? this.#short : this.#long).maximum(offset, length);
        // WebGL2 ALWAYS restarts at these values. The common API intentionally has
        // no restart semantics; raw-byte uploads use the format-specific stored summary.
        if (value === (size === 2 ? 0xffff : 0xffffffff) || value > maxElement) throw new ArenaError('invalid-input');
        this.#cached = { offset, length, format, value };
        return value;
    }
}
