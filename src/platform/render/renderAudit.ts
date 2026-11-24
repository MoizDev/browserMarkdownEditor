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
    readonly frames: Readonly<Record<string, { count: number; totalMs: number; maxMs: number; over16: number; over8: number }>>;
    /** Keyed `surface:stage`; `sum` and `max` are milliseconds, `count` the timed calls, `over8` the calls over a 120 Hz frame. */
    readonly stages: Readonly<Record<string, { sum: number; count: number; max: number; over8: number }>>;
}

/** The phases a GPU frame's main-thread time is split into; one name per stage keeps the table comparable across surfaces. */
/** `gpu-time` is one resolved GPU duration from the timer query (not CPU time), recorded where the result is read. */
export type AuditStage = 'parts' | 'admit' | 'upload' | 'prepare' | 'encodeOffscreen' | 'draw' | 'submit' | 'frame' | 'gpu-time';

let enabled = false;
try { enabled = typeof localStorage !== 'undefined' && localStorage.getItem('bme.renderAudit') === '1'; } catch { enabled = false; }
let since = typeof performance !== 'undefined' ? performance.now() : 0;
let counters = new Map<string, number>();
let frames = new Map<string, { count: number; totalMs: number; maxMs: number; over16: number; over8: number }>();
let stages = new Map<string, { sum: number; count: number; max: number; over8: number }>();
// A 120 Hz display's frame (the owner's ProMotion screen): a sum and a max cannot say how many frames missed it.
const FRAME_120HZ_MS = 1000 / 120;

export function renderAuditEnabled(): boolean { return enabled; }

/** Records one timed call of a stage. Callers read the clock only when `renderAuditEnabled()`, so this costs nothing off. */
export function auditStage(surface: string, stage: AuditStage, ms: number): void {
    if (!enabled || !Number.isFinite(ms)) return;
    const key = `${surface}:${stage}`;
    const entry = stages.get(key) ?? { sum: 0, count: 0, max: 0, over8: 0 };
    entry.sum += ms; entry.count++; entry.max = Math.max(entry.max, ms);
    if (ms > FRAME_120HZ_MS) entry.over8++;
    stages.set(key, entry);
}

/** Counts one event of a surface; `amount` adds to the `surface:event` count, `extra` to `surface:event:<key>`. */
/** A layer's audit view of a shared object (layerHost's per-layer device Proxy), mapped to the object it views. State shared per device is
 * keyed on the device itself: keyed on the view, the audit split it per layer, so a measured run did not behave as the product does
 * (measured: the exact-area pipelines shared per device compiled again for every drag preview's layer under the audit, gpu-f1). */
const auditViews = new WeakMap<object, object>();
export function registerAuditView(view: object, target: object): void { auditViews.set(view, target); }
export function auditViewTarget<T extends object>(value: T): T { return (auditViews.get(value) as T | undefined) ?? value; }
/** A weak map keyed on what a layer's view stands for (auditViewTarget): state kept per device is one per device with the audit on, as with
 * it off. Keyed on the view itself, the audit made per-layer copies the product never has (pipelines compiled per drag preview, a scratch
 * per layer), so a measured run did not measure the product. */
export class PerDeviceMap<K extends object, V> {
    private readonly map = new WeakMap<object, V>();
    get(key: K): V | undefined { return this.map.get(auditViewTarget(key)); }
    has(key: K): boolean { return this.map.has(auditViewTarget(key)); }
    set(key: K, value: V): this { this.map.set(auditViewTarget(key), value); return this; }
    delete(key: K): boolean { return this.map.delete(auditViewTarget(key)); }
}

export function auditCount(surface: string, event: string, amount = 1, extra?: Readonly<Record<string, number>>): void {
    if (!enabled) return;
    const key = `${surface}:${event}`;
    counters.set(key, (counters.get(key) ?? 0) + amount);
    if (TAPE_KEYS.test(event)) tape.add(key);
    if (extra) for (const name in extra) {
        const sub = `${key}:${name}`;
        counters.set(sub, (counters.get(sub) ?? 0) + extra[name]);
    }
}

/** One presented frame of a pane on a backend, with the main-thread time the frame took. */
export function auditFrame(backend: string, ms: number): void {
    if (!enabled || !Number.isFinite(ms)) return;
    const entry = frames.get(backend) ?? { count: 0, totalMs: 0, maxMs: 0, over16: 0, over8: 0 };
    entry.count++; entry.totalMs += ms; entry.maxMs = Math.max(entry.maxMs, ms);
    if (ms > 16.7) entry.over16++;
    if (ms > FRAME_120HZ_MS) entry.over8++;
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
    /** The camera and viewport the frame was drawn at (the frame's view): a kit that scores each present against the scene's own
     * geometry needs the exact camera of that present, which no other record carries. */
    readonly view: PresentView;
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
    /** The frame's tape: the decision counters (why each layer answered changed, which coverage check failed, who drew a stand-in)
     * counted since the scheduler started this frame. Phase counters cannot attribute a redundant present or a stand-in to its frame:
     * measured, 41 of 123 zoom presents redundant with every layer's reason summed over the phase (gpu-h2, gpu-h13). */
    readonly why: readonly string[];
}

