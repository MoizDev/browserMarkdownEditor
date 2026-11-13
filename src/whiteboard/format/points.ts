// FMT-2; native-format §4. R-W2 fixes the pressure ceiling; R-W3 fixes coordinate ties.
export const POINT_LIMITS = Object.freeze({
  count: 1_000_000,
  encodedChars: 48 * 1024 * 1024,
  world: 10_000_000,
  quantized: 2 ** 50,
  exponent: 20,
  pressure: 16,
  pressureQuantum: 65_535,
  pressureQuanta: 16 * 65_535,
})

export type PointErrorCode = 'input' | 'limit' | 'base64' | 'version' | 'truncated'
  | 'varint' | 'channel' | 'coordinate' | 'pressure' | 'runs' | 'allocation'
export interface PointRefusal { code: PointErrorCode; reason: string; offset?: number }
export type PointResult<T> = { ok: true; value: T } | { ok: false; error: PointRefusal }

export interface SegmentRuns {
  readonly starts: Uint32Array
  readonly kinds: Uint8Array // 0 freehand, 1 straight; first start is 0
}
export interface PointChannel { readonly id: number; readonly data: Uint8Array }
export interface PointSamples {
  readonly xy: Float64Array // interleaved local x,y; no per-point objects
  readonly pressure?: Float64Array | null // raw 0..16, not normalized or clamped
  readonly runs?: SegmentRuns | null
  readonly unknownChannels?: Iterable<PointChannel>
}
export interface DecodedPoints extends PointSamples {
  readonly count: number
  readonly k: number
  readonly pressure: Float64Array | null
  readonly runs: SegmentRuns | null
  readonly unknownChannels: Iterable<PointChannel>
}
export interface EncodedPoints { readonly pts: string; readonly count: number; readonly k: number }

class Refusal extends Error {
  constructor(readonly detail: PointRefusal) { super(detail.reason) }
}
function refuse(code: PointErrorCode, reason: string, offset?: number): never {
  throw new Refusal({ code, reason, ...(offset === undefined ? {} : { offset }) })
}
function result<T>(work: () => T): PointResult<T> {
  try { return { ok: true, value: work() } } catch (error) {
    return { ok: false, error: error instanceof Refusal ? error.detail
      : { code: 'allocation', reason: 'The point payload could not be allocated or encoded' } }
  }
}

export function pointExponent(zMax: number): PointResult<number> {
  return result(() => {
    if (!Number.isFinite(zMax) || zMax <= 0) refuse('input', 'Maximum zoom must be finite and positive')
    const k = Math.max(7, Math.ceil(Math.log2(6 * Math.SQRT2 * zMax)))
    if (k > POINT_LIMITS.exponent) refuse('limit', 'Maximum zoom needs an exponent above 20')
    return k
  })
}

function roundEven(value: number): number {
  const floor = Math.floor(value)
  const fraction = value - floor
  return fraction < 0.5 ? floor : fraction > 0.5 ? floor + 1 : floor % 2 === 0 ? floor : floor + 1
}
function zigzag(value: number): number { return value >= 0 ? 2 * value : -2 * value - 1 }
function unzigzag(value: number): number { return value % 2 === 0 ? value / 2 : -(value + 1) / 2 }

