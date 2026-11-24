import type { Affine, Rect } from '../../platform/types';
import type { RenderToken } from '../../platform/render/types';
import type { MemoryCacheHandle } from '../../platform/render/memoryGovernor';
import type { ByteLease } from '../../platform/render/gfx/api';
import { worldPose } from '../change/coordinates';
import { ApplyFailed } from '../change/errors';
import { createBoardChangeGeometry } from '../geom/changeGeometry';
import { compose, inverse } from '../geom/affine';
import { transformBox } from '../geom/bounds';
import { nextUp } from '../geom/numeric';
import type { PaintNode, PaintNodeSource } from './paintStream';
import type { ScenePaintNodeStream } from './scenePaintStream';
import { SessionDenseRasters } from './sessionDenseRasters';
import type { PaintNodeOrder } from './paintOrder';
import { geometrySceneBounds, transformedPathBounds } from '../geom/providers';
import { resolveConnectorGeometry, resolveConnectorGeometryNow } from '../geom/resolveConnector';
import type { AttachmentSurface, ConnectorGeometry } from '../geom/connectorTypes';
import type { PathOp } from '../geom/path';
import type { InkCoverage } from '../ink/outline';
import { inkCoverageBytes } from '../ink/packedCoverage';
import { CURVE_CHUNK_SPANS } from '../ink/curve';
import type { BoardDoc } from '../model/doc';
import type { NodeId } from '../model/ids';
import { createNode, type ConnectorNode, type Node } from '../model/nodes';
import type { SampleStoreReader } from '../model/samples';
import type { MediaStore } from '../media/store';
import { localBounds, BoundsQuality, type BoundsProvider, type Box, type LocalGeometryBounds } from '../scene/bounds';
import type { ScenePaintRequest } from '../scene/types';
import { paintConnector } from './connectorPaint';
import { conservativeConnectorBounds } from './conservativeConnector';
import { buildStrokeCoverage, buildStrokeCoverageNow } from './inkGeometry';
import { InkLodLadder } from './inkLodLadder';
import { paintStrokeNode, paintVectorNode, paintVectorNodeNow, type PreviewMedia } from './nodePaint';
import { DEFAULT_BOARD_PALETTES } from './palette';
import type { PaintPalette } from './colour';
import { retainPaintNodeResources } from './resourceLeases';
import { localGeometrySignature, sameGeometrySignature } from './retainedKeys';
import { createScenePaintNodeStream, prepareScenePaintSource, prepareScenePaintSourceNow, type ScenePaintPorts, type SceneResolveContext } from './sceneSource';
import { createBoardTextGeometry, type PreparedBoardText } from './textGeometry';
import type { BoardFonts } from '../text/fonts';
import { prepareBoardVectorGeometry, prepareBoardVectorGeometryNow, prepareOpaqueGeometry, type BoardVectorGeometry } from './vectorGeometry';
import { connectorBytes, inkChunkBytes, vectorBytes } from './residentBytes';
import { ResolvedNodeCache } from './resolvedNodeCache';
import { auditCount } from '../../platform/render/renderAudit';
import { inkRealisationScale, pictureTileWorld } from './paintRequestScope';
import { loadChunk } from '../../platform/chunkLoad';
import { yieldToHost } from '../../platform/yieldToHost';
/** The audit surface of the board's paint services: every counter below is `board-paint:<event>`. */
const AUDIT = 'board-paint';
/** A link card's stored preview picture and favicon, as the document holds them; other nodes have none. */
function previewMediaOf(doc: Pick<BoardDoc, 'media'>, node: Readonly<Node>): PreviewMedia | undefined {
    if (node.kind !== 'linkcard' || !node.preview) return undefined;
    return { image: node.preview.image ? doc.media.get(node.preview.image) : undefined,
        favicon: node.preview.favicon ? doc.media.get(node.preview.favicon) : undefined };
}
/** The idle geometry budget: about 16 MB of the 32 MB CPU grant, so a few thousand strokes' geometry stays cached. */
const IDLE_GEOMETRY_BYTES = 16 * 1024 * 1024;
/** Resident size of one prepared geometry, estimated from its typed arrays and records (see residentBytes). */
function preparedBytes(prepared: Prepared): number {
    let bytes = 512 + prepared.key.length * 2 + prepared.signature.length * 16;
    for (const chunk of prepared.ink ?? []) bytes += inkChunkBytes(chunk);
    if (prepared.vector) bytes += vectorBytes(prepared.vector);
    if (prepared.connector) bytes += connectorBytes(prepared.connector);
    return bytes;
}
/** A dense plan's resolved nodes, valid for one variant of the paint inputs that resolution reads. */
interface SharedResolution { readonly cache: ResolvedNodeCache; readonly variant: string }


interface Prepared {
    readonly key: string;
    readonly signature: readonly unknown[];
    readonly bounds: LocalGeometryBounds;
    readonly vector?: BoardVectorGeometry;
    readonly ink?: readonly InkCoverage[];
    readonly connector?: ConnectorGeometry;
    readonly inkPrecision?: string;
    readonly inkLod?: boolean;
}
const allocationScratch = new Float64Array(4);
function withAllocation(paint: PaintNode, geometry: Prepared, context: SceneResolveContext): PaintNode {
    const ink = geometry.bounds.ink;
    if (!ink) return paint;
    // Rewalking every realised command for every dense tile left a 1000-polyline view blank.
    // The canonical prepared ink envelope already covers all this node's contributions.
    transformBox(allocationScratch, 0, ink, 0, context.world);
    const [x, y, right, bottom] = allocationScratch;
    const bounds = { x, y, width: nextUp(right - x), height: nextUp(bottom - y) };
    if (Object.values(bounds).some(value => !Number.isFinite(value)) || bounds.width < 0 || bounds.height < 0) return paint;
    return { ...paint, allocationBounds: Object.freeze(bounds) };
}
function matrix(doc: BoardDoc, id: NodeId): Affine {
    const pose = worldPose(doc, id), c = Math.cos(pose.rotation), s = Math.sin(pose.rotation);
    return [c, s, -s, c, pose.x, pose.y];
}
/** The connector with each end whose target has no attachment surface detached: that end paints from its own free point, as a
 * connector whose target is gone does. Left attached, the resolver answers 'pending' for it, and the frame never presents. */
function unattachedWhere(node: ConnectorNode, surfaces: ReadonlyMap<NodeId, AttachmentSurface>): ConnectorNode {
    const start = node.start.attach && !surfaces.has(node.start.attach.target) ? { ...node.start, attach: null } : node.start;
    const end = node.end.attach && !surfaces.has(node.end.attach.target) ? { ...node.end, attach: null } : node.end;
    return start === node.start && end === node.end ? node : { ...node, start, end };
}
function rectangle(w: number, h: number): readonly PathOp[] {
    return [{ op: 'M', p: { x: 0, y: 0 } }, { op: 'L', p: { x: w, y: 0 } },
        { op: 'L', p: { x: w, y: h } }, { op: 'L', p: { x: 0, y: h } }, { op: 'Z' }];
}
function frameClips(doc: BoardDoc, node: Readonly<Node>): AttachmentSurface['clips'] {
    const result: AttachmentSurface['clips'][number][] = [];
    let current = doc.nodes.get(node.parent as NodeId);
    for (let depth = 0; current && depth < 64; depth++) {
        if (current.kind === 'frame') result.push({ outline: rectangle(current.w, current.h), localToWorld: matrix(doc, current.id) });
        current = doc.nodes.get(current.parent as NodeId);
    }
    result.reverse(); return result;
}
function rectBox(rect: Rect): Box { return [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height]; }
function union(a: Box | null, b: Box): Box {
    return a ? [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])] : b;
}

