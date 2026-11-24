import { RENDER_CONSTANTS } from './constants';
import type { RenderToken } from './types';
import type { ByteLease } from './gfx/api';
import type { MemoryAllocator } from './memoryGovernor';
import { auditCount } from './renderAudit';
import { paneMotionState } from './paneMotion';
import type {
    BrokerGpuOwner, ContextDisposeReason, CpuFallbackReason, GpuGrant, GpuRequestResult, GpuUnavailableCause,
    SurfaceBrokerConfiguration, SurfaceCallbacks, SurfaceLease, SurfaceRegistration, SurfaceSnapshot, SurfaceStamp,
    SurfaceState, SurfaceView,
} from './surfaceBroker.types';

const PLATFORM_CONTEXT_CEILING = RENDER_CONSTANTS.maxAppContexts - RENDER_CONSTANTS.reservedTerminalContexts;
const RESTORE_FOREGROUND_MS = 5_000;
// TS6 otherwise selects getContext's broad RenderingContext overload for the readonly policy record.
const CONTEXT_ATTRIBUTES: WebGLContextAttributes = RENDER_CONSTANTS.contextAttributes;

interface SessionCircuit {
    losses: number[];
    pinned: boolean;
    notified: boolean;
    /** The person has been told this document's repeated GPU errors latched it on canvas2d. */
    errorNotified: boolean;
    generation: number;
}

interface Reservation {
    contextLease: ByteLease | null;
    canvas: HTMLCanvasElement;
    context: WebGL2RenderingContext | null;
    owner: BrokerGpuOwner | null;
    grant: GpuGrant | null;
    controller: AbortController;
    generation: number;
    intentional: boolean;
    lost: boolean;
    restored: boolean;
    foregroundMs: number;
    foregroundSince: number | null;
    timer: ReturnType<typeof setTimeout> | null;
    onLost: (event: Event) => void;
    onRestored: () => void;
}

interface SurfaceEntry {
    paneId: string;
    viewLease: number;
    documentToken: RenderToken;
    view: SurfaceView;
    callbacks: SurfaceCallbacks;
    circuit: SessionCircuit;
    state: SurfaceState;
    hiddenAt: number | null;
    generation: number;
    checkedGeneration: number | null;
    reservation: Reservation | null;
    pending: Promise<GpuRequestResult> | null;
    failed: CpuFallbackReason | null;
    waiting: boolean;
    /** Live 2D because the visible-context cap was full: the upgrade waits for a quiet moment, not a gesture. */
    budgetFallback: boolean;
    /** A visibility change upgrades at once, without the quiet-moment wait. Consumed by the next capacity notification. */
    upgradeBypass: boolean;
    upgradeTimer: ReturnType<typeof setTimeout> | null;
    /** Back-off for re-qualifying a timed-out restore: the Nth attempt waits REQUALIFY_MIN_MS * 2^N, capped (see armRequalify). */
    requalifyAttempts: number;
    requalifyTimer: ReturnType<typeof setTimeout> | null;
    lease: SurfaceLease;
}

/** A gesture is over once input and camera motion have been quiet this long; the upgrade waits for that, never mid-gesture. */
const UPGRADE_QUIET_MS = 250;

/** A timed-out restore is not permanent for a visible pane: the pane asks for a fresh context again after this back-off, doubling,
 * capped. Measured need: a context lost with no restore left the pane on 2D for the session, until hidden and shown. */
const REQUALIFY_MIN_MS = 5_000;
const REQUALIFY_MAX_MS = 60_000;

/** The failures a visible pane recovers from by itself, on that back-off: a memory refusal, a context that failed to build or restore,
 * a pressure release. Each once left the pane on 2D until it was hidden and shown again, counted once and never retried: a refused
 * promotion or framebuffer at one zoom kept a document on the CPU for as long as it stayed open. A GPU error is retried by its pane
 * (gpuPaneCandidate) and latches there; `gpu-unavailable` is the device, which a back-off cannot change. */
function requalifies(reason: CpuFallbackReason | null): boolean {
    return reason === 'restore-timeout' || reason === 'creation-failed' || reason === 'out-of-budget' || reason === 'pressure';
}

function sessionKey(token: RenderToken): string {
    return JSON.stringify([token.vaultEpoch, token.documentId, token.session]);
}

function sameToken(a: RenderToken, b: RenderToken): boolean {
    return a.vaultEpoch === b.vaultEpoch && a.documentId === b.documentId &&
        a.bytesGeneration === b.bytesGeneration && a.session === b.session;
}

function drawable(entry: SurfaceEntry): boolean {
    return entry.view.visible && entry.view.cssWidth > 0 && entry.view.cssHeight > 0;
}

function validateView(view: SurfaceView): void {
    if (!Number.isFinite(view.cssWidth) || view.cssWidth < 0 ||
        !Number.isFinite(view.cssHeight) || view.cssHeight < 0 || !Number.isFinite(view.lastInputAt)) {
        throw new RangeError('Invalid surface geometry or input time');
    }
}