const MAX_BYTES = POINT_LIMITS.encodedChars / 4 * 3
class Bytes {
  private bytes = new Uint8Array(256)
  length = 0
  private reserve(extra: number) {
    const length = this.length + extra
    if (!Number.isSafeInteger(length) || length > MAX_BYTES) refuse('limit', 'Point payload exceeds 48 MiB of base64')
    if (length > this.bytes.length) {
      const grown = new Uint8Array(Math.min(MAX_BYTES, Math.max(length, this.bytes.length * 2)))
      grown.set(this.bytes)
      this.bytes = grown
    }
  }
  byte(value: number) { this.reserve(1); this.bytes[this.length++] = value }
  varint(value: number) {
    if (!Number.isSafeInteger(value) || value < 0) refuse('varint', 'Cannot encode an unsafe unsigned integer')
    while (value >= 128) { this.byte(value % 128 + 128); value = Math.floor(value / 128) }
    this.byte(value)
  }
  append(bytes: Uint8Array) { this.reserve(bytes.length); this.bytes.set(bytes, this.length); this.length += bytes.length }
  view() { return this.bytes.subarray(0, this.length) }
  channel(id: number, bytes: Uint8Array) { this.varint(id); this.varint(bytes.length); this.append(bytes) }
}
class Cursor {
  constructor(readonly bytes: Uint8Array, public offset = 0, readonly end = bytes.length) {}
  byte(): number {
    if (this.offset >= this.end) refuse('truncated', 'Point block ends before its declared content', this.offset)
    return this.bytes[this.offset++]
  }
  varint(): number {
    const start = this.offset
    let value = 0
    let place = 1
    for (let i = 0; i < 8; i++, place *= 128) {
      const byte = this.byte()
      value += (byte % 128) * place
      if (!Number.isSafeInteger(value)) refuse('varint', 'Varint exceeds the safe integer range', start)
      if (byte < 128) {
        if (i > 0 && byte === 0) refuse('varint', 'Non-canonical varint', start)
        return value
      }
    }
    return refuse('varint', 'Varint exceeds eight bytes', start)
  }
  done() {
    if (this.offset !== this.end) refuse('channel', 'Block has trailing bytes', this.offset)
  }
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function base64Bytes(text: string): Uint8Array {
  if (typeof text !== 'string' || text.length === 0 || text.length % 4 !== 0) refuse('base64', 'Expected padded standard base64')
  if (text.length > POINT_LIMITS.encodedChars) refuse('limit', 'Point string exceeds 48 MiB')
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0
  const end = text.length - padding
  for (let i = 0; i < end; i++) {
    const c = text.charCodeAt(i)
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47)) {
      refuse('base64', 'Invalid base64 character', i)
    }
  }
  if ((padding === 2 && ALPHABET.indexOf(text[end - 1]) % 16 !== 0)
    || (padding === 1 && ALPHABET.indexOf(text[end - 1]) % 4 !== 0)) refuse('base64', 'Non-zero base64 padding bits')
  let binary: string
  try { binary = atob(text) } catch { return refuse('base64', 'Malformed base64') }
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
function base64Text(bytes: Uint8Array): string {
  const parts: string[] = []
  // Bounded strings avoid an argument-list/stack limit even for a million-point stroke.
  for (let start = 0; start < bytes.length; start += 16_384) {
    const end = Math.min(bytes.length, start + 16_384)
    let part = ''
    for (let i = start; i < end; i++) part += String.fromCharCode(bytes[i])
    parts.push(part)
  }
  const text = btoa(parts.join(''))
  if (text.length > POINT_LIMITS.encodedChars) refuse('limit', 'Point string exceeds 48 MiB')
  return text
}

function safeExponent(xy: Float64Array, requested: number): number {
  if (!Number.isInteger(requested) || requested < 0 || requested > POINT_LIMITS.exponent) refuse('input', 'Point exponent must be an integer from 0 to 20')
  for (let i = 0; i < xy.length; i++) {
    if (!Number.isFinite(xy[i]) || Math.abs(xy[i]) > POINT_LIMITS.world) refuse('coordinate', 'Point coordinate is outside ±10^7 world units')
  }
  for (let k = requested; k >= 0; k--) {
    const scale = 2 ** k
    let x = 0, y = 0, dx = 0, dy = 0
    let safe = true
    for (let i = 0; i < xy.length; i += 2) {
      const qx = roundEven(xy[i] * scale), qy = roundEven(xy[i + 1] * scale)
      const ex = i === 0 ? qx : i === 2 ? qx - x : qx - x - dx
      const ey = i === 0 ? qy : i === 2 ? qy - y : qy - y - dy
      if (Math.abs(qx) > POINT_LIMITS.quantized || Math.abs(qy) > POINT_LIMITS.quantized
        || Math.abs(ex) > POINT_LIMITS.quantized || Math.abs(ey) > POINT_LIMITS.quantized) { safe = false; break }
      dx = qx - x; dy = qy - y; x = qx; y = qy
    }
    if (safe) return k
  }
  return refuse('coordinate', 'Quantized coordinates cannot be represented safely')
}

