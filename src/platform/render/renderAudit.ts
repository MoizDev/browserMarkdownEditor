export interface RenderAuditSnapshot {
    readonly enabled: boolean;
    readonly since: number;
    readonly counters: Readonly<Record<string, number>>;
    readonly frames: Readonly<Record<string, { count: number; totalMs: number; maxMs: number; over16: number; over8: number }>>;
    readonly stages: Readonly<Record<string, { sum: number; count: number; max: number; over8: number }>>;
}

export type AuditStage = 'parts' | 'admit' | 'upload' | 'prepare' | 'encodeOffscreen' | 'draw' | 'submit' | 'frame' | 'gpu-time';

let enabled = false;
try { enabled = typeof localStorage !== 'undefined' && localStorage.getItem('bme.renderAudit') === '1'; } catch { enabled = false; }
let since = typeof performance !== 'undefined' ? performance.now() : 0;
let counters = new Map<string, number>();
let frames = new Map<string, { count: number; totalMs: number; maxMs: number; over16: number; over8: number }>();
let stages = new Map<string, { sum: number; count: number; max: number; over8: number }>();
const FRAME_120HZ_MS = 1000 / 120;

export function renderAuditEnabled(): boolean { return enabled; }

export function auditStage(surface: string, stage: AuditStage, ms: number): void {
    if (!enabled || !Number.isFinite(ms)) return;
    const key = `${surface}:${stage}`;
    const entry = stages.get(key) ?? { sum: 0, count: 0, max: 0, over8: 0 };
    entry.sum += ms; entry.count++; entry.max = Math.max(entry.max, ms);
    if (ms > FRAME_120HZ_MS) entry.over8++;
    stages.set(key, entry);
}

const auditViews = new WeakMap<object, object>();
export function registerAuditView(view: object, target: object): void { auditViews.set(view, target); }
export function auditViewTarget<T extends object>(value: T): T { return (auditViews.get(value) as T | undefined) ?? value; }
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

export function auditFrame(backend: string, ms: number): void {
    if (!enabled || !Number.isFinite(ms)) return;
    const entry = frames.get(backend) ?? { count: 0, totalMs: 0, maxMs: 0, over16: 0, over8: 0 };
    entry.count++; entry.totalMs += ms; entry.maxMs = Math.max(entry.maxMs, ms);
    if (ms > 16.7) entry.over16++;
    if (ms > FRAME_120HZ_MS) entry.over8++;
    frames.set(backend, entry);
}

export function auditTimed(surface: string, work: () => void): void {
    if (!enabled) { work(); return; }
    const started = performance.now();
    try { work(); } finally { auditFrame(surface, performance.now() - started); }
}

export interface PresentInfo {
    readonly pane: string | null;
    readonly frame: number;
    readonly rawTick: number;
    readonly backend: 'webgl2' | 'canvas2d';
    readonly view: PresentView;
    readonly complete: boolean;
    readonly canvas: HTMLCanvasElement | null;
    readonly standIns: number;
    readonly standInsRaster: number;
    readonly holes: number;
    readonly zooming: boolean;
    readonly exact: boolean;
    readonly refusal: string | null;
    readonly why: readonly string[];
}

export interface PresentView { readonly x: number; readonly y: number; readonly z: number; readonly width: number; readonly height: number; readonly dpr: number }
export function presentView(view: { readonly camera: { readonly x: number; readonly y: number; readonly z: number }; readonly viewport: { readonly width: number; readonly height: number; readonly dpr: number } }): PresentView {
    return { x: view.camera.x, y: view.camera.y, z: view.camera.z, width: view.viewport.width, height: view.viewport.height, dpr: view.viewport.dpr };
}

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
const TAPE_KEYS = /^answer:|unchanged-miss|prepare:changed|prepare-changed|answer-miss|coverage-not|standin|incomplete|present-kept|present-skipped|^present:|^pan:|zoom:direct|refuse|held|^live:|passed-over|inflight:wait|claim-refused|settle:|repaint:|camera-unchanged|fallback:/;
let tape = new Set<string>();

export function auditTapeStart(): void { if (enabled) { tape = new Set(); frameStart = new Map(counters); } }
let frameStart: Map<string, number> | null = null;