/** No device, timer or DOM work at import time; all consumers share the instance below. */
class SurfaceBroker {
    private readonly surfaces = new Map<string, SurfaceEntry>();
    private readonly circuits = new Map<string, SessionCircuit>();
    private readonly usedCanvases = new WeakSet<HTMLCanvasElement>();
    /** Device causes the person has been told about: once per app session, whichever pane met it first. */
    private readonly notifiedCauses = new Set<GpuUnavailableCause>();
    private windowVisible = true;
    private terminalContextActive = false;
    private notificationQueued = false;
    private contextReserveWaiting = false;
    private contextAllocator: MemoryAllocator | null = null;

    configure({ contextAllocator }: SurfaceBrokerConfiguration): void {
        if (this.contextAllocator && this.contextAllocator !== contextAllocator) {
            throw new Error('The surface broker already has its app-wide allocator');
        }
        this.contextAllocator = contextAllocator;
    }

    register(registration: SurfaceRegistration): SurfaceLease {
        validateView(registration.view);
        if (!registration.paneId || !Number.isSafeInteger(registration.viewLease) || registration.viewLease < 0) {
            throw new RangeError('Invalid surface lease');
        }
        const previous = this.surfaces.get(registration.paneId);
        if (previous) {
            if (this.matches(previous, registration)) return previous.lease;
            if (registration.viewLease <= previous.viewLease) throw new Error('Stale surface registration');
            this.disposeEntry(previous);
        }
        const key = sessionKey(registration.documentToken);
        for (const entry of this.surfaces.values()) {
            // C4.2 forbids two live panes for one document; silently sharing a device would hide that bug.
            if (sessionKey(entry.documentToken) === key) throw new Error('Document session already has a surface');
        }
        let circuit = this.circuits.get(key);
        if (!circuit) {
            circuit = { losses: [], pinned: false, notified: false, errorNotified: false, generation: 0 };
            this.circuits.set(key, circuit);
        }
        const entry: SurfaceEntry = {
            paneId: registration.paneId, viewLease: registration.viewLease,
            documentToken: { ...registration.documentToken }, view: { ...registration.view },
            callbacks: registration.callbacks, circuit,
            state: circuit.pinned ? 'cpu-pinned' : 'dormant',
            hiddenAt: registration.view.visible ? null : performance.now(),
            generation: circuit.generation, checkedGeneration: null, reservation: null,
            pending: null, failed: null, waiting: false, budgetFallback: false, upgradeBypass: false, upgradeTimer: null,
            requalifyAttempts: 0, requalifyTimer: null,
            lease: {
                get stamp() { return stampOf(entry); },
                updateView: view => this.updateView(entry, view),
                updateToken: token => this.updateToken(entry, token),
                requestGpu: (canvas, stamp) => this.requestGpu(entry, canvas, stamp),
                canMarkPresented: (stamp, generation) => this.canMarkPresented(entry, stamp, generation),
                markPresented: (stamp, generation) => this.markPresented(entry, stamp, generation),
                failGpu: (stamp, generation, reason, latch) => {
                    if (!this.matches(entry, stamp) || entry.reservation?.generation !== generation) return;
                    // A latched failure pins the session to 2D for good, and the person is told once: the document now draws on the
                    // CPU for as long as it is open. Without the latch the pane returns to the GPU by itself (requalifies, or its
                    // pane's own GPU-error retry), so a passing refusal shows nothing.
                    if (latch) {
                        entry.circuit.pinned = true;
                        auditCount('context', 'gpu-error-latched');
                    }
                    this.abandon(entry, 'creation-failed');
                    this.setFailed(entry, reason);
                    if (drawable(entry)) this.fallback(entry, reason);
                    if (latch && this.current(entry)) this.notifyUnavailable(entry, 'gpu-error');
                },
                retry: () => {
                    if (!this.current(entry) || entry.circuit.pinned || entry.reservation) return;
                    entry.failed = null;
                    entry.waiting = drawable(entry);
                    this.notifyAvailable();
                },
                snapshot: () => this.snapshot(entry),
                dispose: () => this.disposeEntry(entry),
            },
        };
        this.surfaces.set(entry.paneId, entry);
        return entry.lease;
    }

    /** Fixed reservation, even when false. The terminal shim imports no renderer to report this. */
    setTerminalContextActive(active: boolean): void {
        this.terminalContextActive = active;
    }

    get contextBudget(): Readonly<{ reserved: number; platform: number; terminalActive: boolean; }> {
        const platform = [...this.surfaces.values()].filter(entry => entry.reservation !== null).length;
        return { reserved: platform + RENDER_CONSTANTS.reservedTerminalContexts, platform, terminalActive: this.terminalContextActive };
    }

    /** Window suspension is NOT app-pane hide: keep working resources and pause restoration time. */
    setWindowVisible(visible: boolean): void {
        if (visible === this.windowVisible) return;
        this.windowVisible = visible;
        for (const entry of this.surfaces.values()) {
            const reservation = entry.reservation;
            if (!reservation?.lost) continue;
            this.pauseRestoreClock(reservation);
            if (visible) {
                if (reservation.foregroundMs >= RESTORE_FOREGROUND_MS) this.restoreTimedOut(entry, reservation);
                else if (reservation.restored) this.restore(entry, reservation);
                else this.armRestoreClock(entry, reservation);
            }
        }
        for (const entry of this.surfaces.values()) if (visible && requalifies(entry.failed)) this.armRequalify(entry);
        if (visible) this.notifyAvailable();
    }