function strokePrepared(key: string, ink: readonly InkCoverage[]): Omit<Prepared, 'signature'> {
    let bounds: Box | null = null;
    for (const chunk of ink) bounds = union(bounds, [chunk.boundsLocal.x, chunk.boundsLocal.y,
        chunk.boundsLocal.x + chunk.boundsLocal.w, chunk.boundsLocal.y + chunk.boundsLocal.h]);
    return { key, ink, bounds: { ink: bounds ?? [0, 0, 0, 0] } };
}
function connectorPrepared(key: string, node: Readonly<Node> & { kind: 'connector' }, geometry: ConnectorGeometry,
    inverseWorld: Affine): Omit<Prepared, 'signature'> {
    let local: Box | null = null;
    for (const path of [geometry.body, ...geometry.heads]) {
        const bounds = transformedPathBounds(path, inverseWorld); if (bounds) local = union(local, rectBox(bounds));
    }
    if (geometry.label) {
        const b = geometry.label.paint.ink, m = compose(inverseWorld, geometry.label.localToWorld);
        const path: PathOp[] = [{ op: 'M', p: { x: b.x, y: b.y } }, { op: 'L', p: { x: b.x + b.width, y: b.y } },
            { op: 'L', p: { x: b.x + b.width, y: b.y + b.height } }, { op: 'L', p: { x: b.x, y: b.y + b.height } }, { op: 'Z' }];
        const box = transformedPathBounds(path, m); if (box) local = union(local, rectBox(box));
    }
    local ??= [node.start.x, node.start.y, node.start.x, node.start.y];
    const half = node.width / 2;
    return { key, connector: geometry, bounds: { ink: [local[0] - half, local[1] - half, local[2] + half, local[3] + half] } };
}

/** One session service resolves the same local geometry for Scene, paint and
 * export. Pinned read-side documents are passed explicitly after every await. */