export function encodePoints(samples: PointSamples, k = 7): PointResult<EncodedPoints> {
  return result(() => {
    const { xy, pressure, runs, unknownChannels } = samples
    if (!(xy instanceof Float64Array) || xy.length === 0 || xy.length % 2 !== 0) refuse('input', 'Coordinates must be non-empty interleaved Float64 x,y pairs')
    const count = xy.length / 2
    if (count > POINT_LIMITS.count) refuse('limit', 'Stroke exceeds one million points')
    if (pressure != null && (!(pressure instanceof Float64Array) || pressure.length !== count)) refuse('pressure', 'Pressure count does not match point count')
    k = safeExponent(xy, k)
    const coords = new Bytes()
    coords.byte(k)
    const scale = 2 ** k
    let x = 0, y = 0, dx = 0, dy = 0
    for (let i = 0; i < xy.length; i += 2) {
      const qx = roundEven(xy[i] * scale), qy = roundEven(xy[i + 1] * scale)
      coords.varint(zigzag(i === 0 ? qx : i === 2 ? qx - x : qx - x - dx))
      coords.varint(zigzag(i === 0 ? qy : i === 2 ? qy - y : qy - y - dy))
      dx = qx - x; dy = qy - y; x = qx; y = qy
    }
    const payload = new Bytes()
    payload.byte(1); payload.varint(count); payload.channel(1, coords.view())
    if (pressure != null) {
      const data = new Bytes()
      let previous = 0
      for (let i = 0; i < count; i++) {
        const p = pressure[i]
        if (!Number.isFinite(p) || p < 0 || p > POINT_LIMITS.pressure) refuse('pressure', 'Pressure is outside the finite 0…16 domain')
        const q = Math.round(p * POINT_LIMITS.pressureQuantum)
        data.varint(i === 0 ? q : zigzag(q - previous))
        previous = q
      }
      payload.channel(2, data.view())
    }
    if (runs != null) {
      const { starts, kinds } = runs
      if (!(starts instanceof Uint32Array) || !(kinds instanceof Uint8Array) || starts.length === 0
        || starts.length > count || starts.length !== kinds.length) refuse('runs', 'Invalid segment run arrays')
      const data = new Bytes()
      data.varint(starts.length)
      let previous = 0
      for (let i = 0; i < starts.length; i++) {
        if ((i === 0 ? starts[i] !== 0 : starts[i] <= previous) || starts[i] >= count || kinds[i] > 1) refuse('runs', 'Invalid segment start or kind')
        data.varint(starts[i] - previous); data.byte(kinds[i]); previous = starts[i]
      }
      payload.channel(3, data.view())
    }
    if (unknownChannels) {
      for (const channel of unknownChannels) {
        if (!Number.isSafeInteger(channel.id) || channel.id < 0 || (channel.id >= 1 && channel.id <= 3)
          || !(channel.data instanceof Uint8Array)) refuse('channel', 'Invalid opaque channel')
        payload.channel(channel.id, channel.data)
      }
    }
    return { pts: base64Text(payload.view()), count, k }
  })
}

