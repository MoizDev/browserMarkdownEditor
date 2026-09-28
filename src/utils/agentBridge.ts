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
    HELPER_APP_ID, HELPER_HOST, HELPER_PORTS, MAX_WS_MESSAGE_BYTES, MIN_HELPER_VERSION, PROTOCOL_VERSION,
    compareVersions,
} from '../../shared/vaultAgentProtocol';
import type {
    ClientMessage, ErrorCode, HealthResponse, HelperMessage, HelperPlatform, RequestName, RequestParams, RequestResult,
} from '../../shared/vaultAgentProtocol';

/** Set after the first successful connection; gates the auto-dial on load. */
const CONNECTED_ONCE_KEY = 'vaultAgentConnectedOnce';

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

export interface HelperInfo {
    port: number;
    version: string;
    platform: HelperPlatform;
    sessionsDir: string;
}

/** Why there is no connection — each gets its own screen in the panel. */
export type BridgeProblem =
    /** Nothing answers on any VaultAgent port: not installed, or not running. */
    | { kind: 'not-found' }
    /** Something answers on a port but is not a VaultAgent that talks to this
     *  page: another program, or a helper whose allowlist lacks this origin. */
    | { kind: 'foreign'; port: number }
    /** Chrome's Local Network Access permission is blocked for this site. */
    | { kind: 'permission-denied' }
    /** The helper is older than this editor needs. */
    | { kind: 'outdated'; version: string }
    /** The helper speaks a newer protocol than this page: the PAGE is stale. */
    | { kind: 'page-outdated'; protocol: number }
    /** A connection existed and dropped (helper quit, crashed, or was killed). */
    | { kind: 'lost' };

export type BridgeState =
    /** Waiting for the user's Connect click (or never asked). */
    | { status: 'idle' }
    /** Deciding, on load, whether it may dial without a click. */
    | { status: 'checking' }
    | { status: 'connecting' }
    | { status: 'connected'; helper: HelperInfo }
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

/** Everything the helper sends that is not a response. */
export type HelperEvent = Exclude<HelperMessage, { type: 'response' }>;

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
        if (s === 'connected' || s === 'connecting' || s === 'checking') return;
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

    /** The Connect / Retry / Reconnect button: dial now. */
    async connect(): Promise<void> {
        this.clearRetry();
        this.closeSocket();
        const gen = ++this.generation;
        this.setState({ status: 'connecting' });

        // The first port alone first: it is where the helper almost always is,
        // and each silent port costs a refused connection (and a red console
        // line, twice — the CORS try and the no-cors one).
        const first = await probePort(HELPER_PORTS[0]);
        const probes = first.kind === 'ours'
            ? [first]
            : [first, ...await Promise.all(HELPER_PORTS.slice(1).map(probePort))];
        if (gen !== this.generation) return;
        const ours = probes.find((p): p is Extract<Probe, { kind: 'ours' }> => p.kind === 'ours');
        if (!ours) {
            const foreign = probes.find((p): p is Extract<Probe, { kind: 'foreign' }> => p.kind === 'foreign');
            if (foreign) { this.fail({ kind: 'foreign', port: foreign.port }, false); return; }
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
        if (compareVersions(health.version, MIN_HELPER_VERSION) < 0 || health.protocol < PROTOCOL_VERSION) {
            this.fail({ kind: 'outdated', version: health.version }, false);
            return;
        }
        if (health.protocol > PROTOCOL_VERSION) {
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
            this.fail({ kind: 'not-found' }, true);
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
                    this.fail(result.protocol > PROTOCOL_VERSION
                        ? { kind: 'page-outdated', protocol: result.protocol }
                        : { kind: 'outdated', version: result.version }, false);
                    return;
                }
                this.connectedThisSession = true;
                this.retryDelay = RETRY_MIN_MS;
                writeFlag(true);
                // A redial that landed after everyone let go (the panel closed
                // mid-backoff) must not hold a socket open for nobody.
                if (this.retainers === 0) this.scheduleRelease();
                this.setState({
                    status: 'connected',
                    helper: { port, version: result.version, platform: result.platform, sessionsDir: result.sessionsDir },
                });
            }, () => {
                if (gen !== this.generation) return;
                this.closeSocket();
                this.fail({ kind: 'lost' }, true);
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
        this.clearRetry();
        this.closeSocket();
        if (this.state.status !== 'uninstalled') this.setState({ status: 'idle' });
    }

    /** The helper has just removed itself (helper.uninstall). Forget that we
     *  ever connected, so the next load starts from the guide. */
    markUninstalled(): void {
        this.generation++;
        this.clearRetry();
        this.closeSocket();
        this.connectedThisSession = false;
        writeFlag(false);
        this.setState({ status: 'uninstalled' });
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