/** A present's camera (world units at the pane origin, `z` its scale) and viewport (CSS pixels, `dpr`). */
export interface PresentView { readonly x: number; readonly y: number; readonly z: number; readonly width: number; readonly height: number; readonly dpr: number }
/** The present view of a frame's view, copied: the record must not hold the frame's objects. */
export function presentView(view: { readonly camera: { readonly x: number; readonly y: number; readonly z: number }; readonly viewport: { readonly width: number; readonly height: number; readonly dpr: number } }): PresentView {
    return { x: view.camera.x, y: view.camera.y, z: view.camera.z, width: view.viewport.width, height: view.viewport.height, dpr: view.viewport.dpr };
}

/** What a compositor passes to auditPresent. It states the layers' own verdict; auditPresent derives `exact` and `complete`
 * from the counts, so no caller can report a frame complete while it drew a stand-in or a hole. */
export interface PresentInput extends Omit<PresentInfo, 'complete' | 'exact' | 'why'> {
    readonly layersComplete: boolean;
}

/** A recorded present without its canvas reference, so the ring never keeps a canvas alive. */
export type PresentRecord = Omit<PresentInfo, 'canvas'>;

interface DrawnTally { standIns: number; standInsRaster: number; holes: number }

const PRESENT_CAPACITY = 1024;
const presentRing: (PresentRecord | undefined)[] = new Array(PRESENT_CAPACITY);
let presentTotal = 0;
let drawn: DrawnTally = { standIns: 0, standInsRaster: 0, holes: 0 };
/** The decision events that enter a frame's tape (see PresentInfo.why); per-item and per-draw counters stay out of it. */
const TAPE_KEYS = /^answer:|unchanged-miss|prepare:changed|prepare-changed|answer-miss|coverage-not|standin|incomplete|present-kept|present-skipped|^present:|^pan:|zoom:direct|refuse|held|^live:|passed-over|inflight:wait|claim-refused|settle:|repaint:|camera-unchanged|fallback:/;
let tape = new Set<string>();

/** The scheduler starts each frame's tape before any pane prepares; every present of the frame carries what was taped since. */
export function auditTapeStart(): void { if (enabled) { tape = new Set(); frameStart = new Map(counters); } }
/** The counters at the frame's start: a frame's record is what moved since (audit only, copied once per frame). */
let frameStart: Map<string, number> | null = null;

/** One frame's work as the audit saw it: its tape and every counter that moved since the scheduler started it. */
export interface FrameRecord { readonly t: number; readonly tape: readonly string[]; readonly delta: Readonly<Record<string, number>> }
/** A frame whose GPU time exceeded a 120 Hz frame, with what that frame did: the log that names each hitch's work. */
export interface SlowFrame extends FrameRecord { readonly ms: number }
/** One frame at 120 Hz: the GPU time a frame may take on the owner's display. */
const SLOW_FRAME_MS = 1000 / 120;
const SLOW_CAPACITY = 256;
const slowFrames: SlowFrame[] = [];
let slowDropped = 0;
/** The record of the frame being submitted, taken where its GPU timer ends; null when the audit is off. */
export function auditFrameRecord(): FrameRecord | null {
    if (!enabled) return null;
    const delta: Record<string, number> = {};
    for (const [key, value] of counters) { const moved = value - (frameStart?.get(key) ?? 0); if (moved) delta[key] = moved; }
    return { t: typeof performance !== 'undefined' ? performance.now() : 0, tape: [...tape], delta };
}
/** The GPU time of a recorded frame, once its timer resolves: kept when it is over a 120 Hz frame. */
export function auditFrameTime(ms: number, record: FrameRecord | null): void {
    if (!enabled || !record || !(ms > SLOW_FRAME_MS)) return;
    if (slowFrames.length >= SLOW_CAPACITY) { slowFrames.shift(); slowDropped++; }
    slowFrames.push({ ...record, ms });
}
export function auditSlowFrames(): { dropped: number; records: readonly SlowFrame[] } { return { dropped: slowDropped, records: slowFrames.slice() }; }
/** Adds a decision to the frame's tape without counting it. */
export function auditTape(entry: string): void { if (enabled) tape.add(entry); }

/** A layer reports, while it draws a frame, the stand-ins it drew and the positions it left with nothing. `origin` tells a
 * geometry stand-in (the default) from a raster stand-in; the layer classifies, the platform only counts. */
