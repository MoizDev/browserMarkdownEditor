// The editor's end of the wire to VaultAgent, the local helper that runs the
// agent CLIs: discovery over `GET /health`, then one WebSocket carrying typed
// requests (by `reqId`) and the helper's run/tool events.
//
// ONE connection for the page, held in this module rather than in the panel:
// the panel is a lazily mounted React tree that closes and reopens, and a run
// in flight must keep answering its `tool.call`s even while the panel is shut.
// Everyone who needs the connection `retain()`s it; it closes a few seconds
// after the last release (a grace, so StrictMode's release → retain and a quick
// close/reopen of the panel do not drop and redial it).
//
// THE RULE THIS FILE EXISTS TO KEEP: no request reaches 127.0.0.1 before the
// user has clicked Connect. Chrome (142+) raises its Local Network Access
// prompt on a public site's FIRST request to loopback, so a request made on
// load would ask the user a question out of nowhere. After one successful
// connection we remember it (CONNECTED_ONCE_KEY); a later load dials by itself
// only if Chrome also reports the permission as already granted — anything
// less and we wait for the click again.

import {
    HELPER_APP_ID, HELPER_HOST, HELPER_PORTS, HELPER_NAME, MAX_WS_MESSAGE_BYTES, MIN_HELPER_VERSION, PROTOCOL_VERSION,
    SELF_UPDATE_VERSION, compareVersions,
} from '../../shared/vaultAgentProtocol';
import type {
    ClientMessage, ErrorCode, HealthResponse, HelperMessage, HelperPlatform, RequestName, RequestParams, RequestResult,
    UpdateCheck, UpdatePhase,
} from '../../shared/vaultAgentProtocol';
import { CONNECTED_ONCE_KEY, getAgentUpdateNotice, setAgentUpdateNotice } from './agentUpdateNotice';
import type { AgentUpdateNotice } from './agentUpdateNotice';

/** Long, because the FIRST probe waits on Chrome's Local Network Access
 *  prompt: a short timeout aborted it while the user was still reading the
 *  prompt, and reported "not running". A refused port fails at once anyway;
 *  only a program that accepts and then hangs ever waits this out. */
const HEALTH_TIMEOUT_MS = 30_000;
const HELLO_TIMEOUT_MS = 5000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30_000;
/** How long the socket outlives its last retainer. */
const RELEASE_GRACE_MS = 5000;
/** `helper.update` answers only once the new binary is downloaded, run and
 *  swapped in; a slow line downloading ~60 MB needs minutes, and the helper
 *  aborts a stalled download itself after 60 s of silence. */
const UPDATE_REQUEST_TIMEOUT_MS = 15 * 60_000;
/** How long a restarting helper may take to answer again. launchd may hold a
 *  respawn back 10 s (ThrottleInterval), systemd waits RestartSec=5. */
const UPDATE_RESTART_DEADLINE_MS = 90_000;
/** While it restarts, re-probe this often rather than on the backoff: the
 *  port comes back within seconds and the user is watching. */
const UPDATE_REPROBE_MS = 1000;
/** The page-load check gives up waiting after this (it then lets go, and the
 *  grace closes the socket unless the panel holds it). */
const BACKGROUND_CHECK_MS = 30_000;

export interface HelperInfo {
    port: number;
    version: string;
    platform: HelperPlatform;
    sessionsDir: string;
    /** Older than MIN_HELPER_VERSION: connected only so it can be updated or
     *  uninstalled; the chat stays shut. */
    outdated: boolean;
    /** At least SELF_UPDATE_VERSION: it answers `helper.update`. */
    selfUpdate: boolean;
}

/** Whether a newer VaultAgent exists, and how the last attempt to get it went. */
export type UpdateStatus =
    /** Older than SELF_UPDATE_VERSION, or not installed (a source run): the
     *  installer download is the only way. */
    | { kind: 'unsupported' }
    | { kind: 'checking' }
    /** The check itself failed (offline, GitHub down). */
    | { kind: 'unknown'; message: string }
    | { kind: 'current'; latest: string }
    | { kind: 'available'; latest: string }
    /** The last attempt failed; the helper that was running still is. */
    | { kind: 'failed'; latest: string | null; message: string }
    /** Reconnected after an update; shown until dismissed. */
    | { kind: 'updated'; from: string };

