// THE RULE THIS FILE EXISTS TO KEEP: no request reaches 127.0.0.1 before the
// user has clicked Connect. Chrome (142+) raises its Local Network Access
// prompt on a public site's FIRST request to loopback, so a request made on
// load would ask the user a question out of nowhere. After one successful
// connection we remember it (CONNECTED_ONCE_KEY); a later load dials by itself
// only if Chrome also reports the permission as already granted — anything
// less and we wait for the click again.

import {
    HELPER_APP_ID, HELPER_HOST, HELPER_PORTS, HELPER_NAME, MAX_WS_MESSAGE_BYTES, MIN_HELPER_VERSION, PROTOCOL_VERSION,
    SELF_UPDATE_VERSION, TERMINAL_VERSION, compareVersions,
} from '../../shared/vaultAgentProtocol';
import type {
    ClientMessage, ErrorCode, HealthResponse, HelperMessage, HelperPlatform, RequestName, RequestParams, RequestResult,
    UpdateCheck, UpdatePhase,
} from '../../shared/vaultAgentProtocol';
import { CONNECTED_ONCE_KEY, getAgentUpdateNotice, setAgentUpdateNotice } from './agentUpdateNotice';
import type { AgentUpdateNotice } from './agentUpdateNotice';
import { removeStoredValue, writeStoredValue } from './storage';

const HEALTH_TIMEOUT_MS = 30_000;
const HELLO_TIMEOUT_MS = 5000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30_000;
const RELEASE_GRACE_MS = 5000;
const UPDATE_REQUEST_TIMEOUT_MS = 15 * 60_000;
const UPDATE_RESTART_DEADLINE_MS = 90_000;
const UPDATE_REPROBE_MS = 1000;
const BACKGROUND_CHECK_MS = 30_000;

export interface HelperInfo {
    port: number;
    version: string;
    platform: HelperPlatform;
    sessionsDir: string;
    outdated: boolean;
    selfUpdate: boolean;
    terminal: boolean;
}

export type UpdateStatus =
    | { kind: 'unsupported' }
    | { kind: 'checking' }
    | { kind: 'unknown'; message: string }
    | { kind: 'current'; latest: string }
    | { kind: 'available'; latest: string }
    | { kind: 'failed'; latest: string | null; message: string }
    | { kind: 'updated'; from: string };

export type BridgeProblem =
    | { kind: 'not-found' }
    | { kind: 'foreign'; port: number }
    | { kind: 'permission-denied' }
    | { kind: 'outdated'; version: string }
    | { kind: 'page-outdated'; protocol: number }
    | { kind: 'lost' }
    | { kind: 'update-lost'; from: string; target: string | null };

export type BridgeState =
    | { status: 'idle' }
    | { status: 'checking' }
    | { status: 'connecting' }
    | { status: 'connected'; helper: HelperInfo; update: UpdateStatus }
    | {
        status: 'updating'; helper: HelperInfo; target: string | null;
        phase: UpdatePhase; received: number | null; total: number | null;
    }
    | { status: 'failed'; problem: BridgeProblem; retryAt: number | null }
    | { status: 'uninstalled' };

export class BridgeError extends Error {
    readonly code: ErrorCode | 'disconnected' | 'timeout';
    constructor(code: BridgeError['code'], message: string) {
        super(message);
        this.code = code;
    }
}

export type HelperEvent = Exclude<HelperMessage, { type: 'response' } | { type: 'update.progress' }>;

export type TerminalEvent = Extract<HelperEvent, { type: `terminal.${string}` }>;

export function isTerminalEvent(event: HelperEvent): event is TerminalEvent {
    return event.type.startsWith('terminal.');
}

export function helperReady(state: BridgeState): state is Extract<BridgeState, { status: 'connected' }> {
    return state.status === 'connected' && !state.helper.outdated;
}