    revokeHiddenContexts(count = Infinity): number {
        const candidates = [...this.surfaces.values()]
            .filter(entry => entry.reservation && !entry.view.visible)
            .sort((a, b) => (a.hiddenAt ?? Infinity) - (b.hiddenAt ?? Infinity) ||
                a.view.lastInputAt - b.view.lastInputAt || (a.paneId < b.paneId ? -1 : a.paneId > b.paneId ? 1 : 0));
        let revoked = 0;
        for (const entry of candidates) {
            if (revoked >= count) break;
            this.abandon(entry, 'revoked');
            revoked++;
        }
        return revoked;
    }

    /** Pressure/freeze teardown is explicit; browser visibility alone never calls this. */
    releaseContextsForPressure(): void {
        for (const entry of this.surfaces.values()) {
            this.setFailed(entry, 'pressure');
            entry.waiting = false;
            if (!entry.reservation) continue;
            this.abandon(entry, 'pressure');
            if (drawable(entry)) this.fallback(entry, 'pressure');
        }
    }

    /** Call only after the App session's closing barrier, never for a view unmount or rename. */
    releaseSession(token: RenderToken): void {
        const key = sessionKey(token);
        for (const entry of this.surfaces.values()) {
            if (sessionKey(entry.documentToken) === key) this.disposeEntry(entry);
        }
        this.circuits.delete(key);
    }

    private current(entry: SurfaceEntry): boolean {
        return this.surfaces.get(entry.paneId) === entry && entry.state !== 'disposed';
    }

    private matches(entry: SurfaceEntry, stamp: SurfaceStamp): boolean {
        return this.current(entry) && entry.paneId === stamp.paneId && entry.viewLease === stamp.viewLease &&
            sameToken(entry.documentToken, stamp.documentToken);
    }

    private updateToken(entry: SurfaceEntry, token: RenderToken): void {
        if (!this.current(entry) || sameToken(entry.documentToken, token)) return;
        if (sessionKey(entry.documentToken) !== sessionKey(token)) {
            throw new Error('A replacement document session needs a new surface lease');
        }
        this.abandon(entry, 'stale');
        entry.documentToken = { ...token };
    }

    private updateView(entry: SurfaceEntry, view: SurfaceView): void {
        if (!this.current(entry)) return;
        validateView(view);
        const wasDrawable = drawable(entry);
        const wasVisible = entry.view.visible;
        entry.view = { ...view };
        if (wasVisible && !view.visible) entry.hiddenAt = performance.now();
        if (!wasVisible && view.visible) entry.hiddenAt = null;
        if (wasDrawable && !drawable(entry)) {
            entry.waiting = false;
            const reservation = entry.reservation;
            try {
                entry.callbacks.beforeHide();
            } finally {
                // A checkpoint can synchronously unmount or show a replacement view.
                if (this.current(entry) && !drawable(entry) && entry.reservation === reservation) {
                    if (!entry.view.visible && reservation?.owner && !reservation.lost && !entry.pending) {
                        entry.state = 'context-reserved';
                        try { reservation.owner.releaseGpu('hidden'); }
                        catch { this.abandon(entry, 'creation-failed'); }
                        finally { zeroCanvas(reservation.canvas); entry.callbacks.onSurfaceZeroed?.(reservation.canvas); }
                    } else if (reservation) {
                        this.abandon(entry, 'stale');
                    }
                    this.notifyAvailable();
                }
            }
        } else if (wasVisible && !view.visible && entry.reservation?.lost) {
            // A zero-size pane can still receive a loss while geometry is changing.
            this.abandon(entry, 'context-lost');
        } else if (!wasDrawable && drawable(entry)) {
            // Showing a pane is a fresh chance for it: the back-off starts again.
            this.clearRequalify(entry);
            entry.failed = null;
            entry.waiting = !entry.circuit.pinned;
            // Showing a pane is the visibility change the upgrade waits for: it is not a gesture, so it skips the quiet wait.
            entry.upgradeBypass = true;
            this.notifyAvailable();
        }
    }

