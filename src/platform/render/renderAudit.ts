/**
 * Measured inventory of what does the drawing work, per surface, in the running app. Off unless the browser setting
 * `bme.renderAudit` is "1" when the platform first loads; when off, every call is one boolean test. The audit of the
 * GPU path is read from here (window.__bmeRenderAudit), never inferred from the code: the backend once shipped without
 * ever having run.
 *
 * Events, by convention (a surface may add its own):
 *   gpu-draw       a draw call that made the surface's pixels on the GPU (shader/geometry)
 *   gpu-quad       a textured quad that composited pixels made elsewhere
 *   cpu-raster     pixels made by a CPU raster (count; `px` adds the pixel area)
 *   upload         a texture/buffer upload (count; `bytes` adds the bytes)
 *   canvas2d       the surface drawn by the 2D backend
 *   fallback:*     a fallback or bridge was taken (raster-route, 2d-bridge, pane-2d, ...)
 */
export interface RenderAuditSnapshot {
    readonly enabled: boolean;
    readonly since: number;
    readonly counters: Readonly<Record<string, number>>;
    readonly frames: Readonly<Record<string, { count: number; totalMs: number; maxMs: number; over16: number }>>;
    /** Keyed `surface:stage`; `sum` and `max` are milliseconds, `count` the timed calls. */
    readonly stages: Readonly<Record<string, { sum: number; count: number; max: number }>>;
}

/** The phases a GPU frame's main-thread time is split into; one name per stage keeps the table comparable across surfaces. */
/** `gpu-time` is one resolved GPU duration from the timer query (not CPU time), recorded where the result is read. */
export type AuditStage = 'parts' | 'admit' | 'upload' | 'prepare' | 'encodeOffscreen' | 'draw' | 'submit' | 'frame' | 'gpu-time';

let enabled = false;
try { enabled = typeof localStorage !== 'undefined' && localStorage.getItem('bme.renderAudit') === '1'; } catch { enabled = false; }
let since = typeof performance !== 'undefined' ? performance.now() : 0;
let counters = new Map<string, number>();
let frames = new Map<string, { count: number; totalMs: number; maxMs: number; over16: number }>();
let stages = new Map<string, { sum: number; count: number; max: number }>();

export function renderAuditEnabled(): boolean { return enabled; }

/** Records one timed call of a stage. Callers read the clock only when `renderAuditEnabled()`, so this costs nothing off. */
export function auditStage(surface: string, stage: AuditStage, ms: number): void {
    if (!enabled || !Number.isFinite(ms)) return;
    const key = `${surface}:${stage}`;
    const entry = stages.get(key) ?? { sum: 0, count: 0, max: 0 };
    entry.sum += ms; entry.count++; entry.max = Math.max(entry.max, ms);
    stages.set(key, entry);
}

/** Counts one event of a surface; `amount` adds to the `surface:event` count, `extra` to `surface:event:<key>`. */
export function auditCount(surface: string, event: string, amount = 1, extra?: Readonly<Record<string, number>>): void {
    if (!enabled) return;
    const key = `${surface}:${event}`;
    counters.set(key, (counters.get(key) ?? 0) + amount);
    if (extra) for (const name in extra) {
        const sub = `${key}:${name}`;
        counters.set(sub, (counters.get(sub) ?? 0) + extra[name]);
    }
}

/** One presented frame of a pane on a backend, with the main-thread time the frame took. */
export function auditFrame(backend: string, ms: number): void {
    if (!enabled || !Number.isFinite(ms)) return;
    const entry = frames.get(backend) ?? { count: 0, totalMs: 0, maxMs: 0, over16: 0 };
    entry.count++; entry.totalMs += ms; entry.maxMs = Math.max(entry.maxMs, ms);
    if (ms > 16.7) entry.over16++;
    frames.set(backend, entry);
}

/** Times one frame's work under a surface name; a plain call when the audit is off. */
export function auditTimed(surface: string, work: () => void): void {
    if (!enabled) { work(); return; }
    const started = performance.now();
    try { work(); } finally { auditFrame(surface, performance.now() - started); }
}

/** A frame at its presentation point: presented, or refused (`refusal` names why). `canvas` is the pane's canvas that drew the
 * frame, readable in the same task as the draw; null for a refused frame. Counts are what the layers reported drawing. */
export interface PresentInfo {
    readonly pane: string | null;
    readonly frame: number;
    readonly rawTick: number;
    readonly backend: 'webgl2' | 'canvas2d';
    /** Every layer reported complete, and the frame is exact. */
    readonly complete: boolean;
    readonly canvas: HTMLCanvasElement | null;
    /** Geometry stand-ins drawn this frame: positions drawn with another scale's geometry. 0 when none was reported. */
    readonly standIns: number;
    /** Raster stand-ins drawn this frame: positions drawn from a raster made at another scale. 0 when none was reported. */
    readonly standInsRaster: number;
    /** Positions left with nothing drawn. 0 when none was reported. */
    readonly holes: number;
    /** A zoom is live: the camera scale changed since this compositor's previous encode. */
    readonly zooming: boolean;
    /** No stand-ins of either kind and no holes. */
    readonly exact: boolean;
    /** Why the frame was refused instead of presented; null for a presented frame. */
    readonly refusal: string | null;
}

