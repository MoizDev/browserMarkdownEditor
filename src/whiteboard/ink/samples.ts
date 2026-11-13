import type { SampleRef, SampleLease, SamplePressure, SampleChunk as ModelSampleChunk, SampleBlockView, SampleStoreReader } from '../model/samples';
import { decodePoints, POINT_LIMITS } from '../format/points';
export type { SampleRef, SampleLease, SamplePressure, SampleBlockView, SampleStoreReader } from '../model/samples';

// D-13, F-INK-006/007/010; architecture/ink.md §2.1. No event/time/device data enters this store.
export const SAMPLE_CHUNK_CAPACITY = 4096;
export const PRESSURE_QUANTUM = 1 / 65535;
export const MAX_PRESSURE = 16;
export const SAMPLE_POSITION_ERROR_DEVICE_PX = 0.01;

export type SegmentKind = 'freehand' | 'straight';
export type PressureChannel = SamplePressure;

// Arrays are immutable by ownership: only the private builder writes, and seal transfers ownership.
// read() returns offsets into these very arrays, never newly allocated subarray views.
export type SampleChunk = ModelSampleChunk & Readonly<{ positionErrorWorld: number; byteLength: number; }>;
export interface SampleSequence {
    readonly count: number;
    x(index: number): number;
    y(index: number): number;
    pressure(index: number): number | undefined;
    // The kind of the span index -> index + 1, not a device or tool identity.
    segmentKind(index: number): SegmentKind;
}
export type SampleBuilderOptions = Readonly<{
    pressure: boolean;
    declaredMaxScale: number;
    maxDpr?: number;
    precision?: 'bounded' | 'float64';
}>;
// Structurally matches format/points.ts PointHeader; only the fully validating reader admits it.
export interface EncodedSampleHeader {
    readonly count: number;
    readonly k: number;
    readonly hasPressure: boolean;
    readonly runCount: number; // 0 is an absent source run channel, not a synthetic storage run.
}

export function validateSample(x: number, y: number, pressure: number | undefined, hasPressure: boolean): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new RangeError('Ink position must be finite');
    if (hasPressure && (pressure === undefined || !Number.isFinite(pressure) || pressure < 0 || pressure > MAX_PRESSURE)) {
        // The reader routes this refusal to D-10 read-only; never clamp received pressure.
        throw new RangeError('Ink pressure must be finite and within 0…16');
    }
    if (!hasPressure && pressure !== undefined) throw new RangeError('Pressure-none ink cannot acquire a pressure channel');
}

function checkedIndex(index: number, count: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= count) throw new RangeError('Ink sample index out of range');
}

class ChunkBuilder {
    count = 0;
    private capacity = 8;
    private positions: Float32Array | Float64Array;
    private pressureValues: Uint16Array | Uint32Array | undefined;
    private kinds = new Uint8Array(this.capacity);
    private constantPressure: number | undefined;
    private lastX = 0;
    private lastY = 0;
    private errorWorld = 0;

    constructor(readonly first: number, readonly originX: number, readonly originY: number,
        private readonly options: SampleBuilderOptions, private readonly maxErrorWorld: number) {
        this.positions = options.precision === 'float64' ? new Float64Array(2 * this.capacity) : new Float32Array(2 * this.capacity);
    }

    checkpoint(): () => void {
        const count = this.count, capacity = this.capacity, positions = this.positions, kinds = this.kinds;
        const pressureValues = this.pressureValues, constantPressure = this.constantPressure;
        const lastX = this.lastX, lastY = this.lastY, errorWorld = this.errorWorld;
        return () => {
            this.count = count; this.capacity = capacity; this.positions = positions; this.kinds = kinds;
            this.pressureValues = pressureValues; this.constantPressure = constantPressure;
            this.lastX = lastX; this.lastY = lastY; this.errorWorld = errorWorld;
        };
    }
    canAppend(x: number, y: number): boolean {
        if (this.count === SAMPLE_CHUNK_CAPACITY) return false;
        const dx = x - this.originX, dy = y - this.originY;
        const packedX = this.positions instanceof Float64Array ? dx : Math.fround(dx);
        const packedY = this.positions instanceof Float64Array ? dy : Math.fround(dy);
        const error = Math.hypot(this.originX + packedX - x, this.originY + packedY - y);
        return Number.isFinite(packedX) && Number.isFinite(packedY)
            && error <= (this.options.precision === 'float64' ? 0 : this.maxErrorWorld);
    }

