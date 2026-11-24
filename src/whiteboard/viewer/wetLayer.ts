import type { ViewState } from '../../platform/types';
import type { PlatformLayerDefinition } from '../../platform/render/attachPlatformPane.types';
import type { LayerCoverage, LayerHost } from '../../platform/render/compositor.types';
import type { ByteLease, GfxDevice, GpuPass, TextureHandle } from '../../platform/render/gfx/api';
import { auditCount, renderAuditEnabled } from '../../platform/render/renderAudit';
import type { FrameBudget, FrameToken, Layer, RenderToken } from '../../platform/render/types';
import { InkCoverageJob, InkOutlineJob, type InkCoverage } from '../ink/outline';
import { materializeCurveRange, type CurveGeometry } from '../ink/curve';
import { DOT_METRIC_PROVISIONAL, type InkDot, type InkWidth } from '../ink/width';
import type { BoardWetLayer } from '../input/attach';
import type { DryInkIdentity, WetInkHandover, WetInkSnapshot } from '../input/liveInk';
import type { Swatch } from '../model/styles';
import { colourCss, resolveSwatch, withOpacity, type PaintPalette } from '../render/colour';
import { inkCoverageChunks } from '../render/paintStream';
import { HIGHLIGHT_OVERLAY_ALPHA, HIGHLIGHT_UNDERLAY_ALPHA, inkMaterial, type InkMaterial } from '../render/material';
import type { PaintSource, PaintInkItem, PaintClip } from '../render/paintStream';
import type { Admission, CreateInkRoutes, InkRouteFor, ItemRoute, PreparedRun, WithClips } from '../render/gpu/contracts';
import { awaitSizedCapacity, isBudgetRefusal } from '../render/budgetRefusal';
import { ArenaError } from '../../platform/render/resourceArena';
import { appendPath2d, path2d } from '../render/reference/coverage2d';

// Provenance: wet/dry ink handover, bounded ink outline and C4 layer contracts;
// independently wired renderer, no third-party source.
/** The primitive ceiling of one chunk's coverage job (its segment, disc and centreline stores). */
const CHUNK_PRIMITIVES = 4096;
const CHUNK = 256, FINAL_SPANS = 16, PATH_BLOCK = 256 * 1024;
/** The scratch a chunk's tessellation holds, derived from what it can reach: per span its cubics (8 doubles), flags (1 byte) and
 * radii (2 doubles); and the coverage job's three stores at their ceiling (6 + 3 + 4 doubles per primitive). A store grows by copy,
 * so it holds its old and new arrays for a moment: 3/2 of the ceiling. 660 KB, not the 4 MiB it was sized at before. */
const TEMP_BYTES = CHUNK * (8 * 8 + 1 + 2 * 8) + Math.ceil(CHUNK_PRIMITIVES * (6 + 3 + 4) * 8 * 3 / 2);
/** The tip's upload grant past a frame's yield: one kit upload piece (64 KiB), so a chunk's append always fits. */
const TIP_UPLOAD_BYTES = 64 * 1024;
/** The most a deferred run waits for on the upload meter: one kit upload piece (the path kit writes 64 KiB pieces). */
const WAIT_UPLOAD_BYTES = 64 * 1024;
type Bounds = { x: number; y: number; w: number; h: number };
type Prepared = { readonly snapshot: WetInkSnapshot; path: Path2D | null; readonly origin: readonly [number, number]; readonly leases: ByteLease[];
    readonly scale: number; readonly bounds: Bounds | null; readonly coverageChunks: readonly InkCoverage[]; readonly serial: number };
// The finalized prefix of one stroke. A span the curve has finalized (publication.finalizedSpanCount) keeps its coverage
// for the stroke's life, so a growing stroke tessellates only its replaceable tail.
type Stable = { readonly nodeId: string; readonly scale: number; readonly origin: readonly [number, number]; spans: number;
    chunks: InkCoverage[]; bounds: Bounds | null; dot: boolean; scan: number; buffers: Set<ArrayBufferLike>; leases: ByteLease[];
    /** The tessellation scratch of this stroke, held for its life: one chunk runs at a time, and a publication per input frame
     * reserved and released it again otherwise. */
    temp: ByteLease | null;
    /** The width of the stroke's chunks: one per stroke, not one per tip. */
    style: InkWidth | null };
type Tail = { chunks: InkCoverage[]; bounds: Bounds | null; buffers: Set<ArrayBufferLike>; leases: ByteLease[] };
type Chunk = { readonly first: number; readonly count: number; readonly finalizing: boolean;
    coverage: InkCoverageJob | null; readonly leases: ByteLease[];
    retained: { coverage: InkCoverage; buffers: ArrayBufferLike[]; bytes: number } | null };
type Work = { snapshot: WetInkSnapshot; stable: Stable; scale: number; offset: number; tail: Tail; chunk: Chunk | null };
/** The GPU routes that draw wet ink, injected by the board's input host (the route modules are not imported here). */
export interface WetGpuRoutes {
    readonly createInkRoutes: CreateInkRoutes;
    readonly inkRouteFor: InkRouteFor;
    readonly withClips: WithClips;
}
export interface BoardWetOptions {
    readonly token: RenderToken;
    readonly palette: () => PaintPalette;
    readonly readyFrame: () => PaintSource | null;
    readonly current: () => boolean;
    readonly exists: (identity: DryInkIdentity) => boolean;
    readonly invalidate: () => void;
    readonly onError: (error: unknown) => void;
    readonly gpuRoutes: WetGpuRoutes;
    /** The ink nodes the board drew in the CURRENT composite (valid during that frame's draw; the board's layers draw before
     * this one in the same document group). A stroke the board drew is not drawn again here, so one composite never paints
     * a stroke twice. */
    readonly boardDrawnInk: () => ReadonlySet<string>;
}
export interface BoardWetRenderer extends BoardWetLayer {
    readonly layers: Readonly<{ underlay: PlatformLayerDefinition; content: PlatformLayerDefinition }>;
    consumeInput(): void;
    liveNodeIds(): ReadonlySet<string>;
    /** Whether this band's wet layer paints the node at `view` on the given backend. A changed node the live layer paints is covered
     * by the picture it drew; one it does not paint (not a stroke it holds, or not yet shown) is not. */
    drawsLive(nodeId: string, band: WetBand, view: ViewState, canvas: boolean): boolean;
    presented(revision: number, token: RenderToken, frame?: PaintSource): void;
    clear(): void;
    dispose(): void;
}
function sameToken(a: RenderToken, b: RenderToken): boolean {
    return a.vaultEpoch === b.vaultEpoch && a.documentId === b.documentId && a.bytesGeneration === b.bytesGeneration && a.session === b.session;
}
/** The presented-frame test the acknowledgement uses: this token's frame holds the node at a current revision. */
function available(frame: PaintSource | null | undefined, identity: DryInkIdentity, token: RenderToken): boolean {
    return !!frame && sameToken(frame.token, token) && frame.sceneRevision >= identity.nodeRevision && frame.inkNodeIds.has(identity.nodeId);
}
function unionBounds(a: Bounds | null, next: Bounds): Bounds {
    if (!a) return { x: next.x, y: next.y, w: next.w, h: next.h };
    const x = Math.min(a.x, next.x), y = Math.min(a.y, next.y);
    return { x, y, w: Math.max(a.x + a.w, next.x + next.w) - x, h: Math.max(a.y + a.h, next.y + next.h) - y };
}
function retainedBuffers(coverage: InkCoverage, known: readonly ReadonlySet<ArrayBufferLike>[]): { buffers: ArrayBufferLike[]; bytes: number } {
    const unique = new Set<ArrayBufferLike>();
    const add = (view: ArrayBufferView) => { if (!known.some(set => set.has(view.buffer))) unique.add(view.buffer); };
    add(coverage.geometry.cubics); add(coverage.geometry.flags); add(coverage.radii);
    add(coverage.segments); add(coverage.discs); add(coverage.centreline);
    for (const map of coverage.arcMaps) { add(map.cubic); add(map.pieces); }
    const buffers = [...unique], bytes = buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
    if (!Number.isSafeInteger(bytes)) throw new RangeError('Wet coverage accounting overflow');
    return { buffers, bytes };
}
class ImmutableIds implements ReadonlySet<string> {
    readonly [Symbol.toStringTag] = 'ImmutableIds';
    private readonly ids: Set<string>;
    constructor(values?: Iterable<string>) { this.ids = new Set(values); }
    get size(): number { return this.ids.size; }
    has(value: string): boolean { return this.ids.has(value); }
    entries(): SetIterator<[string, string]> { return this.ids.entries(); }
    keys(): SetIterator<string> { return this.ids.keys(); }
    values(): SetIterator<string> { return this.ids.values(); }
    [Symbol.iterator](): SetIterator<string> { return this.values(); }
    forEach(callback: (value: string, value2: string, set: ReadonlySet<string>) => void, thisArg?: unknown): void {
        for (const value of this.ids) callback.call(thisArg, value, value, this);
    }
}
const EMPTY_LIVE_IDS: ReadonlySet<string> = new ImmutableIds();

