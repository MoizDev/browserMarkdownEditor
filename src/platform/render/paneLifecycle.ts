import { surfaceBroker } from './surfaceBroker';
import type { BrokerGpuOwner, GpuGrant, SurfaceLease, SurfaceRegistration, SurfaceView } from './surfaceBroker.types';
import type { MemoryGovernor, MemoryPressureState, PaneMemoryGrant } from './memoryGovernor';
import type { BorrowedMirror, MirrorBorrow, MirrorSet, MirrorView } from './mirrorSet';
import { renderTokenKey } from './tiles/geometry';
import type { FrameBudget, FrameToken, GpuReleaseReason, Layer } from './types';

export type PaneSuspendReason = 'unregistered' | 'window-hidden' | 'frozen' | 'geometry-dormant' | 'stopped';
export type RetainedReleaseReason = 'pressure' | 'freeze' | 'hidden-timeout';

/** Structurally supplied by ScheduledPaneLease; the scheduler owns all timers, input and frames. */
export interface PaneFrameBinding {
    invalidate(reason: string): void;
    setFocused(focused: boolean): void;
    dispose(): void;
}

export interface MirrorPresentation {
    readonly presented: boolean;
    readonly complete: boolean;
    readonly sharp: boolean;
    /** Vector/procedural truth can be exact without a raster mirror. */
    readonly usedMirror: boolean;
}

export interface PreparedMirrorPresentation {
    submit(): MirrorPresentation;
    discard(): void;
}

export interface MirrorFrame<T extends object> {
    readonly view: MirrorView;
    readonly revision: string;
    readonly entries: readonly BorrowedMirror<T>[];
    readonly budget: FrameBudget;
    /** Call during Layer.prepare, before any drawImage; false means defer, never waive. */
    claimImplicit(entryId: string): boolean;
    /** Check just before each draw; the original upload deadline is never renewed at submit. */
    mayDrawImplicit(entryId: string): boolean;
    /** Record every attempted admitted draw, including zero nominal bytes on subsequent clips. */
    recordImplicit(entryId: string, actualCallMs: number, succeeded: boolean): void;
}

/** The real 2D compositor supplies this port. Preparing must not draw; submission uses its ticket. */
export interface Pane2DPresenter<T extends object> {
    generation(): number;
    prepare(frame: MirrorFrame<T>): PreparedMirrorPresentation;
    select2D(): void;
    selectGpu(grant: GpuGrant): void;
    /** Same-task 0×0/backing-lease release; never closes session pixels. */
    releaseSurface(): void;
}

export interface PaneSession<T extends object> {
    readonly mirrors: MirrorSet<T>;
    /** Synchronous capture into the App save funnel, never an awaited disk write. */
    checkpoint(): void;
}

export interface PaneLifecycleOptions<T extends object> {
    readonly host: PaneLifecycleHost;
    readonly registration: Omit<SurfaceRegistration, 'callbacks'> & {
        readonly callbacks: Omit<SurfaceRegistration['callbacks'], 'beforeHide'>;
    };
    readonly session: PaneSession<T>;
    readonly layers: readonly Layer[];
    readonly presenter: Pane2DPresenter<T>;
    /** Called only for app-visible panes; wire ScheduledPane.suspend to this lifecycle.suspend. */
    registerFrames(): PaneFrameBinding;
    currentFrameToken(): FrameToken | null;
    currentView(): MirrorView | null;
    /** Immutable compositor revision covering committed/live content and geometry, not a frame id. */
    currentRevision(): string;
    setInputEnabled(enabled: boolean): void;
    /** View jobs only; saves, exports and awaited captures belong to the session and survive hide. */
    cancelViewWork(reason: PaneSuspendReason | GpuReleaseReason): void;
    recordUpload(nominalBytes: number, actualCallMs: number): void;
    now(): number;
}

interface Pending2D<T extends object> {
    readonly serial: number;
    readonly borrow: MirrorBorrow<T>;
    readonly epoch: number;
    readonly token: FrameToken;
    readonly revision: string;
    readonly viewKey: string;
    readonly frameId: number;
    readonly generation: number;
    readonly prepared: PreparedMirrorPresentation;
    readonly clear: () => void;
}

const emptyPresentation: MirrorPresentation = Object.freeze({ presented: false, complete: false, sharp: false, usedMirror: false });