/** What a compositor passes to auditPresent. It states the layers' own verdict; auditPresent derives `exact` and `complete`
 * from the counts, so no caller can report a frame complete while it drew a stand-in or a hole. */
export interface PresentInput extends Omit<PresentInfo, 'complete' | 'exact'> {
    readonly layersComplete: boolean;
}

/** A recorded present without its canvas reference, so the ring never keeps a canvas alive. */
export type PresentRecord = Omit<PresentInfo, 'canvas'>;

interface DrawnTally { standIns: number; standInsRaster: number; holes: number }

const PRESENT_CAPACITY = 1024;
const presentRing: (PresentRecord | undefined)[] = new Array(PRESENT_CAPACITY);
let presentTotal = 0;
let drawn: DrawnTally = { standIns: 0, standInsRaster: 0, holes: 0 };

/** A layer reports, while it draws a frame, the stand-ins it drew and the positions it left with nothing. `origin` tells a
 * geometry stand-in (the default) from a raster stand-in; the layer classifies, the platform only counts. */
export function auditDrawn(kind: 'stand-in' | 'hole', count = 1, origin: 'geometry' | 'raster' = 'geometry'): void {
    if (!enabled || !(count > 0)) return;
    if (kind === 'hole') drawn.holes += count;
    else if (origin === 'raster') drawn.standInsRaster += count;
    else drawn.standIns += count;
}

/** The compositor starts a frame's tally before its layers draw, and takes it once they have drawn. */
export function auditDrawnStart(): void { drawn = { standIns: 0, standInsRaster: 0, holes: 0 }; }
export function auditDrawnTake(): DrawnTally {
    const taken = drawn;
    drawn = { standIns: 0, standInsRaster: 0, holes: 0 };
    return taken;
}

/** Records a frame at its presentation point. Off unless the audit is on: one boolean test. Each record enters a bounded ring
 * (read with auditPresents, exposed as window.__bmeRenderAudit.presents()), and the audit kit's `__bmePresentHook`, if
 * installed, receives the full info, canvas included. */
export function auditPresent(input: PresentInput): void {
    if (!enabled) return;
    const exact = input.standIns === 0 && input.standInsRaster === 0 && input.holes === 0;
    const record: PresentRecord = { pane: input.pane, frame: input.frame, rawTick: input.rawTick, backend: input.backend,
        complete: input.layersComplete && exact, standIns: input.standIns, standInsRaster: input.standInsRaster, holes: input.holes,
        zooming: input.zooming, exact, refusal: input.refusal };
    presentRing[presentTotal % PRESENT_CAPACITY] = record;
    presentTotal++;
    (globalThis as unknown as { __bmePresentHook?: (info: PresentInfo) => void }).__bmePresentHook?.({ ...record, canvas: input.canvas });
}

/** The recent presents, oldest first. `dropped` counts the records the ring has overwritten since the last reset. */
export function auditPresents(): { dropped: number; records: readonly PresentRecord[] } {
    const kept = Math.min(presentTotal, PRESENT_CAPACITY);
    const records: PresentRecord[] = [];
    for (let i = presentTotal - kept; i < presentTotal; i++) {
        const record = presentRing[i % PRESENT_CAPACITY];
        if (record) records.push(record);
    }
    return { dropped: presentTotal - kept, records };
}

/** Named gauges: a surface registers a read of a live value (a node count, a cache size) and the audit reads it when asked.
 * Off, registering returns a no-op and nothing is kept. A registration under a name replaces the earlier one; the returned
 * function removes it only while it is still this one. */
const gauges = new Map<string, () => number>();
export function auditGauge(name: string, read: () => number): () => void {
    if (!enabled) return () => {};
    gauges.set(name, read);
    return () => { if (gauges.get(name) === read) gauges.delete(name); };
}
/** The current value of every registered gauge; a read that throws reads as NaN. */
export function auditGauges(): Record<string, number> {
    const values: Record<string, number> = {};
    for (const [name, read] of gauges) {
        try { values[name] = read(); } catch { values[name] = Number.NaN; }
    }
    return values;
}

export function auditSnapshot(): RenderAuditSnapshot {
    return { enabled, since, counters: Object.fromEntries(counters),
        frames: Object.fromEntries([...frames].map(([key, value]) => [key, { ...value }])),
        stages: Object.fromEntries([...stages].map(([key, value]) => [key, { ...value }])) };
}

export function auditReset(): void {
    counters = new Map(); frames = new Map(); stages = new Map();
    presentRing.fill(undefined); presentTotal = 0; drawn = { standIns: 0, standInsRaster: 0, holes: 0 };
    since = typeof performance !== 'undefined' ? performance.now() : 0;
}

if (enabled && typeof window !== 'undefined') {
    (window as unknown as { __bmeRenderAudit?: unknown }).__bmeRenderAudit = { snapshot: auditSnapshot, reset: auditReset, presents: auditPresents, gauges: auditGauges };
}