    private requestGpu(entry: SurfaceEntry, canvas: HTMLCanvasElement, stamp: SurfaceStamp): Promise<GpuRequestResult> {
        if (!this.contextAllocator) throw new Error('Configure the surface broker before requesting a context');
        if (!this.matches(entry, stamp)) return Promise.resolve({ kind: 'stale' });
        if (!drawable(entry) || !this.windowVisible) return Promise.resolve({ kind: 'ineligible' });
        if (entry.circuit.pinned) return Promise.resolve(this.fallback(entry, 'cpu-pinned'));
        if (entry.pending) return entry.pending;
        if (entry.failed) return Promise.resolve({ kind: 'cpu', reason: entry.failed });
        const kept = entry.reservation;
        if (kept?.lost || kept?.context?.isContextLost()) {
            return Promise.resolve(this.fallback(entry, 'context-lost'));
        }
        const otherVisible = [...this.surfaces.values()].filter(other =>
            other !== entry && drawable(other) && other.reservation !== null).length;
        if (otherVisible >= RENDER_CONSTANTS.maxVisiblePaneContexts) {
            if (kept) this.abandon(entry, 'revoked');
            return Promise.resolve(this.fallbackBudget(entry));
        }
        if (kept?.owner) {
            if (kept.grant && (entry.state === 'rebuilding' || entry.state === 'gpu-visible')) {
                return Promise.resolve({ kind: 'gpu', grant: kept.grant });
            }
            const grant = this.grant(entry, kept, true);
            kept.grant = grant;
            entry.state = 'rebuilding';
            entry.waiting = false;
            try { entry.callbacks.onGpuReady(grant); }
            catch {
                if (entry.reservation !== kept) return Promise.resolve({ kind: 'stale' });
                this.abandon(entry, 'creation-failed');
                this.setFailed(entry, 'creation-failed');
                return Promise.resolve(this.fallback(entry, 'creation-failed'));
            }
            return Promise.resolve(this.matches(entry, stamp) && entry.reservation === kept && drawable(entry)
                ? { kind: 'gpu', grant } : { kind: 'stale' });
        }
        if (this.contextBudget.platform >= PLATFORM_CONTEXT_CEILING) this.revokeHiddenContexts(1);
        if (this.contextBudget.platform >= PLATFORM_CONTEXT_CEILING) {
            return Promise.resolve(this.fallbackBudget(entry));
        }
        if (this.usedCanvases.has(canvas)) {
            throw new Error('A fresh GPU attempt requires a fresh canvas');
        }
        const contextLease = this.contextAllocator.reserve(RENDER_CONSTANTS.keptContextReserveBytes);
        if (!contextLease) {
            if (!this.matches(entry, stamp)) return Promise.resolve({ kind: 'stale' });
            if (!drawable(entry) || !this.windowVisible) return Promise.resolve({ kind: 'ineligible' });
            if (entry.pending || entry.reservation || entry.circuit.pinned) return this.requestGpu(entry, canvas, stamp);
            // Shared memory is short: this pane shows 2D now and waits for the reserve to fit. Marking it failed instead kept
            // it on 2D until an explicit retry, even after the memory freed; the waiter is the real capacity event.
            // With no sized waiter the pane would wait for nothing: it takes the explicit retry path instead.
            if (this.awaitContextReserve()) entry.waiting = true;
            else this.setFailed(entry, 'out-of-budget');
            return Promise.resolve(this.fallback(entry, 'out-of-budget'));
        }
        const reservation: Reservation = {
            contextLease, canvas, context: null, owner: null, grant: null, controller: new AbortController(),
            generation: ++entry.circuit.generation, intentional: false, lost: false, restored: false,
            foregroundMs: 0, foregroundSince: null, timer: null,
            onLost: event => this.contextLost(entry, reservation, event),
            onRestored: () => this.restore(entry, reservation),
        };
        // Budget eviction may synchronously close this view or admit a duplicate request (§6.1:603).
        if (!this.matches(entry, stamp) || !drawable(entry) || !this.windowVisible || entry.circuit.pinned ||
            entry.pending || entry.reservation) {
            this.returnContextReserve(reservation);
            return this.requestGpu(entry, canvas, stamp);
        }
        const visibleAfterAllocation = [...this.surfaces.values()].filter(other =>
            other !== entry && drawable(other) && other.reservation !== null).length;
        if (this.contextBudget.platform >= PLATFORM_CONTEXT_CEILING || visibleAfterAllocation >= RENDER_CONSTANTS.maxVisiblePaneContexts) {
            this.returnContextReserve(reservation);
            return Promise.resolve(this.fallbackBudget(entry));
        }
        // Both reservations and loss listeners precede getContext (§3.3:360–364).
        entry.reservation = reservation;
        entry.generation = reservation.generation;
        entry.state = 'requesting';
        entry.waiting = false;
        canvas.addEventListener('webglcontextlost', reservation.onLost);
        canvas.addEventListener('webglcontextrestored', reservation.onRestored);
        return this.prepare(entry, reservation);
    }