function sameFrame(a: FrameToken, b: FrameToken): boolean {
    return renderTokenKey(a) === renderTokenKey(b) && a.viewLease === b.viewLease && a.deviceGeneration === b.deviceGeneration;
}

function viewKey(view: MirrorView): string {
    const { camera, viewport } = view.view;
    return JSON.stringify([renderTokenKey(view.token), view.sourceRole, view.contentRevision, view.colourVersion,
    view.geometryDigest, view.nominalDpr, camera.x, camera.y, camera.z, viewport.width, viewport.height, viewport.dpr]);
}

function all(actions: readonly (() => void)[]): void {
    const errors: unknown[] = [];
    for (const action of actions) { try { action(); } catch (error) { errors.push(error); } }
    if (errors.length) throw new AggregateError(errors, 'Pane cleanup failed');
}

/** Platform-side view lifetime only. Session truth and mirrors outlive this object (§3.3:374). */
export class PaneLifecycle<T extends object> {
    readonly surface: SurfaceLease;
    readonly paneId: string;
    private readonly options: PaneLifecycleOptions<T>;
    private readonly layers: readonly Layer[];
    private binding: PaneFrameBinding | null = null;
    private borrow: MirrorBorrow<T> | null = null;
    private pending: Pending2D<T> | null = null;
    private view: SurfaceView;
    private visible = false;
    private suspended = false;
    private disposed = false;
    private sealing = false;
    private usingGpu = false;
    private first2DPresented = false;
    private activeGeneration: number | null = null;
    private readyGrant: GpuGrant | null = null;
    private uploadGeneration: number | null = null;
    private uploaded = new WeakSet<T>();
    private budgetKey = '';
    private presentationEpoch = 0;
    private prepareSerial = 0;
    private readonly detachHost: () => void;

    constructor(options: PaneLifecycleOptions<T>) {
        this.options = options;
        this.layers = Object.freeze([...options.layers]);
        this.paneId = options.registration.paneId;
        this.view = { ...options.registration.view, visible: false };
        const callbacks = options.registration.callbacks;
        const detachHost = options.host.add(this);
        try {
            this.surface = surfaceBroker.register({
                ...options.registration, view: this.view, callbacks: {
                    ...callbacks,
                    beforeHide: () => { this.seal('unregistered', true); },
                    prepareGpu: async preparation => this.wrapOwner(await callbacks.prepareGpu(preparation), preparation.generation),
                    onGpuReady: grant => {
                        this.activeGeneration = grant.generation;
                        this.readyGrant = grant;
                        if (this.visible && !this.suspended && !this.disposed) { this.readyGrant = null; callbacks.onGpuReady(grant); }
                    },
                    onCpuFallback: reason => {
                        if (!this.disposed && this.visible) this.begin2D();
                        callbacks.onCpuFallback(reason);
                    },
                    onSlotAvailable: () => { if (this.visible && !this.suspended && !this.disposed) callbacks.onSlotAvailable(); },
                }
            });
        } catch (error) { detachHost(); throw error; }
        this.detachHost = detachHost;
    }

    showPane(view: SurfaceView): void {
        if (this.disposed) throw new Error('Cannot show a disposed pane');
        const wasDrawable = this.visible && this.view.cssWidth > 0 && this.view.cssHeight > 0;
        const drawable = view.cssWidth > 0 && view.cssHeight > 0;
        this.visible = true;
        this.view = { ...view, visible: true };
        this.options.session.mirrors.setVisible(true, this.options.now());
        if (!wasDrawable && drawable) this.begin2D();
        this.surface.updateView(this.view);
        if (!drawable) {
            try { all([() => this.discard2D(), () => this.options.presenter.releaseSurface(), () => this.returnBorrow()]); }
            finally { this.usingGpu = false; this.uploaded = new WeakSet<T>(); this.uploadGeneration = null; }
            return;
        }
        if (!this.binding) this.binding = this.options.registerFrames();
        this.binding.setFocused(view.focused);
        this.options.setInputEnabled(!this.suspended);
        this.binding.invalidate(wasDrawable ? 'geometry' : 'show-mirror');
    }

    hidePane(): void {
        if (this.disposed || !this.visible) return;
        this.visible = false;
        this.view = { ...this.view, visible: false };
        // Broker.beforeHide seals first, then the wrapped owner releases layers/arena and zeros GL.
        try { this.surface.updateView(this.view); }
        finally {
            try {
                all([() => this.discard2D(), () => this.options.presenter.releaseSurface(), () => this.returnBorrow(),
                () => this.options.session.mirrors.setVisible(false, this.options.now())]);
            } finally { this.uploaded = new WeakSet<T>(); this.uploadGeneration = null; }
        }
    }

