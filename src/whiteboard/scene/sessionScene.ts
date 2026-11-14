import type { RenderToken } from '../../platform/render/types';
import type { Applied } from '../change/ops';
import type { BoardDoc } from '../model/doc';
import type { NodeId, SheetId } from '../model/ids';
import { createNode, type Node } from '../model/nodes';
import { boardPageStack } from '../model/pages';
import type { PaintNodeSource } from '../render/paintStream';
import type { SpatialCursor } from '../pick';
import { BoundsQuality, type BoundsProvider, type LocalGeometryBounds } from './bounds';
import { SceneBootstrapJob, type BootstrappedScene } from './bootstrap';
import { BoundsVersions } from './boundsVersions';
import { sceneDirty, SceneDirtyFlag as Flag, type SceneDirty } from './dirty';
import { SceneGeometryCache } from './geometryCache';
import { updateScene } from './incremental';
import { LiveSceneView } from './live';
import { createSceneSnapshot } from './pin';
import { createSceneRecordStore, type SceneRecordStore } from './recordStore';
import { ScenePackedRebuild } from './rebuild';
import { SceneMetadataStore } from './snapshotDoc';
import type { NearestVisitor, QueryBuffer, SpatialQuery } from './query';
import type { SceneBounds, ScenePaintRequest, SceneQueryOptions, SceneSnapshot, SceneSpatial } from './types';

export interface SessionSceneOptions {
    readonly doc: BoardDoc;
    readonly token: RenderToken;
    readonly bounds: BoundsProvider;
    /** Leases refer to captured node versions, not the current document record. */
    retainNode(node: Readonly<Node>): { release(): void };
    realize(node: Readonly<Node>, signal: AbortSignal): Promise<LocalGeometryBounds>;
    preparePaint(doc: BoardDoc, request: ScenePaintRequest, signal: AbortSignal): Promise<PaintNodeSource>;
    /** Requests bounded platform work; never starts a private animation loop. */
    invalidate(): void;
    onError(error: unknown): void;
    cooperate?(): Promise<void>;
    readonly signal?: AbortSignal;
}
function yieldToHost(): Promise<void> {
    const scheduler = (globalThis as typeof globalThis & { scheduler?: { yield(): Promise<void> } }).scheduler;
    return scheduler?.yield() ?? new Promise(resolve => setTimeout(resolve, 0));
}

/** Session-owned Scene, independent of pane lifetime. Publication is blocked while
 * an incremental order splice is in progress; no query observes half of a move. */