export function createBoardRenderServices(options: {
    readonly doc: BoardDoc;
    readonly samples: SampleStoreReader;
    readonly media: MediaStore;
    readonly token: RenderToken;
    readonly palettes?: Readonly<{ light: PaintPalette; dark: PaintPalette }>;
    readonly deviceScale?: number;
    /** Main-window transport only; worker-hosted admission reuses its own cooperative canonical job. */
    readonly coverageWorker?: boolean;
    readonly fonts?: BoardFonts;
    /** The session's cache allocator for derived residency: idle geometry and stroke LOD levels. Absent, nothing is charged. */
    readonly derivedMemory?: (evict: (bytes: number) => void) => Pick<MemoryCacheHandle, 'reserve' | 'release' | 'close'>;
    /** Hears the bytes of stroke geometry alive now (built by these services and not yet collected), whoever holds it: frames, caches,
     * picks. Absent, nothing is reported. */
    readonly modelMemory?: (bytes: number) => void;
    cooperate?(): Promise<void>;
}) {
    // Every prepared geometry is kept under its own geometry key (unique per build), indexed by node. A frame can ask for one node
    // at several precisions and from two document states (a preview and the committed board), so a lookup matches the precision and
    // the signature, and no other variant is dropped on a store: the byte budget ages them out.
    const cached = new Map<string, Prepared>(), variantsOf = new Map<NodeId, Set<string>>();
    const listeners = new Set<(ids: ReadonlySet<NodeId>) => void>();
    const sessionRasters = new SessionDenseRasters();
    // Every coverage these services built, counted until it is collected: what a board's geometry costs while anything holds it.
    // The frames that draw it, the idle cache and the surviving index all share one object per chunk, so it is counted once.
    let liveModelBytes = 0, modelReported = -1, modelReport = false;
    const reportModel = () => {
        if (modelReport || !options.modelMemory) return;
        modelReport = true;
        queueMicrotask(() => {
            modelReport = false;
            if (disposed || liveModelBytes === modelReported) return;
            modelReported = liveModelBytes; options.modelMemory?.(Math.max(0, liveModelBytes));
        });
    };
    const modelCounted = new WeakSet<InkCoverage>();
    const modelGone = typeof FinalizationRegistry === 'function' && options.modelMemory
        ? new FinalizationRegistry<number>(bytes => { if (!disposed) { liveModelBytes -= bytes; reportModel(); } }) : null;
    const countModel = (ink: readonly InkCoverage[]): void => {
        if (!modelGone) return;
        for (const chunk of ink) {
            if (modelCounted.has(chunk)) continue;
            const bytes = inkCoverageBytes(chunk);
            modelCounted.add(chunk); modelGone.register(chunk, bytes); liveModelBytes += bytes;
        }
        reportModel();
    };
    // An opaque service incarnation binds the full owner token without putting an arbitrarily
    // long document id into the worker protocol's 128-character session field.
    const workerSession = `render/${options.token.session}/${options.token.bytesGeneration}/${crypto.randomUUID()}`;
    const coverageWorker = typeof window !== 'undefined' && options.coverageWorker !== false;
    const textIds = new Set<NodeId>();
    const changeScopes = new Set<ReadonlyMap<NodeId, Prepared>>();
    let serial = 0, disposed = false, ownerReleased = false, holders = 1;
    // One ladder per stroke, valid for its geometry signature: an edit replaces the signature, so the old
    // ladder is disposed at the next prepare, and the cache trim and session end release the rest.
    const inkLadders = new Map<NodeId, { readonly signature: readonly unknown[]; readonly ladder: InkLodLadder }>();
    const evictInkLadders = (bytes: number): number => {
        let freed = 0;
        for (const { ladder } of inkLadders.values()) { if (freed >= bytes) break; freed += ladder.evict(bytes - freed); }
        return freed;
    };
    // Idle entries are bounded by bytes, and each lease is charged to the derived handle, so the governor reclaims them first.
    const idle = new Map<string, { readonly node: NodeId; readonly bytes: number; readonly lease: ByteLease | null }>();
    let idleBytes = 0;
    const dropInkLadder = (id: NodeId) => {
        const entry = inkLadders.get(id);
        if (entry) { entry.ladder.dispose(); inkLadders.delete(id); }
    };
    // Drops one variant. Replacing or releasing an entry keeps its ladder, which the caller may have just rebuilt for the new signature.
    const dropVariant = (key: string) => {
        const entry = idle.get(key), value = cached.get(key);
        cached.delete(key);
        if (value && entry) {
            const set = variantsOf.get(entry.node);
            set?.delete(key); if (set && set.size === 0) variantsOf.delete(entry.node);
        }
        if (!entry) return;
        idle.delete(key); idleBytes -= entry.bytes;
        if (entry.lease) derived?.release(entry.lease);
    };
    const forgetIdle = (id: NodeId) => { for (const key of [...(variantsOf.get(id) ?? [])]) dropVariant(key); };
    // Stroke geometry outlives its idle entry while anything draws it: a presented frame's ink items hold the very coverage array
    // the build returned. Each build leaves a small record (key, signature, bounds) holding that array weakly, so a later stream
    // takes the geometry that is still in memory instead of building a second copy of it. Evicted from the idle budget and asked
    // again by the next stream (view, whole scene, a dense tile), every stroke of a dense board was built again: measured, a
    // 451-stroke notebook opened with 2,519 builds of 905 variants. The record goes when the coverage is collected.
    interface Surviving { readonly key: string; readonly signature: readonly unknown[]; readonly bounds: LocalGeometryBounds;
        readonly inkPrecision?: string; readonly inkLod?: boolean; readonly ink: WeakRef<readonly InkCoverage[]> }
    const surviving = new Map<NodeId, Map<string, Surviving>>();
    const survivingGone = typeof FinalizationRegistry === 'function' ? new FinalizationRegistry<{ id: NodeId; band: string }>(({ id, band }) => {
        const bands = surviving.get(id), entry = bands?.get(band);
        if (entry && entry.ink.deref() === undefined) { bands!.delete(band); if (!bands!.size) surviving.delete(id); }
    }) : null;
    const noteSurviving = (id: NodeId, prepared: Prepared): void => {
        if (!prepared.ink || prepared.inkPrecision === undefined || typeof WeakRef !== 'function') return;
        let bands = surviving.get(id);
        if (!bands) surviving.set(id, bands = new Map());
        bands.set(prepared.inkPrecision, { key: prepared.key, signature: prepared.signature, bounds: prepared.bounds,
            inkPrecision: prepared.inkPrecision, inkLod: prepared.inkLod, ink: new WeakRef(prepared.ink) });
        survivingGone?.register(prepared.ink, { id, band: prepared.inkPrecision });
    };
    const survivingFor = (id: NodeId, signature: readonly unknown[], accept: (value: Prepared) => boolean): Prepared | undefined => {
        const bands = surviving.get(id);
        if (!bands) return undefined;
        for (const [band, entry] of bands) {
            const ink = entry.ink.deref();
            if (!ink) { bands.delete(band); continue; }
            if (!sameGeometrySignature(entry.signature, signature)) continue;
            const value: Prepared = { key: entry.key, signature: entry.signature, bounds: entry.bounds, ink,
                ...(entry.inkPrecision !== undefined ? { inkPrecision: entry.inkPrecision, inkLod: entry.inkLod } : {}) };
            if (accept(value)) { auditCount(AUDIT, 'geometry:surviving'); return value; }
        }
        if (!bands.size) surviving.delete(id);
        return undefined;
    };
    // A node's prepared geometry for `signature`, whichever precision it was prepared for (bounds and changes do not depend on it).
    const variantFor = (id: NodeId, signature: readonly unknown[], accept: (value: Prepared) => boolean = () => true): Prepared | undefined => {
        for (const key of variantsOf.get(id) ?? []) {
            const value = cached.get(key);
            if (value && accept(value) && sameGeometrySignature(value.signature, signature)) return value;
        }
        return survivingFor(id, signature, accept);
    };
    // Marks an idle entry most recently used. A surviving geometry (survivingFor) is not an idle entry and stays out of the budget.
    const touch = (value: Prepared): void => { if (cached.delete(value.key)) cached.set(value.key, value); };
    // One build per node, precision and signature at a time: a second stream asking while it runs takes its answer. Without it the
    // view and whole-scene streams, which share one realisation per stroke on a device, built the same stroke side by side.
    const building = new Map<string, { readonly signature: readonly unknown[]; readonly promise: Promise<Prepared>; readonly signal: AbortSignal }>();
    // The band a paint stream last resolved an ordinary stroke at: what a bounds-only build (realize) builds, so the two share it.
    let lastPaintPrecision: Pick<SceneResolveContext, 'deviceScale' | 'allowInkLod' | 'sensitive'> | null = null;
    // The geometry a visible item draws at its wanted band, else at the band before the last crossing. A missing wanted band is
    // counted (geometry:band-miss) whether or not the previous band serves it; both missing leaves the caller a counted stand-in.
    const variantForBand = (id: NodeId, signature: readonly unknown[], wanted: string, previous: string | null): Prepared | undefined => {
        const exact = variantFor(id, signature, value => value.inkPrecision === wanted);
        if (exact) return exact;
        auditCount(AUDIT, 'geometry:band-miss');
        return previous === null ? undefined : variantFor(id, signature, value => value.inkPrecision === previous);
    };
    // The zoom's pins (pinVisible): the visible nodes. Every variant of a pinned node is kept, whatever its band: a sensitive stroke is
    // keyed at another scale, and a band crossing holds the previous band. Matched at eviction, so a variant stored after the pins
    // were set (in the same frame) is pinned too. A pin lapses PIN_TTL_MS after the zoom's last pin, so a zoom that ends with no
    // further prepare (the settled board asks for none) still lets the governor reclaim its geometry. Released at rest too.
    const PIN_TTL_MS = 1000;
    let pinnedNodes = new Set<NodeId>(), pinnedAt = -Infinity;
    const pinsLive = (): boolean => {
        if (performance.now() - pinnedAt <= PIN_TTL_MS) return true;
        if (pinnedNodes.size) pinnedNodes = new Set();
        return false;
    };
    const isPinned = (key: string): boolean => {
        const entry = idle.get(key);
        return !!entry && pinsLive() && pinnedNodes.has(entry.node);
    };
    const pinVisible = (ids: Iterable<NodeId>): void => {
        pinnedNodes = new Set(ids); pinnedAt = performance.now();
        auditCount(AUDIT, 'geometry:pin', pinnedNodes.size);
    };
    const releasePins = (): void => { pinnedNodes = new Set(); pinnedAt = -Infinity; };
    // Least recently used first; a budget eviction also drops the entry's ladder once no precision of its node has a geometry to serve.
    // Null when every idle entry is pinned: the caller stops (a pinned zoom variant is never the budget's to take).
    const evictOldestIdle = (): { readonly bytes: number; readonly charged: number } | null => {
        let gone: string | undefined;
        for (const key of cached.keys()) if (!isPinned(key)) { gone = key; break; }
        if (gone === undefined) return null;
        const entry = idle.get(gone);
        // A budget eviction of a node a later pass needs again is a rebuild; the count shows whether the idle budget is too small.
        auditCount(AUDIT, 'geometry:evict');
        dropVariant(gone);
        if (entry && !variantsOf.has(entry.node)) dropInkLadder(entry.node);
        return { bytes: entry?.bytes ?? 0, charged: entry?.lease?.bytes ?? 0 };
    };
    // The governor's request: idle geometry first (rebuildable from the document), then stroke ladders, then the session's resolved
    // paint (rebuilt by the next resolve). Left out, the resolved paint was the one derived charge no trim could take: an old board of
    // 450 pen strokes held most of the 32 MiB CPU pool in it, every frame was refused, idle geometry was trimmed and rebuilt 379 times
    // in 15 s, and the pane stayed on "Waiting for memory to draw this board…" for good (measured, CfT 157, M4 Pro, one pane).
    const evictDerived = (bytes: number) => {
        let freed = 0;
        while (freed < bytes) { const evicted = evictOldestIdle(); if (!evicted) break; freed += evicted.charged; }
        if (freed < bytes) freed += evictInkLadders(bytes - freed);
        if (freed < bytes && sessionResolved) { auditCount(AUDIT, 'geometry:evict-resolved'); freed += sessionResolved.evict(); }
    };
    const derived = options.derivedMemory?.(evictDerived);
    // The session's resolved paint, one revision at a time. A node resolves to the same items in every stream and frame of one
    // variant (revision, sheet, theme, precision, fonts), so a direct frame, a candidate pass and a dense plan of one revision each
    // paint a node once. By reading: the paint re-ran per stream, and the first picture of a 5,400-item board prepared each candidate
    // three times (solo/whiteboard.md). Its charge is the derived handle's, released with the session.
    const sessionResolved = derived ? new ResolvedNodeCache(derived) : undefined;
    const inkLadder = (id: NodeId, signature: readonly unknown[]): InkLodLadder | undefined => {
        if (!derived || disposed) return undefined;
        const entry = inkLadders.get(id);
        if (entry && sameGeometrySignature(entry.signature, signature)) return entry.ladder;
        dropInkLadder(id);
        const ladder = new InkLodLadder(derived);
        inkLadders.set(id, { signature, ladder });
        return ladder;
    };
    const admit = (charged: number): { readonly lease: ByteLease | null } | null => {
        if (!derived) return { lease: null };
        // Work ahead of need (ReserveOptions.prefetch): idle geometry only saves a rebuild. Asked as a normal reservation, its refusal
        // was pool pressure: it trimmed the frame's own working memory and stepped the app's quality down for a cache insert.
        const lease = derived.reserve(charged, { prefetch: true });
        return lease ? { lease } : null;
    };
    /** Stores a prepared geometry as the newest idle entry. Its stroke ladder counts toward the budget too. A charge the
     * governor still denies after idle bytes are freed leaves the entry out: the cache only ever saves a rebuild. */
    const storeIdle = (id: NodeId, prepared: Prepared): void => {
        const key = prepared.key;
        const ladder = inkLadders.get(id), charged = preparedBytes(prepared);
        const bytes = charged + (ladder && sameGeometrySignature(ladder.signature, prepared.signature) ? ladder.ladder.bytes : 0);
        if (bytes > IDLE_GEOMETRY_BYTES) return;
        while (idleBytes + bytes > IDLE_GEOMETRY_BYTES) {
            if (!evictOldestIdle()) { auditCount(AUDIT, 'geometry:pinned-full'); return; }
        }
        let admitted = admit(charged);
        if (!admitted && cached.size) { evictDerived(charged); admitted = admit(charged); }
        if (!admitted) return;
        cached.set(key, prepared);
        let set = variantsOf.get(id);
        if (!set) variantsOf.set(id, set = new Set());
        set.add(key);
        idle.set(key, { node: id, bytes, lease: admitted.lease });
        idleBytes += bytes;
    };
    const palettes = options.palettes ?? DEFAULT_BOARD_PALETTES;
    const text = createBoardTextGeometry({ fonts: options.fonts, cooperate: options.cooperate, onFontEpoch() {
        // An id leaves the set only when the session doc no longer holds its node AND no geometry is kept for it: a deleted node
        // whose geometry is gone has nothing to re-prepare, so the set stays the text nodes the session still has or keeps.
        for (const id of [...textIds]) {
            const kept = (variantsOf.get(id)?.size ?? 0) > 0;
            forgetIdle(id);
            if (!kept && !options.doc.nodes.has(id)) textIds.delete(id);
        }
        const ids = new Set(textIds);
        for (const listener of listeners) listener(ids);
    } });
    const check = (signal?: AbortSignal) => {
        signal?.throwIfAborted();
        if (disposed) throw new DOMException('Board rendering services disposed', 'AbortError');
    };
    const releaseHolder = () => {
        if (--holders !== 0) return;
        disposed = true; for (const controller of warmControllers) controller.abort(); text.dispose(); for (const key of [...cached.keys()]) dropVariant(key); textIds.clear(); listeners.clear(); sessionRasters.dispose();
        for (const id of [...inkLadders.keys()]) dropInkLadder(id);
        sessionResolved?.dispose();
        derived?.close();
        // The services' own count ends with them; geometry still drawn by a closing pane goes with it.
        if (options.modelMemory) { liveModelBytes = 0; modelReported = 0; options.modelMemory(0); }
    };
    const signature = (node: Readonly<Node>, doc: BoardDoc): readonly unknown[] => {
        const local = localGeometrySignature(node, text.fonts.epoch, 1);
        if (node.kind !== 'connector') return local;
        const result = [...local, ...matrix(doc, node.id)];
        for (const end of [node.start, node.end]) if (end.attach) {
            const target = doc.nodes.get(end.attach.target);
            if (!target) { result.push(null); continue; }
            result.push(...localGeometrySignature(target, text.fonts.epoch, 1), ...matrix(doc, target.id));
            for (const clip of frameClips(doc, target)) result.push(...clip.localToWorld, clip.outline[1].op === 'L' ? clip.outline[1].p.x : 0,
                clip.outline[2].op === 'L' ? clip.outline[2].p.y : 0);
        }
        return result;
    };
    const inkPrecision = (context?: Partial<Pick<SceneResolveContext, 'deviceScale' | 'sensitive' | 'allowInkLod'>>) => {
        const raw = context?.deviceScale ?? options.deviceScale ?? 3;
        const scale = inkRealisationScale(raw, !!context?.sensitive);
        const lod = !!context?.allowInkLod && context.deviceScale !== undefined && !context.sensitive;
        return { scale, lod, key: `${scale}:${lod ? 'lod' : 'fine'}` };
    };
    // Wanted bands building in the background during a zoom: one build per node and band at a time.
    const warming = new Set<string>(), warmFailed = new Set<string>(), warmControllers = new Set<AbortController>();
    // A warm build has its own controller: a band crossing aborts the request's paint, and a build tied to it would restart from zero
    // at every crossing. A failure other than the abort is counted, and that node and band is not retried (the previous band serves).
    const warmBand = (borrowed: Readonly<Node>, doc: BoardDoc,
        context: Pick<SceneResolveContext, 'deviceScale' | 'sensitive' | 'allowInkLod' | 'previousDeviceScale'>, key: string): void => {
        if (disposed || warming.has(key) || warmFailed.has(key)) return;
        warming.add(key);
        const controller = new AbortController();
        warmControllers.add(controller);
        prepare(borrowed, doc, controller.signal, { ...context, previousDeviceScale: undefined })
            .catch(() => { if (!controller.signal.aborted) { warmFailed.add(key); auditCount(AUDIT, 'geometry:warm-failed'); } })
            .finally(() => { warming.delete(key); warmControllers.delete(controller); });
    };
    const prepare = async (borrowed: Readonly<Node>, doc: BoardDoc, signal: AbortSignal,
        context?: Pick<SceneResolveContext, 'deviceScale' | 'sensitive' | 'allowInkLod' | 'previousDeviceScale'>): Promise<Prepared> => {
        check(signal);
        const node = createNode(borrowed), before = signature(node, doc);
        const precision = node.kind === 'stroke' ? inkPrecision(context) : undefined;
        const old = variantFor(node.id, before, value => value.inkPrecision === precision?.key);
        if (old) { touch(old); auditCount(AUDIT, 'geometry:hit'); return old; }
        // A band crossing during a live zoom: the stroke draws its previous band's geometry (a band miss) while the wanted band builds
        // in the background, so the zoom frame does not wait for the build. Only the async producer takes this (the live paint path).
        if (precision && context?.previousDeviceScale !== undefined) {
            // The previous band of this stroke: sensitivity applies to it as to the wanted band, so a selected stroke's previous band is its own.
            const previousKey = inkPrecision({ ...context, deviceScale: context.previousDeviceScale }).key;
            const held = variantForBand(node.id, before, precision.key, previousKey);
            if (held) { warmBand(borrowed, doc, context, `${node.id}:${precision.key}`); return held; }
        }
        const flightKey = `${node.id}|${precision?.key ?? ''}`;
        const flight = building.get(flightKey);
        if (flight && sameGeometrySignature(flight.signature, before)) {
            try { const value = await flight.promise; check(signal); auditCount(AUDIT, 'geometry:joined'); return value; }
            catch (error) {
                check(signal);
                // A build its own caller cancelled is not this caller's failure, whatever form the cancellation took (a worker reports
                // it as its own 'Cancelled' error, not an AbortError): this caller builds. Rethrown, an old board's acquisition
                // failed with "Request aborted" when a stream it had joined was superseded.
                if (!flight.signal.aborted) throw error;
            }
        }
        const promise = build(node, doc, signal, before, precision);
        building.set(flightKey, { signature: before, promise, signal });
        try { return await promise; } finally { if (building.get(flightKey)?.promise === promise) building.delete(flightKey); }
    };
    const build = async (node: Node, doc: BoardDoc, signal: AbortSignal, before: readonly unknown[],
        precision: ReturnType<typeof inkPrecision> | undefined): Promise<Prepared> => {
        auditCount(AUDIT, 'geometry:build');
        const key = `${options.token.session}:${node.id}:geometry:${++serial}`;
        let result: Omit<Prepared, 'signature'>;
        if (node.kind === 'group') throw new TypeError('Groups aggregate child geometry in Scene');
        if (node.kind === 'stroke') {
            const revision = doc.rev, sampleRef = node.samples;
            const identity = { session: workerSession, epoch: options.token.vaultEpoch, revision };
            // Captured now, not inside the worker callback: a later edit must not hand this stroke's ladder to a newer geometry.
            const ladder = coverageWorker && precision!.lod ? inkLadder(node.id, before) : undefined;
            const ink = await buildStrokeCoverage(node, options.samples, {
                deviceScale: precision!.scale, cooperate: options.cooperate, signal,
                worker: coverageWorker ? async (points, parameters, style, range, coverage) => {
                    // Bounded like every lazy chunk on a path a person waits on: a stalled fetch here held "Loading drawing…".
                    const { prepareInkCoverageInWorker } = await loadChunk(() => import('../workers/inkCoverageClient'));
                    return prepareInkCoverageInWorker(points, parameters, style, range, coverage, identity, signal, () => {
                        const current = doc.nodes.get(node.id);
                        return !disposed && !signal.aborted && doc.rev === revision && current?.kind === 'stroke'
                            && current.samples === sampleRef && sameGeometrySignature(signature(current, doc), before);
                    }, precision!.lod ? { ladder, chunkCount: Math.max(1, Math.ceil((options.samples.count(sampleRef) - 1) / CURVE_CHUNK_SPANS)) } : undefined);
                } : undefined,
            });
            countModel(ink);
            result = strokePrepared(key, ink);
        } else if (node.kind === 'connector') {
            // Capture every dependency before awaiting fonts/geometry. An export
            // pin never follows a later target move in the live document.
            const world = matrix(doc, node.id), inverseWorld = inverse(world, 1e12);
            if (!inverseWorld) throw new RangeError('Connector transform is not invertible');
            const targets = new Map<NodeId, { node: Node; world: Affine; clips: AttachmentSurface['clips'] }>();
            for (const end of [node.start, node.end]) if (end.attach && !targets.has(end.attach.target)) {
                const target = doc.nodes.get(end.attach.target);
                // A target the doc does not hold has no surface: its end is painted unattached (unattachedWhere), not thrown on.
                if (!target) continue;
                targets.set(target.id, { node: createNode(target), world: matrix(doc, target.id), clips: frameClips(doc, target) });
            }
            const surfaces = new Map<NodeId, AttachmentSurface>();
            for (const [id, target] of targets) {
                // A group aggregates its children in Scene and has no geometry of its own, so it is never prepared here.
                if (target.node.kind === 'group') continue;
                const prepared = await prepare(target.node, doc, signal);
                const surface = prepared.vector?.attachments;
                // A target with no attachment surface leaves its end unattached, as a group does; a throw here would drop every frame.
                if (!surface) continue;
                surfaces.set(id, { target: id, outline: surface.outline, logicalBox: surface.logicalBox,
                    localToWorld: target.world, clips: target.clips, revision: doc.rev });
            }
            const paintNode = unattachedWhere(node, surfaces);
            const resolved = await resolveConnectorGeometry({ key, node: paintNode, localToWorld: world,
                resolveTarget: id => surfaces.get(id), label: null, toleranceWorld: .01, maxPieces: 65_536 }, {
                signal, cooperate: options.cooperate,
                label: node.label ? async (anchor, length, labelSignal) => {
                    const prepared = await text.prepare(node, { revision: key, connectorLength: length, anchor }, labelSignal);
                    return prepared ? { paint: prepared.paint, localToWorld: [1, 0, 0, 1, prepared.placement.x, prepared.placement.y] } : null;
                } : undefined,
            });
            if (resolved.status !== 'ready') throw new Error(resolved.status === 'unroutable' ? resolved.reason : `Connector ${node.id} geometry is pending: ${resolved.reason}`);
            result = connectorPrepared(key, paintNode, resolved.geometry, inverseWorld);
        } else {
            const vector = node.kind === 'opaque' ? await prepareOpaqueGeometry(node, signal, options.cooperate)
                : await prepareBoardVectorGeometry(node, { text, revision: key, zoom: 1, signal, cooperate: options.cooperate });
            if (vector.text.length) textIds.add(node.id);
            const bounds = geometrySceneBounds(vector);
            result = { key, vector, bounds: { ink: bounds.ink, hit: bounds.hit } };
        }
        check(signal);
        // The build awaited: another stream may have stored the same realization meanwhile. One realization per node, precision
        // and signature is kept, so every stream that asks gets the same geometry key (a second key would make an unchanged node
        // look changed to the composer's index, which reports the parts whose key moved).
        const twin = variantFor(node.id, before, value => value.inkPrecision === precision?.key);
        if (twin) { touch(twin); auditCount(AUDIT, 'geometry:twin'); return twin; }
        const prepared: Prepared = { ...result, signature: before,
            ...(precision ? { inkPrecision: precision.key, inkLod: precision.lod } : {}) };
        // Retained source items own their geometry by reference after eviction, and a later lookup finds it there (noteSurviving).
        storeIdle(node.id, prepared);
        noteSurviving(node.id, prepared);
        return prepared;
    };
    // A pick reuses the coverage the painter already built when that coverage is precise enough at the pick's zoom. Every
    // InkCoverage carries its own certified error (centre, radius, dash phase), and the pick jobs widen their hit/miss
    // decisions by exactly that error, so ANY certified variant answers a hit test correctly; precision only decides how
    // close to the band's edge an answer stays undecided. Under PICK_COVERAGE_ERROR_CSS the edge moves by less than an
    // eighth of a CSS px against a 4 CSS px pointer margin. The pick asked for its own variant before (device scale 3,
    // never LOD), so the first hover or marquee over fresh ink waited on worker coverage jobs for geometry already on screen
    // (measured: after 12 strokes painted, the first hover sweep counted geometry:build 10, the second 1).
    const PICK_COVERAGE_ERROR_CSS = 1 / 8;
    const pickVariant = (borrowed: Readonly<Node>, doc: BoardDoc, cssPerWorld: number): Prepared | undefined => {
        if (borrowed.kind !== 'stroke' || !(cssPerWorld > 0) || !Number.isFinite(cssPerWorld)) return undefined;
        const coverageError = (value: Prepared): number => {
            let error = 0;
            for (const coverage of value.ink ?? []) error = Math.max(error, coverage.centreErrorWorld + coverage.radiusErrorWorld + coverage.dashPhaseErrorWorld);
            return error;
        };
        const value = variantFor(borrowed.id, signature(borrowed, doc), candidate => !!candidate.ink
            && coverageError(candidate) * cssPerWorld <= PICK_COVERAGE_ERROR_CSS);
        if (!value) return undefined;
        touch(value); auditCount(AUDIT, 'geometry:pick-reuse');
        return value;
    };
    // A native copy event cannot await fonts, images, or a worker. These are the
    // canonical CPU producers at the current face epoch, not persisted b hints.
    // Mutation access below still separately requires fully loaded text faces.
    const prepareNow = (borrowed: Readonly<Node>, doc: BoardDoc, signal: AbortSignal,
        context?: Pick<SceneResolveContext, 'deviceScale' | 'sensitive' | 'allowInkLod'>): Prepared => {
        check(signal);
        const node = createNode(borrowed), before = signature(node, doc);
        const precision = node.kind === 'stroke' ? inkPrecision(context ? { ...context, allowInkLod: false } : undefined) : undefined;
        const old = variantFor(node.id, before, value => value.inkPrecision === precision?.key);
        if (old) { touch(old); auditCount(AUDIT, 'geometry:hit'); return old; }
        auditCount(AUDIT, 'geometry:build');
        const key = `${options.token.session}:${node.id}:geometry:${++serial}`;
        let result: Omit<Prepared, 'signature'>;
        if (node.kind === 'group' || node.kind === 'opaque') throw new TypeError('Copy geometry requires a supported non-container leaf');
        if (node.kind === 'stroke') {
            const ink = buildStrokeCoverageNow(node, options.samples, { deviceScale: precision!.scale, signal });
            countModel(ink);
            result = strokePrepared(key, ink);
        } else if (node.kind === 'connector') {
            const world = matrix(doc, node.id), inverseWorld = inverse(world, 1e12);
            if (!inverseWorld) throw new RangeError('Connector transform is not invertible');
            const surfaces = new Map<NodeId, AttachmentSurface>(), seen = new Set<NodeId>();
            for (const end of [node.start, node.end]) if (end.attach && !seen.has(end.attach.target)) {
                seen.add(end.attach.target);
                const target = doc.nodes.get(end.attach.target);
                // A missing target, a group, or an opaque node has no copy geometry: its end is painted unattached (unattachedWhere).
                if (!target || target.kind === 'group' || target.kind === 'opaque') continue;
                const surface = prepareNow(target, doc, signal).vector?.attachments;
                if (!surface) continue;
                surfaces.set(target.id, { target: target.id, outline: surface.outline, logicalBox: surface.logicalBox,
                    localToWorld: matrix(doc, target.id), clips: frameClips(doc, target), revision: doc.rev });
            }
            const paintNode = unattachedWhere(node, surfaces);
            const resolved = resolveConnectorGeometryNow({ key, node: paintNode, localToWorld: world,
                resolveTarget: id => surfaces.get(id), label: null, toleranceWorld: .01, maxPieces: 65_536 }, {
                label: node.label ? (anchor, length) => {
                    const label = text.prepareNow(node, { revision: key, connectorLength: length, anchor });
                    return label ? { paint: label.paint, localToWorld: [1, 0, 0, 1, label.placement.x, label.placement.y] } : null;
                } : undefined,
            });
            if (resolved.status !== 'ready') throw new Error(resolved.status === 'unroutable' ? resolved.reason : `Connector ${node.id} geometry is pending: ${resolved.reason}`);
            result = connectorPrepared(key, paintNode, resolved.geometry, inverseWorld);
        } else {
            const vector = prepareBoardVectorGeometryNow(node, { text, revision: key, zoom: 1 });
            if (vector.text.length) textIds.add(node.id);
            const bounds = geometrySceneBounds(vector);
            result = { key, vector, bounds: { ink: bounds.ink, hit: bounds.hit } };
        }
        check(signal);
        const prepared: Prepared = { ...result, signature: before,
            ...(precision ? { inkPrecision: precision.key, inkLod: false } : {}) };
        storeIdle(node.id, prepared);
        return prepared;
    };
    const bounds: BoundsProvider = {
        local(node) {
            return variantFor(node.id, signature(node, options.doc))?.bounds;
        },
        stroke(node) {
            const summary = options.samples.summary?.(node.samples);
            if (!summary) return undefined;
            const [x, y, w, h] = summary.localBounds, [cx, cy, cw, ch] = summary.curveBounds;
            return { minX: x, minY: y, maxX: x + w, maxY: y + h, curve: [cx, cy, cx + cw, cy + ch],
                maxReach: summary.maxReach, maxPressure: summary.maxPressure };
        },
    };
    const asyncPaintPorts = (doc: BoardDoc, request: ScenePaintRequest, orderedIds?: PaintNodeOrder, shared?: SharedResolution): ScenePaintPorts => {
        const palette = palettes[doc.kind === 'whiteboard' ? request.theme : 'light'];
        return {
            cooperate: options.cooperate, ...(orderedIds ? { orderedIds } : {}),
            // Physical-page capture owns its final clip. A stored pg is an
            // origin, not a certificate that overflowing geometry is invisible.
            intersectsPage: () => true,
            async resolve(node, context, itemSignal) {
                if (node.kind === 'group') return { content: [] };
                if (node.kind === 'stroke' && !context.sensitive) lastPaintPrecision = { deviceScale: context.deviceScale, allowInkLod: context.allowInkLod, sensitive: false };
                // A picture's tiles depend on the stream's own world, so only world-independent resolutions are shared.
                const reuse = shared && node.kind !== 'picture' ? shared : undefined;
                const known = reuse?.cache.get(reuse.variant, node.id, context.sensitive);
                if (known) { auditCount(AUDIT, 'paint:resolve-hit'); return known; }
                auditCount(AUDIT, 'paint:resolve-built');
                const geometry = await prepare(node, doc, itemSignal, context);
                const paint = node.kind === 'stroke' ? paintStrokeNode(node, geometry.ink!, geometry.key, context, palette)
                    : node.kind === 'connector' ? paintConnector(node, geometry.connector!, context, palette, text.faces)
                    : await paintVectorNode(node, geometry.vector!, context, palette, text.faces,
                        { signal: itemSignal, cooperate: options.cooperate, media: node.kind === 'picture' || node.kind === 'clip' ? doc.media.get(node.media!) : undefined,
                            preview: previewMediaOf(doc, node), tiles: { deviceScale: request.deviceScale, world: pictureTileWorld(request),
                                ...(request.exactScale !== undefined ? { exactScale: request.exactScale } : {}) } });
                const resolved = withAllocation(paint, geometry, context);
                if (reuse) reuse.cache.set(reuse.variant, node.id, context.sensitive, resolved);
                return resolved;
            },
        };
    };
    const rasterVariant = (doc: BoardDoc, request: ScenePaintRequest, epoch: number, sourceToken: RenderToken) => JSON.stringify([
        sourceToken.vaultEpoch, sourceToken.documentId, sourceToken.bytesGeneration, sourceToken.session,
        request.sheetId, request.theme, palettes[doc.kind === 'whiteboard' ? request.theme : 'light'].revision, epoch,
    ]);
    const paint = async (doc: BoardDoc, request: ScenePaintRequest, signal: AbortSignal, orderedIds?: PaintNodeOrder, sourceToken: RenderToken = options.token): Promise<PaintNodeSource> => {
        const epoch = text.fonts.epoch, variant = rasterVariant(doc, request, epoch, sourceToken);
        const world = request.world ? Object.freeze({ ...request.world }) : undefined;
        const source = await prepareScenePaintSource(doc, sourceToken, request, asyncPaintPorts(doc, request, orderedIds, sharedResolution(doc, request, sourceToken)), signal);
        return { ...source, sessionRasters, sourceWorld: world,
            ...(text.fonts.epoch === epoch ? { rasterVariant: variant } : {}) };
    };
    // What resolution reads beyond the node itself: a shared resolution is reused only while every one of these holds.
    const resolutionVariant = (doc: BoardDoc, request: ScenePaintRequest, sourceToken: RenderToken) => JSON.stringify([
        doc.rev, sourceToken.vaultEpoch, sourceToken.documentId, sourceToken.bytesGeneration, sourceToken.session,
        request.sheetId, request.theme, request.deviceScale ?? null, !!request.allowInkLod,
        palettes[doc.kind === 'whiteboard' ? request.theme : 'light'].revision, text.fonts.epoch,
    ]);
    /** The resolution a paint shares: the caller's dense-plan cache when it names one, else the session's cache of this revision. */
    /** `null`: the caller keeps what it reads itself (a dense plan's node buffer), so no cache also holds it. */
    const sharedResolution = (doc: BoardDoc, request: ScenePaintRequest, sourceToken: RenderToken, given?: ResolvedNodeCache | null): SharedResolution | undefined => {
        const cache = given === null ? undefined : given ?? sessionResolved;
        return cache ? { cache, variant: resolutionVariant(doc, request, sourceToken) } : undefined;
    };
    // Frame identity matches `paint`: the variant is withdrawn if the font epoch moved while the
    // stream was being consumed, so a frame never claims a raster from a superseded face set.
    const paintStream = (doc: BoardDoc, request: ScenePaintRequest, signal: AbortSignal, orderedIds?: PaintNodeOrder,
        sourceToken: RenderToken = options.token, resolved?: ResolvedNodeCache | null): ScenePaintNodeStream => {
        const epoch = text.fonts.epoch, variant = rasterVariant(doc, request, epoch, sourceToken);
        const world = request.world ? Object.freeze({ ...request.world }) : undefined;
        const shared = sharedResolution(doc, request, sourceToken, resolved);
        const stream = createScenePaintNodeStream(doc, sourceToken, request, asyncPaintPorts(doc, request, orderedIds, shared), signal);
        return {
            token: stream.token, theme: request.theme, sceneRevision: stream.sceneRevision, sourceDoc: stream.sourceDoc, sensitiveNodes: stream.sensitiveNodes,
            sessionRasters, sourceWorld: world,
            get rasterVariant() { return text.fonts.epoch === epoch ? variant : undefined; },
            isCurrent: () => stream.isCurrent(),
            next: () => stream.next(),
            release: () => stream.release(),
        };
    };
    const paintNow = (doc: BoardDoc, request: ScenePaintRequest, signal: AbortSignal, orderedIds?: PaintNodeOrder, sourceToken: RenderToken = options.token) => {
        const palette = palettes[doc.kind === 'whiteboard' ? request.theme : 'light'];
        return prepareScenePaintSourceNow(doc, sourceToken, request, {
            ...(orderedIds ? { orderedIds } : {}), intersectsPage: () => true,
            resolve(node, context, itemSignal) {
                if (node.kind === 'group') return { content: [] };
                const geometry = prepareNow(node, doc, itemSignal, context);
                const paint = node.kind === 'stroke' ? paintStrokeNode(node, geometry.ink!, geometry.key, context, palette)
                    : node.kind === 'connector' ? paintConnector(node, geometry.connector!, context, palette, text.faces)
                    : paintVectorNodeNow(node, geometry.vector!, context, palette, text.faces,
                        { signal: itemSignal, media: node.kind === 'picture' || node.kind === 'clip' ? doc.media.get(node.media!) : undefined,
                            preview: previewMediaOf(doc, node) });
                return withAllocation(paint, geometry, context);
            },
        }, signal);
    };
    const requireLoadedText = (value: PreparedBoardText | null) => {
        if (!value) return;
        const faces = value.paint.faceTable ?? text.faces;
        if (!text.fonts.isLoaded({ family: value.request.style.font, bold: false, italic: false })
            || value.paint.lines.some(line => line.fragments.some(fragment => !faces.faces[fragment.face]?.loaded))) {
            throw new ApplyFailed('geometry-unavailable', 'Text faces must finish loading before a geometric content operation');
        }
    };
    const preparedForChange = (doc: BoardDoc, node: Readonly<Node>) => {
        for (const scope of changeScopes) {
            const value = scope.get(node.id);
            if (value && !value.inkLod && sameGeometrySignature(value.signature, signature(node, doc))) return value;
        }
        return variantFor(node.id, signature(node, doc), value => !value.inkLod);
    };
    const warmChangeGeometry = async (ids: Iterable<NodeId>, signal: AbortSignal, scope?: Map<NodeId, Prepared>, leases?: { release(): void }[],
        doc: BoardDoc = options.doc, current?: () => boolean) => {
        check(signal);
        const revision = doc.rev, host = doc.host, seen = new Set<NodeId>(), queue = [...ids];
        const captured = new Map<NodeId, Readonly<Node>>(), children = new Map<NodeId, readonly Node[] | undefined>();
        const incidents = new Map<NodeId, ReadonlySet<NodeId> | undefined>();
        // A candidate's explicit current callback fences the immutable overlay's base too.
        const fenced = doc === options.doc || current !== undefined;
        const fast = () => {
            check(signal);
            if ((current && !current()) || doc.rev !== revision || doc.host !== host) throw new DOMException('Board changed during geometry preparation', 'AbortError');
        };
        const all = () => {
            for (const [id, node] of captured) if (doc.nodes.get(id) !== node) throw new DOMException('Geometry dependency changed', 'AbortError');
            for (const [id, value] of children) if (doc.children.get(id) !== value) throw new DOMException('Geometry children changed', 'AbortError');
            for (const [id, value] of incidents) if (doc.attachedTo.get(id) !== value) throw new DOMException('Geometry attachments changed', 'AbortError');
        };
        const stable = () => { fast(); if (!fenced) all(); };
        const nodeStable = (node: Readonly<Node>) => {
            let value: Readonly<Node> | undefined = node;
            for (let depth = 0; value && depth < 64; depth++) {
                if (doc.nodes.get(value.id) !== captured.get(value.id)) throw new DOMException('Geometry ancestor changed', 'AbortError');
                value = doc.nodes.get(value.parent as NodeId);
            }
        };
        const sweep = async () => {
            let work = 0, started = performance.now();
            const due = () => ++work >= 256 || performance.now() - started >= 3;
            const yieldWork = async () => { stable(); await (options.cooperate?.() ?? yieldToHost()); stable(); work = 0; started = performance.now(); };
            for (const [id, node] of captured) { if (doc.nodes.get(id) !== node) throw new DOMException('Geometry dependency changed', 'AbortError'); if (due()) await yieldWork(); }
            for (const [id, value] of children) { if (doc.children.get(id) !== value) throw new DOMException('Geometry children changed', 'AbortError'); if (due()) await yieldWork(); }
            for (const [id, value] of incidents) { if (doc.attachedTo.get(id) !== value) throw new DOMException('Geometry attachments changed', 'AbortError'); if (due()) await yieldWork(); }
            stable();
        };
        const capture = (node: Readonly<Node>) => {
            let current: Readonly<Node> | undefined = node;
            for (let depth = 0; current && depth < 64; depth++) {
                const old = captured.get(current.id);
                if (old && old !== current) throw new DOMException('Geometry ancestor changed', 'AbortError');
                captured.set(current.id, current);
                current = doc.nodes.get(current.parent as NodeId);
            }
        };
        for (let at = 0; at < queue.length; at++) {
            check(signal);
            if (doc.rev !== revision || doc.host !== host) throw new DOMException('Board changed during geometry preparation', 'AbortError');
            const id = queue[at];
            if (seen.has(id)) continue;
            seen.add(id);
            const node = doc.nodes.get(id);
            if (!node) continue;
            capture(node);
            if (leases) leases.push(retainPaintNodeResources(node, options.samples, options.media));
            incidents.set(id, doc.attachedTo.get(id));
            for (const connector of doc.attachedTo.get(id) ?? []) queue.push(connector);
            if (node.kind === 'group' || node.kind === 'frame') {
                children.set(node.id, doc.children.get(node.id));
                for (const child of doc.children.get(id) ?? []) queue.push(child.id);
            }
            if (node.kind !== 'group') {
                if (node.kind === 'connector') {
                    for (const end of [node.start, node.end]) if (end.attach) {
                        const target = doc.nodes.get(end.attach.target); if (target) capture(target);
                        queue.push(end.attach.target);
                    }
                }
                await text.loadFaces(node, stable);
                const value = await prepare(node, doc, signal);
                stable(); nodeStable(node); scope?.set(id, value);
            }
            if ((at & 63) === 63) { await (options.cooperate?.() ?? yieldToHost()); stable(); }
        }
        stable();
        if (scope) {
            // Later font loads can invalidate geometry prepared early in the closure.
            // Publish only a complete set built at the final, stable font epoch.
            const epoch = text.fonts.epoch;
            for (const id of seen) {
                const node = doc.nodes.get(id); if (!node || node.kind === 'group') continue;
                const value = await prepare(node, doc, signal); stable(); nodeStable(node);
                if (text.fonts.epoch !== epoch || !sameGeometrySignature(value.signature, signature(node, doc))) {
                    throw new DOMException('Geometry changed during preparation', 'AbortError');
                }
                scope.set(id, value);
            }
        }
        await sweep(); stable();
    };
    const changeVector = (doc: BoardDoc, node: Readonly<Node>) => {
        check();
        if (node.kind === 'group' || node.kind === 'stroke' || node.kind === 'connector') return undefined;
        const key = `${options.token.session}:${node.id}:change:${++serial}`;
        if (node.kind !== 'opaque') requireLoadedText(text.prepareNow(node, { revision: key }));
        const hit = preparedForChange(doc, node);
        if (hit?.vector) return hit.vector;
        return node.kind === 'opaque' ? undefined : prepareBoardVectorGeometryNow(node, { text, revision: key, zoom: 1 });
    };
    const changeGeometry = createBoardChangeGeometry({ vector: changeVector,
        local(doc, node) {
            if (node.kind === 'stroke') {
                return preparedForChange(doc, node)?.bounds;
            }
            const vector = changeVector(doc, node);
            return vector ? geometrySceneBounds(vector) : undefined;
        },
        connectorText(_doc, node, anchor, length) {
            const value = text.prepareNow(node, { revision: `change:${node.id}:${++serial}`, connectorLength: length, anchor });
            requireLoadedText(value);
            return value ? { paint: value.paint, localToWorld: [1, 0, 0, 1, value.placement.x, value.placement.y] } : undefined;
        },
    });
    /** A save/export pin may finish after its App session closes. Releasing
     * the runtime owner must not invalidate that pin's geometry/fonts. */
    const retainRenderer = () => {
        check();
        if (ownerReleased) throw new DOMException('Board render owner ended', 'AbortError');
        holders++;
        let held = true;
        return { release() { if (held) { held = false; releaseHolder(); } } };
    };
    const localEnvelope = (node: Readonly<Node>): LocalGeometryBounds | undefined => {
        check();
        const hit = bounds.local(node);
        if (hit) return hit;
        if (node.kind === 'group' || node.kind === 'opaque') return undefined;
        if (node.kind === 'connector') return conservativeConnectorBounds(node, options.doc, text, worldEnvelope);
        if (node.kind === 'stroke') {
            const box = new Float64Array(4), quality = localBounds(node, bounds, box);
            return quality === BoundsQuality.Pending || quality === BoundsQuality.ColdLayout ? undefined : { ink: [box[0], box[1], box[2], box[3]] };
        }
        const key = `${options.token.session}:${node.id}:geometry:${++serial}`;
        const vector = prepareBoardVectorGeometryNow(node, { text, revision: key, zoom: 1 });
        const box = geometrySceneBounds(vector), value = { ink: box.ink, hit: box.hit };
        if (vector.text.length) textIds.add(node.id);
        storeIdle(node.id, { key, vector, bounds: value, signature: signature(node, options.doc) });
        return value;
    };
    // A connector's conservative envelope may name an attach target the connector hint cannot box alone (a stroke,
    // a polyline or a group). Such a target's own genuine geometry, carried by its pose, is the only source; a group
    // is the union of its children's boxes. Depth is bounded so a cyclic attachment refuses instead of recursing.
    let envelopeDepth = 0;
    const worldEnvelope = (node: Readonly<Node>): Box | undefined => {
        if (envelopeDepth >= 8) return undefined;
        envelopeDepth++;
        try {
            if (node.kind === 'group') {
                let box: Box | undefined;
                for (const child of options.doc.children.get(node.id) ?? []) {
                    const part = worldEnvelope(child);
                    if (!part) return undefined;
                    box = box
                        ? [Math.min(box[0], part[0]), Math.min(box[1], part[1]), Math.max(box[2], part[2]), Math.max(box[3], part[3])]
                        : [part[0], part[1], part[2], part[3]];
                }
                return box;
            }
            const local = localEnvelope(node);
            if (!local) return undefined;
            const pose = worldPose(options.doc, node.id), c = Math.cos(pose.rotation), s = Math.sin(pose.rotation), out = new Float64Array(4);
            transformBox(out, 0, local.ink, 0, [c, s, -s, c, pose.x, pose.y]);
            return [out[0], out[1], out[2], out[3]];
        } finally { envelopeDepth--; }
    };
    return {
        text, bounds, changeGeometry, retainRenderer, variantForBand, pinVisible, releasePins,
        /** The stroke band key the producers and pinVisible use, for a device scale and the flags the paint request carries. */
        /** Actual source admission belongs to the App owner. This captures publication identity
         * for NEW work over the same canonical model/cache; existing sources are never retagged. */
        capturePaintBinding(token: RenderToken) {
            check();
            const captured = Object.freeze({ ...token });
            if (captured.vaultEpoch !== options.token.vaultEpoch || captured.documentId !== options.token.documentId
                || captured.session !== options.token.session || !Number.isSafeInteger(captured.bytesGeneration)
                || captured.bytesGeneration < options.token.bytesGeneration) throw new TypeError('Paint binding is not the same document source');
            return Object.freeze({
                token: captured, retainRenderer,
                preparePaintStream: (doc: BoardDoc, request: ScenePaintRequest, signal: AbortSignal, order?: PaintNodeOrder, resolved?: ResolvedNodeCache | null) =>
                    paintStream(doc, request, signal, order, captured, resolved),
                preparePaint: (doc: BoardDoc, request: ScenePaintRequest, signal: AbortSignal, order?: PaintNodeOrder) => paint(doc, request, signal, order, captured),
                prepareOverlay: (doc: BoardDoc, request: ScenePaintRequest, ids: Iterable<NodeId> | undefined, signal: AbortSignal) => paint(doc, request, signal, ids, captured),
                prepareOverlayNow: (doc: BoardDoc, request: ScenePaintRequest, ids: Iterable<NodeId> | undefined, signal: AbortSignal) => {
                    check(signal); return paintNow(doc, request, signal, ids, captured);
                },
            });
        },
        /** `cssPerWorld`: the pick's zoom. With it, a stroke's already-built coverage serves the pick when it is precise enough there. */
        async prepareForPick(node: Readonly<Node>, signal: AbortSignal, doc: BoardDoc = options.doc, cssPerWorld?: number): Promise<Prepared> {
            check(signal);
            return (cssPerWorld === undefined ? undefined : pickVariant(node, doc, cssPerWorld)) ?? await prepare(node, doc, signal);
        },
        prepareForPickNow(node: Readonly<Node>, signal: AbortSignal, doc: BoardDoc = options.doc) { return prepareNow(node, doc, signal); },
        prepareOverlayNow(doc: BoardDoc, request: ScenePaintRequest, ids: Iterable<NodeId> | undefined, signal: AbortSignal) {
            check(signal); return paintNow(doc, request, signal, ids);
        },
        pinChangeGeometryNow(ids: Iterable<NodeId>, signal: AbortSignal, doc: BoardDoc = options.doc, current?: () => boolean): { release(): void } {
            check(signal);
            const revision = doc.rev, font = text.fonts.epoch, scope = new Map<NodeId, Prepared>();
            const leases: { release(): void }[] = [], queue = [...ids], seen = new Set<NodeId>();
            const stable = () => {
                check(signal);
                if (doc.rev !== revision || text.fonts.epoch !== font || current?.() === false) throw new DOMException('Copy geometry changed', 'AbortError');
            };
            try {
                for (let at = 0; at < queue.length; at++) {
                    stable(); const id = queue[at]; if (seen.has(id)) continue; seen.add(id);
                    const node = doc.nodes.get(id); if (!node) continue;
                    leases.push(retainPaintNodeResources(node, options.samples, options.media));
                    for (const incident of doc.attachedTo.get(id) ?? []) queue.push(incident);
                    if (node.kind === 'group' || node.kind === 'frame') for (const child of doc.children.get(id) ?? []) queue.push(child.id);
                    if (node.kind === 'connector') for (const end of [node.start, node.end]) if (end.attach) queue.push(end.attach.target);
                    if (node.kind !== 'group') scope.set(id, prepareNow(node, doc, signal));
                }
                stable();
            } catch (error) { for (const lease of leases) lease.release(); throw error; }
            changeScopes.add(scope); holders++;
            let held = true;
            return { release() {
                if (!held) return;
                held = false; changeScopes.delete(scope); scope.clear();
                try { for (const lease of leases) lease.release(); } finally { releaseHolder(); }
            } };
        },
        /** Preflight actual font/ink inputs outside the synchronous writer.
         * Staged transforms still resolve through the doc passed by apply. */
        prepareChangeGeometry: (ids: Iterable<NodeId>, signal: AbortSignal) => warmChangeGeometry(ids, signal),
        /** Commands may touch more than the idle cache's 256 nodes. Their
         * exact records/resources stay pinned until the synchronous writer ends. */
        async pinChangeGeometry(ids: Iterable<NodeId>, signal: AbortSignal, doc: BoardDoc = options.doc, current?: () => boolean): Promise<{ release(): void }> {
            // A pre-existing Scene/export pin owns a renderer holder. Its
            // asynchronous geometry may start after the App owner has closed;
            // disposed (zero holders), not ownerReleased, ends that authority.
            check(signal);
            const scope = new Map<NodeId, Prepared>(), leases: { release(): void }[] = [];
            try {
                await warmChangeGeometry(ids, signal, scope, leases, doc, current);
                check(signal);
            } catch (error) { for (const lease of leases) lease.release(); throw error; }
            changeScopes.add(scope); holders++;
            let held = true;
            return { release() {
                if (!held) return;
                held = false; changeScopes.delete(scope); scope.clear();
                try { for (const lease of leases) lease.release(); } finally { releaseHolder(); }
            } };
        },
        /** Conservative native b hint only. Current-font TX3 layout is real
         * geometry, but a conservative connector/ink envelope is NOT a Scene
         * exact-bound or page-placement capability. */
        encoderLocal: localEnvelope,
        retainNode: (node: Readonly<Node>) => retainPaintNodeResources(node, options.samples, options.media),
        // Bounds do not depend on the band: any geometry of the node's current signature answers, whichever band it was built at.
        // A missing one is built at the band the paint last asked for, so the stream that draws it shares the build. Built at the
        // default band, the camera fit of a converted 5,640-stroke drawing built every stroke a second time, at a band no frame
        // drew (measured: 5,640 extra builds beside the view's, the open's whole second half).
        async realize(node: Readonly<Node>, signal: AbortSignal) {
            const known = variantFor(node.id, signature(node, options.doc));
            return (known ?? await prepare(node, options.doc, signal, lastPaintPrecision ?? undefined)).bounds;
        },
        preparePaint: paint, preparePaintStream: (doc: BoardDoc, request: ScenePaintRequest, signal: AbortSignal, order?: PaintNodeOrder, resolved?: ResolvedNodeCache | null) =>
            paintStream(doc, request, signal, order, undefined, resolved),
        prepareOverlay(doc: BoardDoc, request: ScenePaintRequest, ids: Iterable<NodeId>, signal: AbortSignal) {
            return paint(doc, request, signal, ids);
        },
        subscribeInvalidation(listener: (ids: ReadonlySet<NodeId>) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        /** No view shows the document: gives back everything derived it holds (idle geometry, stroke levels, resolved paint), all of it
         * rebuildable. A geometry a frame still draws is found again through `surviving` while that frame lives. */
        releaseDerived() {
            if (disposed) return;
            releasePins();
            evictDerived(Number.POSITIVE_INFINITY);
            auditCount(AUDIT, 'geometry:release-derived');
        },
        dispose() { if (!ownerReleased) { ownerReleased = true; releaseHolder(); } },
    };
}
