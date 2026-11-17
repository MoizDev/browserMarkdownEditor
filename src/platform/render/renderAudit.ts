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

export function auditSnapshot(): RenderAuditSnapshot {
    return { enabled, since, counters: Object.fromEntries(counters),
        frames: Object.fromEntries([...frames].map(([key, value]) => [key, { ...value }])),
        stages: Object.fromEntries([...stages].map(([key, value]) => [key, { ...value }])) };
}

export function auditReset(): void {
    counters = new Map(); frames = new Map(); stages = new Map();
    since = typeof performance !== 'undefined' ? performance.now() : 0;
}

if (enabled && typeof window !== 'undefined') {
    (window as unknown as { __bmeRenderAudit?: unknown }).__bmeRenderAudit = { snapshot: auditSnapshot, reset: auditReset };
}