// Frame clips of a continuation stroke as canvas2d paths, built once per clip geometry. Only a continuation of a framed
// stroke has any, so the table stays tiny; it is cleared past a few dozen entries rather than tracked per stroke.
const clipPaths = new Map<string, { readonly d: PaintClip['d']; readonly path: Path2D }>();
function clipPathFor(clip: PaintClip): Path2D {
    const held = clipPaths.get(clip.key);
    if (held && held.d === clip.d) return held.path;
    if (clipPaths.size >= 64) clipPaths.clear();
    const path = path2d(clip.d); clipPaths.set(clip.key, { d: clip.d, path });
    return path;
}
type WetBand = 'underlay' | 'content';
const BANDS: readonly WetBand[] = ['underlay', 'content'];
type InkRoutes = ReturnType<CreateInkRoutes>;
/** What a slot draws: a route's run, or the CPU scrap of a stroke the route refuses. */
/** `kept` is the geometry chunks a union run maps: they stay cached while it is shown, so a CPU reclaim never frees them. */
interface WetShown { readonly clips: readonly PaintClip[]; readonly draw: () => void; readonly dispose: () => void; readonly kept?: readonly InkCoverage[] }
/** One stroke's GPU run for one band. `shown` is what is drawn; the rest says what the current publication needs. A
 * deferred or denied admission keeps drawing the last shown tip while coverage waits for the new one. */