    private prepare(entry: SurfaceEntry, reservation: Reservation): Promise<GpuRequestResult> {
        const stamp = stampOf(entry);
        const generation = reservation.generation;
        const controller = reservation.controller;
        const valid = () => this.matches(entry, stamp) && entry.reservation === reservation &&
            reservation.generation === generation && !controller.signal.aborted && !reservation.lost &&
            !reservation.context?.isContextLost();
        // The microtask gives duplicate callers the SAME promise before the adapter runs any code.
        const pending = Promise.resolve().then(async (): Promise<GpuRequestResult> => {
            if (!valid()) return { kind: 'stale' };
            let owner: BrokerGpuOwner;
            let capabilityUnavailable = false;
            let software = false;
            try {
                if (!reservation.context) {
                    // A StrictMode cleanup can cancel before this microtask; that canvas was never used.
                    if (this.usedCanvases.has(reservation.canvas)) throw new Error('GPU canvas already used');
                    this.usedCanvases.add(reservation.canvas);
                    // Limits/capability negotiation precedes any nonzero drawing-buffer allocation.
                    zeroCanvas(reservation.canvas);
                    reservation.context = reservation.canvas.getContext('webgl2', CONTEXT_ATTRIBUTES);
                    if (!reservation.context) { capabilityUnavailable = true; throw new Error('WebGL2 unavailable'); }
                    if (!valid()) {
                        // A wrapped getContext may synchronously unmount; abandon could not see its result yet.
                        if (entry.reservation !== reservation) destroyContext(reservation.context);
                        return { kind: 'stale' };
                    }
                }
                // Asked on a restored context too: Chrome restores a context lost to a GPU process crash on SwiftShader.
                if (softwareRenderer(reservation.context)) { software = true; throw new Error('Software WebGL2'); }
                owner = await entry.callbacks.prepareGpu({
                    canvas: reservation.canvas, context: reservation.context, generation, signal: controller.signal,
                });
            } catch (error) {
                if (!valid()) return { kind: 'stale' };
                // No usable GPU is a fallback the person is told about, never memory pressure, and no back-off retries it.
                // Measured (Chrome 157): --use-angle=swiftshader hands out SwiftShader WebGL2 even with failIfMajorPerformanceCaveat, and
                // the pane presented 'webgl2' at up to 584 ms a frame; --disable-gpu refuses the context, but a plain probe got SwiftShader,
                // so the null counted as a capability failure (pressure) and the person was never told the pane draws on the CPU.
                const cause: GpuUnavailableCause | null = software ? 'software'
                    : capabilityUnavailable ? deviceGpu()
                        : typeof error === 'object' && error !== null && 'code' in error && error.code === 'unsupported' ? 'unsupported' : null;
                this.abandon(entry, 'creation-failed');
                auditCount('context', 'creation-failed');
                if (cause) {
                    this.setFailed(entry, 'gpu-unavailable');
                    const result = this.fallback(entry, 'gpu-unavailable');
                    if (this.current(entry)) this.notifyUnavailable(entry, cause);
                    return result;
                }
                this.setFailed(entry, 'creation-failed');
                if (capabilityUnavailable) entry.callbacks.onCapabilityFailure?.();
                return this.fallback(entry, 'creation-failed');
            }
            if (!valid() || !drawable(entry)) {
                owner.dispose('stale');
                return { kind: 'stale' };
            }
            reservation.owner = owner;
            entry.checkedGeneration = generation;
            entry.state = 'rebuilding';
            const grant = this.grant(entry, reservation, false);
            reservation.grant = grant;
            try { entry.callbacks.onGpuReady(grant); }
            catch {
                if (entry.reservation !== reservation) return { kind: 'stale' };
                this.abandon(entry, 'creation-failed');
                this.setFailed(entry, 'creation-failed');
                auditCount('context', 'creation-failed');
                return this.fallback(entry, 'creation-failed');
            }
            return valid() && drawable(entry) ? { kind: 'gpu', grant } : { kind: 'stale' };
        });
        entry.pending = pending;
        void pending.finally(() => {
            if (entry.pending === pending) entry.pending = null;
        }).catch(() => { /* The caller owns rejection; cleanup must not create a second rejection. */ });
        return pending;
    }

    private grant(entry: SurfaceEntry, reservation: Reservation, reused: boolean): GpuGrant {
        const owner = reservation.owner!;
        const stamp = stampOf(entry);
        const generation = reservation.generation;
        return {
            canvas: reservation.canvas, limits: owner.limits, generation, reused,
            resizeSurface: (width, height) => {
                if (!this.matches(entry, stamp) || entry.reservation !== reservation ||
                    entry.generation !== generation || reservation.lost || !drawable(entry) || !this.windowVisible) {
                    return { width: 0, height: 0, complete: false, generation };
                }
                return owner.resizeSurface(width, height);
            },
            // The same lifetime checks as resizeSurface: a raise opened or presented after the grant went stale does nothing.
            openOffscreen: (width, height) => {
                if (!this.matches(entry, stamp) || entry.reservation !== reservation ||
                    entry.generation !== generation || reservation.lost || !drawable(entry) || !this.windowVisible) return false;
                return owner.openOffscreen(width, height);
            },
            commitSurface: () => {
                if (!this.matches(entry, stamp) || entry.reservation !== reservation ||
                    entry.generation !== generation || reservation.lost || !drawable(entry) || !this.windowVisible) return null;
                return owner.commitSurface();
            },
            closeOffscreen: () => { owner.closeOffscreen(); },
        };
    }

    /** Pure: whether the GPU surface may be shown now. The lifecycle asks before it switches the display, so a refused
     * switch leaves the broker's state where the picture on screen says it is. */
    private canMarkPresented(entry: SurfaceEntry, stamp: SurfaceStamp, generation: number): boolean {
        return this.matches(entry, stamp) && drawable(entry) && this.windowVisible &&
            !!entry.reservation?.owner && !entry.reservation.lost && !entry.reservation.context?.isContextLost() &&
            entry.checkedGeneration === generation && entry.generation === generation;
    }

    private markPresented(entry: SurfaceEntry, stamp: SurfaceStamp, generation: number): boolean {
        if (!this.canMarkPresented(entry, stamp, generation)) return false;
        entry.state = 'gpu-visible';
        entry.requalifyAttempts = 0;
        return true;
    }

