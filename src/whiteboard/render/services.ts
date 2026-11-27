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
import { createNode, type ConnectorNode, type Node, type StrokeNode } from '../model/nodes';
import type { SampleStoreReader } from '../model/samples';
import type { MediaStore } from '../media/store';
import { localBounds, BoundsQuality, type BoundsProvider, type Box, type LocalGeometryBounds } from '../scene/bounds';
import type { ScenePaintRequest } from '../scene/types';
import { paintConnector } from './connectorPaint';
import { conservativeConnectorBounds } from './conservativeConnector';
import { buildStrokeCoverage, buildStrokeCoverageNow, strokeSampleBounds } from './inkGeometry';
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
import { INK_GEOMETRY_CRASHED } from '../workers/geometryProtocol';
import { inkRealisationScale, pictureTileWorld } from './paintRequestScope';
import { loadChunk } from '../../platform/chunkLoad';
import { yieldToHost } from '../../platform/yieldToHost';
const AUDIT = 'board-paint';
function previewMediaOf(doc: Pick<BoardDoc, 'media'>, node: Readonly<Node>): PreviewMedia | undefined {
    if (node.kind !== 'linkcard' || !node.preview) return undefined;
    return { image: node.preview.image ? doc.media.get(node.preview.image) : undefined,
        favicon: node.preview.favicon ? doc.media.get(node.preview.favicon) : undefined };
}
const IDLE_GEOMETRY_BYTES = 16 * 1024 * 1024;
function preparedBytes(prepared: Prepared): number {
    let bytes = 512 + prepared.key.length * 2 + prepared.signature.length * 16;
    for (const chunk of prepared.ink ?? []) bytes += inkChunkBytes(chunk);
    if (prepared.vector) bytes += vectorBytes(prepared.vector);
    if (prepared.connector) bytes += connectorBytes(prepared.connector);
    return bytes;
}
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