export interface FrameRecord { readonly t: number; readonly tape: readonly string[]; readonly delta: Readonly<Record<string, number>> }
export interface SlowFrame extends FrameRecord { readonly ms: number }
const SLOW_FRAME_MS = 1000 / 120;
const SLOW_CAPACITY = 256;
const slowFrames: SlowFrame[] = [];
let slowDropped = 0;
export function auditFrameRecord(): FrameRecord | null {
    if (!enabled) return null;
    const delta: Record<string, number> = {};
    for (const [key, value] of counters) { const moved = value - (frameStart?.get(key) ?? 0); if (moved) delta[key] = moved; }
    return { t: typeof performance !== 'undefined' ? performance.now() : 0, tape: [...tape], delta };
}
export function auditFrameTime(ms: number, record: FrameRecord | null): void {
    if (!enabled || !record || !(ms > SLOW_FRAME_MS)) return;
    if (slowFrames.length >= SLOW_CAPACITY) { slowFrames.shift(); slowDropped++; }
    slowFrames.push({ ...record, ms });
}
export function auditSlowFrames(): { dropped: number; records: readonly SlowFrame[] } { return { dropped: slowDropped, records: slowFrames.slice() }; }
export function auditTape(entry: string): void { if (enabled) tape.add(entry); }

export function auditDrawn(kind: 'stand-in' | 'hole', count = 1, origin: 'geometry' | 'raster' = 'geometry', who = 'unnamed'): void {
    if (!enabled || !(count > 0)) return;
    tape.add(`drawn:${kind}:${origin}:${who}`);
    if (kind === 'hole') drawn.holes += count;
    else if (origin === 'raster') drawn.standInsRaster += count;
    else drawn.standIns += count;
}

export function auditDrawnStart(): void { drawn = { standIns: 0, standInsRaster: 0, holes: 0 }; }
export function auditDrawnTake(): DrawnTally {
    const taken = drawn;
    drawn = { standIns: 0, standInsRaster: 0, holes: 0 };
    return taken;
}

export function auditPresent(input: PresentInput): void {
    if (!enabled) return;
    const exact = input.standIns === 0 && input.standInsRaster === 0 && input.holes === 0;
    const complete = input.layersComplete && input.holes === 0 && input.standIns === 0 && (input.standInsRaster === 0 || input.zooming);
    const record: PresentRecord = { pane: input.pane, frame: input.frame, rawTick: input.rawTick, view: input.view, backend: input.backend,
        complete, standIns: input.standIns, standInsRaster: input.standInsRaster, holes: input.holes,
        zooming: input.zooming, exact, refusal: input.refusal, why: [...tape] };
    presentRing[presentTotal % PRESENT_CAPACITY] = record;
    presentTotal++;
    (globalThis as unknown as { __bmePresentHook?: (info: PresentInfo) => void }).__bmePresentHook?.({ ...record, canvas: input.canvas });
}

export function auditPresents(): { dropped: number; records: readonly PresentRecord[] } {
    const kept = Math.min(presentTotal, PRESENT_CAPACITY);
    const records: PresentRecord[] = [];
    for (let i = presentTotal - kept; i < presentTotal; i++) {
        const record = presentRing[i % PRESENT_CAPACITY];
        if (record) records.push(record);
    }
    return { dropped: presentTotal - kept, records };
}

let trimHook: ((pool: 'gpu' | 'cpu') => number) | null = null;
export function auditTrimHook(trim: (pool: 'gpu' | 'cpu') => number): void { if (enabled) trimHook = trim; }
function auditTrim(pool: 'gpu' | 'cpu'): number { return trimHook?.(pool) ?? -1; }

const gauges = new Map<string, () => number>();
export function auditGauge(name: string, read: () => number): () => void {
    if (!enabled) return () => {};
    gauges.set(name, read);
    return () => { if (gauges.get(name) === read) gauges.delete(name); };
}
export function auditGauges(): Record<string, number> {
    const values: Record<string, number> = {};
    for (const [name, read] of gauges) {
        try { values[name] = read(); } catch { values[name] = Number.NaN; }
    }
    return values;
}

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