export class SessionScene implements SceneSpatial {
    private readonly cache = new SceneGeometryCache();
    private readonly versions = new Map<NodeId, number>();
    private readonly listeners = new Set<() => void>();
    private readonly boundsVersions: BoundsVersions;
    private readonly pendingNodes = new Map<NodeId, number>();
    private readonly pendingSheets = new Set<SheetId>();
    private pages = false;
    private serial = 0;
    private disposed = false;
    private active: { readonly serial: number; readonly dirty: SceneDirty; readonly job: Generator<void, BootstrappedScene> } | undefined;
    private readonly live: LiveSceneView;
    private readonly rebuild: ScenePackedRebuild;
    private readonly controller = new AbortController();
    private constructor(private readonly options: SessionSceneOptions, private state: BootstrappedScene,
        private readonly records: SceneRecordStore, private readonly metadata: SceneMetadataStore) {
        this.live = new LiveSceneView(options.doc, state);
        this.boundsVersions = new BoundsVersions(options.doc.rev);
        const provider: BoundsProvider = {
            local: node => this.cache.get(node.id, this.versions.get(node.id) ?? 0) ?? options.bounds.local(node),
            stroke: node => options.bounds.stroke(node),
        };
        this.provider = provider;
        this.rebuild = new ScenePackedRebuild(state.index, state.columns, state.unbounded,
            { session: `scene-${options.token.documentId}-${options.token.session}`, epoch: options.token.vaultEpoch }, options.onError, options.invalidate);
    }
    private readonly provider: BoundsProvider;
    static async create(options: SessionSceneOptions): Promise<SessionScene> {
        const revision = options.doc.rev, cooperate = options.cooperate ?? yieldToHost;
        const check = () => {
            options.signal?.throwIfAborted();
            if (options.doc.rev !== revision) throw new Error('Board changed during scene acquisition');
        };
        let records: SceneRecordStore | undefined;
        try {
            records = await createSceneRecordStore(options.doc.nodes.values(), options.retainNode,
                async () => { check(); await cooperate(); check(); }, options.signal);
            check();
            const metadata = await SceneMetadataStore.create(options.doc, async () => { check(); await cooperate(); check(); }, options.signal);
            const bootstrap = new SceneBootstrapJob(options.doc, options.bounds);
            for (;;) {
                check();
                const status = bootstrap.step(256);
                if (status === 'complete') break;
                if (status !== 'pending') throw new Error('Scene acquisition was interrupted');
                await cooperate();
            }
            check();
            const scene = new SessionScene(options, bootstrap.result, records, metadata);
            try {
                const initial = new Map<NodeId, SceneBounds | null>();
                let count = 0;
                for (const id of bootstrap.result.slots.keys()) {
                    initial.set(id, scene.live.worldBounds(id));
                    if ((++count & 255) === 0) { check(); await cooperate(); }
                }
                const publish = scene.boundsVersions.updateSteps(revision, initial);
                while (!publish.next().done) { check(); await cooperate(); }
                check();
                return scene;
            } catch (error) { scene.dispose(); throw error; }
        } catch (error) { records?.dispose(); throw error; }
    }
    get revision(): number { return this.state.revision; }
    get layout() { return boardPageStack(this.options.doc.host) ?? null; }
    get ready(): boolean { return !this.disposed && !this.active && !this.pendingNodes.size && !this.pendingSheets.size && !this.pages && this.state.revision === this.options.doc.rev; }
    get byteLength(): number { return this.live.byteLength; }
    subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    private notify(): void {
        for (const listener of this.listeners) { try { listener(); } catch (error) { this.options.onError(error); } }
    }
    record(applied: Applied): void {
        if (this.disposed) return;
        const dirty = sceneDirty(applied, this.options.doc);
        const changed: Readonly<Node>[] = [], removed: NodeId[] = [];
        for (const id of applied.touched.nodes) {
            const node = this.options.doc.nodes.get(id);
            if (node) changed.push(node); else removed.push(id);
        }
        this.records.update(changed, removed);
        this.metadata.update(applied, this.options.doc);
        for (const [id, flags] of dirty.nodes) {
            this.pendingNodes.set(id, (this.pendingNodes.get(id) ?? 0) | flags);
            if (flags & (Flag.Geometry | Flag.Text | Flag.Structure)) {
                this.versions.set(id, (this.versions.get(id) ?? 0) + 1); this.cache.delete(id);
            }
        }
        for (const sheet of dirty.sheets) this.pendingSheets.add(sheet);
        this.pages ||= dirty.pages;
        this.serial++;
        this.options.invalidate();
    }
    private *update(dirty: SceneDirty): Generator<void, BootstrappedScene> {
        const next = yield* updateScene(this.options.doc, this.state, dirty, this.provider);
        yield* this.boundsVersions.updateSteps(next.revision, next.boundsChanges);
        return next;
    }
    /** Called by the platform's bounded CPU preparation task, including after a
     * packed-worker ready callback. No RAF/polling belongs to this Scene. */
    step(maxWork: number, deadline = Infinity): 'pending' | 'complete' {
        if (this.disposed) return 'complete';
        if (!Number.isSafeInteger(maxWork) || maxWork < 1 || Number.isNaN(deadline)) throw new RangeError('Invalid scene work budget');
        let work = 0;
        while (work++ < maxWork && performance.now() < deadline) {
            if (!this.active) {
                if (!this.pendingNodes.size && !this.pendingSheets.size && !this.pages && this.state.revision === this.options.doc.rev) {
                    this.rebuild.step(Math.max(1, maxWork - work));
                    if (this.state.index.needsRebuild) this.rebuild.start(this.controller.signal);
                    return 'complete';
                }
                const dirty = { nodes: new Map(this.pendingNodes), sheets: new Set(this.pendingSheets), pages: this.pages };
                this.active = { serial: this.serial, dirty, job: this.update(dirty) };
            }
            const active = this.active;
            try {
                const next = active.job.next();
                if (!next.done) continue;
                this.state = next.value;
                if (active.serial !== this.serial || this.state.revision !== this.options.doc.rev) { this.active = undefined; continue; }
                this.pendingNodes.clear(); this.pendingSheets.clear(); this.pages = false;
                this.active = undefined;
                this.live.replace(this.state);
                this.notify();
                return 'complete';
            } catch (error) {
                this.active = undefined;
                if (active.serial !== this.serial) continue;
                this.options.onError(error); throw error;
            }
        }
        return 'pending';
    }
    worldBounds(id: NodeId): SceneBounds | null {
        if (!this.options.doc.nodes.has(id)) return null;
        if (!this.ready) return { revision: this.options.doc.rev, quality: BoundsQuality.Pending, ink: null, selectable: null };
        return this.live.worldBounds(id);
    }
    async ensureExactBounds(id: NodeId, signal?: AbortSignal): Promise<SceneBounds | null> {
        if (this.disposed) throw new DOMException('Scene is disposed', 'AbortError');
        const node = this.options.doc.nodes.get(id);
        if (!node) return null;
        const version = this.versions.get(id) ?? 0;
        const captured = createNode(node);
        await this.cache.ensure(id, version, signal ?? this.controller.signal, jobSignal => this.options.realize(captured, jobSignal));
        signal?.throwIfAborted();
        if (this.disposed || !this.options.doc.nodes.has(id) || (this.versions.get(id) ?? 0) !== version) throw new DOMException('Scene geometry changed', 'AbortError');
        this.pendingNodes.set(id, (this.pendingNodes.get(id) ?? 0) | Flag.Bounds | Flag.Paint);
        this.serial++; this.options.invalidate();
        const cooperate = this.options.cooperate ?? yieldToHost;
        while (!this.ready) { signal?.throwIfAborted(); this.controller.signal.throwIfAborted(); this.step(16, performance.now() + 3); await cooperate(); }
        return this.worldBounds(id);
    }
    query(options: SceneQueryOptions, output?: QueryBuffer, visitor?: NearestVisitor): SpatialQuery {
        if (!this.ready) throw new Error('Scene publication is pending');
        return this.live.query(options, output, visitor);
    }
    spatialCursor(options: SceneQueryOptions): SpatialCursor {
        if (!this.ready) throw new Error('Scene publication is pending');
        return this.live.spatialCursor(options);
    }
    pin(): SceneSnapshot {
        if (this.disposed) throw new Error('Scene is disposed');
        return createSceneSnapshot({ token: this.options.token, revision: this.options.doc.rev, records: this.records.pin(),
            metadata: this.metadata.pin(), ...(this.ready ? { bounds: this.boundsVersions.pin() } : {}), prepare: this.options.preparePaint,
            cooperate: this.options.cooperate ?? yieldToHost, onError: this.options.onError });
    }
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true; this.controller.abort(); this.rebuild.dispose(); this.cache.dispose(); this.records.dispose();
        this.active = undefined; this.pendingNodes.clear(); this.pendingSheets.clear(); this.listeners.clear();
    }
}
