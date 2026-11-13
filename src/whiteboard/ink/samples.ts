// D-13, F-INK-006/007/010; architecture/ink.md §2.1. No event/time/device data enters this store.
export const SAMPLE_CHUNK_CAPACITY = 4096
export const PRESSURE_QUANTUM = 1 / 65535
export const MAX_PRESSURE = 16
export const SAMPLE_POSITION_ERROR_DEVICE_PX = 0.01

export type SegmentKind = 'freehand' | 'straight'
export type SampleRef = number
export type SampleLease = Readonly<{ ref: SampleRef; release(): void }>
export type PressureChannel =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'constant'; value: number }>
  | Readonly<{ kind: 'u16'; values: Uint16Array }>
  | Readonly<{ kind: 'u32'; values: Uint32Array }>

// Arrays are immutable by ownership: only the private builder writes, and seal transfers ownership.
// read() returns offsets into these very arrays, never newly allocated subarray views.
export type SampleChunk = Readonly<{
  first: number; count: number
  originX: number; originY: number
  positions: Float32Array | Float64Array
  firstX: number; firstY: number; lastX: number; lastY: number
  pressure: PressureChannel
  runStarts: Uint16Array; runKinds: Uint8Array
  positionErrorWorld: number
  byteLength: number
}>
export type SampleBlockView = Readonly<{ chunk: SampleChunk; offset: number; count: number }>
export interface SampleStoreReader {
  has(ref: SampleRef): boolean
  count(ref: SampleRef): number
  read(ref: SampleRef, first: number, count: number): SampleBlockView
  retain(ref: SampleRef): SampleLease
}
export interface SampleSequence {
  readonly count: number
  x(index: number): number
  y(index: number): number
  pressure(index: number): number | undefined
  // The kind of the span index -> index + 1, not a device or tool identity.
  segmentKind(index: number): SegmentKind
}
export type SampleBuilderOptions = Readonly<{
  pressure: boolean
  declaredMaxScale: number
  maxDpr?: number
  precision?: 'bounded' | 'float64'
}>

export function validateSample(x: number, y: number, pressure: number | undefined, hasPressure: boolean): void {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new RangeError('Ink position must be finite')
  if (hasPressure && (pressure === undefined || !Number.isFinite(pressure) || pressure < 0 || pressure > MAX_PRESSURE)) {
    // The reader routes this refusal to D-10 read-only; never clamp received pressure.
    throw new RangeError('Ink pressure must be finite and within 0…16')
  }
  if (!hasPressure && pressure !== undefined) throw new RangeError('Pressure-none ink cannot acquire a pressure channel')
}

function checkedIndex(index: number, count: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= count) throw new RangeError('Ink sample index out of range')
}

class ChunkBuilder {
  count = 0
  private capacity = 8
  private positions: Float32Array | Float64Array
  private pressureValues: Uint16Array | Uint32Array | undefined
  private kinds = new Uint8Array(this.capacity)
  private constantPressure: number | undefined
  private lastX = 0
  private lastY = 0
  private errorWorld = 0

  constructor(readonly first: number, readonly originX: number, readonly originY: number,
    private readonly options: SampleBuilderOptions, private readonly maxErrorWorld: number) {
    this.positions = options.precision === 'float64' ? new Float64Array(2 * this.capacity) : new Float32Array(2 * this.capacity)
  }

  checkpoint(): () => void {
    const count = this.count, capacity = this.capacity, positions = this.positions, kinds = this.kinds
    const pressureValues = this.pressureValues, constantPressure = this.constantPressure
    const lastX = this.lastX, lastY = this.lastY, errorWorld = this.errorWorld
    return () => {
      this.count = count; this.capacity = capacity; this.positions = positions; this.kinds = kinds
      this.pressureValues = pressureValues; this.constantPressure = constantPressure
      this.lastX = lastX; this.lastY = lastY; this.errorWorld = errorWorld
    }
  }
  canAppend(x: number, y: number): boolean {
    if (this.count === SAMPLE_CHUNK_CAPACITY) return false
    const dx = x - this.originX, dy = y - this.originY
    const packedX = this.positions instanceof Float64Array ? dx : Math.fround(dx)
    const packedY = this.positions instanceof Float64Array ? dy : Math.fround(dy)
    const error = Math.hypot(this.originX + packedX - x, this.originY + packedY - y)
    return Number.isFinite(packedX) && Number.isFinite(packedY)
      && error <= (this.options.precision === 'float64' ? 0 : this.maxErrorWorld)
  }