    append(x: number, y: number, pressure: number | undefined, incomingKind: SegmentKind): void {
        if (this.count === this.capacity) this.grow();
        const i = this.count;
        this.positions[2 * i] = x - this.originX;
        this.positions[2 * i + 1] = y - this.originY;
        this.errorWorld = Math.max(this.errorWorld,
            Math.hypot(this.originX + this.positions[2 * i] - x, this.originY + this.positions[2 * i + 1] - y));
        this.kinds[i] = incomingKind === 'straight' ? 1 : 0;
        if (i === 0) this.constantPressure = pressure;
        if (pressure !== undefined) {
            if (!this.pressureValues && pressure !== this.constantPressure) {
                this.pressureValues = pressure > 1 || this.constantPressure! > 1
                    ? new Uint32Array(this.capacity) : new Uint16Array(this.capacity);
                this.pressureValues.fill(Math.round(this.constantPressure! * 65535), 0, i);
            }
            if (this.pressureValues) {
                if (pressure > 1 && this.pressureValues instanceof Uint16Array) {
                    const wider = new Uint32Array(this.capacity);
                    wider.set(this.pressureValues);
                    this.pressureValues = wider;
                }
                this.pressureValues[i] = Math.round(pressure * 65535);
            }
        }
        this.lastX = x;
        this.lastY = y;
        this.count++;
    }

    private grow(): void {
        this.capacity = Math.min(2 * this.capacity, SAMPLE_CHUNK_CAPACITY);
        const positions = this.positions instanceof Float64Array ? new Float64Array(2 * this.capacity) : new Float32Array(2 * this.capacity);
        positions.set(this.positions);
        this.positions = positions;
        const kinds = new Uint8Array(this.capacity);
        kinds.set(this.kinds);
        this.kinds = kinds;
        if (this.pressureValues) {
            const pressure = this.pressureValues instanceof Uint32Array ? new Uint32Array(this.capacity) : new Uint16Array(this.capacity);
            pressure.set(this.pressureValues);
            this.pressureValues = pressure;
        }
    }

    x(index: number): number {
        return index === 0 ? this.originX : index === this.count - 1 ? this.lastX : this.originX + this.positions[2 * index];
    }
    y(index: number): number {
        return index === 0 ? this.originY : index === this.count - 1 ? this.lastY : this.originY + this.positions[2 * index + 1];
    }
    pressure(index: number): number | undefined {
        return this.pressureValues ? this.pressureValues[index] / 65535 : this.constantPressure;
    }
    incomingKind(index: number): SegmentKind { return this.kinds[index] ? 'straight' : 'freehand'; }

    seal(): SampleChunk {
        const positions = this.positions.slice(0, 2 * this.count);
        const pressure: PressureChannel = this.pressureValues
            ? Object.freeze({
                kind: this.pressureValues instanceof Uint32Array ? 'u32' as const : 'u16' as const,
                values: this.pressureValues.slice(0, this.count)
            }) as PressureChannel
            : this.constantPressure === undefined ? Object.freeze({ kind: 'none' })
                : Object.freeze({ kind: 'constant', value: this.constantPressure });
        let runs = 1;
        for (let i = 1; i < this.count; i++) if (this.kinds[i] !== this.kinds[i - 1]) runs++;
        const runStarts = new Uint16Array(runs), runKinds = new Uint8Array(runs);
        runKinds[0] = this.kinds[0];
        for (let i = 1, run = 1; i < this.count; i++) {
            if (this.kinds[i] !== this.kinds[i - 1]) { runStarts[run] = i; runKinds[run++] = this.kinds[i]; }
        }
        return Object.freeze({
            first: this.first, count: this.count, originX: this.originX, originY: this.originY,
            positions, firstX: this.originX, firstY: this.originY, lastX: this.lastX, lastY: this.lastY,
            pressure, runStarts, runKinds, positionErrorWorld: this.errorWorld,
            byteLength: positions.byteLength + runStarts.byteLength + runKinds.byteLength
                + (pressure.kind === 'u16' || pressure.kind === 'u32' ? pressure.values.byteLength : 0)
        });
    }
}