    unmountPane(): void {
        if (this.disposed) return;
        try { this.hidePane(); }
        finally {
            this.disposed = true;
            all([() => this.detachHost(), () => this.seal('unregistered', true), () => this.surface.dispose(), () => this.discard2D(),
            () => this.options.presenter.releaseSurface(), () => this.returnBorrow(),
            ...this.layers.map(layer => () => layer.dispose())]);
        }
    }

    /** Scheduler suspension is not pane hide: no GPU release and no hidden-mirror demotion. */
    suspend(reason: PaneSuspendReason): void {
        if (reason === 'window-hidden' || reason === 'frozen') this.suspended = true;
        if (reason === 'unregistered') this.binding = null;
        this.seal(reason, false);
    }

    setWindowVisible(visible: boolean): void {
        if (this.suspended === !visible) return;
        this.suspended = !visible;
        if (!visible) { this.seal('window-hidden', false); return; }
        if (!this.visible || this.disposed) return;
        this.options.setInputEnabled(true);
        if (this.readyGrant) {
            const grant = this.readyGrant;
            this.readyGrant = null;
            this.options.registration.callbacks.onGpuReady(grant);
        }
        this.surface.retry();
        this.binding?.invalidate('resume-geometry');
    }

    /** Called by the scheduler's pressure/freeze/deadline path, not a short visibility switch. */
    releaseRetained(_reason: RetainedReleaseReason): void {
        this.presentationEpoch++;
        this.usingGpu = false;
        this.first2DPresented = false;
        try {
            all([() => this.discard2D(), () => this.returnBorrow(), () => this.options.presenter.releaseSurface()]);
        } finally { this.uploaded = new WeakSet<T>(); this.uploadGeneration = null; }
        if (this.visible && !this.suspended) this.begin2D();
    }

    /** Layer.prepare only; the compositor later submits this admitted frame without a second claim. */
    prepare2D(view: MirrorView, budget: FrameBudget): void {
        const existing = this.pending;
        if (existing && this.canDraw() && existing.epoch === this.presentationEpoch && existing.frameId === budget.frameId &&
            sameFrame(existing.token, budget.token) && existing.viewKey === viewKey(view) &&
            existing.revision === this.options.currentRevision() && existing.generation === this.options.presenter.generation()) return;
        const serial = ++this.prepareSerial;
        this.discard2D();
        const token = this.options.currentFrameToken();
        if (!this.canDraw() || this.usingGpu || !token || !sameFrame(token, budget.token) ||
            budget.token.viewLease !== this.surface.stamp.viewLease ||
            renderTokenKey(budget.token) !== renderTokenKey(this.surface.stamp.documentToken) ||
            renderTokenKey(view.token) !== renderTokenKey(this.surface.stamp.documentToken)) return;
        this.returnBorrow();
        const borrow = this.options.session.mirrors.borrow(view, this.options.now());
        this.borrow = borrow;
        const entries = borrow.read(view);
        const byId = new Map(entries.map(entry => [entry.entry.id, entry]));
        const generation = this.options.presenter.generation();
        if (!Number.isSafeInteger(generation) || generation < 0) throw new RangeError('Invalid 2D surface generation');
        if (this.uploadGeneration !== generation) { this.uploaded = new WeakSet<T>(); this.uploadGeneration = generation; }
        const claims = new Map<string, { entry: BorrowedMirror<T>; bytes: number; recorded: boolean; failed: boolean; }>();
        const revision = this.options.currentRevision();
        const key = viewKey(view);
        const frameToken = { ...budget.token };
        const epoch = this.presentationEpoch;
        const current = () => {
            const activeToken = this.options.currentFrameToken();
            const activeView = this.options.currentView();
            return this.prepareSerial === serial && this.presentationEpoch === epoch && this.canDraw() && activeToken !== null && activeView !== null && sameFrame(activeToken, frameToken) &&
                viewKey(activeView) === key && this.options.presenter.generation() === generation && this.options.currentRevision() === revision;
        };
        let prepared: PreparedMirrorPresentation;
        try {
            prepared = this.options.presenter.prepare({
                view, revision, entries, budget,
                claimImplicit: id => {
                    const entry = byId.get(id);
                    if (!entry || !current()) return false;
                    const existing = claims.get(id);
                    if (existing) return !existing.failed;
                    const bytes = this.uploaded.has(entry.pixels) ? 0 : entry.entry.bytes;
                    if (!budget.claimUpload(bytes)) return false;
                    claims.set(id, { entry, bytes, recorded: false, failed: false });
                    return true;
                },
                mayDrawImplicit: id => {
                    const claim = claims.get(id);
                    return claim !== undefined && !claim.failed && current() && this.options.now() < budget.upload.deadline;
                },
                recordImplicit: (id, elapsed, succeeded) => {
                    const claim = claims.get(id);
                    if (!claim || claim.failed || !Number.isFinite(elapsed) || elapsed < 0) {
                        throw new Error('Unmetered or stale mirror draw');
                    }
                    const bytes = claim.recorded ? 0 : claim.bytes;
                    claim.recorded = true;
                    claim.failed = !succeeded;
                    this.options.recordUpload(bytes, elapsed);
                    // Even a stale/failed draw consumed work; don't reuse its admission on a new surface.
                    if (succeeded && current()) this.uploaded.add(claim.entry.pixels);
                },
            });
        } catch (error) {
            byId.clear(); claims.clear(); this.releaseBorrow(borrow);
            throw error;
        }
        if (!current()) {
            try { prepared.discard(); }
            finally { byId.clear(); claims.clear(); this.releaseBorrow(borrow); }
            return;
        }
        this.pending = {
            serial, borrow, epoch, token: frameToken, revision, viewKey: key, frameId: budget.frameId, generation, prepared,
            clear: () => { byId.clear(); claims.clear(); this.releaseBorrow(borrow); }
        };
    }