  append(x: number, y: number, pressure: number | undefined, incomingKind: SegmentKind): void {
    if (this.count === this.capacity) this.grow()
    const i = this.count
    this.positions[2 * i] = x - this.originX
    this.positions[2 * i + 1] = y - this.originY
    this.errorWorld = Math.max(this.errorWorld,
      Math.hypot(this.originX + this.positions[2 * i] - x, this.originY + this.positions[2 * i + 1] - y))
    this.kinds[i] = incomingKind === 'straight' ? 1 : 0
    if (i === 0) this.constantPressure = pressure
    if (pressure !== undefined) {
      if (!this.pressureValues && pressure !== this.constantPressure) {
        this.pressureValues = pressure > 1 || this.constantPressure! > 1
          ? new Uint32Array(this.capacity) : new Uint16Array(this.capacity)
        this.pressureValues.fill(Math.round(this.constantPressure! * 65535), 0, i)
      }
      if (this.pressureValues) {
        if (pressure > 1 && this.pressureValues instanceof Uint16Array) {
          const wider = new Uint32Array(this.capacity)
          wider.set(this.pressureValues)
          this.pressureValues = wider
        }
        this.pressureValues[i] = Math.round(pressure * 65535)
      }
    }
    this.lastX = x
    this.lastY = y
    this.count++
  }

  private grow(): void {
    this.capacity = Math.min(2 * this.capacity, SAMPLE_CHUNK_CAPACITY)
    const positions = this.positions instanceof Float64Array ? new Float64Array(2 * this.capacity) : new Float32Array(2 * this.capacity)
    positions.set(this.positions)
    this.positions = positions
    const kinds = new Uint8Array(this.capacity)
    kinds.set(this.kinds)
    this.kinds = kinds
    if (this.pressureValues) {
      const pressure = this.pressureValues instanceof Uint32Array ? new Uint32Array(this.capacity) : new Uint16Array(this.capacity)
      pressure.set(this.pressureValues)
      this.pressureValues = pressure
    }
  }

  x(index: number): number {
    return index === 0 ? this.originX : index === this.count - 1 ? this.lastX : this.originX + this.positions[2 * index]
  }
  y(index: number): number {
    return index === 0 ? this.originY : index === this.count - 1 ? this.lastY : this.originY + this.positions[2 * index + 1]
  }
  pressure(index: number): number | undefined {
    return this.pressureValues ? this.pressureValues[index] / 65535 : this.constantPressure
  }
  incomingKind(index: number): SegmentKind { return this.kinds[index] ? 'straight' : 'freehand' }

  seal(): SampleChunk {
    const positions = this.positions.slice(0, 2 * this.count)
    const pressure: PressureChannel = this.pressureValues
      ? Object.freeze({ kind: this.pressureValues instanceof Uint32Array ? 'u32' as const : 'u16' as const,
        values: this.pressureValues.slice(0, this.count) }) as PressureChannel
      : this.constantPressure === undefined ? Object.freeze({ kind: 'none' })
        : Object.freeze({ kind: 'constant', value: this.constantPressure })
    let runs = 1
    for (let i = 1; i < this.count; i++) if (this.kinds[i] !== this.kinds[i - 1]) runs++
    const runStarts = new Uint16Array(runs), runKinds = new Uint8Array(runs)
    runKinds[0] = this.kinds[0]
    for (let i = 1, run = 1; i < this.count; i++) {
      if (this.kinds[i] !== this.kinds[i - 1]) { runStarts[run] = i; runKinds[run++] = this.kinds[i] }
    }
    return Object.freeze({ first: this.first, count: this.count, originX: this.originX, originY: this.originY,
      positions, firstX: this.originX, firstY: this.originY, lastX: this.lastX, lastY: this.lastY,
      pressure, runStarts, runKinds, positionErrorWorld: this.errorWorld,
      byteLength: positions.byteLength + runStarts.byteLength + runKinds.byteLength
        + (pressure.kind === 'u16' || pressure.kind === 'u32' ? pressure.values.byteLength : 0) })
  }
}