    private contextLost(entry: SurfaceEntry, reservation: Reservation, event: Event): void {
        if (!this.current(entry) || entry.reservation !== reservation || reservation.intentional || reservation.lost) return;
        event.preventDefault();
        reservation.lost = true;
        reservation.controller.abort();
        entry.pending = null;
        entry.checkedGeneration = null;
        entry.generation = ++entry.circuit.generation;
        const now = performance.now();
        entry.circuit.losses = entry.circuit.losses.filter(time => now - time <= RENDER_CONSTANTS.contextLossWindowMs);
        entry.circuit.losses.push(now);
        const owner = reservation.owner;
        reservation.owner = null;
        reservation.grant = null;
        try { owner?.releaseGpu('context-lost'); }
        finally {
            try { owner?.dispose('context-lost'); }
            finally {
                const pinned = entry.circuit.losses.length >= RENDER_CONSTANTS.contextLossPinCount;
                if (pinned) entry.circuit.pinned = true;
                auditCount('context', pinned ? 'loss:pinned' : 'loss');
                try {
                    zeroCanvas(reservation.canvas);
                    entry.callbacks.onSurfaceZeroed?.(reservation.canvas);
                } finally {
                    try {
                        if (this.current(entry) && entry.reservation === reservation) {
                            if (pinned) {
                                try { this.abandon(entry, 'cpu-pinned'); }
                                finally { if (this.current(entry)) this.fallback(entry, 'cpu-pinned'); }
                            } else if (!drawable(entry)) this.abandon(entry, 'context-lost');
                            else {
                                entry.state = 'lost-waiting';
                                try { this.fallback(entry, 'context-lost'); }
                                finally { this.armRestoreClock(entry, reservation); }
                            }
                        }
                    } finally {
                        if (pinned && !entry.circuit.notified) {
                            entry.circuit.notified = true;
                            entry.callbacks.onPinned();
                        }
                    }
                }
            }
        }
    }

    private restore(entry: SurfaceEntry, reservation: Reservation): void {
        if (!this.current(entry) || entry.reservation !== reservation || !reservation.lost ||
            reservation.intentional || entry.circuit.pinned) return;
        reservation.restored = true;
        this.pauseRestoreClock(reservation);
        auditCount('context', 'restored');
        if (!drawable(entry)) { this.abandon(entry, 'stale'); return; }
        if (reservation.foregroundMs >= RESTORE_FOREGROUND_MS) { this.restoreTimedOut(entry, reservation); return; }
        if (!this.windowVisible) return;
        reservation.lost = false;
        reservation.restored = false;
        reservation.foregroundMs = 0;
        reservation.generation = ++entry.circuit.generation;
        reservation.controller = new AbortController();
        entry.generation = reservation.generation;
        entry.state = 'rebuilding';
        void this.prepare(entry, reservation).catch(() => {
            // Preparation owns rollback and CPU fallback; there is no request caller on restore.
        });
    }

    private armRestoreClock(entry: SurfaceEntry, reservation: Reservation): void {
        if (!this.windowVisible || reservation.timer !== null || !this.current(entry) ||
            entry.reservation !== reservation || !reservation.lost) return;
        reservation.foregroundSince = performance.now();
        reservation.timer = setTimeout(() => {
            reservation.timer = null;
            this.pauseRestoreClock(reservation);
            if (reservation.foregroundMs < RESTORE_FOREGROUND_MS) this.armRestoreClock(entry, reservation);
            else this.restoreTimedOut(entry, reservation);
        }, Math.max(0, RESTORE_FOREGROUND_MS - reservation.foregroundMs));
    }

    private pauseRestoreClock(reservation: Reservation): void {
        if (reservation.timer !== null) clearTimeout(reservation.timer);
        reservation.timer = null;
        if (reservation.foregroundSince !== null) {
            reservation.foregroundMs += performance.now() - reservation.foregroundSince;
            reservation.foregroundSince = null;
        }
    }

    private restoreTimedOut(entry: SurfaceEntry, reservation: Reservation): void {
        if (!this.current(entry) || entry.reservation !== reservation || !reservation.lost) return;
        auditCount('context', 'restore-timeout');
        this.abandon(entry, 'restore-timeout');
        this.setFailed(entry, 'restore-timeout');
        if (drawable(entry)) this.fallback(entry, 'restore-timeout');
    }

    /** Records why the pane is on 2D, and arms its back-off when it is one a visible pane recovers from by itself. */
    private setFailed(entry: SurfaceEntry, reason: CpuFallbackReason): void {
        entry.failed = reason;
        if (requalifies(reason)) this.armRequalify(entry);
    }

    /** Counts a pane that has no usable GPU and tells the person once per cause (see SurfaceCallbacks.onGpuUnavailable). */
    private notifyUnavailable(entry: SurfaceEntry, cause: GpuUnavailableCause): void {
        auditCount('context', `unavailable:${cause}`);
        if (cause === 'gpu-error') {
            if (entry.circuit.errorNotified) return;
            entry.circuit.errorNotified = true;
        } else {
            if (this.notifiedCauses.has(cause)) return;
            this.notifiedCauses.add(cause);
        }
        entry.callbacks.onGpuUnavailable?.(cause);
    }