export function auditDrawn(kind: 'stand-in' | 'hole', count = 1, origin: 'geometry' | 'raster' = 'geometry', who = 'unnamed'): void {
    if (!enabled || !(count > 0)) return;
    tape.add(`drawn:${kind}:${origin}:${who}`);
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
    // The gate's rule (gpu): no hole and no geometry stand-in; a raster stand-in is complete only while a zoom is live.
    const complete = input.layersComplete && input.holes === 0 && input.standIns === 0 && (input.standInsRaster === 0 || input.zooming);
    const record: PresentRecord = { pane: input.pane, frame: input.frame, rawTick: input.rawTick, view: input.view, backend: input.backend,
        complete, standIns: input.standIns, standInsRaster: input.standInsRaster, holes: input.holes,
        zooming: input.zooming, exact, refusal: input.refusal, why: [...tape] };
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

/** A forced trim (audit only: the session kit proves that everything above the visible view and its ring is given back on request).
 * The runtime registers the governor's trim; the kit calls `__bmeRenderAudit.trim(pool)` and reads the charge again after it. */
let trimHook: ((pool: 'gpu' | 'cpu') => number) | null = null;
export function auditTrimHook(trim: (pool: 'gpu' | 'cpu') => number): void { if (enabled) trimHook = trim; }
function auditTrim(pool: 'gpu' | 'cpu'): number { return trimHook?.(pool) ?? -1; }

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

/** Named scene reads, audit only: a surface registers how to describe what it last presented (the board: its paint items and the
 * view they were drawn at), and the fidelity kit reads it at a screenshot to rasterise the exact reference of the same geometry
 * (FAULT-GPU.md, the truth yardstick). Read lazily: nothing is serialised unless the kit asks. Same replacement rule as gauges. */
const scenes = new Map<string, () => unknown>();
export function auditScene(name: string, read: () => unknown): () => void {
    if (!enabled) return () => {};
    scenes.set(name, read);
    return () => { if (scenes.get(name) === read) scenes.delete(name); };
}
export function auditScenes(): Record<string, unknown> {
    const values: Record<string, unknown> = {};
    for (const [name, read] of scenes) {
        try { values[name] = read(); } catch (error) { values[name] = { error: String(error) }; }
    }
    return values;
}

/** The first GPU error of each pane, audit only: what failed (its code and message), the arguments its throw site named as
 * failing validation (ArenaError.detail), and the top of its stack. Read with __bmeRenderAudit.gpuErrors(); never read by the device. */
export interface GpuErrorRecord { readonly pane: string | null; readonly where: string; readonly code: string; readonly message: string;
    readonly detail: unknown; readonly stack: readonly string[] }
const gpuErrors = new Map<string, GpuErrorRecord>();
export function auditGpuError(pane: string | null, where: string, error: unknown): void {
    if (!enabled) return;
    const key = pane ?? '';
    if (gpuErrors.has(key)) return;
    const record = (typeof error === 'object' && error !== null ? error : {}) as { code?: unknown; message?: unknown; detail?: unknown; stack?: unknown };
    gpuErrors.set(key, { pane, where, code: typeof record.code === 'string' ? record.code : 'unknown',
        message: typeof record.message === 'string' ? record.message : String(error), detail: record.detail ?? null,
        stack: typeof record.stack === 'string' ? record.stack.split('\n').slice(0, 16) : [] });
}
export function auditGpuErrors(): GpuErrorRecord[] { return [...gpuErrors.values()]; }

/** Every 'invalid-input' ArenaError constructed while the audit is on, in order (the first ARENA_LOG_CAPACITY; the rest counted),
 * with its arguments when the site named them and the top of its stack. Audit only. */
const ARENA_LOG_CAPACITY = 32;
const arenaLog: { code: string; detail: unknown; stack: readonly string[] }[] = [];
let arenaDropped = 0;
export function auditArenaError(code: string, detail: unknown, stack: string | undefined): void {
    if (!enabled) return;
    if (arenaLog.length >= ARENA_LOG_CAPACITY) { arenaDropped++; return; }
    arenaLog.push({ code, detail: detail ?? null, stack: (stack ?? '').split('\n').slice(0, 12) });
}
export function auditArenaErrors(): { dropped: number; records: readonly { code: string; detail: unknown; stack: readonly string[] }[] } {
    return { dropped: arenaDropped, records: arenaLog.slice() };
}

export function auditSnapshot(): RenderAuditSnapshot {
    return { enabled, since, counters: Object.fromEntries(counters),
        frames: Object.fromEntries([...frames].map(([key, value]) => [key, { ...value }])),
        stages: Object.fromEntries([...stages].map(([key, value]) => [key, { ...value }])) };
}

export function auditReset(): void {
    counters = new Map(); frames = new Map(); stages = new Map();
    presentRing.fill(undefined); presentTotal = 0; slowFrames.length = 0; slowDropped = 0; drawn = { standIns: 0, standInsRaster: 0, holes: 0 }; gpuErrors.clear(); arenaLog.length = 0; arenaDropped = 0;
    since = typeof performance !== 'undefined' ? performance.now() : 0;
}

if (enabled && typeof window !== 'undefined') {
    (window as unknown as { __bmeRenderAudit?: unknown }).__bmeRenderAudit = { snapshot: auditSnapshot, reset: auditReset, presents: auditPresents, gauges: auditGauges, scenes: auditScenes, gpuErrors: auditGpuErrors, arenaErrors: auditArenaErrors, slowFrames: auditSlowFrames, trim: auditTrim };
}