/** Why there is no connection — each gets its own screen in the panel. */
export type BridgeProblem =
    /** Nothing answers on any VaultAgent port: not installed, or not running. */
    | { kind: 'not-found' }
    /** Something answers on a port but is not a VaultAgent that talks to this
     *  page: another program, or a helper whose allowlist lacks this origin. */
    | { kind: 'foreign'; port: number }
    /** Chrome's Local Network Access permission is blocked for this site. */
    | { kind: 'permission-denied' }
    /** The helper speaks an older protocol than this page. */
    | { kind: 'outdated'; version: string }
    /** The helper speaks a newer protocol than this page: the PAGE is stale. */
    | { kind: 'page-outdated'; protocol: number }
    /** A connection existed and dropped (helper quit, crashed, or was killed). */
    | { kind: 'lost' }
    /** An update went through (or the socket died mid-update) and no helper
     *  answered again within UPDATE_RESTART_DEADLINE_MS. `target` is null when
     *  the helper never said what it installed. */
    | { kind: 'update-lost'; from: string; target: string | null };

export type BridgeState =
    /** Waiting for the user's Connect click (or never asked). */
    | { status: 'idle' }
    /** Deciding, on load, whether it may dial without a click. */
    | { status: 'checking' }
    | { status: 'connecting' }
    | { status: 'connected'; helper: HelperInfo; update: UpdateStatus }
    /** `helper.update` is in flight, or the helper is restarting into the new
     *  binary. `helper` is the one that was running when it began. */
    | {
        status: 'updating'; helper: HelperInfo; target: string | null;
        phase: UpdatePhase; received: number | null; total: number | null;
    }
    /** `retryAt` (epoch ms) when a redial is scheduled; null = waiting for the user. */
    | { status: 'failed'; problem: BridgeProblem; retryAt: number | null }
    /** The user uninstalled VaultAgent from the panel, this session. */
    | { status: 'uninstalled' };

/** A failed request. `code` is the helper's, or one of the two local ones. */
export class BridgeError extends Error {
    readonly code: ErrorCode | 'disconnected' | 'timeout';
    constructor(code: BridgeError['code'], message: string) {
        super(message);
        this.code = code;
    }
}

/** Everything the helper sends that is not a response — minus the update's
 *  progress, which the bridge consumes itself (it drives the `updating` state). */
export type HelperEvent = Exclude<HelperMessage, { type: 'response' } | { type: 'update.progress' }>;

/** Connected to a helper the chat may use: not merely a socket to one that is
 *  only there to be updated or uninstalled. */
export function helperReady(state: BridgeState): state is Extract<BridgeState, { status: 'connected' }> {
    return state.status === 'connected' && !state.helper.outdated;
}

/** An update the bridge is seeing through: from the click until the helper
 *  answers again. `expired` = it never came back in time; kept (without its
 *  retain) so a later reconnect can still say whether the update took. */
interface PendingUpdate {
    from: string;
    target: string | null;
    helper: HelperInfo;
    /** The helper answered with `target`: the new binary is in place. Until
     *  then `target` is only what the last check offered. */
    confirmed: boolean;
    /** Set when the restart begins (response, or the socket closing first). */
    deadline: number | null;
    expired: boolean;
    release: () => void;
}

interface Pending {
    resolve(value: unknown): void;
    reject(error: BridgeError): void;
    timer: number;
}

function readFlag(): boolean {
    try { return localStorage.getItem(CONNECTED_ONCE_KEY) === '1'; } catch { return false; }
}

/** This browser has reached the helper before (cleared by an uninstall). */
export function hasConnectedBefore(): boolean {
    return readFlag();
}

function writeFlag(on: boolean): void {
    try {
        if (on) localStorage.setItem(CONNECTED_ONCE_KEY, '1');
        else localStorage.removeItem(CONNECTED_ONCE_KEY);
    } catch { /* storage blocked — the click is simply asked for again */ }
}

/**
 * Chrome's own answer to "may this page reach loopback?", without asking.
 * The permission's NAME moved: Chrome 142–144 call it `local-network-access`;
 * 145 split it into `loopback-network` (127.0.0.1 — ours) and `local-network`,
 * keeping the old name as an alias. Names a browser does not know make
 * `query` throw, so each is tried in turn; null = cannot tell.
 */