function chunkCoordinate(chunk: SampleChunk, index: number, axis: 0 | 1): number {
  if (index === 0) return axis ? chunk.firstY : chunk.firstX
  if (index === chunk.count - 1) return axis ? chunk.lastY : chunk.lastX
  return (axis ? chunk.originY : chunk.originX) + chunk.positions[2 * index + axis]
}
function chunkPressure(chunk: SampleChunk, index: number): number | undefined {
  const p = chunk.pressure
  return p.kind === 'none' ? undefined : p.kind === 'constant' ? p.value : p.values[index] / 65535
}
function chunkKind(chunk: SampleChunk, index: number): SegmentKind {
  let run = 0
  while (run + 1 < chunk.runStarts.length && chunk.runStarts[run + 1] <= index) run++
  return chunk.runKinds[run] ? 'straight' : 'freehand'
}
function findChunk(chunks: readonly SampleChunk[], index: number): SampleChunk {
  let low = 0, high = chunks.length - 1
  while (low < high) {
    const mid = (low + high + 1) >>> 1
    if (chunks[mid].first <= index) low = mid
    else high = mid - 1
  }
  return chunks[low]
}

export class SampleBuilder implements SampleSequence {
  private frozen: SampleChunk[] = []
  private active: ChunkBuilder | undefined
  private sealed = false
  private length = 0
  private readonly maxErrorWorld: number
  private exactTail = false
  readonly options: SampleBuilderOptions
  constructor(options: SampleBuilderOptions) {
    this.options = Object.freeze({ ...options })
    const scale = options.declaredMaxScale * (options.maxDpr ?? 3)
    if (!Number.isFinite(scale) || scale <= 0) throw new RangeError('Ink needs a finite positive declared device scale')
    this.maxErrorWorld = SAMPLE_POSITION_ERROR_DEVICE_PX / scale
  }
  get count(): number { return this.length }
  append(x: number, y: number, pressure: number | undefined, incomingKind: SegmentKind = 'freehand'): void {
    if (this.sealed) throw new Error('A sealed sample builder cannot be extended')
    validateSample(x, y, pressure, this.options.pressure)
    if (!this.active || !this.active.canAppend(x, y)) {
      if (this.active) this.frozen.push(this.active.seal())
      this.active = new ChunkBuilder(this.length, x, y,
        this.exactTail ? { ...this.options, precision: 'float64' } : this.options, this.maxErrorWorld)
    }
    this.active.append(x, y, pressure, incomingKind)
    this.length++
  }
  private locate(index: number): SampleChunk | ChunkBuilder {
    if (this.sealed) throw new Error('Sample ownership has already transferred')
    checkedIndex(index, this.count)
    return this.active && index >= this.active.first ? this.active : findChunk(this.frozen, index)
  }
  x(index: number): number {
    const c = this.locate(index), i = index - c.first
    return c instanceof ChunkBuilder ? c.x(i) : chunkCoordinate(c, i, 0)
  }
  y(index: number): number {
    const c = this.locate(index), i = index - c.first
    return c instanceof ChunkBuilder ? c.y(i) : chunkCoordinate(c, i, 1)
  }
  pressure(index: number): number | undefined {
    const c = this.locate(index), i = index - c.first
    return c instanceof ChunkBuilder ? c.pressure(i) : chunkPressure(c, i)
  }
  segmentKind(index: number): SegmentKind {
    checkedIndex(index, this.count - 1)
    const c = this.locate(index + 1), i = index + 1 - c.first
    return c instanceof ChunkBuilder ? c.incomingKind(i) : chunkKind(c, i)
  }
  snapshot(): SampleSequence {
    if (this.sealed) throw new Error('Sample ownership has already transferred')
    const chunks = this.active ? [...this.frozen, this.active.seal()] : this.frozen.slice()
    return sequenceFromChunks(Object.freeze(chunks), this.count)
  }
  checkpoint(): () => void {
    if (this.sealed) throw new Error('Sample ownership has already transferred')
    const length = this.length, frozenCount = this.frozen.length, active = this.active, exactTail = this.exactTail
    const restoreActive = active?.checkpoint()
    let restored = false
    return () => {
      if (this.sealed || restored) throw new Error('Sample checkpoint is no longer writable')
      restored = true
      restoreActive?.()
      this.length = length; this.frozen.length = frozenCount; this.active = active; this.exactTail = exactTail
    }
  }
  beginBoundedChunk(): void {
    if (this.sealed) throw new Error('Sample ownership has already transferred')
    if (this.active) this.frozen.push(this.active.seal())
    this.active = undefined
    this.exactTail = false
  }
  beginExactTail(): void {
    if (this.sealed) throw new Error('Sample ownership has already transferred')
    if (this.active) this.frozen.push(this.active.seal())
    this.active = undefined
    this.exactTail = true
  }
  seal(): readonly SampleChunk[] {
    if (this.sealed) throw new Error('Sample ownership has already transferred')
    if (!this.count) throw new Error('An empty builder is not a stroke')
    if (this.active) this.frozen.push(this.active.seal())
    const chunks = Object.freeze(this.frozen)
    this.sealed = true
    this.active = undefined
    this.frozen = []
    return chunks
  }
}

