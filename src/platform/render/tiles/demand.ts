import type { Rect } from '../../types';
import { RENDER_CONSTANTS as POLICY } from '../constants';
import { tileKeyString, validateTileRect } from './geometry';
import type { TileKey } from './geometry';

export type TileDemandClass = 'visible-hole' | 'visible-exact' | 'prefetch';

export interface TileDemand {
    readonly paneId: string;
    readonly key: TileKey;
    readonly class: TileDemandClass;
    readonly distanceToViewportCentre: number;
    /** Lower is preferred: the producer can bias equal-distance work toward travel. */
    readonly travelBias: number;
    readonly enqueuedAt: number;
    readonly visibleSince: number | null;
}

export function tileDemandId(demand: Pick<TileDemand, 'paneId' | 'key'>): string {
    return JSON.stringify([demand.paneId, tileKeyString(demand.key)]);
}

function stable(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function priority(kind: TileDemandClass): number { return kind === 'visible-hole' ? 0 : kind === 'visible-exact' ? 1 : 2; }

function validateDemand(demand: TileDemand, now: number): void {
    if (!demand.paneId || !Number.isFinite(now) || !Number.isFinite(demand.distanceToViewportCentre) ||
        demand.distanceToViewportCentre < 0 || !Number.isFinite(demand.travelBias) ||
        !Number.isFinite(demand.enqueuedAt) || demand.enqueuedAt > now ||
        (demand.class === 'prefetch' ? demand.visibleSince !== null : demand.visibleSince === null) ||
        (demand.visibleSince !== null && (!Number.isFinite(demand.visibleSince) || demand.visibleSince > now))) {
        throw new RangeError('Invalid tile demand');
    }
}

function compare(a: TileDemand, b: TileDemand, now: number): number {
    const aged = (demand: TileDemand) => demand.class !== 'prefetch' && demand.visibleSince !== null &&
        now - demand.visibleSince >= POLICY.demandAgePromotionMs;
    // Vr-lead §5.7 ruling: age promotes within a class only; sharpening never jumps a hole.
    return priority(a.class) - priority(b.class) || Number(aged(b)) - Number(aged(a)) ||
        a.distanceToViewportCentre - b.distanceToViewportCentre || a.travelBias - b.travelBias ||
        a.enqueuedAt - b.enqueuedAt || stable(tileDemandId(a), tileDemandId(b));
}

function unique(demands: readonly TileDemand[], now: number): Map<string, TileDemand> {
    const result = new Map<string, TileDemand>();
    for (const demand of demands) {
        validateDemand(demand, now);
        const id = tileDemandId(demand);
        const previous = result.get(id);
        if (!previous || compare(demand, previous, now) < 0) result.set(id, demand);
    }
    return result;
}

interface Turn { paneId: string; used: number }

/** One decision per dispatch, not a precomputed drain order (§5.7:571–573).
 * The host supplies only queued entries and revalidates eligibility again after every completion.
 */
export class TileDemandOrder {
    private readonly turns = new Map<TileDemandClass, Turn>();

    next(demands: readonly TileDemand[], focusedPaneId: string | null, now: number,
        eligible: (demand: TileDemand) => boolean): TileDemand | null {
        const ready = [...unique(demands, now).values()].filter(eligible);
        if (!ready.length) return null;
        const firstClass = ready.reduce((best, demand) => priority(demand.class) < priority(best) ? demand.class : best, ready[0].class);
        const byPane = new Map<string, TileDemand[]>();
        for (const demand of ready) {
            if (demand.class !== firstClass) continue;
            const group = byPane.get(demand.paneId) ?? [];
            group.push(demand);
            byPane.set(demand.paneId, group);
        }
        const panes = [...byPane.keys()].sort(stable);
        const previous = this.turns.get(firstClass);
        let paneId = panes[0];
        let used = 0;
        if (previous) {
            const index = panes.indexOf(previous.paneId);
            const weight = previous.paneId === focusedPaneId ? POLICY.focusedPaneWeight : POLICY.unfocusedPaneWeight;
            if (index >= 0 && previous.used < weight) { paneId = previous.paneId; used = previous.used; }
            else if (index >= 0) paneId = panes[(index + 1) % panes.length];
            else paneId = panes.find(id => stable(id, previous.paneId) > 0) ?? panes[0];
        } else if (focusedPaneId && byPane.has(focusedPaneId)) paneId = focusedPaneId;
        this.turns.set(firstClass, { paneId, used: used + 1 });
        return byPane.get(paneId)!.sort((a, b) => compare(a, b, now))[0];
    }
}

export interface ReconciledTileDemand {
    readonly queued: readonly TileDemand[];
    readonly retainedRunning: readonly TileDemand[];
    readonly cancelQueued: readonly TileDemand[];
    /** Best effort only; the host still owns each eventual reply/transfer until it closes/adopts it. */
    readonly cancelRunning: readonly TileDemand[];
}

/** Equal keys survive camera epochs and rename; source/content changes are different keys. */
export function reconcileTileDemand(queued: readonly TileDemand[], running: readonly TileDemand[],
    desired: readonly TileDemand[], now: number, stillUseful: (running: TileDemand) => boolean): ReconciledTileDemand {
    const oldQueued = unique(queued, now);
    const oldRunning = unique(running, now);
    const wanted = unique(desired, now);
    const nextQueued: TileDemand[] = [];
    const retainedRunning: TileDemand[] = [];
    for (const [id, demand] of wanted) {
        const previous = oldRunning.get(id) ?? oldQueued.get(id);
        const next = previous ? { ...demand, enqueuedAt: previous.enqueuedAt,
            visibleSince: demand.class !== 'prefetch' && previous.class !== 'prefetch' ?
                previous.visibleSince ?? demand.visibleSince : demand.visibleSince } : demand;
        if (oldRunning.has(id)) retainedRunning.push(next);
        else nextQueued.push(next);
    }
    const cancelRunning: TileDemand[] = [];
    for (const [id, demand] of oldRunning) {
        if (wanted.has(id)) continue;
        // The consumer revalidates content/source and useful stand-in regions, not camera epoch.
        if (stillUseful(demand)) retainedRunning.push(demand);
        else cancelRunning.push(demand);
    }
    return {
        queued: nextQueued, retainedRunning, cancelRunning,
        cancelQueued: [...oldQueued].filter(([id]) => !wanted.has(id)).map(([, demand]) => demand),
    };
}

export interface TileMotionObservation {
    readonly frameId: number;
    readonly now: number;
    readonly x: number;
    readonly y: number;
    /** Camera zoom * renderDpr; a pinch can change scale without moving the camera origin. */
    readonly scale: number;
    readonly phase: 'idle' | 'pan' | 'pinch' | 'fling' | 'end';
}

export interface TileMotionDecision {
    readonly generateMotionSet: boolean;
    readonly requestExact: boolean;
    readonly velocity: Readonly<{ x: number; y: number }>;
    readonly direction: Readonly<{ x: number; y: number }>;
    /** Cancel queued speculation now, even when the next pinch-level demand set is coalesced. */
    readonly reversed: boolean;
    /** Scheduler-owned wakeup; this module never creates a timer or a frame loop. */
    readonly wakeAt: number | null;
}

interface MotionSample { x: number; y: number; now: number }

/** Observe the shared frame's actual camera; don't build a second input sampler (§5.7:573–575). */
export class TileMotionDemand {
    private samples: MotionSample[] = [];
    private lastFrame = -1;
    private lastNow = -Infinity;
    private lastScale: number | null = null;
    private lastMovementAt: number | null = null;
    private lastSetAt: number | null = null;
    private lastSetFrame = -1;
    private exactIssued = false;
    private direction = { x: 0, y: 0 };

    observe(observation: TileMotionObservation): TileMotionDecision {
        const { frameId, now, x, y, scale, phase } = observation;
        if (!Number.isSafeInteger(frameId) || frameId < 0 || frameId < this.lastFrame ||
            ![now, x, y, scale].every(Number.isFinite) || scale <= 0 || now < this.lastNow) throw new RangeError('Invalid tile motion frame');
        const previous = this.samples.at(-1);
        const moved = !previous || x !== previous.x || y !== previous.y || scale !== this.lastScale;
        const delta = previous ? { x: x - previous.x, y: y - previous.y } : { x: 0, y: 0 };
        if (![delta.x, delta.y].every(Number.isFinite)) throw new RangeError('Tile motion delta overflow');
        const previousDirection = this.direction;
        const turned = previous && (delta.x !== 0 || delta.y !== 0) &&
            (previousDirection.x !== 0 || previousDirection.y !== 0) &&
            (delta.x * previousDirection.x + delta.y * previousDirection.y <= 0 ||
                delta.x * previousDirection.x < 0 || delta.y * previousDirection.y < 0);
        if (moved) { this.lastMovementAt = now; this.exactIssued = false; this.direction = delta; }
        if (frameId === this.lastFrame || now === this.lastNow) this.samples[this.samples.length - 1] = { x, y, now };
        else this.samples.push({ x, y, now });
        this.lastFrame = frameId;
        this.lastNow = now;
        this.lastScale = scale;
        const boundary = now - POLICY.velocityWindowMs;
        while (this.samples.length > 2 && this.samples[1].now <= boundary) this.samples.shift();
        let first = this.samples[0];
        const next = this.samples[1];
        if (first.now < boundary && next && next.now > first.now) {
            const fraction = Math.min(1, (boundary - first.now) / (next.now - first.now));
            first = { x: first.x + (next.x - first.x) * fraction, y: first.y + (next.y - first.y) * fraction,
                now: Math.min(boundary, next.now) };
        }
        const elapsed = now - first.now;
        const velocity = elapsed > 0 ? { x: (x - first.x) / elapsed * 1000, y: (y - first.y) / elapsed * 1000 } : { x: 0, y: 0 };
        if (![velocity.x, velocity.y].every(Number.isFinite)) throw new RangeError('Tile motion velocity overflow');
        const reversed = Boolean(turned);
        const moving = phase !== 'idle' && phase !== 'end';
        const generateMotionSet = moving && moved && frameId !== this.lastSetFrame &&
            (phase !== 'pinch' || this.lastSetAt === null || now - this.lastSetAt >= POLICY.pinchDemandIntervalMs);
        if (generateMotionSet) { this.lastSetAt = now; this.lastSetFrame = frameId; }
        const quietAt = this.lastMovementAt === null ? now : this.lastMovementAt + POLICY.settledDemandDelayMs;
        const requestExact = !this.exactIssued && (phase === 'end' || phase === 'idle' || now >= quietAt);
        if (requestExact) this.exactIssued = true;
        return { generateMotionSet, requestExact, velocity, direction: { ...this.direction }, reversed,
            wakeAt: this.exactIssued ? null : quietAt };
    }
}

/** Velocity is world units/second, matching the supplied world viewport (§5.7:573). */
export function tilePrefetchRegion(viewport: Readonly<Rect>, velocity: Readonly<{ x: number; y: number }>,
    lowCoverage = false, direction: Readonly<{ x: number; y: number }> = velocity): Rect {
    validateTileRect(viewport);
    if (![velocity.x, velocity.y, direction.x, direction.y].every(Number.isFinite)) throw new RangeError('Invalid tile prefetch velocity');
    const extent = (size: number, speed: number, travel: number) => {
        const behind = size * (lowCoverage ? POLICY.lowPreviewBehindViewports : POLICY.prefetchBehindViewports);
        const ahead = lowCoverage ? size * POLICY.lowPreviewAheadViewports :
            Math.min(size * POLICY.prefetchMaxViewports, Math.max(size * POLICY.prefetchMinViewports,
                Math.abs(speed) * POLICY.prefetchHorizonSeconds));
        return travel < 0 ? { before: ahead, after: behind } : travel > 0 ?
            { before: behind, after: ahead } : { before: behind, after: behind };
    };
    const horizontal = extent(viewport.width, velocity.x, direction.x);
    const vertical = extent(viewport.height, velocity.y, direction.y);
    const region = { x: viewport.x - horizontal.before, y: viewport.y - vertical.before,
        width: viewport.width + horizontal.before + horizontal.after,
        height: viewport.height + vertical.before + vertical.after };
    validateTileRect(region);
    return region;
}

/** Host owns the real deadline/healthy-worker retry; merely awaiting a reply is not frame work. */
export function tileWatchdogAction(startedAt: number, now: number, failures: number,
    timeoutMs: number = POLICY.tileWatchdogMs): 'waiting' | 'retry' | 'failed' {
    if (![startedAt, now, timeoutMs].every(Number.isFinite) || now < startedAt || timeoutMs <= 0 ||
        !Number.isSafeInteger(failures) || failures < 0) throw new RangeError('Invalid tile watchdog');
    if (now - startedAt < timeoutMs) return 'waiting';
    return failures < POLICY.tileRetryCount ? 'retry' : 'failed';
}