export async function loopbackPermission(): Promise<PermissionStatus | null> {
    const names = ['loopback-network', 'local-network-access', 'local-network'];
    for (const name of names) {
        try {
            return await navigator.permissions.query({ name: name as PermissionName });
        } catch { /* unknown name here — try the next */ }
    }
    return null;
}

/** The panel runs a helper's error on into a sentence of its own
 *  ("… is still running."), so it must end like one. */
function sentence(text: string): string {
    const t = text.trim();
    return /[.!?]$/.test(t) ? t : `${t}.`;
}

/**
 * What the app outside the panel should hint at, given the bridge's state.
 * In-between states (dialling, disconnected after the grace, a check that
 * failed or is still out) keep the last known answer: a socket the page-load
 * check let go of says nothing new about the helper.
 */
function noticeFor(state: BridgeState, previous: AgentUpdateNotice): AgentUpdateNotice {
    switch (state.status) {
        case 'connected': {
            if (state.helper.outdated) return { kind: 'outdated', version: state.helper.version };
            const u = state.update;
            if (u.kind === 'available') return { kind: 'available', version: u.latest };
            // Still behind after a failed attempt: still worth the hint.
            if (u.kind === 'failed') {
                return u.latest && compareVersions(u.latest, state.helper.version) > 0
                    ? { kind: 'available', version: u.latest } : previous;
            }
            if (u.kind === 'checking' || u.kind === 'unknown') return previous;
            return null;
        }
        case 'updating':
        case 'uninstalled':
            return null;
        default:
            return previous;
    }
}