interface WetRunSlot {
    readonly gesture: number;
    serial: number; scale: number; token: FrameToken;
    /** The palette and material the item was built with: a retry of the same publication reuses both, and so the item. */
    palette: PaintPalette | null; material: InkMaterial | null;
    /** The route's input for this publication. Its identity is the key of the route's per-stroke triangle cache, so a
     * deferred or denied retry reuses it instead of re-joining the whole stroke. */
    item: PaintInkItem | null;
    state: 'pending' | 'ready' | 'empty' | 'denied';
    shown: WetShown | null;
    /** The admission depends on the view (an empty result, or a CPU scrap): it is current for `viewKey` only. */
    viewBound: boolean; viewKey: string;
    /** The first refusal of this stroke is reported; a refusal is never reported per frame. */
    reported: boolean;
    /** The upload meter a deferred admission used: its retry waits until the frame's meter holds that much (admitRuns). */
    waitBytes: number;
}
interface WetScrap { readonly device: GfxDevice; readonly texture: TextureHandle; readonly world: Bounds; readonly pw: number; readonly ph: number }
/** A run's key: no string per band per frame. Gesture sequences are small sequential integers. */
const runKey = (gesture: number, band: WetBand): number => gesture * 2 + (band === 'content' ? 1 : 0);
/** Whether a stroke with this gesture is still pending: a scan, the list is short. */
function isPending(pending: readonly WetInkSnapshot[], gesture: number): boolean {
    for (const item of pending) if (item.identity.gestureSequence === gesture) return true;
    return false;
}
/** A coverage verdict. The fixed ones are constants, so a frame that asks for coverage allocates nothing. */
interface Verdict { readonly complete: boolean; readonly sharp: boolean; readonly why: string }
const VERDICT_SHARP: Verdict = { complete: true, sharp: true, why: '' }, VERDICT_STALE: Verdict = { complete: true, sharp: false, why: '' };
// The verdict of the frame after a uniform write the ring refused (4c118264): the draw that was skipped is not in the picture.
const VERDICT_RING_DEFERRED: Verdict = { complete: false, sharp: false, why: 'uniform-deferred' };
// A stroke's tip is one bounded chunk. It is tessellated within this allowance even past the frame's budget, so a newest
// publication never waits behind the frame's general work (measured: 234 frames left unprepared behind the budget).
const TIP_ALLOWANCE_MS = 3;
// A band with nothing shown does not hold the frame: the frame presents without it and is not sharp, so the newest publication
// is drawn when it is admitted. Refusing here made every drawing frame wait on the newest tip (measured on the drawing: 58 frames
// refused as no-shown-pending per draw phase, answer rate .89 paced and .79 saturated against 1.0 on canvas2d). The reason is kept
// for the audit, so a frame that is not sharp says which band it is waiting for.
const VERDICT_UNSHOWN: Record<'no-slot' | 'token' | WetRunSlot['state'], Verdict> = {
    'no-slot': { complete: true, sharp: false, why: 'unshown:no-slot' }, token: { complete: true, sharp: false, why: 'unshown:token' },
    pending: { complete: true, sharp: false, why: 'unshown:pending' }, ready: { complete: true, sharp: false, why: 'unshown:ready' },
    empty: { complete: true, sharp: false, why: 'unshown:empty' }, denied: { complete: true, sharp: false, why: 'unshown:denied' },
};
const COVER_CANVAS2D: LayerCoverage = { complete: true, sharp: true };
function sameFrameToken(a: FrameToken, b: FrameToken): boolean {
    return sameToken(a, b) && a.viewLease === b.viewLease && a.deviceGeneration === b.deviceGeneration;
}
// The wet bands' picture key is mixed from numbers into two independent 32-bit hashes, kept as one 53-bit number: no string is joined
// per band per frame (the frame-path allocation rule; two keys a frame, each one string per run plus the join). One 32-bit hash alone
// would let a collision answer an unchanged picture and skip a present that draws ink.
const keyBits = new Float64Array(1), keyWords = new Uint32Array(keyBits.buffer);
let keyA = 0, keyB = 0;
function keyStart(): void { keyA = 0x811c9dc5; keyB = 0x9747b28c; }
function keyInt(value: number): void {
    keyA = Math.imul(keyA ^ (value | 0), 0x01000193);
    keyB = Math.imul(keyB ^ (value | 0), 0x5bd1e995); keyB ^= keyB >>> 13;
}
function keyNumber(value: number): void { keyBits[0] = value; keyInt(keyWords[0]); keyInt(keyWords[1]); }
function keyString(value: string): void { keyInt(value.length); for (let i = 0; i < value.length; i++) keyInt(value.charCodeAt(i)); }
function keyEnd(): number { return (keyA >>> 0) * 0x200000 + ((keyB >>> 0) & 0x1fffff); }
const SLOT_STATES = { pending: 1, ready: 2, empty: 3, denied: 4 } as const;
function viewKeyOf(view: ViewState): string {
    return `${view.camera.x},${view.camera.y},${view.camera.z},${view.viewport.width},${view.viewport.height},${view.viewport.dpr}`;
}
// The same material the committed ink takes (inkMaterial / highlighterMaterials with the node's inherited opacity), so
// the wet stroke's colour at pen-up is the committed one. Null when the band draws nothing for this stroke.
function bandMaterial(snapshot: WetInkSnapshot, band: WetBand, palette: PaintPalette): InkMaterial | null {
    const highlight = snapshot.presentation.tool === 'highlighter';
    if (!highlight && band === 'underlay') return null;
    const pigment = resolveSwatch(palette, snapshot.presentation.color as Swatch, highlight ? 'highlight' : 'stroke');
    if (!pigment) return null;
    const bandAlpha = highlight ? (band === 'underlay' ? HIGHLIGHT_UNDERLAY_ALPHA : HIGHLIGHT_OVERLAY_ALPHA) : 1;
    return inkMaterial(pigment, bandAlpha * (snapshot.presentation.opacity ?? 1));
}
/** The axis-aligned world box of a local rect under a local-to-world affine. */
function worldBox(bounds: Bounds, m: readonly [number, number, number, number, number, number]): Bounds {
    const [a, c1, c2, d, e, f] = m;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let corner = 0; corner < 4; corner++) {
        const x = corner & 1 ? bounds.x + bounds.w : bounds.x, y = corner & 2 ? bounds.y + bounds.h : bounds.y;
        const wx = a * x + c2 * y + e, wy = c1 * x + d * y + f;
        minX = Math.min(minX, wx); maxX = Math.max(maxX, wx); minY = Math.min(minY, wy); maxY = Math.max(maxY, wy);
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
/** The part of the world the viewport shows. */
/** Device pixels per world unit of the item's own transform, at this view. */
function scaleAt(view: ViewState, item: WetInkSnapshot): number {
    const m = item.presentation.localToWorld;
    return view.camera.z * view.viewport.dpr * Math.hypot(m[0], m[1], m[2], m[3]);
}
function viewWorld(view: ViewState): Bounds {
    return { x: view.camera.x, y: view.camera.y, w: view.viewport.width / view.camera.z, h: view.viewport.height / view.camera.z };
}
function offScreen(bounds: Bounds | null, m: readonly [number, number, number, number, number, number], view: ViewState): boolean {
    if (!bounds) return false;
    const box = worldBox(bounds, m), v = viewWorld(view);
    return box.x + box.w < v.x || box.x > v.x + v.w || box.y + box.h < v.y || box.y > v.y + v.h;
}

export function createBoardWetLayer(options: BoardWetOptions): BoardWetRenderer {
    const gpuRoutes = options.gpuRoutes;
    let handover: WetInkHandover | null = null, disposed = false, generation = 0, dirty = false, denied = false;
    let liveIds: ReadonlySet<string> = EMPTY_LIVE_IDS;
    let owner: LayerHost | null = null, work: Work | null = null, reserved = 0, lastPrepareFrame: number | null = null;
    const hosts = new Set<LayerHost>(), prepared = new Map<number, Prepared>(), callbacks = new Set<() => void>();
    let publicationVersion = 0;
    let inkRoutes: InkRoutes | null = null;
    const runs = new Map<number, WetRunSlot>();
    // Read only while drawRouted runs: one reused record, so a draw allocates nothing.
    const drawCall: { pass: GpuPass | null; view: ViewState | null; host: LayerHost | null } = { pass: null, view: null, host: null };
    // A uniform write the ring refused (out-of-budget) skips that one draw or admission and the frame stands. Coverage is read before
    // the layers draw, so this frame's verdict cannot see the skip: the next frame's coverage reports it incomplete and asks for a frame.
    let ringDeferred = false;
    const ringRefused = (error: unknown): boolean => {
        if (!(error instanceof ArenaError) || error.code !== 'out-of-budget') return false;
        ringDeferred = true; auditCount('wet', 'uniform-deferred'); return true;
    };
    const hostLayers = new Map<LayerHost, Layer>();
    const report = (error: unknown) => {
        // A refusal that reaches here has no size of its own, so the wait is sized by the layer's next bounded demand (the
        // CPU bytes cpuWorkingSet declares). The scrap's texture refusal is sized where it is thrown, below.
        if (isBudgetRefusal(error)) { denied = true; awaitSizedCapacity(owner, invalidate, { pool: 'cpu', bytes: TEMP_BYTES + PATH_BLOCK }); return; }
        try { options.onError(error); } catch { /* reporting must not escape the scheduler */ }
    };
    const invalidate = () => { if (disposed) return; dirty = true; generation++; denied = false; options.invalidate(); for (const host of hosts) host.invalidate('wet-ink'); };
    const release = (lease: ByteLease) => { owner!.allocator.cpu.release(lease); reserved -= lease.bytes; };
    const stables = new Map<number, Stable>();
    const dropPrepared = (item: Prepared) => { for (const lease of item.leases) release(lease); };
    const dropStable = (gesture: number) => {
        const item = stables.get(gesture);
        if (!item) return;
        stables.delete(gesture);
        for (const lease of item.leases) release(lease);
        if (item.temp) release(item.temp);
    };
    const dropWork = () => {
        const item = work; work = null;
        dropPartial();
        if (!item) return;
        const chunk = item.chunk; item.chunk = null;
        if (chunk) {
            chunk.coverage?.cancel();
            for (const lease of chunk.leases) release(lease);
        }
        for (const lease of item.tail.leases) release(lease);
    };
    const reserve = (bytes: number): ByteLease | null => {
        const lease = owner?.allocator.cpu.reserve(bytes) ?? null;
        if (lease) reserved += lease.bytes;
        return lease;
    };
    const dropSlot = (key: number) => {
        const slot = runs.get(key);
        if (!slot) return;
        runs.delete(key);
        slot.shown?.dispose();
        slot.shown = null;
    };
    const releaseRoutes = () => {
        for (const [key] of [...runs]) dropSlot(key);
        if (inkRoutes) { inkRoutes.analytic.release(); inkRoutes.union.release(); inkRoutes = null; }
    };
    // The partial outline of a stroke whose first publication is incomplete (see sourceOf). Its path lease is the layer's, so it is
    // released when the partial is replaced, when the stroke completes, or when the layer clears.
    let partial: { owner: object; count: number; source: Prepared } | null = null;
    const dropPartial = (): void => {
        if (!partial) return;
        for (const lease of partial.source.leases) release(lease);
        partial = null;
    };
    const clear = () => {
        dropWork(); dropPartial(); for (const item of prepared.values()) dropPrepared(item); prepared.clear();
        for (const gesture of [...stables.keys()]) dropStable(gesture);
        releaseRoutes();
        dirty = false; denied = false; liveIds = EMPTY_LIVE_IDS;
    };
    const routesMemory = (): { gpuBytes: number; cpuBytes: number } => {
        if (!inkRoutes) return { gpuBytes: 0, cpuBytes: 0 };
        const analytic = inkRoutes.analytic.memory(), union = inkRoutes.union.memory();
        return { gpuBytes: analytic.gpuBytes + union.gpuBytes, cpuBytes: analytic.cpuBytes + union.cpuBytes };
    };
    // The canvas2d outline of a stroke, built on first use: by draw2d, or by the CPU path for a refused stroke. It is not
    // built per tip, because the routes draw the chunks and an outline tessellated per input frame would be paid for nothing.
    const pathOf = (source: Prepared): Path2D | null => {
        if (source.path) return source.path;
        const path = new Path2D();
        let commands = 0;
        for (const coverage of source.coverageChunks) {
            const job = new InkOutlineJob(coverage, source.scale, command => appendPath2d(path, command, source.origin));
            while (job.step(1024) === 'pending') { /* bounded per chunk, as coverageOutline is */ }
            commands += job.commandCount;
        }
        const bytes = (commands + 1) * 80, lease = reserve(bytes);
        if (!lease) { denied = true; awaitSizedCapacity(owner, invalidate, { pool: 'cpu', bytes }); return null; }
        source.leases.push(lease); source.path = path;
        return path;
    };
    // The partial outline of a stroke with no completed publication: the chunks its tessellation has so far, drawn as a publication of
    // their own. Cached per chunk count, so a frame that adds no chunk re-admits nothing; drawn through the same route as any stroke.
    const partialOf = (snapshot: WetInkSnapshot): Prepared | null => {
        const w = work;
        if (!w || w.snapshot.identity.gestureSequence !== snapshot.identity.gestureSequence || w.snapshot.identity.nodeId !== snapshot.identity.nodeId) return null;
        const coverageChunks = [...w.stable.chunks, ...w.tail.chunks];
        if (!coverageChunks.length) return null;
        if (partial?.owner === w && partial.count === coverageChunks.length) return partial.source;
        dropPartial();
        const source: Prepared = { snapshot: w.snapshot, path: null, origin: w.stable.origin, leases: [], scale: w.scale,
            bounds: w.tail.bounds ? unionBounds(w.stable.bounds, w.tail.bounds) : w.stable.bounds, coverageChunks, serial: ++publicationVersion };
        partial = { owner: w, count: coverageChunks.length, source };
        return source;
    };
    // What a stroke draws: its last completed publication, or while its first is incomplete, the partial outline. A stroke with
    // neither (nothing tessellated yet) draws nothing and is not refused for it.
    const sourceOf = (snapshot: WetInkSnapshot): Prepared | null => {
        const done = prepared.get(snapshot.identity.gestureSequence);
        if (done && done.snapshot.identity.nodeId === snapshot.identity.nodeId) return done;
        return partialOf(snapshot);
    };
    const drawScrap = (pass: GpuPass, view: ViewState, host: LayerHost, scrap: WetScrap): void => {
        const cam = view.camera, scale = cam.z * view.viewport.dpr;
        host.drawTexturedQuad(pass, scrap.texture, { x: 0, y: 0, width: scrap.pw, height: scrap.ph },
            { x: (scrap.world.x - cam.x) * scale, y: (scrap.world.y - cam.y) * scale, width: scrap.pw, height: scrap.ph },
            { opacity: 1, sampling: 'linear', coverage: 'none' });
    };
    // The CPU path for a stroke the route refuses: the stroke's canvas2d fill, rastered once for the part of its bounds
    // in view and uploaded as one texture. The stroke is drawn, never dropped, and counted with its pixels.
    const admitScrap = (host: LayerHost, snapshot: WetInkSnapshot, source: Prepared, material: InkMaterial, why: string,
        view: ViewState, budget: FrameBudget): Admission<WetScrap> => {
        const device = host.device();
        if (!device || !source.bounds) return { status: 'empty' };
        const box = worldBox(source.bounds, snapshot.presentation.localToWorld), v = viewWorld(view);
        const x0 = Math.max(box.x, v.x), y0 = Math.max(box.y, v.y), x1 = Math.min(box.x + box.w, v.x + v.w), y1 = Math.min(box.y + box.h, v.y + v.h);
        if (!(x1 > x0 && y1 > y0)) return { status: 'empty' };
        const world: Bounds = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, scale = view.camera.z * view.viewport.dpr;
        const pw = Math.max(1, Math.ceil(world.w * scale)), ph = Math.max(1, Math.ceil(world.h * scale)), bytes = pw * ph * 4;
        // pathOf has registered its own sized wait; the stroke is deferred behind it, not waited for twice.
        const path = pathOf(source);
        if (!path) return { status: 'deferred' };
        const lease = host.allocator.gpu.reserve(bytes);
        if (!lease) return { status: 'denied', pool: 'gpu', bytes };
        // The raster's CPU pixels (the canvas, then the bitmap it transfers into) are charged while they exist: they were the one
        // CPU allocation of the scrap the governor never saw.
        const cpuLease = host.allocator.cpu.reserve(bytes);
        if (!cpuLease) { host.allocator.gpu.release(lease); return { status: 'denied', pool: 'cpu', bytes }; }
        if (!budget.claimUpload(bytes)) { host.allocator.gpu.release(lease); host.allocator.cpu.release(cpuLease); return { status: 'deferred' }; }
        let canvas: OffscreenCanvas | null = null, bitmap: ImageBitmap | null = null, texture: TextureHandle | null = null, attached = false;
        try {
            canvas = new OffscreenCanvas(pw, ph);
            const ctx = canvas.getContext('2d');
            if (!ctx) throw new Error('Offscreen 2D canvas unavailable');
            ctx.setTransform(scale, 0, 0, scale, -world.x * scale, -world.y * scale);
            const [a, b, c, d, e, f] = snapshot.presentation.localToWorld, [ox, oy] = source.origin;
            ctx.transform(a, b, c, d, e, f); ctx.translate(ox, oy);
            ctx.fillStyle = colourCss(material.color); ctx.fill(path, 'nonzero');
            auditCount('wet', `fallback:item-cpu:ink:${why}`, 1, { px: pw * ph });
            // The same raster, under h5's name: cpu-raster equals the sum of every fallback:item-cpu:* of this layer.
            auditCount('wet', 'cpu-raster', 1, { px: pw * ph });
            bitmap = canvas.transferToImageBitmap();
            texture = device.createTexture(pw, ph, 'rgba8', ['sample', 'copy-dst'], lease); attached = true;
            device.writeTexture(texture, { x: 0, y: 0, width: pw, height: ph }, { source: bitmap, premultiplied: true, colorSpace: 'srgb', origin: 'top-left' });
            const scrap: WetScrap = { device, texture, world, pw, ph };
            texture = null;
            return { status: 'ready', value: scrap };
        } catch (error) {
            // A refused texture is a sized denial of the pool it was for, not an error: the stroke waits for those bytes.
            if (isBudgetRefusal(error)) return { status: 'denied', pool: 'gpu', bytes };
            throw error;
        } finally {
            bitmap?.close();
            if (canvas) { canvas.width = 0; canvas.height = 0; }
            host.allocator.cpu.release(cpuLease);
            if (texture) device.destroy(texture);
            if (!attached) host.allocator.gpu.release(lease);
        }
    };
    const setShown = (slot: WetRunSlot, next: WetShown | null, state: WetRunSlot['state']): void => { slot.shown?.dispose(); slot.shown = next; slot.state = state; };
    // Records what a band's run now is: the publication, palette, token and view it was admitted for.
    const stamp = (key: number, gesture: number, current: WetRunSlot | undefined, source: Prepared, palette: PaintPalette,
        token: FrameToken, viewKey: string, material: InkMaterial | null, item: PaintInkItem | null): WetRunSlot => {
        const slot: WetRunSlot = current ?? { gesture, serial: 0, scale: 0, palette: null, material: null, item: null,
            token, state: 'pending', shown: null, viewBound: false, viewKey: '', reported: false, waitBytes: 0 };
        slot.serial = source.serial; slot.scale = source.scale; slot.palette = palette; slot.material = material; slot.item = item;
        slot.token = { ...token }; slot.viewBound = false; slot.viewKey = viewKey; slot.waitBytes = 0;
        runs.set(key, slot);
        return slot;
    };
    // The newest publication's admission never waits for the frame's yield. A publication is tessellated in the same prepare, and that
    // tessellation spends the frame's time, so the budget reads yielded at this point on nearly every drawing frame (traced: 95% of the
    // frames that published). The kit refuses every upload claim once a frame yields, so skipping the admission was the same as deferring
    // it: the tip reached the screen one frame late on every other frame, and the paced draw answered 48% of its inputs (96% on the
    // frames that did not yield). The tip is admitted with a bounded grant instead (tipBudget). A live stroke is one input ahead of its
    // tessellation, so the run admitted is the last completed publication of the node (the same match draw2d uses), and
    // the newest publication is admitted once it completes. Only the tip is new work: the route keys its geometry by chunk.
    // A frame's tip grant: the frame's own claims first, then TIP_UPLOAD_BYTES past a yield. The bytes the device then writes are
    // reported to the scheduler like any upload, so the overshoot is measured, not hidden. One counter per frame, shared by this layer's
    // admissions; a media claim is never granted here (it has its own grant).
    let tipFrame = -1, tipBytes = 0;
    const tipBudget = (budget: FrameBudget): FrameBudget => {
        if (tipFrame !== budget.frameId) { tipFrame = budget.frameId; tipBytes = 0; }
        return { ...budget, shouldYield: () => false, claimUpload: (bytes: number, kind?: 'media') => {
            if (budget.claimUpload(bytes, kind)) return true;
            if (kind === 'media' || tipBytes + bytes > TIP_UPLOAD_BYTES) return false;
            tipBytes += bytes; return true;
        } };
    };
    const admitRuns = (host: LayerHost, view: ViewState, budget: FrameBudget): void => {
        const routes = inkRoutes ??= gpuRoutes.createInkRoutes(host, 'board-wet');
        const palette = options.palette(), pending = handover?.pendingSnapshots() ?? [], viewKey = viewKeyOf(view);
        const audited = renderAuditEnabled(), tip = tipBudget(budget);
        // Deleting the entry being visited is safe in a Map's iteration; a slot whose stroke is gone is dropped here.
        for (const [key, slot] of runs) if (!isPending(pending, slot.gesture)) dropSlot(key);
        for (const snapshot of pending) {
            const gesture = snapshot.identity.gestureSequence, source = sourceOf(snapshot);
            if (!source) { if (audited) auditCount('wet', 'admit-skip:unprepared'); continue; }
            const shown = source.snapshot;
            for (const band of BANDS) {
                const key = runKey(gesture, band), current = runs.get(key);
                if (current && current.serial === source.serial && current.scale === source.scale && current.palette === palette
                    && sameFrameToken(current.token, budget.token) && (current.state === 'ready' || current.state === 'empty')
                    && (!current.viewBound || current.viewKey === viewKey)) { if (audited) auditCount('wet', 'admit-skip:fresh'); continue; }
                // A band with nothing shown yet is admitted even past the frame's budget: the tessellation spent it, and until
                // it is admitted the frame presents without the newest tip (measured: 41 yields left drawing frames unsharp).
                if (audited && current?.shown && budget.shouldYield()) auditCount('wet', 'admit-tip:yielded');
                // A deferred run waits for the upload meter to hold the bytes its last attempt used. Re-admitting it every frame
                // re-uploads the stroke each time and spends the meter the board needs (measured as a feedback loop).
                if (current && current.state === 'pending' && current.waitBytes > 0 && current.serial === source.serial && current.palette === palette
                    && (budget.shouldYield() || budget.upload.remainingBytes < current.waitBytes)) { if (audited) auditCount('wet', 'admit-wait:meter'); continue; }
                const reuse = current && current.serial === source.serial && current.palette === palette ? current : null;
                const material = reuse ? reuse.material : bandMaterial(shown, band, palette);
                if (!material) {
                    // This band paints nothing for this stroke (a pen's underlay): it is admitted as empty, so coverage counts it
                    // done, and nothing is built for it again while the palette stays.
                    setShown(stamp(key, gesture, current, source, palette, budget.token, viewKey, null, null), null, 'empty');
                    continue;
                }
                const item = reuse?.item ?? { kind: 'ink', key: `wet/${gesture}/${band}`, nodeId: shown.identity.nodeId,
                    geometryKey: `wet/${gesture}/${source.serial}`, localToWorld: shown.presentation.localToWorld,
                    clips: shown.presentation.clips ?? [], coverage: source.coverageChunks, material } satisfies PaintInkItem;
                const route = gpuRoutes.inkRouteFor(item) === 'ink-analytic' ? routes.analytic : routes.union;
                const before = audited ? route.memory().gpuBytes : 0;
                const meterBefore = budget.upload.remainingBytes;
                let admission: Admission<PreparedRun>;
                try { admission = route.admit([item], view, 'over', tip); }
                catch (error) { if (!ringRefused(error)) throw error; admission = { status: 'deferred' }; }
                const meterUsed = meterBefore - budget.upload.remainingBytes;
                if (audited) {
                    auditCount('wet', `admit:${admission.status}`, 1, { [route.id]: 1 });
                    const grown = route.memory().gpuBytes - before; if (grown > 0) auditCount('wet', 'upload:vertex', 1, { bytes: grown });
                }
                const slot = stamp(key, gesture, current, source, palette, budget.token, viewKey, material, item);
                switch (admission.status) {
                    case 'ready': {
                        const run = admission.value;
                        setShown(slot, { clips: item.clips, kept: inkCoverageChunks(item.coverage), draw: () => { if (drawCall.pass) route.draw(drawCall.pass, run); }, dispose: () => route.retire(run) }, 'ready');
                        break;
                    }
                    // A replaced shown is disposed only when its successor is admitted: a deferred or denied admission keeps the last tip.
                    case 'empty': slot.viewBound = true; setShown(slot, null, 'empty'); break;
                    // The wait is one upload piece at most: the meter refills per frame, so a run waiting for its whole last attempt's bytes
                    // could wait for more than any frame offers (a stale tip). One piece always fits a frame that offers any allowance.
                    case 'deferred': slot.state = 'pending'; slot.waitBytes = Math.min(WAIT_UPLOAD_BYTES, Math.max(1, meterUsed)); break;
                    case 'denied': slot.state = 'denied'; denied = true; awaitSizedCapacity(host, invalidate, { pool: admission.pool, bytes: admission.bytes }); break;
                    case 'unsupported': {
                        // The route refused the stroke: it is drawn through the CPU path, and the refusal is reported once.
                        if (!slot.reported) { slot.reported = true; report(new Error(`Wet ink route refused a stroke (${admission.why}); it is drawn through the CPU path`)); }
                        // stamp has already written this publication's serial: a throw here leaves the slot pending and not current, so the
                        // stroke is retried and the frame is never counted sharp for a tip that was not drawn.
                        let scrap: ReturnType<typeof admitScrap>;
                        try { scrap = admitScrap(host, shown, source, material, admission.why, view, budget); }
                        catch (error) { slot.serial = -1; slot.state = 'pending'; throw error; }
                        if (scrap.status === 'ready') {
                            const value = scrap.value;
                            slot.viewBound = true;
                            setShown(slot, { clips: item.clips, dispose: () => value.device.destroy(value.texture),
                                draw: () => { if (drawCall.pass && drawCall.view && drawCall.host) drawScrap(drawCall.pass, drawCall.view, drawCall.host, value); } }, 'ready');
                        } else if (scrap.status === 'empty') { slot.viewBound = true; setShown(slot, null, 'empty'); }
                        else if (scrap.status === 'deferred') slot.state = 'pending';
                        else if (scrap.status === 'denied') { slot.state = 'denied'; denied = true; awaitSizedCapacity(host, invalidate, { pool: scrap.pool, bytes: scrap.bytes }); }
                        else slot.state = 'pending'; // admitScrap never refuses a stroke as unsupported; a stroke kept pending is never drawn wrong
                        break;
                    }
                }
            }
        }
    };
    // True while some visible band still needs an admission for the current publication.
    const runsPending = (): boolean => {
        const drawn = options.boardDrawnInk();
        for (const snapshot of handover?.pendingSnapshots() ?? []) {
            if (snapshot.dry && drawn.has(snapshot.identity.nodeId)) continue;
            const gesture = snapshot.identity.gestureSequence, source = sourceOf(snapshot);
            if (!source) continue;
            for (const band of BANDS) {
                const slot = runs.get(runKey(gesture, band));
                if (!slot || slot.state === 'pending' || slot.serial !== source.serial || slot.scale !== source.scale) return true;
            }
        }
        return false;
    };
    // Coverage of the routed path. A band with an admitted run draws it, whichever publication that run is for, so the
    // frame is complete while the stroke grows (measured: a serial check refused 118 of 209 drawing frames, and a critical
    // layer's refusal refused the whole frame). No band refuses the frame: one with nothing shown is not sharp (VERDICT_UNSHOWN).
    // `sharp` says the shown runs are the current publication's, for this token and view; a deferred or denied tip is not sharp.
    const routedCoverage = (token: FrameToken, view: ViewState): Verdict => {
        if (ringDeferred) { ringDeferred = false; return VERDICT_RING_DEFERRED; }
        const viewKey = viewKeyOf(view), drawn = options.boardDrawnInk();
        let sharp = true;
        for (const snapshot of handover?.pendingSnapshots() ?? []) {
            if (snapshot.dry && drawn.has(snapshot.identity.nodeId)) continue;
            const gesture = snapshot.identity.gestureSequence, source = sourceOf(snapshot);
            if (!source) continue;
            for (const band of BANDS) {
                const slot = runs.get(runKey(gesture, band));
                if (!slot) return VERDICT_UNSHOWN['no-slot'];
                if (!sameFrameToken(slot.token, token)) return VERDICT_UNSHOWN.token;
                if (!slot.shown && slot.state !== 'empty') return VERDICT_UNSHOWN[slot.state];
                const current = (slot.state === 'ready' || slot.state === 'empty') && slot.serial === source.serial && slot.scale === source.scale
                    && (!slot.viewBound || slot.viewKey === viewKey);
                if (!current) sharp = false;
            }
        }
        return sharp ? VERDICT_SHARP : VERDICT_STALE;
    };
    const drawRouted = (pass: GpuPass, view: ViewState, band: WetBand): void => {
        if (disposed || !options.current() || !inkRoutes || !owner) return;
        const host = owner;
        let drawn = 0;
        // A stroke hands over to the board only once it is committed (it has a dry identity): a frame can hold an earlier revision of
        // the node an in-progress stroke continues, and skipping on it would drop the stroke being drawn.
        const boardDrawn = options.boardDrawnInk();
        drawCall.pass = pass; drawCall.view = view; drawCall.host = host;
        try {
            for (const snapshot of handover?.pendingSnapshots() ?? []) {
                if (snapshot.dry && boardDrawn.has(snapshot.identity.nodeId)) { if (renderAuditEnabled()) auditCount('wet', 'skip:board-drawn'); continue; }
                const gesture = snapshot.identity.gestureSequence, source = sourceOf(snapshot);
                if (!source || offScreen(source.bounds, source.snapshot.presentation.localToWorld, view)) continue;
                const shown = runs.get(runKey(gesture, band))?.shown;
                if (!shown) continue;
                // Clips are applied here and only here: the route draws the item's geometry, withClips its clips.
                let admitted: Admission<void>;
                try { admitted = gpuRoutes.withClips(pass, shown.clips, view, shown.draw); }
                catch (error) { if (!ringRefused(error)) throw error; continue; }
                if (admitted.status === 'ready') drawn++;
                else auditCount('wet', `clip:${admitted.status}`);
            }
        } finally { drawCall.pass = null; drawCall.view = null; drawCall.host = null; }
        if (drawn) auditCount('wet', 'draw');
    };
    const begin = (snapshot: WetInkSnapshot, view: ViewState): boolean => {
        const matrix = snapshot.presentation.localToWorld;
        const scale = Math.max(Number.MIN_VALUE, view.camera.z * view.viewport.dpr * Math.hypot(matrix[0], matrix[1], matrix[2], matrix[3]));
        const gesture = snapshot.identity.gestureSequence;
        let stable = stables.get(gesture);
        // Finalized geometry is specific to its device scale and node: any change starts the prefix again.
        // So does a publication that finalizes fewer spans than are cached: a stroke closing at pen up turns its first span
        // (ink/curve.ts closeCurvePublication), re-tessellated once while the open picture stays shown.
        if (stable && (stable.nodeId !== snapshot.identity.nodeId || stable.scale !== scale
            || stable.spans > snapshot.curve.finalizedSpanCount)) { dropStable(gesture); stable = undefined; }
        if (!stable) {
            const samples = snapshot.curve.samples;
            stable = { nodeId: snapshot.identity.nodeId, scale, origin: [samples.x(0), samples.y(0)], spans: 0, chunks: [],
                bounds: null, dot: true, scan: 1, buffers: new Set(), leases: [], temp: null, style: null };
            stables.set(gesture, stable);
        }
        work = { snapshot, stable, scale, offset: stable.spans, chunk: null,
            tail: { chunks: [], bounds: null, buffers: new Set(), leases: [] } };
        return true;
    };
    const step = (): boolean => {
        const w = work!, publication = w.snapshot.curve, real = publication.samples, s = w.stable;
        if (s.scan < real.count) {
            if (real.x(s.scan) !== real.x(0) || real.y(s.scan) !== real.y(0)) s.dot = false;
            s.scan++; return false;
        }
        const c = w.chunk;
        if (c?.retained) {
            const retained = c.retained;
            const lease = retained.bytes ? reserve(retained.bytes) : null;
            if (retained.bytes && !lease) { denied = true; awaitSizedCapacity(owner, invalidate, { pool: 'cpu', bytes: retained.bytes }); return false; }
            if (lease) c.leases.push(lease);
            if (c.finalizing) {
                s.chunks.push(retained.coverage); s.spans = c.first + c.count;
                s.bounds = unionBounds(s.bounds, retained.coverage.boundsLocal);
                for (const buffer of retained.buffers) s.buffers.add(buffer);
                s.leases.push(...c.leases);
            } else {
                w.tail.chunks.push(retained.coverage);
                w.tail.bounds = unionBounds(w.tail.bounds, retained.coverage.boundsLocal);
                for (const buffer of retained.buffers) w.tail.buffers.add(buffer);
                w.tail.leases.push(...c.leases);
            }
            w.chunk = null;
            return false;
        }
        if (c?.coverage) {
            if (c.coverage.step(1) === 'complete') {
                const coverage = c.coverage.result;
                c.coverage = null;
                c.retained = { coverage, ...retainedBuffers(coverage, c.finalizing ? [s.buffers] : [s.buffers, w.tail.buffers]) };
            }
            return false;
        }
        // Only sealed real samples are drawn. A predicted tail (browser getPredictedEvents) was tried
        // and removed: measured, predicted tails were retracted on 7/186 frames and read as recoil.
        const spans = real.count - 1, offset = w.offset;
        if (offset < spans || (spans === 0 && offset === 0)) {
            const finalizing = spans > 0 && offset + FINAL_SPANS <= publication.finalizedSpanCount;
            const count = spans === 0 ? 0 : finalizing ? FINAL_SPANS : Math.min(CHUNK, spans - offset);
            // A refusal waits for the pool to have TEMP_BYTES free, as every other wet refusal does: without the wake the stroke polled.
            const temp = s.temp ?? reserve(TEMP_BYTES); if (!temp) { denied = true; awaitSizedCapacity(owner, invalidate, { pool: 'cpu', bytes: TEMP_BYTES }); return false; }
            s.temp = temp;
            const geometry = materializeCurveRange(real, { firstSpan: offset, spanCount: count }, publication.parameters, publication.closure);
            w.offset = spans === 0 ? 1 : offset + count;
            const style: InkWidth = s.style ??= { width: w.snapshot.presentation.width, model: { id: 'uniform' }, pressure: 'none' };
            const dot: InkDot | null = offset === 0 && s.dot ? { x: real.x(0), y: real.y(0), radius: DOT_METRIC_PROVISIONAL.radius(style.width, style.width / 2, style.model) } : null;
            w.chunk = { first: offset, count, finalizing, leases: [], retained: null,
                coverage: new InkCoverageJob(real, geometry, style, { deviceScale: w.scale, dot, maxPrimitives: CHUNK_PRIMITIVES }) };
            // A non-finalized chunk is the tip: rebuilt on every publication, so this counts the per-input tessellation.
            if (!finalizing) auditCount('wet', 'tip-build');
            return false;
        }
        const gesture = w.snapshot.identity.gestureSequence;
        const prior = prepared.get(gesture);
        if (prior) dropPrepared(prior);
        dropPartial();
        prepared.set(gesture, { snapshot: w.snapshot, path: null, origin: s.origin, leases: w.tail.leases, scale: w.scale,
            bounds: w.tail.bounds ? unionBounds(s.bounds, w.tail.bounds) : s.bounds, coverageChunks: [...s.chunks, ...w.tail.chunks], serial: ++publicationVersion });
        work = null; return true;
    };
    // The Layer contract's answer: `false` only when the picture this band draws is the one it last drew. The picture is fingerprinted
    // from everything the band draws (each run and what it shows, the pending strokes and whether the board draws them, the view, and the
    // live state). A shown object is named once, so a replaced shown changes the fingerprint. The answer is per band: the shared prepare
    // tells whether the stroke's state is final for the frame, and each band compares it with its own last draw.
    const shownIds = new WeakMap<object, number>();
    let nextShownId = 0;
    const shownIdOf = (shown: object | null): number => {
        if (!shown) return 0;
        let id = shownIds.get(shown);
        if (id === undefined) shownIds.set(shown, id = ++nextShownId);
        return id;
    };
    const fingerprintOf = (view: ViewState, canvas: boolean): number => {
        const drawn = options.boardDrawnInk();
        keyStart();
        keyNumber(view.camera.x); keyNumber(view.camera.y); keyNumber(view.camera.z);
        keyNumber(view.viewport.width); keyNumber(view.viewport.height); keyNumber(view.viewport.dpr);
        keyInt(options.current() ? 1 : 0); keyInt(disposed ? 1 : 0);
        if (canvas) keyNumber(shownIdOf(options.palette()));
        // Only what drawRouted draws: the pending strokes the board has not drawn, each with its two band runs. A stroke the board drew
        // (skipped at draw) or a run of a stroke no longer pending draws nothing, so its retirement leaves the picture as it was; keyed,
        // every pen-up's hand-over presented the same picture once more (measured: 12 of 18 redundant GPU presents, drawing, notebook, img8).
        // draw2d fills each stroke's source instead, and canvas2d admits no runs: keyed by runs, a live stroke's fingerprint never moved,
        // so every frame of it answered unchanged and the stroke showed only at pen-up (measured: canvas2d doc12 DPR 2 draw, 8 presents
        // for 114 inputs, a held stroke's screenshot blank).
        for (const snapshot of handover?.pendingSnapshots() ?? []) {
            if (snapshot.dry && drawn.has(snapshot.identity.nodeId)) continue;
            const gesture = snapshot.identity.gestureSequence;
            keyNumber(gesture);
            if (canvas) keyNumber(sourceOf(snapshot)?.serial ?? -1);
            else { keyRun(runs.get(runKey(gesture, 'underlay'))); keyRun(runs.get(runKey(gesture, 'content'))); }
        }
        return keyEnd();
    };
    /** Whether draw2d paints this pending stroke on this band: the same skips its loop makes, short of the off-screen test. */
    const canvasPaints = (snapshot: WetInkSnapshot, band: WetBand, drawn: ReadonlySet<string>): boolean => {
        if (snapshot.dry && drawn.has(snapshot.identity.nodeId)) return false;
        const isHighlight = snapshot.presentation.tool === 'highlighter';
        if (!isHighlight && band === 'underlay') return false;
        if (!sourceOf(snapshot)) return false;
        return !!resolveSwatch(options.palette(), snapshot.presentation.color as Swatch, isHighlight ? 'highlight' : 'stroke');
    };
    const keyRun = (slot: WetRunSlot | undefined): void => {
        if (!slot) { keyInt(-2); return; }
        keyInt(SLOT_STATES[slot.state]); keyNumber(slot.serial); keyNumber(slot.scale);
        if (slot.viewBound) keyString(slot.viewKey); else keyInt(-1);
        keyNumber(slot.token.viewLease); keyNumber(slot.token.deviceGeneration); keyNumber(shownIdOf(slot.shown));
    };
    const drawnKey: Partial<Record<WetBand, number>> = {};
    // Whether the band's last draw drew nothing (no shown run). An empty band stays unchanged whatever the view does: its fingerprint folds
    // the camera in, so without this a camera move answered changed for a band with no ink (measured: every zoom frame).
    const drawnEmpty: Partial<Record<WetBand, boolean>> = {};
    // Whether the band's last draw was draw2d's: its picture is then keyed by the pending strokes' sources (fingerprintOf).
    const drawnCanvas: Partial<Record<WetBand, boolean>> = {};
    let frameAnswer = false;
    const prepareShared = (view: ViewState, budget: FrameBudget): boolean => {
        if (disposed || !owner || !options.current()) return false;
        if (lastPrepareFrame === budget.frameId) return frameAnswer;
        lastPrepareFrame = budget.frameId;
        inkRoutes?.beginFrame(budget.frameId);
        // A denied reservation waits for a genuine scheduler wake, not another polling frame.
        denied = false;
        try {
            for (const item of handover?.pendingSnapshots() ?? []) {
                if (item.dry && !options.exists(item.dry)) handover?.clear(item.identity);
            }
            const snapshots = handover?.pendingSnapshots() ?? [];
            for (const [id, item] of prepared) if (!isPending(snapshots, id)) { dropPrepared(item); prepared.delete(id); publicationVersion++; }
            for (const gesture of stables.keys()) if (!isPending(snapshots, gesture)) dropStable(gesture);
            if (work && (!snapshots.some(item => item.identity.gestureSequence === work!.snapshot.identity.gestureSequence
                && item.identity.nodeId === work!.snapshot.identity.nodeId) || work.scale < scaleAt(view, work.snapshot))) dropWork();
            const tipUntil = performance.now() + TIP_ALLOWANCE_MS;
            while (!budget.shouldYield() || (work !== null && performance.now() < tipUntil)) {
                if (!work) {
                    let next: WetInkSnapshot | null = null;
                    for (const item of snapshots) {
                        const old = prepared.get(item.identity.gestureSequence);
                        if (old?.snapshot !== item || old.scale < scaleAt(view, item)) { next = item; break; }
                    }
                    if (!next) { dirty = false; break; }
                    if (!begin(next, view)) { denied = true; break; }
                }
                step();
                // Publish the exact next admission to demand() before attempting it.
                // A finalized span is not on the published path, so it does not gate this frame's publication:
                // only the tail chunk, which the next publication shows, yields here (measured: a per-finalize break was a hold every 16 samples).
                if (denied || (work?.chunk?.retained && !work.chunk.finalizing)) break;
            }
        } catch (error) { dropWork(); denied = true; report(error); }
        let admitted = false;
        if (owner.device() && sameToken(options.token, budget.token)) {
            try { admitRuns(owner, view, budget); admitted = true; } catch (error) { report(error); }
        } else auditCount('wet', 'admit-skip:device-or-token');
        // Complete is the state, not the loop: a frame whose budget was spent before the loop ran (no work to do) is complete too.
        // Every pending stroke must be prepared at its current snapshot and scale, with no work left in progress.
        const caughtUp = (handover?.pendingSnapshots() ?? []).every(item => { const old = prepared.get(item.identity.gestureSequence); return old?.snapshot === item && old.scale >= scaleAt(view, item); });
        frameAnswer = caughtUp && work === null && admitted && !denied && routedCoverage(budget.token, view) === VERDICT_SHARP;
        return frameAnswer;
    };
    // A band that holds nothing shown has nothing to draw, so it has nothing that differs from its last presented frame: it answers
    // unchanged even before it has ever drawn (measured: a band with no stroke answered changed on every idle frame).
    const bandHasInk = (band: WetBand): boolean => {
        for (const [key, slot] of runs) if (((key & 1) === 1) === (band === 'content') && slot.shown) return true;
        return false;
    };
    // canvas2d admits no runs, so bandHasInk is false there for good: what draw2d paints is each pending stroke's source.
    const canvasHasInk = (band: WetBand): boolean => {
        const drawn = options.boardDrawnInk();
        return (handover?.pendingSnapshots() ?? []).some(snapshot => canvasPaints(snapshot, band, drawn));
    };
    const hasInk = (band: WetBand, canvas: boolean): boolean => canvas ? canvasHasInk(band) : bandHasInk(band);
    const prepareBand = (band: WetBand) => (view: ViewState, budget: FrameBudget): boolean | undefined => {
        const shared = prepareShared(view, budget);
        // Answered against the kind of draw the band last made; before any, the pane's backend decides.
        const canvas = drawnCanvas[band] ?? !owner?.device();
        if (!hasInk(band, canvas) && drawnEmpty[band] === true) return false;
        const same = drawnKey[band] !== undefined && drawnKey[band] === fingerprintOf(view, canvas);
        // The answer's branch, as audit counters: a redundant present names the gate that made it changed.
        if (renderAuditEnabled()) auditCount('wet', `answer:${band}:${same ? 'same' : 'fingerprint'}:${!shared ? 'gate' : 'shared'}:${drawnKey[band] === undefined ? 'undrawn' : 'drawn'}`);
        // The picture is the one this band last drew whatever the shared state: a stroke whose tip is still in progress (its work has not
        // published) draws nothing new, so it answers unchanged. Measured: on a large drawing every other frame of a stroke answered changed
        // over an identical picture, because the tip yielded and the gate read that as a change.
        if (same) return false;
        if (!shared) return undefined;
        if (drawnKey[band] === undefined) return hasInk(band, canvas) ? undefined : false;
        return undefined;
    };
    const make = (band: WetBand): PlatformLayerDefinition => ({
        id: `board-wet-${band}`, group: 'document', liveInput: true,
        // The owner band reclaims for the pane, under cpuWorkingSet's guard: the geometry is one set of bytes for both bands. A chunk a
        // shown run maps is kept (its triangles are the kit's until the run is retired), so only idle geometry is given back.
        cpuEvict(layer, bytes) {
            if (!owner || hostLayers.get(owner) !== layer) return;
            const keep = new Set<InkCoverage>();
            for (const slot of runs.values()) for (const chunk of slot.shown?.kept ?? []) keep.add(chunk);
            const freed = inkRoutes?.evictCpu(bytes, keep) ?? 0;
            // Measured for the pressure run: the bytes of idle geometry this live layer gave back to the pool.
            if (renderAuditEnabled()) auditCount('wet', 'reclaim:geometry', 1, { bytes: freed });
        },
        create(host) {
            if (disposed) throw new Error('Wet layer disposed');
            hosts.add(host); owner ??= host;
            let ended = false;
            // prepareFirst is read by the scheduler from the layer object (not the definition): a live stroke with GPU runs in
            // flight is prepared before the pane's other critical layers (fd3c12a6). The Layer contract itself is unchanged.
            const layer: Layer & { prepareFirst(): boolean } = {
                prepareFirst: () => !!owner?.device() && runsPending(),
                prepare: prepareBand(band),
                drawGpu(pass, view) { drawRouted(pass, view, band); drawnCanvas[band] = false; drawnKey[band] = fingerprintOf(view, false); drawnEmpty[band] = !bandHasInk(band); },
                draw2d(ctx, view) {
                    if (disposed || !options.current()) return;
                    drawnCanvas[band] = true; drawnKey[band] = fingerprintOf(view, true); drawnEmpty[band] = !canvasHasInk(band);
                    // The CPU reference path: counted, so a device session that draws here is visible in the audit.
                    if (renderAuditEnabled()) auditCount('wet', 'draw:canvas2d');
                    const boardDrawn = options.boardDrawnInk();
                    const snapshots = handover?.pendingSnapshots() ?? [];
                    host.paintWorld(ctx, view, () => {
                        for (const snapshot of snapshots) {
                            if (snapshot.dry && boardDrawn.has(snapshot.identity.nodeId)) continue;
                            const item = sourceOf(snapshot);
                            if (!item) continue;
                            if (offScreen(item.bounds, snapshot.presentation.localToWorld, view)) continue;
                            const isHighlight = snapshot.presentation.tool === 'highlighter';
                            if (!isHighlight && band === 'underlay') continue;
                            const pigment = resolveSwatch(options.palette(), snapshot.presentation.color as Swatch, isHighlight ? 'highlight' : 'stroke');
                            if (!pigment) continue;
                            // A continuation inherits its node's opacity and ancestor frame clips, as the committed stroke does. Live ink
                            // drew without them, so a segment past its frame showed while drawing and vanished at pen-up (feature 6e360790).
                            const alpha = (isHighlight ? (band === 'underlay' ? HIGHLIGHT_UNDERLAY_ALPHA : HIGHLIGHT_OVERLAY_ALPHA) : 1)
                                * (snapshot.presentation.opacity ?? 1);
                            ctx.save();
                            try {
                                // Each clip in its own transform, from the base of the paint world, then the stroke's own transform below.
                                const base = ctx.getTransform();
                                for (const clip of snapshot.presentation.clips ?? []) {
                                    ctx.setTransform(base); ctx.transform(...clip.localToWorld); ctx.clip(clipPathFor(clip), clip.fillRule);
                                }
                                ctx.setTransform(base);
                                const [a, b, c, d, e, f] = snapshot.presentation.localToWorld;
                                ctx.transform(a, b, c, d, e, f); ctx.translate(item.origin[0], item.origin[1]);
                                ctx.fillStyle = colourCss(withOpacity(pigment, alpha));
                                const path = pathOf(item);
                                if (path) ctx.fill(path, 'nonzero');
                            } finally { ctx.restore(); }
                        }
                    });
                },
                releaseGpu(reason) { if (reason === 'hidden' || reason === 'pressure') clear(); else releaseRoutes(); },
                // Partial relief: with no stroke in flight the routes draw nothing, so their GPU bytes (the union route's scratch, 16.8 MB)
                // are given back when the governor asks; the next stroke makes them again. Without it a pane that had prepared this frame
                // could not release the layer at all, and the pool's trim fell short (measured, notebook zoom to 332%: quality 1 -> 0.8,
                // the rest picture blurred for the 5 s recovery).
                evictGpu(bytes) {
                    if (bytes <= 0 || runs.size || work || !inkRoutes) return 0;
                    const freed = routesMemory().gpuBytes;
                    releaseRoutes();
                    auditCount('wet', 'evict:routes', 1, { bytes: freed });
                    return freed;
                },
                memory() {
                    // The shared routes and the reserve are one set of bytes for both bands, which share an owner host. Only the layer that
                    // cpuWorkingSet demands them for reports them: a host check alone counted them twice in the pane's sum.
                    const reporting = !!owner && hostLayers.get(owner) === layer;
                    const memory = reporting ? routesMemory() : undefined;
                    return { gpuBytes: memory?.gpuBytes ?? 0, cpuBytes: reporting ? reserved + (memory?.cpuBytes ?? 0) : 0 };
                },
                needsFrame() { return !ended && !disposed && !denied && (ringDeferred || dirty || !!work || (!!owner?.device() && runsPending())); },
                dispose() { if (ended) return; ended = true; if (owner === host) { clear(); owner = null; } hosts.delete(host); hostLayers.delete(host); owner ??= hosts.values().next().value ?? null; },
            };
            hostLayers.set(host, layer);
            return layer;
        },
        revision: () => generation,
        cpuWorkingSet: layer => {
            if (!owner || hostLayers.get(owner) !== layer) return { mandatoryBytes: 0, prefetchBytes: 0 };
            const snapshots = handover?.pendingSnapshots() ?? [];
            const pending = !!work || snapshots.some(item => prepared.get(item.identity.gestureSequence)?.snapshot !== item);
            // Each band shares this one owner. Demand the NEXT bounded native-path/coverage
            // allocation before prepare, including a replacement while old wet pixels stay live.
            // A pending stroke's scratch is already held (in reserved) from its first step until it is retired: it is demanded once, not per frame.
            const scratchHeld = snapshots.some(item => stables.get(item.identity.gestureSequence)?.temp) || !!work?.stable.temp;
            const extra = pending ? (scratchHeld ? 0 : TEMP_BYTES) + PATH_BLOCK + (work?.chunk?.retained?.bytes ?? 0) : 0;
            return { mandatoryBytes: reserved + extra + (owner.device() ? routesMemory().cpuBytes : 0), prefetchBytes: 0 };
        },
        // A live stroke whose GPU runs are still in flight is critical: the non-critical share of a frame is one sliver,
        // which took two frames per plan (measured: every other screencast frame held the same ink). Only while ink is in
        // flight: an idle layer that still wanted a frame kept every frame critical, which starves the other layers' upload
        // share (measured: drawing pan 204 → 78 presents, notebook pan 38).
        critical: () => !!owner?.device() && runsPending(),
        coverage: (_layer, frame, backend): LayerCoverage => {
            if (backend === 'canvas2d') return COVER_CANVAS2D;
            const verdict = routedCoverage(frame.token, frame.view);
            if (renderAuditEnabled()) auditCount('wet', verdict.complete ? (verdict.sharp ? 'cover:sharp' : verdict.why ? `cover:stale:${verdict.why}` : 'cover:stale') : `cover:incomplete:${verdict.why}`);
            return verdict;
        },
    });
    const layers = Object.freeze({ underlay: make('underlay'), content: make('content') });
    return {
        layers,
        attach(value) { if (disposed) throw new Error('Wet layer disposed'); handover = value; value.onPublish(invalidate); invalidate(); return () => { if (handover === value) { value.onPublish(null); handover = null; clear(); invalidate(); } }; },
        onInputFrame(callback) { callbacks.add(callback); return () => { callbacks.delete(callback); }; },
        invalidate,
        consumeInput() { if (disposed || !options.current()) return; for (const callback of callbacks) callback(); },
        // The same conditions the band's draw applies to this stroke: a pending stroke this band draws (its source, its
        // pigment on canvas2d, its shown run on a device), an off-screen one (no pixel of the view changes), or one this band
        // never paints (the underlay holds only highlighters). Board-drawn ink is the board's, so it is not covered here.
        drawsLive(nodeId, band, view, canvas) {
            if (disposed || !options.current()) return false;
            const snapshot = (handover?.pendingSnapshots() ?? []).find(item => item.identity.nodeId === nodeId);
            if (!snapshot) return false;
            const source = sourceOf(snapshot);
            if (!source) return false;
            if (offScreen(source.bounds, snapshot.presentation.localToWorld, view)) return true;
            const isHighlight = snapshot.presentation.tool === 'highlighter';
            if (band === 'underlay' && !isHighlight) return true;
            if (snapshot.dry && options.boardDrawnInk().has(nodeId)) return false;
            if (!canvas) return !!runs.get(runKey(snapshot.identity.gestureSequence, band))?.shown;
            return !!resolveSwatch(options.palette(), snapshot.presentation.color as Swatch, isHighlight ? 'highlight' : 'stroke');
        },
        liveNodeIds() {
            if (disposed) return EMPTY_LIVE_IDS;
            // Compared in place: the set is rebuilt only when it changes, since the board reads it every frame.
            const pending = handover?.pendingSnapshots() ?? [];
            let count = 0, same = true;
            for (const snapshot of pending) {
                if (!snapshot.dry) continue;
                count++;
                if (same && !liveIds.has(snapshot.dry.nodeId)) same = false;
            }
            if (same && count === liveIds.size) return liveIds;
            const next = new Set<string>();
            for (const snapshot of pending) if (snapshot.dry) next.add(snapshot.dry.nodeId);
            liveIds = next.size ? new ImmutableIds(next) : EMPTY_LIVE_IDS;
            return liveIds;
        },
        presented(revision, token, frame) {
            if (disposed || !sameToken(token, options.token) || !frame || frame.sceneRevision !== revision || !sameToken(frame.token, token)) return;
            let acknowledged = false;
            for (const item of handover?.pendingSnapshots() ?? []) {
                if (item.dry && available(frame, item.dry, token)) { handover?.acknowledgePresented(item.dry); acknowledged = true; }
            }
            // Only a handover that changed needs another frame. Invalidating on every presented frame made each frame ask
            // for the next: on a webgl2 PDF the board restarted its GPU plan every frame (245 in 6 s idle), never finished
            // one, stayed 'Updating…', and a later drag froze on a frame without the moved ink.
            if (acknowledged) invalidate();
        },
        clear,
        dispose() { if (disposed) return; clear(); disposed = true; callbacks.clear(); handover = null; },
    };
}