    submit2D(frameId: number): MirrorPresentation {
        const pending = this.pending;
        this.pending = null;
        const view = this.options.currentView();
        const token = this.options.currentFrameToken();
        if (!pending) return emptyPresentation;
        try {
            if (this.prepareSerial !== pending.serial || this.presentationEpoch !== pending.epoch || !this.canDraw() || !view || !token || frameId !== pending.frameId || !sameFrame(token, pending.token) ||
                viewKey(view) !== pending.viewKey || this.options.currentRevision() !== pending.revision ||
                this.options.presenter.generation() !== pending.generation) {
                pending.prepared.discard();
                return emptyPresentation;
            }
            const result = pending.prepared.submit();
            const activeToken = this.options.currentFrameToken();
            const activeView = this.options.currentView();
            if (this.prepareSerial !== pending.serial || this.presentationEpoch !== pending.epoch || !this.canDraw() || !activeToken || !activeView || !sameFrame(activeToken, pending.token) ||
                viewKey(activeView) !== pending.viewKey || this.options.currentRevision() !== pending.revision ||
                this.options.presenter.generation() !== pending.generation) return emptyPresentation;
            if (result.presented) this.first2DPresented = true;
            return { ...result, sharp: result.complete && result.sharp && (!result.usedMirror || pending.borrow.sharpEligible(view)) };
        } finally { pending.clear(); }
    }

    /** ScheduledEncoding.discard is frame-bound, so old cleanup cannot discard a newer ticket. */
    discardFrame(frameId: number): void {
        if (this.pending?.frameId === frameId) this.discard2D();
    }

    /** Complete current coverage, not upload completion alone, authorizes the compositor's swap. */
    presentGpu(grant: GpuGrant, token: FrameToken, view: MirrorView, revision: string, complete: boolean): boolean {
        const current = this.options.currentFrameToken();
        const currentView = this.options.currentView();
        if (!complete || !this.canDraw() || !this.first2DPresented || !current || !currentView ||
            token.viewLease !== this.surface.stamp.viewLease || token.deviceGeneration !== grant.generation ||
            renderTokenKey(token) !== renderTokenKey(this.surface.stamp.documentToken) ||
            !sameFrame(token, current) || viewKey(view) !== viewKey(currentView) || revision !== this.options.currentRevision() ||
            !this.surface.markPresented(this.surface.stamp, grant.generation)) return false;
        this.options.presenter.selectGpu(grant);
        this.usingGpu = true;
        this.returnBorrow();
        return true;
    }