function chunkCoordinate(chunk: SampleChunk, index: number, axis: 0 | 1): number {
    if (index === 0) return axis ? chunk.firstY : chunk.firstX;
    if (index === chunk.count - 1) return axis ? chunk.lastY : chunk.lastX;
    return (axis ? chunk.originY : chunk.originX) + chunk.positions[2 * index + axis];
}
function chunkPressure(chunk: SampleChunk, index: number): number | undefined {
    const p = chunk.pressure;
    return p.kind === 'none' ? undefined : p.kind === 'constant' ? p.value : p.values[index] / 65535;
}
function chunkKind(chunk: SampleChunk, index: number): SegmentKind {
    let run = 0;
    while (run + 1 < chunk.runStarts.length && chunk.runStarts[run + 1] <= index) run++;
    return chunk.runKinds[run] ? 'straight' : 'freehand';
}
function findChunk(chunks: readonly SampleChunk[], index: number): SampleChunk {
    let low = 0, high = chunks.length - 1;
    while (low < high) {
        const mid = (low + high + 1) >>> 1;
        if (chunks[mid].first <= index) low = mid;
        else high = mid - 1;
    }
    return chunks[low];
}

export class SampleBuilder implements SampleSequence {
    private frozen: SampleChunk[] = [];
    private active: ChunkBuilder | undefined;
    private sealed = false;
    private length = 0;
    private readonly maxErrorWorld: number;
    private exactTail = false;
    readonly options: SampleBuilderOptions;
    constructor(options: SampleBuilderOptions) {
        this.options = Object.freeze({ ...options });
        const maxDpr = options.maxDpr ?? 3, scale = options.declaredMaxScale * maxDpr;
        if (!Number.isFinite(scale) || options.declaredMaxScale <= 0 || maxDpr <= 0) throw new RangeError('Ink needs a finite positive declared device scale');
        this.maxErrorWorld = SAMPLE_POSITION_ERROR_DEVICE_PX / scale;
    }
    get count(): number { return this.length; }
    append(x: number, y: number, pressure: number | undefined, incomingKind: SegmentKind = 'freehand'): void {
        if (this.sealed) throw new Error('A sealed sample builder cannot be extended');
        validateSample(x, y, pressure, this.options.pressure);
        if (!this.active || !this.active.canAppend(x, y)) {
            if (this.active) this.frozen.push(this.active.seal());
            this.active = new ChunkBuilder(this.length, x, y,
                this.exactTail ? { ...this.options, precision: 'float64' } : this.options, this.maxErrorWorld);
        }
        this.active.append(x, y, pressure, incomingKind);
        this.length++;
    }
    private locate(index: number): SampleChunk | ChunkBuilder {
        if (this.sealed) throw new Error('Sample ownership has already transferred');
        checkedIndex(index, this.count);
        return this.active && index >= this.active.first ? this.active : findChunk(this.frozen, index);
    }
    x(index: number): number {
        const c = this.locate(index), i = index - c.first;
        return c instanceof ChunkBuilder ? c.x(i) : chunkCoordinate(c, i, 0);
    }
    y(index: number): number {
        const c = this.locate(index), i = index - c.first;
        return c instanceof ChunkBuilder ? c.y(i) : chunkCoordinate(c, i, 1);
    }
    pressure(index: number): number | undefined {
        const c = this.locate(index), i = index - c.first;
        return c instanceof ChunkBuilder ? c.pressure(i) : chunkPressure(c, i);
    }
    segmentKind(index: number): SegmentKind {
        checkedIndex(index, this.count - 1);
        const c = this.locate(index + 1), i = index + 1 - c.first;
        return c instanceof ChunkBuilder ? c.incomingKind(i) : chunkKind(c, i);
    }
    snapshot(): SampleSequence {
        if (this.sealed) throw new Error('Sample ownership has already transferred');
        const chunks = this.active ? [...this.frozen, this.active.seal()] : this.frozen.slice();
        return sequenceFromChunks(Object.freeze(chunks), this.count);
    }
    checkpoint(): () => void {
        if (this.sealed) throw new Error('Sample ownership has already transferred');
        const length = this.length, frozenCount = this.frozen.length, active = this.active, exactTail = this.exactTail;
        const restoreActive = active?.checkpoint();
        let restored = false;
        return () => {
            if (this.sealed || restored) throw new Error('Sample checkpoint is no longer writable');
            restored = true;
            restoreActive?.();
            this.length = length; this.frozen.length = frozenCount; this.active = active; this.exactTail = exactTail;
        };
    }
    beginBoundedChunk(): void {
        if (this.sealed) throw new Error('Sample ownership has already transferred');
        if (this.active) this.frozen.push(this.active.seal());
        this.active = undefined;
        this.exactTail = false;
    }
    beginExactTail(): void {
        if (this.sealed) throw new Error('Sample ownership has already transferred');
        if (this.active) this.frozen.push(this.active.seal());
        this.active = undefined;
        this.exactTail = true;
    }
    seal(): readonly SampleChunk[] {
        if (this.sealed) throw new Error('Sample ownership has already transferred');
        if (!this.count) throw new Error('An empty builder is not a stroke');
        if (this.active) this.frozen.push(this.active.seal());
        const chunks = Object.freeze(this.frozen);
        this.sealed = true;
        this.active = undefined;
        this.frozen = [];
        return chunks;
    }
}