export function createBoardRenderServices(options: {
    readonly doc: BoardDoc;
    readonly samples: SampleStoreReader;
    readonly media: MediaStore;
    readonly token: RenderToken;
    readonly palettes?: Readonly<{ light: PaintPalette; dark: PaintPalette }>;
    readonly deviceScale?: number;
    readonly coverageWorker?: boolean;
    readonly fonts?: BoardFonts;
    readonly derivedMemory?: (evict: (bytes: number) => void) => Pick<MemoryCacheHandle, 'reserve' | 'release' | 'close'>;
    readonly modelMemory?: (bytes: number) => void;
    cooperate?(): Promise<void>;
}) {
    const cached = new Map<string, Prepared>(), variantsOf = new Map<NodeId, Set<string>>();
    const listeners = new Set<(ids: ReadonlySet<NodeId>) => void>();
    const failedStrokes = new Set<NodeId>(), failureListeners = new Set<(count: number) => void>();
    let failureAnnounce = false;
    const strokeFailed = (id: NodeId) => {
        if (failedStrokes.has(id)) return;
        failedStrokes.add(id); auditCount(AUDIT, 'geometry:crashed');
        if (failureAnnounce) return;
        failureAnnounce = true;
        queueMicrotask(() => { failureAnnounce = false; for (const listener of [...failureListeners]) listener(failedStrokes.size); });
    };
    const sessionRasters = new SessionDenseRasters();
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
    const workerSession = `render/${options.token.session}/${options.token.bytesGeneration}/${crypto.randomUUID()}`;
    const coverageWorker = typeof window !== 'undefined' && options.coverageWorker !== false;
    const textIds = new Set<NodeId>();
    const changeScopes = new Set<ReadonlyMap<NodeId, Prepared>>();
    let serial = 0, disposed = false, ownerReleased = false, holders = 1;
    const inkLadders = new Map<NodeId, { readonly signature: readonly unknown[]; readonly ladder: InkLodLadder }>();
    const evictInkLadders = (bytes: number): number => {
        let freed = 0;
        for (const { ladder } of inkLadders.values()) { if (freed >= bytes) break; freed += ladder.evict(bytes - freed); }
        return freed;
    };
    const idle = new Map<string, { readonly node: NodeId; readonly bytes: number; readonly lease: ByteLease | null }>();
    let idleBytes = 0;
    const dropInkLadder = (id: NodeId) => {
        const entry = inkLadders.get(id);
        if (entry) { entry.ladder.dispose(); inkLadders.delete(id); }
    };
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
    const variantFor = (id: NodeId, signature: readonly unknown[], accept: (value: Prepared) => boolean = () => true): Prepared | undefined => {
        for (const key of variantsOf.get(id) ?? []) {
            const value = cached.get(key);
            if (value && accept(value) && sameGeometrySignature(value.signature, signature)) return value;
        }
        return survivingFor(id, signature, accept);
    };
    const touch = (value: Prepared): void => { if (cached.delete(value.key)) cached.set(value.key, value); };
    const building = new Map<string, { readonly signature: readonly unknown[]; readonly promise: Promise<Prepared>; readonly signal: AbortSignal }>();
    let lastPaintPrecision: Pick<SceneResolveContext, 'deviceScale' | 'allowInkLod' | 'sensitive'> | null = null;
    const variantForBand = (id: NodeId, signature: readonly unknown[], wanted: string, previous: string | null): Prepared | undefined => {
        const exact = variantFor(id, signature, value => value.inkPrecision === wanted);
        if (exact) return exact;
        auditCount(AUDIT, 'geometry:band-miss');
        return previous === null ? undefined : variantFor(id, signature, value => value.inkPrecision === previous);
    };
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
    const evictOldestIdle = (): { readonly bytes: number; readonly charged: number } | null => {
        let gone: string | undefined;
        for (const key of cached.keys()) if (!isPinned(key)) { gone = key; break; }
        if (gone === undefined) return null;
        const entry = idle.get(gone);
        auditCount(AUDIT, 'geometry:evict');
        dropVariant(gone);
        if (entry && !variantsOf.has(entry.node)) dropInkLadder(entry.node);
        return { bytes: entry?.bytes ?? 0, charged: entry?.lease?.bytes ?? 0 };
    };
    const evictDerived = (bytes: number) => {
        let freed = 0;
        while (freed < bytes) { const evicted = evictOldestIdle(); if (!evicted) break; freed += evicted.charged; }
        if (freed < bytes) freed += evictInkLadders(bytes - freed);
        if (freed < bytes && sessionResolved) { auditCount(AUDIT, 'geometry:evict-resolved'); freed += sessionResolved.evict(); }
    };
    const derived = options.derivedMemory?.(evictDerived);
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
        const lease = derived.reserve(charged, { prefetch: true });
        return lease ? { lease } : null;
    };
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
        disposed = true; warmController.abort(); text.dispose(); for (const key of [...cached.keys()]) dropVariant(key); textIds.clear(); listeners.clear(); sessionRasters.dispose();
        for (const id of [...inkLadders.keys()]) dropInkLadder(id);
        sessionResolved?.dispose();
        derived?.close();
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
    const warming = new Set<string>(), warmFailed = new Set<string>();
    const warmController = new AbortController();
    const warmBand = (borrowed: Readonly<Node>, doc: BoardDoc,
        context: Pick<SceneResolveContext, 'deviceScale' | 'sensitive' | 'allowInkLod' | 'previousDeviceScale'>, key: string): void => {
        if (disposed || warming.has(key) || warmFailed.has(key)) return;
        warming.add(key);
        prepare(borrowed, doc, warmController.signal, { ...context, previousDeviceScale: undefined })
            .catch(() => { if (!warmController.signal.aborted) { warmFailed.add(key); auditCount(AUDIT, 'geometry:warm-failed'); } })
            .finally(() => { warming.delete(key); });
    };
    const prepare = async (borrowed: Readonly<Node>, doc: BoardDoc, signal: AbortSignal,
        context?: Pick<SceneResolveContext, 'deviceScale' | 'sensitive' | 'allowInkLod' | 'previousDeviceScale'>): Promise<Prepared> => {
        check(signal);
        const node = createNode(borrowed), before = signature(node, doc);
        const precision = node.kind === 'stroke' ? inkPrecision(context) : undefined;
        const old = variantFor(node.id, before, value => value.inkPrecision === precision?.key);
        if (old) { touch(old); auditCount(AUDIT, 'geometry:hit'); return old; }
        if (precision && context?.previousDeviceScale !== undefined) {
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
            const world = matrix(doc, node.id), inverseWorld = inverse(world, 1e12);
            if (!inverseWorld) throw new RangeError('Connector transform is not invertible');
            const targets = new Map<NodeId, { node: Node; world: Affine; clips: AttachmentSurface['clips'] }>();
            for (const end of [node.start, node.end]) if (end.attach && !targets.has(end.attach.target)) {
                const target = doc.nodes.get(end.attach.target);
                if (!target) continue;
                targets.set(target.id, { node: createNode(target), world: matrix(doc, target.id), clips: frameClips(doc, target) });
            }
            const surfaces = new Map<NodeId, AttachmentSurface>();
            for (const [id, target] of targets) {
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
        storeIdle(node.id, prepared);
        noteSurviving(node.id, prepared);
        return prepared;
    };
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
            intersectsPage: () => true,
            async resolve(node, context, itemSignal) {
                if (node.kind === 'group') return { content: [] };
                if (node.kind === 'stroke' && !context.sensitive) lastPaintPrecision = { deviceScale: context.deviceScale, allowInkLod: context.allowInkLod, sensitive: false };
                const reuse = shared && node.kind !== 'picture' ? shared : undefined;
                const known = reuse?.cache.get(reuse.variant, node.id, context.sensitive);
                if (known) { auditCount(AUDIT, 'paint:resolve-hit'); return known; }
                auditCount(AUDIT, 'paint:resolve-built');
                let geometry: Prepared;
                try { geometry = await prepare(node, doc, itemSignal, context); }
                catch (error) {
                    if (node.kind !== 'stroke' || !(error instanceof Error) || error.name !== INK_GEOMETRY_CRASHED) throw error;
                    strokeFailed(node.id);
                    return { content: [] };
                }
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
    const resolutionVariant = (doc: BoardDoc, request: ScenePaintRequest, sourceToken: RenderToken) => JSON.stringify([
        doc.rev, sourceToken.vaultEpoch, sourceToken.documentId, sourceToken.bytesGeneration, sourceToken.session,
        request.sheetId, request.theme, request.deviceScale ?? null, !!request.allowInkLod,
        palettes[doc.kind === 'whiteboard' ? request.theme : 'light'].revision, text.fonts.epoch,
    ]);
    const sharedResolution = (doc: BoardDoc, request: ScenePaintRequest, sourceToken: RenderToken, given?: ResolvedNodeCache | null): SharedResolution | undefined => {
        const cache = given === null ? undefined : given ?? sessionResolved;
        return cache ? { cache, variant: resolutionVariant(doc, request, sourceToken) } : undefined;
    };
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
        prepareChangeGeometry: (ids: Iterable<NodeId>, signal: AbortSignal) => warmChangeGeometry(ids, signal),
        async pinChangeGeometry(ids: Iterable<NodeId>, signal: AbortSignal, doc: BoardDoc = options.doc, current?: () => boolean): Promise<{ release(): void }> {
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
        encoderLocal: localEnvelope,
        retainNode: (node: Readonly<Node>) => retainPaintNodeResources(node, options.samples, options.media),
        async realize(node: Readonly<Node>, signal: AbortSignal) {
            const known = variantFor(node.id, signature(node, options.doc));
            try { return (known ?? await prepare(node, options.doc, signal, lastPaintPrecision ?? undefined)).bounds; }
            catch (error) {
                if (node.kind !== 'stroke' || !(error instanceof Error) || error.name !== INK_GEOMETRY_CRASHED) throw error;
                strokeFailed(node.id);
                return { ink: strokeSampleBounds(createNode(node) as StrokeNode, options.samples) };
            }
        },
        preparePaint: paint, preparePaintStream: (doc: BoardDoc, request: ScenePaintRequest, signal: AbortSignal, order?: PaintNodeOrder, resolved?: ResolvedNodeCache | null) =>
            paintStream(doc, request, signal, order, undefined, resolved),
        prepareOverlay(doc: BoardDoc, request: ScenePaintRequest, ids: Iterable<NodeId>, signal: AbortSignal) {
            return paint(doc, request, signal, ids);
        },
        subscribeInvalidation(listener: (ids: ReadonlySet<NodeId>) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        subscribeStrokeFailures(listener: (count: number) => void) {
            failureListeners.add(listener);
            if (failedStrokes.size) listener(failedStrokes.size);
            return () => { failureListeners.delete(listener); };
        },
        releaseDerived() {
            if (disposed) return;
            releasePins();
            evictDerived(Number.POSITIVE_INFINITY);
            auditCount(AUDIT, 'geometry:release-derived');
        },
        dispose() { if (!ownerReleased) { ownerReleased = true; releaseHolder(); } },
    };
}