interface PendingUpdate {
    from: string;
    target: string | null;
    helper: HelperInfo;
    confirmed: boolean;
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

export function hasConnectedBefore(): boolean {
    return readFlag();
}

function writeFlag(on: boolean): void {
    if (on) writeStoredValue(CONNECTED_ONCE_KEY, '1');
    else removeStoredValue(CONNECTED_ONCE_KEY);
}

export async function loopbackPermission(): Promise<PermissionStatus | null> {
    const names = ['loopback-network', 'local-network-access', 'local-network'];
    for (const name of names) {
        try {
            return await navigator.permissions.query({ name: name as PermissionName });
        } catch { /* unknown name here — try the next */ }
    }
    return null;
}

function sentence(text: string): string {
    const t = text.trim();
    return /[.!?]$/.test(t) ? t : `${t}.`;
}

function noticeFor(state: BridgeState, previous: AgentUpdateNotice): AgentUpdateNotice {
    switch (state.status) {
        case 'connected': {
            if (state.helper.outdated) return { kind: 'outdated', version: state.helper.version };
            const u = state.update;
            if (u.kind === 'available') return { kind: 'available', version: u.latest };
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
    private generation = 0;
    private retainers = 0;
    private releaseTimer = 0;
    private retryTimer = 0;
    private retryDelay = RETRY_MIN_MS;
    private connectedThisSession = false;
    private permissionWatch: PermissionStatus | null = null;
    private pendingUpdate: PendingUpdate | null = null;
    private lastCheck: UpdateStatus = { kind: 'unsupported' };
    private checkInFlight: { helper: HelperInfo; promise: Promise<void> } | null = null;
    private unseenOutcome: { version: string; update: UpdateStatus } | null = null;
    private backgroundCheck: Promise<void> | null = null;

    getState = (): BridgeState => this.state;

    subscribeState = (listener: () => void): (() => void) => {
        this.stateListeners.add(listener);
        return () => { this.stateListeners.delete(listener); };
    };

    subscribe(listener: (event: HelperEvent) => void): () => void {
        this.eventListeners.add(listener);
        return () => { this.eventListeners.delete(listener); };
    }

    private setState(next: BridgeState): void {
        this.state = next;
        setAgentUpdateNotice(noticeFor(next, getAgentUpdateNotice()));
        for (const listener of this.stateListeners) listener();
    }

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

    async autoConnect(): Promise<void> {
        const s = this.state.status;
        if (s === 'connected' || s === 'connecting' || s === 'checking' || s === 'updating') return;
        if (s === 'failed' && this.retryTimer) return;
        if (this.connectedThisSession && s !== 'uninstalled') { void this.connect(); return; }
        if (s !== 'idle' || !readFlag()) return;
        this.setState({ status: 'checking' });
        const permission = pageIsLoopback() ? null : await loopbackPermission();
        if (this.getState().status !== 'checking') return;
        if (pageIsLoopback() || permission?.state === 'granted') void this.connect();
        else this.setState({ status: 'idle' });
    }

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

    private until(done: (state: BridgeState) => boolean, timeoutMs: number): Promise<void> {
        if (done(this.state)) return Promise.resolve();
        return new Promise(resolve => {
            const finish = () => { clearTimeout(timer); off(); resolve(); };
            const timer = window.setTimeout(finish, timeoutMs);
            const off = this.subscribeState(() => { if (done(this.state)) finish(); });
        });
    }

    async connect(): Promise<void> {
        this.clearRetry();
        this.closeSocket();
        const gen = ++this.generation;
        const lost = this.pendingUpdate?.expired ? this.pendingUpdate : null;
        if (this.awaitingRestart()) this.setState(this.restartingState());
        else if (!lost) this.setState({ status: 'connecting' });

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
            const permission = pageIsLoopback() ? null : await loopbackPermission();
            if (gen !== this.generation) return;
            if (permission?.state === 'denied') {
                this.watchPermission(permission);
                this.fail({ kind: 'permission-denied' }, false);
                return;
            }
            this.fail({ kind: 'not-found' }, permission?.state !== 'prompt');
            return;
        }
        const { health, port } = ours;
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
                    terminal: compareVersions(result.version, TERMINAL_VERSION) >= 0,
                };
                this.lastCheck = helper.selfUpdate ? { kind: 'checking' } : { kind: 'unsupported' };
                if (this.pendingUpdate) {
                    this.unseenOutcome = { version: helper.version, update: this.updateOutcome(this.pendingUpdate, helper.version) };
                }
                const update = this.unseenOutcome?.version === helper.version ? this.unseenOutcome.update : this.lastCheck;
                this.endUpdate();
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
            if (this.awaitingRestart()) { this.awaitRestart(); return; }
            this.fail(opened ? { kind: 'lost' } : { kind: 'foreign', port }, opened);
        };
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

    disconnect(): void {
        this.generation++;
        this.endUpdate();
        this.clearRetry();
        this.closeSocket();
        if (this.state.status !== 'uninstalled') this.setState({ status: 'idle' });
    }

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

    checkForUpdate(force: boolean): Promise<void> {
        const s = this.state;
        if (s.status !== 'connected' || !s.helper.selfUpdate) return Promise.resolve();
        const helper = s.helper;
        if (this.checkInFlight?.helper === helper && !force) return this.checkInFlight.promise;
        const check = this.request('helper.checkUpdate', { force }).then(
            result => this.checkStatus(result),
            (e: unknown): UpdateStatus => e instanceof BridgeError && e.code === 'unsupported'
                ? { kind: 'unsupported' }
                : { kind: 'unknown', message: e instanceof Error ? e.message : String(e) },
        ).then(status => {
            const now = this.state;
            if (now.status !== 'connected' || now.helper !== helper) return;
            this.lastCheck = status;
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
            window.setTimeout(() => {
                if (this.pendingUpdate !== pending || pending.expired || !this.socket) return;
                this.closeSocket();
                this.awaitRestart();
            }, UPDATE_RESTART_DEADLINE_MS);
        } catch (e) {
            if (this.pendingUpdate !== pending) return;
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

    dismissUpdateNotice(): void {
        const s = this.state;
        if (s.status !== 'connected' || (s.update.kind !== 'updated' && s.update.kind !== 'failed')) return;
        this.unseenOutcome = null;
        this.setState({ ...s, update: this.lastCheck });
    }

    private awaitingRestart(): boolean {
        return !!this.pendingUpdate && !this.pendingUpdate.expired;
    }

    private restartingState(): BridgeState {
        const s = this.state;
        if (s.status === 'updating') return { ...s, phase: 'restarting' };
        const pending = this.pendingUpdate!;
        return { status: 'updating', helper: pending.helper, target: pending.target, phase: 'restarting', received: null, total: null };
    }

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

    private updateLost(pending: PendingUpdate): BridgeProblem {
        return { kind: 'update-lost', from: pending.from, target: pending.confirmed ? pending.target : null };
    }

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

    send(message: ClientMessage): boolean {
        const socket = this.socket;
        if (!socket || socket.readyState !== WebSocket.OPEN) return false;
        socket.send(JSON.stringify(message));
        return true;
    }
}

export const agentBridge = new AgentBridge();

import.meta.hot?.dispose(() => agentBridge.disconnect());