function pageIsLoopback(): boolean {
    const host = location.hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

type Probe =
    | { kind: 'ours'; port: number; health: HealthResponse }
    | { kind: 'foreign'; port: number }
    | { kind: 'silent' };

async function probePort(port: number): Promise<Probe> {
    const url = `http://${HELPER_HOST}:${port}/health`;
    try {
        const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
        if (!res.ok) return { kind: 'foreign', port };
        const body = await res.json().catch(() => null) as Partial<HealthResponse> | null;
        if (body && body.app === HELPER_APP_ID && typeof body.version === 'string') {
            return { kind: 'ours', port, health: body as HealthResponse };
        }
        return { kind: 'foreign', port };
    } catch {
        // A CORS refusal and a refused connection are the same TypeError to
        // us. An opaque `no-cors` probe tells them apart: it RESOLVES whenever
        // anything answered at all.
        try {
            await fetch(url, { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
            return { kind: 'foreign', port };
        } catch {
            return { kind: 'silent' };
        }
    }
}

class AgentBridge {
    private state: BridgeState = { status: 'idle' };
    private readonly stateListeners = new Set<() => void>();
    private readonly eventListeners = new Set<(event: HelperEvent) => void>();
    private readonly pending = new Map<string, Pending>();
    private socket: WebSocket | null = null;
    /** Bumped by every dial and every deliberate close, so a stale attempt's
     *  late callbacks can tell they no longer own the bridge. */
    private generation = 0;
    private retainers = 0;
    private releaseTimer = 0;
    private retryTimer = 0;
    private retryDelay = RETRY_MIN_MS;
    /** This page load has connected once — reopening the panel redials freely. */
    private connectedThisSession = false;
    private permissionWatch: PermissionStatus | null = null;
    private pendingUpdate: PendingUpdate | null = null;
    /** What the latest `helper.checkUpdate` said: the status a dismissed
     *  "updated"/"failed" notice falls back to. */
    private lastCheck: UpdateStatus = { kind: 'unsupported' };
    /** One check at a time: the connect and every ⋯ open each ask, and
     *  StrictMode doubles the latter. */
    private checkInFlight: { helper: HelperInfo; promise: Promise<void> } | null = null;
    /** An update's "updated"/"failed" outcome nobody has dismissed yet, and the
     *  helper version it belongs to. It outlives a disconnect: the panel may
     *  have been closed through the whole update, and its grace then drops
     *  the socket before anyone saw the result — the next connection to that
     *  same version shows it instead of a bare re-check. */
    private unseenOutcome: { version: string; update: UpdateStatus } | null = null;
    private backgroundCheck: Promise<void> | null = null;

    /* ── store ─────────────────────────────────────────────────── */

    getState = (): BridgeState => this.state;

    subscribeState = (listener: () => void): (() => void) => {
        this.stateListeners.add(listener);
        return () => { this.stateListeners.delete(listener); };
    };

    /** run.event / run.done / run.error / tool.call, as they arrive. */
    subscribe(listener: (event: HelperEvent) => void): () => void {
        this.eventListeners.add(listener);
        return () => { this.eventListeners.delete(listener); };
    }

    private setState(next: BridgeState): void {
        this.state = next;
        setAgentUpdateNotice(noticeFor(next, getAgentUpdateNotice()));
        for (const listener of this.stateListeners) listener();
    }

    /* ── who wants the connection ───────────────────────────────── */

    /** Hold the connection open (and keep redialling) until the returned
     *  function is called. Idempotent release. */
    retain(): () => void {
        this.retainers++;
        if (this.releaseTimer) { clearTimeout(this.releaseTimer); this.releaseTimer = 0; }
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.retainers--;
            if (this.retainers === 0) this.scheduleRelease();
        };
    }

    private scheduleRelease(): void {
        if (this.releaseTimer) clearTimeout(this.releaseTimer);
        this.releaseTimer = window.setTimeout(() => {
            this.releaseTimer = 0;
            if (this.retainers === 0) this.disconnect();
        }, RELEASE_GRACE_MS);
    }

    /**
     * Called when the panel mounts. Dials without a click only when that
     * cannot raise Chrome's prompt: this load already connected, or an earlier
     * one did AND Chrome says the permission is granted.
     */
    async autoConnect(): Promise<void> {
        const s = this.state.status;
        if (s === 'connected' || s === 'connecting' || s === 'checking' || s === 'updating') return;
        if (s === 'failed' && this.retryTimer) return;
        if (this.connectedThisSession && s !== 'uninstalled') { void this.connect(); return; }
        if (s !== 'idle' || !readFlag()) return;
        this.setState({ status: 'checking' });
        // A loopback page (the dev server) cannot raise the prompt at all.
        const permission = pageIsLoopback() ? null : await loopbackPermission();
        // The click may have dialled meanwhile; a fresh read, not the narrowed one.
        if (this.getState().status !== 'checking') return;
        if (pageIsLoopback() || permission?.state === 'granted') void this.connect();
        else this.setState({ status: 'idle' });
    }

    /**
     * The page-load look for a newer helper, so the app can hint at it with
     * the panel shut. Dials only where autoConnect would (THE RULE above),
     * holds the bridge until the update check has answered — or the dial
     * failed, or BACKGROUND_CHECK_MS passed — then lets go, and the grace
     * closes the socket unless the panel is holding it. Once per page; later
     * calls get the same promise. Never forces the helper's check cache: it
     * keeps a success 10 minutes, so a reload after that asks GitHub again.
     */
    checkInBackground(): Promise<void> {
        return (this.backgroundCheck ??= this.runBackgroundCheck());
    }

    private async runBackgroundCheck(): Promise<void> {
        const release = this.retain();
        try {
            await this.autoConnect();
            await this.until(s => {
                switch (s.status) {
                    case 'checking':
                    case 'connecting':
                        return false;
                    case 'connected':
                        return s.update.kind !== 'checking';
                    default:
                        return true;
                }
            }, BACKGROUND_CHECK_MS);
        } finally {
            release();
        }
    }

    /** Resolves once `done(state)` holds, or after `timeoutMs`. */
    private until(done: (state: BridgeState) => boolean, timeoutMs: number): Promise<void> {
        if (done(this.state)) return Promise.resolve();
        return new Promise(resolve => {
            const finish = () => { clearTimeout(timer); off(); resolve(); };
            const timer = window.setTimeout(finish, timeoutMs);
            const off = this.subscribeState(() => { if (done(this.state)) finish(); });
        });
    }

    /** The Connect / Retry / Reconnect button: dial now. */
    async connect(): Promise<void> {
        this.clearRetry();
        this.closeSocket();
        const gen = ++this.generation;
        // An update whose helper never came back keeps saying so on every
        // redial (measured: it fell to "Connecting…" then "isn't running" a
        // second after the deadline, losing what had happened).
        const lost = this.pendingUpdate?.expired ? this.pendingUpdate : null;
        // A re-probe of a restarting helper stays on the update's screen.
        if (this.awaitingRestart()) this.setState(this.restartingState());
        else if (!lost) this.setState({ status: 'connecting' });

        // The first port alone first: it is where the helper almost always is,
        // and each silent port costs a refused connection (and a red console
        // line, twice — the CORS try and the no-cors one).
        const first = await probePort(HELPER_PORTS[0]);
        const probes = first.kind === 'ours'
            ? [first]
            : [first, ...await Promise.all(HELPER_PORTS.slice(1).map(probePort))];
        if (gen !== this.generation) return;
        const ours = probes.find((p): p is Extract<Probe, { kind: 'ours' }> => p.kind === 'ours');
        if (!ours && this.awaitingRestart()) { this.awaitRestart(); return; }
        if (!ours) {
            const foreign = probes.find((p): p is Extract<Probe, { kind: 'foreign' }> => p.kind === 'foreign');
            if (foreign) { this.fail({ kind: 'foreign', port: foreign.port }, false); return; }
            if (lost) { this.fail(this.updateLost(lost), true); return; }
            // Local Network Access guards a PUBLIC page reaching loopback; a page
            // served from loopback itself (the dev server) is never blocked, yet
            // Chromium can still report 'denied' there — which read as "Chrome
            // is blocking" when the helper was simply not running.
            const permission = pageIsLoopback() ? null : await loopbackPermission();
            if (gen !== this.generation) return;
            if (permission?.state === 'denied') {
                this.watchPermission(permission);
                this.fail({ kind: 'permission-denied' }, false);
                return;
            }
            // Redial by itself only where that cannot raise Chrome's prompt
            // again: a dismissed prompt leaves the permission at 'prompt', and
            // a retry loop would put it back in front of the user every time.
            this.fail({ kind: 'not-found' }, permission?.state !== 'prompt');
            return;
        }
        const { health, port } = ours;
        // A helper below MIN_HELPER_VERSION is connected all the same (as
        // `outdated`): that is what lets it be updated in one click, or
        // uninstalled. Only a protocol it cannot speak keeps the socket shut.
        if (health.protocol < PROTOCOL_VERSION) {
            this.endUpdate();
            this.fail({ kind: 'outdated', version: health.version }, false);
            return;
        }
        if (health.protocol > PROTOCOL_VERSION) {
            this.endUpdate();
            this.fail({ kind: 'page-outdated', protocol: health.protocol }, false);
            return;
        }
        this.openSocket(gen, port);
    }

    private openSocket(gen: number, port: number): void {
        let socket: WebSocket;
        try {
            socket = new WebSocket(`ws://${HELPER_HOST}:${port}/ws`);
        } catch {
            if (this.awaitingRestart()) this.awaitRestart();
            else this.fail({ kind: 'not-found' }, true);
            return;
        }
        this.socket = socket;
        let opened = false;
        socket.onopen = () => {
            if (gen !== this.generation) return;
            opened = true;
            this.request('hello', { protocol: PROTOCOL_VERSION }, HELLO_TIMEOUT_MS).then(result => {
                if (gen !== this.generation) return;
                if (result.protocol !== PROTOCOL_VERSION) {
                    this.closeSocket();
                    this.endUpdate();
                    this.fail(result.protocol > PROTOCOL_VERSION
                        ? { kind: 'page-outdated', protocol: result.protocol }
                        : { kind: 'outdated', version: result.version }, false);
                    return;
                }
                this.connectedThisSession = true;
                this.retryDelay = RETRY_MIN_MS;
                writeFlag(true);
                const helper: HelperInfo = {
                    port,
                    version: result.version,
                    platform: result.platform,
                    sessionsDir: result.sessionsDir,
                    outdated: compareVersions(result.version, MIN_HELPER_VERSION) < 0,
                    selfUpdate: compareVersions(result.version, SELF_UPDATE_VERSION) >= 0,
                };
                this.lastCheck = helper.selfUpdate ? { kind: 'checking' } : { kind: 'unsupported' };
                if (this.pendingUpdate) {
                    this.unseenOutcome = { version: helper.version, update: this.updateOutcome(this.pendingUpdate, helper.version) };
                }
                const update = this.unseenOutcome?.version === helper.version ? this.unseenOutcome.update : this.lastCheck;
                this.endUpdate();
                // A redial that landed after everyone let go (the panel closed
                // mid-backoff) must not hold a socket open for nobody.
                if (this.retainers === 0) this.scheduleRelease();
                this.setState({ status: 'connected', helper, update });
                void this.checkForUpdate(false);
            }, () => {
                if (gen !== this.generation) return;
                this.closeSocket();
                if (this.awaitingRestart()) this.awaitRestart();
                else this.fail({ kind: 'lost' }, true);
            });
        };
        socket.onmessage = (e) => {
            if (gen !== this.generation || typeof e.data !== 'string') return;
            let message: HelperMessage;
            try { message = JSON.parse(e.data) as HelperMessage; } catch { return; }
            this.dispatch(message);
        };
        socket.onclose = () => {
            if (gen !== this.generation) return;
            this.socket = null;
            this.rejectAll('disconnected', 'The connection to VaultAgent closed.');
            // The helper exiting to restart into its new binary is the update
            // working, not the connection failing.
            if (this.awaitingRestart()) { this.awaitRestart(); return; }
            // Refused before it opened: the helper rejected the upgrade (an
            // origin it does not allow) — the same thing a CORS refusal is.
            this.fail(opened ? { kind: 'lost' } : { kind: 'foreign', port }, opened);
        };
        // onerror is always followed by onclose, which does the work.
        socket.onerror = () => {};
    }

    private dispatch(message: HelperMessage): void {
        if (message.type === 'response') {
            const entry = this.pending.get(message.reqId);
            if (!entry) return;
            this.pending.delete(message.reqId);
            clearTimeout(entry.timer);
            if (message.ok) entry.resolve(message.result);
            else entry.reject(new BridgeError(message.error.code, message.error.message));
            return;
        }
        if (message.type === 'update.progress') {
            const s = this.state;
            if (s.status !== 'updating') return;
            this.setState({ ...s, phase: message.phase, received: message.received ?? null, total: message.total ?? null });
            return;
        }
        for (const listener of this.eventListeners) listener(message);
    }

    /** No connection, and whether to redial by itself. Redialling makes sense
     *  only for "not running (yet)" and "dropped" — the others need the user. */
    private fail(problem: BridgeProblem, retry: boolean): void {
        this.clearRetry();
        if (retry && this.retainers > 0) {
            const delay = this.retryDelay;
            this.retryDelay = Math.min(RETRY_MAX_MS, this.retryDelay * 2);
            this.retryTimer = window.setTimeout(() => { this.retryTimer = 0; void this.connect(); }, delay);
            this.setState({ status: 'failed', problem, retryAt: Date.now() + delay });
        } else {
            this.setState({ status: 'failed', problem, retryAt: null });
        }
    }

    /** A blocked permission the user re-allows in site settings takes effect
     *  at once: Chrome fires `change` on the status object. */
    private watchPermission(status: PermissionStatus): void {
        if (this.permissionWatch === status) return;
        if (this.permissionWatch) this.permissionWatch.onchange = null;
        this.permissionWatch = status;
        status.onchange = () => {
            const s = this.state;
            if (status.state !== 'denied' && s.status === 'failed' && s.problem.kind === 'permission-denied') {
                void this.connect();
            }
        };
    }

    private clearRetry(): void {
        if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = 0; }
    }

    private closeSocket(): void {
        const socket = this.socket;
        this.socket = null;
        if (socket) {
            socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
            try { socket.close(1000); } catch { /* already closing */ }
        }
        this.rejectAll('disconnected', 'Disconnected from VaultAgent.');
    }

    private rejectAll(code: BridgeError['code'], message: string): void {
        const entries = [...this.pending.values()];
        this.pending.clear();
        for (const entry of entries) {
            clearTimeout(entry.timer);
            entry.reject(new BridgeError(code, message));
        }
    }

    /** A deliberate, quiet close: back to idle (a remount redials freely). */
    disconnect(): void {
        this.generation++;
        this.endUpdate();
        this.clearRetry();
        this.closeSocket();
        if (this.state.status !== 'uninstalled') this.setState({ status: 'idle' });
    }

    /** The helper has just removed itself (helper.uninstall). Forget that we
     *  ever connected, so the next load starts from the guide. */
    markUninstalled(): void {
        this.generation++;
        this.endUpdate();
        this.clearRetry();
        this.closeSocket();
        this.connectedThisSession = false;
        this.unseenOutcome = null;
        writeFlag(false);
        this.setState({ status: 'uninstalled' });
    }

    /* ── updating the helper ───────────────────────────────────── */

    /**
     * Ask the helper whether a newer release is out, and show the answer. The
     * helper caches it (so the ⋯ menu may ask on every open); `force` skips
     * that cache. Only a self-updating helper is asked: older ones answer
     * nothing useful and keep the installer download.
     */
    checkForUpdate(force: boolean): Promise<void> {
        const s = this.state;
        if (s.status !== 'connected' || !s.helper.selfUpdate) return Promise.resolve();
        const helper = s.helper;
        // Only a check of THIS connection counts: one still out to the helper
        // before a reconnect would be dropped on arrival, leaving 'checking'.
        if (this.checkInFlight?.helper === helper && !force) return this.checkInFlight.promise;
        const check = this.request('helper.checkUpdate', { force }).then(
            result => this.checkStatus(result),
            (e: unknown): UpdateStatus => e instanceof BridgeError && e.code === 'unsupported'
                ? { kind: 'unsupported' }
                : { kind: 'unknown', message: e instanceof Error ? e.message : String(e) },
        ).then(status => {
            const now = this.state;
            // Answered for a connection that has since gone (or been replaced).
            if (now.status !== 'connected' || now.helper !== helper) return;
            this.lastCheck = status;
            // An outcome the user has not acknowledged outranks a fresh check:
            // the menu re-checks on open, and would otherwise wipe the error
            // bar (and its Download link) the moment the user went looking.
            if (now.update.kind === 'updated' || now.update.kind === 'failed') {
                if (status.kind !== 'unsupported') return;
            }
            this.setState({ ...now, update: status });
        });
        const entry = { helper, promise: check.finally(() => { if (this.checkInFlight === entry) this.checkInFlight = null; }) };
        this.checkInFlight = entry;
        return entry.promise;
    }

    private checkStatus(result: UpdateCheck): UpdateStatus {
        if (!result.installed) return { kind: 'unsupported' };
        if (result.error || !result.latest) {
            return { kind: 'unknown', message: result.error ?? "Couldn't check for updates." };
        }
        return result.available ? { kind: 'available', latest: result.latest } : { kind: 'current', latest: result.latest };
    }

    /**
     * Update the helper in place: it downloads, checks and swaps in the new
     * binary, answers, then exits and comes back as the new version. The
     * bridge holds itself open meanwhile (closing the panel must not abandon
     * the reconnect), reads the socket closing as the restart rather than a
     * loss, and re-probes until the new helper answers. One at a time — a
     * second call while one is in flight does nothing.
     *
     * The caller stops any reply first: the helper refuses while a run is live.
     */
    async update(): Promise<void> {
        const s = this.state;
        if (s.status !== 'connected' || !s.helper.selfUpdate || this.pendingUpdate) return;
        const helper = s.helper;
        const latest = s.update.kind === 'available' || s.update.kind === 'current' || s.update.kind === 'failed'
            ? s.update.latest : null;
        const pending: PendingUpdate = {
            from: helper.version, target: latest, confirmed: false, helper, deadline: null, expired: false, release: this.retain(),
        };
        this.pendingUpdate = pending;
        this.setState({ status: 'updating', helper, target: latest, phase: 'checking', received: null, total: null });
        try {
            const result = await this.request('helper.update', {}, UPDATE_REQUEST_TIMEOUT_MS);
            if (this.pendingUpdate !== pending) return;
            pending.target = result.to;
            pending.confirmed = true;
            pending.deadline ??= Date.now() + UPDATE_RESTART_DEADLINE_MS;
            const now = this.state;
            if (now.status === 'updating') this.setState({ ...now, target: result.to, phase: 'restarting' });
            // The helper's exit is what closes the socket and starts the
            // re-probing; one that answered and then never went would leave
            // this screen up for good.
            window.setTimeout(() => {
                if (this.pendingUpdate !== pending || pending.expired || !this.socket) return;
                this.closeSocket();
                this.awaitRestart();
            }, UPDATE_RESTART_DEADLINE_MS);
        } catch (e) {
            if (this.pendingUpdate !== pending) return;
            // The socket went before the answer: the helper is restarting (or
            // died) — onclose has already started waiting for it.
            if (e instanceof BridgeError && e.code === 'disconnected') return;
            this.endUpdate();
            const message = sentence(e instanceof Error ? e.message : String(e));
            const socket = this.socket;
            if (socket && socket.readyState === WebSocket.OPEN && this.state.status === 'updating') {
                const update: UpdateStatus = { kind: 'failed', latest: pending.target, message };
                this.unseenOutcome = { version: helper.version, update };
                this.setState({ status: 'connected', helper, update });
            } else {
                void this.connect();
            }
        }
    }

    /** Hide the "updated" / "failed" notice: back to what the last check said. */
    dismissUpdateNotice(): void {
        const s = this.state;
        if (s.status !== 'connected' || (s.update.kind !== 'updated' && s.update.kind !== 'failed')) return;
        this.unseenOutcome = null;
        this.setState({ ...s, update: this.lastCheck });
    }

    /** An update is between its response (or the socket dropping) and the
     *  helper answering again, inside the deadline. */
    private awaitingRestart(): boolean {
        return !!this.pendingUpdate && !this.pendingUpdate.expired;
    }

    private restartingState(): BridgeState {
        const s = this.state;
        if (s.status === 'updating') return { ...s, phase: 'restarting' };
        const pending = this.pendingUpdate!;
        return { status: 'updating', helper: pending.helper, target: pending.target, phase: 'restarting', received: null, total: null };
    }

    /** Nobody answered (yet): try again shortly, until the deadline. */
    private awaitRestart(): void {
        const pending = this.pendingUpdate!;
        pending.deadline ??= Date.now() + UPDATE_RESTART_DEADLINE_MS;
        this.clearRetry();
        if (Date.now() >= pending.deadline) {
            pending.expired = true;
            pending.release();
            this.fail(this.updateLost(pending), true);
            return;
        }
        this.setState(this.restartingState());
        this.retryTimer = window.setTimeout(() => { this.retryTimer = 0; void this.connect(); }, UPDATE_REPROBE_MS);
    }

    /** Only a confirmed target may be named as installed (SetupGuide's wording). */
    private updateLost(pending: PendingUpdate): BridgeProblem {
        return { kind: 'update-lost', from: pending.from, target: pending.confirmed ? pending.target : null };
    }

    /** What the helper that answered says about the update that preceded it. */
    private updateOutcome(pending: PendingUpdate, version: string): UpdateStatus {
        if (version === pending.target || compareVersions(version, pending.from) > 0) {
            return { kind: 'updated', from: pending.from };
        }
        return {
            kind: 'failed',
            latest: pending.target,
            message: pending.target
                ? `${HELPER_NAME} restarted on ${version}, not ${pending.target}.`
                : `${HELPER_NAME} restarted on ${version}; the update didn't install.`,
        };
    }

    private endUpdate(): void {
        const pending = this.pendingUpdate;
        this.pendingUpdate = null;
        pending?.release();
    }

    /* ── talking ───────────────────────────────────────────────── */

    /** One request, one response. Rejects with a BridgeError. */
    request<N extends RequestName>(
        type: N,
        params: RequestParams<N>,
        timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
    ): Promise<RequestResult<N>> {
        const socket = this.socket;
        if (!socket || socket.readyState !== WebSocket.OPEN) {
            return Promise.reject(new BridgeError('disconnected', 'Not connected to VaultAgent.'));
        }
        const reqId = crypto.randomUUID();
        const frame = JSON.stringify({ ...params, type, reqId });
        // Counted in UTF-16 units — an over-estimate for ASCII-heavy base64,
        // never an under-estimate that lets the helper drop the socket.
        if (frame.length > MAX_WS_MESSAGE_BYTES) {
            return Promise.reject(new BridgeError('bad-request', 'This message is too large to send (attach fewer or smaller images).'));
        }
        return new Promise<RequestResult<N>>((resolve, reject) => {
            const timer = window.setTimeout(() => {
                this.pending.delete(reqId);
                reject(new BridgeError('timeout', 'VaultAgent did not answer in time.'));
            }, timeoutMs);
            this.pending.set(reqId, { resolve: resolve as (value: unknown) => void, reject, timer });
            socket.send(frame);
        });
    }

    /** A message that expects no response (tool.result). False when not sent. */
    send(message: ClientMessage): boolean {
        const socket = this.socket;
        if (!socket || socket.readyState !== WebSocket.OPEN) return false;
        socket.send(JSON.stringify(message));
        return true;
    }
}

/** The page's one bridge. */
export const agentBridge = new AgentBridge();

// Dev only: a hot update re-runs this module; the old bridge's socket would
// otherwise stay open beside the new one's, both receiving the same events.
import.meta.hot?.dispose(() => agentBridge.disconnect());