    /** Re-qualifies a pane whose failure requalifies() with a fresh context after a back-off: a visible pane must not stay on 2D for the session.
     * The wait doubles per attempt (5 s, 10 s, 20 s, ... to 60 s); a hidden or window-hidden pane arms nothing and is re-armed
     * when it is shown. The re-qualification goes through the normal capacity path, so the context limits still apply. */
    private armRequalify(entry: SurfaceEntry): void {
        if (entry.requalifyTimer !== null || !requalifies(entry.failed) || !this.windowVisible || !drawable(entry)) return;
        const delay = Math.min(REQUALIFY_MAX_MS, REQUALIFY_MIN_MS * 2 ** Math.min(entry.requalifyAttempts, 10));
        entry.requalifyAttempts++;
        entry.requalifyTimer = setTimeout(() => {
            entry.requalifyTimer = null;
            if (!this.current(entry) || !requalifies(entry.failed)) return;
            if (!this.windowVisible || !drawable(entry)) return;
            auditCount('broker', 'requalify');
            entry.failed = null;
            entry.waiting = !entry.circuit.pinned;
            this.notifyAvailable();
        }, delay);
    }

    private clearRequalify(entry: SurfaceEntry): void {
        if (entry.requalifyTimer !== null) { clearTimeout(entry.requalifyTimer); entry.requalifyTimer = null; }
        entry.requalifyAttempts = 0;
    }

    private abandon(entry: SurfaceEntry, reason: ContextDisposeReason): void {
        const reservation = entry.reservation;
        if (!reservation) return;
        reservation.intentional = true;
        reservation.controller.abort();
        this.pauseRestoreClock(reservation);
        reservation.canvas.removeEventListener('webglcontextlost', reservation.onLost);
        reservation.canvas.removeEventListener('webglcontextrestored', reservation.onRestored);
        // Retire authority before callbacks: a late event/promise cannot reacquire this reservation.
        entry.reservation = null;
        entry.pending = null;
        entry.checkedGeneration = null;
        // Retire the generation before callbacks can observe or publish stale device resources.
        entry.generation = ++entry.circuit.generation;
        entry.state = entry.circuit.pinned ? 'cpu-pinned' : 'dormant';
        const owner = reservation.owner;
        reservation.owner = null;
        reservation.grant = null;
        try {
            try { owner?.releaseGpu(reason === 'pressure' ? 'pressure' : reason === 'context-lost' ? 'context-lost' : 'hidden'); }
            finally { owner?.dispose(reason); }
        } finally {
            try {
                zeroCanvas(reservation.canvas);
                try { entry.callbacks.onSurfaceZeroed?.(reservation.canvas); }
                finally { if (reservation.context) destroyContext(reservation.context); }
            } finally {
                try { this.returnContextReserve(reservation); }
                finally { this.notifyAvailable(); }
            }
        }
    }

    private returnContextReserve(reservation: Reservation): void {
        const lease = reservation.contextLease;
        if (!lease) return;
        reservation.contextLease = null;
        // Only permanent rollback/abandon returns this; owner.dispose(context-lost) cannot (§3.3:360).
        this.contextAllocator!.release(lease);
    }

    private disposeEntry(entry: SurfaceEntry): void {
        if (!this.current(entry)) return;
        try { this.updateView(entry, { ...entry.view, visible: false }); }
        finally {
            try { this.abandon(entry, 'disposed'); }
            finally {
                entry.waiting = false;
                entry.budgetFallback = false;
                if (entry.upgradeTimer !== null) { clearTimeout(entry.upgradeTimer); entry.upgradeTimer = null; }
                this.clearRequalify(entry);
                entry.state = 'disposed';
                this.surfaces.delete(entry.paneId);
                this.notifyAvailable();
            }
        }
    }

    /** One sized waiter for the whole broker: it wakes once the context reserve fits, and the waiting panes retry then. Returns
     * false when no waiter can be registered (the allocator cannot wake one), so the caller must not wait for it. */
    private awaitContextReserve(): boolean {
        if (this.contextReserveWaiting) return true;
        if (!this.contextAllocator?.whenAvailable) return false;
        this.contextReserveWaiting = true;
        this.contextAllocator.whenAvailable(() => { this.contextReserveWaiting = false; this.notifyAvailable(); },
            RENDER_CONSTANTS.keptContextReserveBytes);
        return true;
    }

    /** The visible-context cap is full (a sixth visible pane, or the platform ceiling). The pane is live 2D at once, through the
     * lifecycle's real presentation, never parked on its last picture; it upgrades to GPU when a context frees, on its next
     * visibility change or a quiet moment (see notifyAvailable). Counted: fallback:budget. */
    private fallbackBudget(entry: SurfaceEntry): GpuRequestResult {
        entry.waiting = true;
        entry.budgetFallback = true;
        auditCount('context', 'fallback:budget');
        return this.fallback(entry, 'budget');
    }

    /** Milliseconds until this pane is quiet: no input and no motion for the quiet window. A pane still moving reports one
     * window and is asked again when it passes, so a fling or zoom that outlives its last input still holds the upgrade. */
    private quietWait(entry: SurfaceEntry): number {
        const motion = paneMotionState(entry.paneId);
        if (motion.moving) return UPGRADE_QUIET_MS;
        const since = Math.max(entry.view.lastInputAt, motion.stoppedAt);
        return Math.max(0, since + UPGRADE_QUIET_MS - performance.now());
    }