function sequenceFromChunks(chunks: readonly SampleChunk[], count: number): SampleSequence {
  const locate = (i: number) => { checkedIndex(i, count); return findChunk(chunks, i) }
  return Object.freeze({ count,
    x: (i: number) => { const c = locate(i); return chunkCoordinate(c, i - c.first, 0) },
    y: (i: number) => { const c = locate(i); return chunkCoordinate(c, i - c.first, 1) },
    pressure: (i: number) => { const c = locate(i); return chunkPressure(c, i - c.first) },
    segmentKind: (i: number) => { checkedIndex(i, count - 1); const c = locate(i + 1); return chunkKind(c, i + 1 - c.first) },
  })
}

type SampleRecord = { ref: SampleRef; count: number; chunks: readonly SampleChunk[]; owners: number; bytes: number }
// Handles are process-unique across stores, so a foreign ref cannot alias a local record.
let nextSampleRef = 1
export class SampleStore implements SampleStoreReader {
  private records = new Map<SampleRef, SampleRecord>()
  private bytes = 0
  // Exact committed typed-array bytes, including exceptional Uint32 pressure. JS objects, active
  // builders and compositor snapshots are additional heap ownership, measured by the engine budget.
  get byteLength(): number { return this.bytes }
  get recordCount(): number { return this.records.size }
  commit(builder: SampleBuilder): SampleLease {
    if (!Number.isSafeInteger(nextSampleRef)) throw new RangeError('Ink sample handle space exhausted')
    const chunks = builder.seal()
    const ref = nextSampleRef++
    const bytes = chunks.reduce((sum, c) => sum + c.byteLength, 0)
    const record = { ref, count: builder.count, chunks, owners: 0, bytes }
    this.records.set(ref, record)
    this.bytes += bytes
    // The creator receives a lease, so an unpublished ref can never be accidentally unowned.
    return this.retain(ref)
  }
  has(ref: SampleRef): boolean { return this.records.has(ref) }
  count(ref: SampleRef): number { return this.record(ref).count }
  private record(ref: SampleRef): SampleRecord {
    const record = this.records.get(ref)
    if (!record) throw new Error('Foreign or released ink sample reference')
    return record
  }
  retain(ref: SampleRef): SampleLease {
    const record = this.record(ref)
    record.owners++
    let released = false
    return Object.freeze({ ref, release: () => {
      if (released) return
      released = true
      if (--record.owners === 0) { this.records.delete(ref); this.bytes -= record.bytes }
    } })
  }
  read(ref: SampleRef, first: number, count: number): SampleBlockView {
    const record = this.record(ref)
    checkedIndex(first, record.count)
    if (!Number.isInteger(count) || count <= 0 || count > record.count - first) throw new RangeError('Invalid sample range')
    const chunk = findChunk(record.chunks, first)
    const offset = first - chunk.first
    // A read ends at a chunk boundary. Callers advance by result.count, with no array slicing.
    return Object.freeze({ chunk, offset, count: Math.min(count, chunk.count - offset) })
  }
  sequence(ref: SampleRef): SampleSequence {
    const record = this.record(ref)
    // The caller's lease must outlive this view, just as it must outlive read().
    return sequenceFromChunks(record.chunks, record.count)
  }
}