export function decodePoints(pts: string): PointResult<DecodedPoints> {
  return result(() => {
    const bytes = base64Bytes(pts)
    const cursor = new Cursor(bytes)
    if (cursor.byte() !== 1) refuse('version', 'Unsupported point payload version', 0)
    const count = cursor.varint()
    if (count < 1 || count > POINT_LIMITS.count) refuse('limit', 'Point count must be 1…1,000,000')
    const known = new Map<number, Cursor>()
    const channelStart = cursor.offset
    while (cursor.offset < cursor.end) {
      const id = cursor.varint(), length = cursor.varint()
      if (length > cursor.end - cursor.offset) refuse('truncated', 'Channel extends past payload', cursor.offset)
      const end = cursor.offset + length
      if (id >= 1 && id <= 3) {
        if (known.has(id)) refuse('channel', 'Duplicate known point channel', cursor.offset)
        known.set(id, new Cursor(bytes, cursor.offset, end))
      }
      cursor.offset = end
    }
    // Future channels are skipped without an object per block. A hostile payload can contain
    // millions of empty blocks; preserving them eagerly would expand a small string into a heap.
    const unknownChannels: Iterable<PointChannel> = {
      *[Symbol.iterator]() {
        const scan = new Cursor(bytes, channelStart)
        while (scan.offset < scan.end) {
          const id = scan.varint(), length = scan.varint()
          const end = scan.offset + length
          if (id < 1 || id > 3) yield { id, data: bytes.subarray(scan.offset, end) }
          scan.offset = end
        }
      },
    }
    const coords = known.get(1)
    if (!coords) refuse('channel', 'Coordinate channel is required')
    // Counts are untrusted. Refuse a tiny block claiming a million points before allocating arrays.
    if (coords.end - coords.offset < 1 + 2 * count || coords.end - coords.offset > 1 + 16 * count) refuse('channel', 'Coordinate block length cannot match point count')
    const k = coords.byte()
    if (k > POINT_LIMITS.exponent) refuse('coordinate', 'Point exponent exceeds 20')
    const scale = 2 ** k
    const xy = new Float64Array(2 * count)
    let x = 0, y = 0, dx = 0, dy = 0
    for (let i = 0; i < count; i++) {
      const ex = unzigzag(coords.varint()), ey = unzigzag(coords.varint())
      if (Math.abs(ex) > POINT_LIMITS.quantized || Math.abs(ey) > POINT_LIMITS.quantized) refuse('coordinate', 'Point difference exceeds ±2^50')
      if (i === 0) { x = ex; y = ey } else {
        dx = i === 1 ? ex : dx + ex; dy = i === 1 ? ey : dy + ey
        x += dx; y += dy
      }
      if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || Math.abs(x) > POINT_LIMITS.quantized
        || Math.abs(y) > POINT_LIMITS.quantized || Math.abs(x / scale) > POINT_LIMITS.world
        || Math.abs(y / scale) > POINT_LIMITS.world) refuse('coordinate', 'Decoded coordinate is outside the supported range')
      xy[2 * i] = x / scale; xy[2 * i + 1] = y / scale
    }
    coords.done()
    const pressureBlock = known.get(2)
    let pressure: Float64Array | null = null
    if (pressureBlock) {
      const length = pressureBlock.end - pressureBlock.offset
      if (length < count || length > 8 * count) refuse('channel', 'Pressure block length cannot match point count')
      pressure = new Float64Array(count)
      let q = 0
      for (let i = 0; i < count; i++) {
        const value = pressureBlock.varint()
        q = i === 0 ? value : q + unzigzag(value)
        if (!Number.isSafeInteger(q) || q < 0 || q > POINT_LIMITS.pressureQuanta) refuse('pressure', 'Decoded pressure is outside 0…16')
        pressure[i] = q / POINT_LIMITS.pressureQuantum
      }
      pressureBlock.done()
    }
    const runBlock = known.get(3)
    let runs: SegmentRuns | null = null
    if (runBlock) {
      const runCount = runBlock.varint()
      if (runCount < 1 || runCount > count || runBlock.end - runBlock.offset < 2 * runCount) refuse('runs', 'Invalid segment run count')
      const starts = new Uint32Array(runCount), kinds = new Uint8Array(runCount)
      let start = 0
      for (let i = 0; i < runCount; i++) {
        const delta = runBlock.varint(), kind = runBlock.byte()
        start += delta
        if ((i === 0 ? start !== 0 : delta === 0) || !Number.isSafeInteger(start) || start >= count || kind > 1) refuse('runs', 'Invalid segment start or kind')
        starts[i] = start; kinds[i] = kind
      }
      runBlock.done()
      runs = { starts, kinds }
    }
    return { xy, count, k, pressure, runs, unknownChannels }
  })
}