    private deferUpgrade(entry: SurfaceEntry, delay: number): void {
        if (entry.upgradeTimer !== null) return;
        auditCount('context', 'upgrade:deferred');
        // A real deadline, not a poll: the timer fires when the quiet window of input and motion has passed, and re-arms if not.
        entry.upgradeTimer = setTimeout(() => {
            entry.upgradeTimer = null;
            if (this.current(entry)) this.notifyAvailable();
        }, delay);
    }

    private fallback(entry: SurfaceEntry, reason: CpuFallbackReason): GpuRequestResult {
        entry.state = entry.circuit.pinned ? 'cpu-pinned' :
            entry.reservation?.lost ? 'lost-waiting' : 'cpu-visible';
        entry.callbacks.onCpuFallback(reason);
        return { kind: 'cpu', reason };
    }

    private notifyAvailable(): void {
        if (this.notificationQueued) return;
        this.notificationQueued = true;
        queueMicrotask(() => {
            this.notificationQueued = false;
            if (!this.windowVisible) return;
            for (const entry of this.surfaces.values()) {
                // Consumed on every visit: a visibility change's bypass covers this notification only, never a later one.
                const bypass = entry.upgradeBypass;
                entry.upgradeBypass = false;
                if (!entry.waiting || !drawable(entry) || entry.circuit.pinned || entry.failed) continue;
                // A returning kept context owns its slot already, even when all five panes are visible.
                const others = [...this.surfaces.values()].filter(other =>
                    other !== entry && drawable(other) && other.reservation).length;
                const hasRoom = entry.reservation || this.contextBudget.platform < PLATFORM_CONTEXT_CEILING ||
                    [...this.surfaces.values()].some(other => !other.view.visible && other.reservation);
                if (others >= RENDER_CONSTANTS.maxVisiblePaneContexts || !hasRoom) continue;
                // A budget fallback upgrades on a visibility change or once input has been quiet: never mid-gesture.
                const wait = entry.budgetFallback && !bypass ? this.quietWait(entry) : 0;
                if (wait > 0) {
                    this.deferUpgrade(entry, wait);
                    continue;
                }
                if (entry.upgradeTimer !== null) { clearTimeout(entry.upgradeTimer); entry.upgradeTimer = null; }
                entry.waiting = false;
                if (entry.budgetFallback) {
                    entry.budgetFallback = false;
                    auditCount('context', 'upgrade');
                }
                entry.callbacks.onSlotAvailable();
            }
        });
    }

    private snapshot(entry: SurfaceEntry): SurfaceSnapshot {
        return {
            ...stampOf(entry), ...entry.view, state: entry.state, hiddenAt: entry.hiddenAt,
            gpuGeneration: entry.generation, capabilityCheckedGeneration: entry.checkedGeneration,
            reserved: entry.reservation !== null, lossTimes: [...entry.circuit.losses],
        };
    }
}

function stampOf(entry: SurfaceEntry): SurfaceStamp {
    return { paneId: entry.paneId, viewLease: entry.viewLease, documentToken: { ...entry.documentToken } };
}

function zeroCanvas(canvas: HTMLCanvasElement): void {
    canvas.width = 0;
    canvas.height = 0;
}

/** WebGL2 drawn by the CPU: SwiftShader, Mesa's llvmpipe/softpipe/lavapipe, Windows' WARP ("Microsoft Basic Render Driver"), Apple's
 * software renderer. Chrome reports them only through the unmasked renderer string. */
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|lavapipe|basic render driver|\bwarp\b|software/i;

/** One synchronous query per context build or restore, never on the frame path (rendering-platform: device creation). */
function softwareRenderer(context: WebGL2RenderingContext): boolean {
    try {
        const info = context.getExtension('WEBGL_debug_renderer_info');
        const renderer: unknown = context.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : context.RENDERER);
        return typeof renderer === 'string' && SOFTWARE_RENDERER.test(renderer);
    } catch { return false; }
}

// Measured (gpu-h13): a browser with no WebGL2 returns null for every canvas, and each new GPU generation (every quality change)
// reported that null as capability pressure, so each raise dropped the quality again. A device that cannot make a usable WebGL2
// context is a fallback, not pressure; a fresh canvas tells that apart from a pane that merely got no context. Asked only after a
// pane got none, so nothing is cached: a device can lose its GPU mid-session (Chrome falls back to software after GPU crashes).
function deviceGpu(): Exclude<GpuUnavailableCause, 'unsupported' | 'gpu-error'> | null {
    try {
        const context = document.createElement('canvas').getContext('webgl2', CONTEXT_ATTRIBUTES);
        if (context) {
            const software = softwareRenderer(context);
            destroyContext(context);
            return software ? 'software' : null;
        }
        // failIfMajorPerformanceCaveat refuses a software context (measured, --disable-gpu): a plain request tells it from none at all.
        const plain = document.createElement('canvas').getContext('webgl2');
        if (!plain) return 'no-webgl2';
        destroyContext(plain);
        return 'software';
    } catch { return 'no-webgl2'; }
}

function destroyContext(context: WebGL2RenderingContext): void {
    try { context.getExtension('WEBGL_lose_context')?.loseContext(); }
    catch { /* Already lost/denied; no restoration listener remains to resurrect this canvas. */ }
}

export const surfaceBroker = new SurfaceBroker();