function sequenceFromChunks(chunks: readonly SampleChunk[], count: number): SampleSequence {
    const locate = (i: number) => { checkedIndex(i, count); return findChunk(chunks, i); };
    return Object.freeze({
        count,
        x: (i: number) => { const c = locate(i); return chunkCoordinate(c, i - c.first, 0); },
        y: (i: number) => { const c = locate(i); return chunkCoordinate(c, i - c.first, 1); },
        pressure: (i: number) => { const c = locate(i); return chunkPressure(c, i - c.first); },
        segmentKind: (i: number) => { checkedIndex(i, count - 1); const c = locate(i + 1); return chunkKind(c, i + 1 - c.first); },
    });
}

type SampleRecord = {
    ref: SampleRef; count: number; owners: number;
    chunks: readonly SampleChunk[] | null; bytes: number;
    encoded: string | null; k: number; hasPressure: boolean; runCount: number;
};
// Handles are unique across stores in this realm; worker bridges re-admit encoded payloads into
// their owning store rather than treating another realm's numeric handles as portable references.
let nextSampleRef = 1;
function sampleRef(): SampleRef {
    if (!Number.isSafeInteger(nextSampleRef)) throw new RangeError('Ink sample handle space exhausted');
    return nextSampleRef++;
}
export class SampleStore implements SampleStoreReader {
    private records = new Map<SampleRef, SampleRecord>();
    private bytes = 0;
    private encodedBytes = 0;
    // Exact owned decoded typed-array bytes, including exceptional Uint32 pressure. JS objects,
    // active builders and compositor-held old views are additional engine-budget ownership.
    get byteLength(): number { return this.bytes; }
    // Conservative UTF-16 upper bound, not a claim about V8's actual one-/two-byte string storage.
    get encodedByteLength(): number { return this.encodedBytes; }
    get recordCount(): number { return this.records.size; }
    commit(builder: SampleBuilder): SampleLease {
        const ref = sampleRef(), chunks = builder.seal();
        return this.add({
            ref, count: builder.count, chunks, owners: 0,
            bytes: chunks.reduce((sum, c) => sum + c.byteLength, 0),
            encoded: null, k: 0, hasPressure: builder.options.pressure, runCount: 0
        });
    }
    admitEncoded(pts: string, header: EncodedSampleHeader): SampleLease {
        // R-W28/29: the parse worker has already walked every channel/varint/bound. Do not decode
        // or allocate point arrays at admission, has(), count(), retain() or sequence() creation.
        if (typeof pts !== 'string' || !pts.length || pts.length % 4 || pts.length > POINT_LIMITS.encodedChars
            || !Number.isInteger(header.count) || header.count < 1 || header.count > POINT_LIMITS.count
            || !Number.isInteger(header.k) || header.k < 0 || header.k > POINT_LIMITS.exponent
            || typeof header.hasPressure !== 'boolean' || !Number.isInteger(header.runCount)
            || header.runCount < 0 || header.runCount > header.count) throw new RangeError('Invalid validated ink payload header');
        return this.add({
            ref: sampleRef(), count: header.count, chunks: null, owners: 0, bytes: 0,
            encoded: pts, k: header.k, hasPressure: header.hasPressure, runCount: header.runCount
        });
    }
    private add(record: SampleRecord): SampleLease {
        // Both admission paths hand the creator one lease, never an unowned/staging ref. Allocate
        // it before registering the record, so a failed lease allocation cannot orphan a record.
        const lease = this.lease(record);
        this.records.set(record.ref, record);
        this.bytes += record.bytes;
        this.encodedBytes += record.encoded === null ? 0 : 2 * record.encoded.length;
        return lease;
    }
    has(ref: SampleRef): boolean { return this.records.has(ref); }
    count(ref: SampleRef): number { return this.record(ref).count; }
    private record(ref: SampleRef): SampleRecord {
        const record = this.records.get(ref);
        if (!record) throw new Error('Foreign or released ink sample reference');
        return record;
    }
    retain(ref: SampleRef): SampleLease { return this.lease(this.record(ref)); }
    private lease(record: SampleRecord): SampleLease {
        let released = false;
        const lease = Object.freeze({
            ref: record.ref, release: () => {
                if (released) return;
                released = true;
                if (--record.owners === 0) {
                    this.records.delete(record.ref); this.bytes -= record.bytes;
                    this.encodedBytes -= record.encoded === null ? 0 : 2 * record.encoded.length;
                    record.chunks = null; record.bytes = 0; record.encoded = null;
                }
            }
        });
        record.owners++;
        return lease;
    }
    evictDecoded(ref: SampleRef): boolean {
        const record = this.record(ref);
        if (record.encoded === null || record.chunks === null) return false;
        // Never mutate/recycle an old published array. A compositor holding a view may finish its
        // generation; only the store's cache ownership is dropped, with native truth kept encoded.
        this.bytes -= record.bytes; record.bytes = 0; record.chunks = null;
        return true;
    }
    private decoded(record: SampleRecord): readonly SampleChunk[] {
        if (record.chunks !== null) return record.chunks;
        if (record.encoded === null) throw new Error('Ink has neither canonical samples nor native encoding');
        // R-W29 admits a full synchronous decode of this ONE stroke on its first actual read.
        // Checkpointed incremental decoding is a seam only if an integrated frame run requires it.
        const result = decodePoints(record.encoded);
        if (!result.ok) throw new Error(`Native ink cannot be decoded: ${result.error.reason}`);
        const points = result.value;
        if (points.count !== record.count || points.k !== record.k || (points.pressure !== null) !== record.hasPressure
            || (points.runs?.starts.length ?? 0) !== record.runCount) throw new Error('Native ink no longer matches its validated header');
        // Native coordinates are on the 2^-k grid. Any NONZERO Float32 rounding is >= one quantum;
        // this stricter-than-quantum budget therefore forces exact storage or a fresh local anchor,
        // independent of the host's zoom. This is not an inferred product/camera zoom cap.
        const builder = new SampleBuilder({ pressure: record.hasPressure, declaredMaxScale: 2 ** record.k, maxDpr: 3 });
        const runs = points.runs;
        let run = 0;
        // R-W31: native runs are OUTGOING span starts. Storage is incoming-at-sample, so translate
        // exactly here; sample 0 carries the meaningful first span kind, never a dummy freehand run.
        for (let i = 0; i < points.count; i++) {
            const outgoing = Math.max(0, i - 1);
            if (runs) while (run + 1 < runs.starts.length && runs.starts[run + 1] <= outgoing) run++;
            builder.append(points.xy[2 * i], points.xy[2 * i + 1], points.pressure?.[i],
                runs?.kinds[run] ? 'straight' : 'freehand');
        }
        // No authoring filter: native points/runs are canonical already. Publish only after a
        // complete successful decode; allocation/refusal leaves the original encoded record intact.
        const chunks = builder.seal(), bytes = chunks.reduce((sum, c) => sum + c.byteLength, 0);
        record.chunks = chunks; record.bytes = bytes; this.bytes += bytes;
        return chunks;
    }
    read(ref: SampleRef, first: number, count: number): SampleBlockView {
        const record = this.record(ref);
        checkedIndex(first, record.count);
        if (!Number.isInteger(count) || count <= 0 || count > record.count - first) throw new RangeError('Invalid sample range');
        const chunk = findChunk(this.decoded(record), first), offset = first - chunk.first;
        return Object.freeze({ chunk, offset, count: Math.min(count, chunk.count - offset) });
    }
    sequence(ref: SampleRef): SampleSequence {
        const count = this.record(ref).count;
        // No captured decoded generation: eviction can actually release it, and the next numeric
        // access re-decodes. Holding a sequence still requires the caller's explicit SampleLease.
        const locate = (i: number) => { const record = this.record(ref); checkedIndex(i, count); return findChunk(this.decoded(record), i); };
        return Object.freeze({
            count,
            x: (i: number) => { const c = locate(i); return chunkCoordinate(c, i - c.first, 0); },
            y: (i: number) => { const c = locate(i); return chunkCoordinate(c, i - c.first, 1); },
            pressure: (i: number) => { const c = locate(i); return chunkPressure(c, i - c.first); },
            segmentKind: (i: number) => { checkedIndex(i, count - 1); const c = locate(i + 1); return chunkKind(c, i + 1 - c.first); },
        });
    }
}