    applyBudget(grant: PaneMemoryGrant | null): void {
        const key = grant ? JSON.stringify([grant.pixelGrant, grant.gpuCacheBytes, grant.cpuBytes, grant.state]) : '';
        if (key === this.budgetKey) return;
        this.budgetKey = key;
        if (this.canDraw()) this.binding?.invalidate('budget');
    }

    private canDraw(): boolean {
        return this.visible && !this.sealing && !this.suspended && !this.disposed && this.view.cssWidth > 0 && this.view.cssHeight > 0;
    }

    private begin2D(): void {
        this.presentationEpoch++;
        this.usingGpu = false;
        this.first2DPresented = false;
        this.options.presenter.select2D();
        const view = this.options.currentView();
        if (!this.borrow && view && this.canDraw()) this.borrow = this.options.session.mirrors.borrow(view, this.options.now());
        this.binding?.invalidate('mirror');
    }

    private seal(reason: PaneSuspendReason, unregister: boolean): void {
        if (this.sealing) return;
        this.presentationEpoch++;
        this.sealing = true;
        const binding = unregister ? this.binding : null;
        if (unregister) this.binding = null;
        try {
            all([() => binding?.dispose(), () => this.options.setInputEnabled(false),
            () => this.options.cancelViewWork(reason), () => this.options.session.checkpoint(),
            () => this.discard2D(), () => this.returnBorrow()]);
        } finally { this.sealing = false; }
    }

    private wrapOwner(owner: BrokerGpuOwner, generation: number): BrokerGpuOwner {
        return {
            limits: owner.limits, resizeSurface: (width, height) => owner.resizeSurface(width, height),
            releaseGpu: reason => {
                const layerRelease = () => {
                    if (this.activeGeneration !== generation) return;
                    this.activeGeneration = null;
                    all(this.layers.map(layer => () => layer.releaseGpu(reason)));
                };
                // A lost device must be abandoned before layers release old handles (§9.2:771).
                const actions = reason === 'context-lost' ? [() => owner.releaseGpu(reason), layerRelease] :
                    [layerRelease, () => owner.releaseGpu(reason)];
                all(actions);
            },
            dispose: reason => owner.dispose(reason),
        };
    }

    private discard2D(): void {
        const pending = this.pending;
        this.pending = null;
        if (!pending) return;
        try { pending.prepared.discard(); }
        finally { pending.clear(); }
    }

    private releaseBorrow(borrow: MirrorBorrow<T>): void {
        if (this.borrow === borrow) this.borrow = null;
        borrow.release();
    }

    private returnBorrow(): void {
        if (this.borrow) this.releaseBorrow(this.borrow);
    }
}

interface HostedPane {
    readonly paneId: string;
    setWindowVisible(visible: boolean): void;
    releaseRetained(reason: RetainedReleaseReason): void;
    applyBudget(grant: PaneMemoryGrant | null): void;
    unmountPane(): void;
}

/** App-owned collection, not module state; scheduler callbacks supply visibility and real deadlines. */
export class PaneLifecycleHost {
    private readonly panes = new Map<string, HostedPane>();
    private pressureAnnounced = false;

    constructor(private readonly governor: MemoryGovernor, private readonly onPressure: (state: MemoryPressureState) => void) { }

    add(pane: HostedPane): () => void {
        if (this.panes.has(pane.paneId)) throw new Error('A pane lifecycle is already hosted');
        this.panes.set(pane.paneId, pane);
        return () => { if (this.panes.get(pane.paneId) === pane) this.panes.delete(pane.paneId); };
    }

    windowVisibility(visible: boolean): void {
        surfaceBroker.setWindowVisible(visible);
        all([...this.panes.values()].map(pane => () => pane.setWindowVisible(visible)));
    }

    releaseRetained(reason: RetainedReleaseReason): void {
        all([() => surfaceBroker.releaseContextsForPressure(),
        ...[...this.panes.values()].map(pane => () => pane.releaseRetained(reason))]);
    }

    dispose(): void {
        all([...this.panes.values()].map(pane => () => pane.unmountPane()));
    }

    advancePressure(now: number, liveGesture: boolean): void {
        this.governor.advance(now, liveGesture);
        const state = this.governor.readout().state;
        if (state === 'normal') this.pressureAnnounced = false;
        else if (!this.pressureAnnounced) { this.pressureAnnounced = true; this.onPressure(state); }
        for (const pane of this.panes.values()) pane.applyBudget(this.governor.grant(pane.paneId));
    }
}
