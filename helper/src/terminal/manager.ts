import { SerializeAddon } from '@xterm/addon-serialize';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { Terminal } from '@xterm/headless';
import {
    isUuid, MAX_TERMINALS, TERMINAL_ACK_HIGH, TERMINAL_ACK_LOW, TERMINAL_DETACHED_TTL_MS, TERMINAL_INPUT_MAX_CHARS,
    TERMINAL_MAX_COLS, TERMINAL_MAX_ROWS, TERMINAL_SCROLLBACK,
    type HelperMessage, type TerminalBackend, type TerminalExit,
} from '../../../shared/vaultAgentProtocol.ts';
import { BadRequest } from '../paths.ts';
import { terminalLaunch, type TerminalLaunch } from './shell.ts';
import type { PtyBackend, PtyProcess } from './types.ts';

export interface TerminalOwner {
    send(msg: HelperMessage): boolean | void;
}

export interface Timers {
    set(fn: () => void, ms: number): unknown;
    clear(handle: unknown): void;
}

const realTimers: Timers = {
    set(fn, ms) {
        const t = setTimeout(fn, ms);
        t.unref?.();
        return t;
    },
    clear: h => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export class TerminalLimit extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'TerminalLimit';
    }
}

export class TerminalNotFound extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'TerminalNotFound';
    }
}

const COALESCE_MS = 5;
const COALESCE_CHARS = 65_536;
const RESYNC_RETRY_MS = 250;
const CLOSE_ALL_WAIT_MS = 3000;
const TOTAL_FACTOR = 3;

interface Session {
    readonly id: string;
    readonly headless: Terminal;
    readonly serialize: SerializeAddon;
    readonly decoder: TextDecoder;
    pty: PtyProcess | null;
    shell: string;
    backend: TerminalBackend;
    owner: TerminalOwner | null;
    attaching: TerminalOwner | null;
    pending: string;
    unacked: number;
    behind: boolean;
    holding: boolean;
    epoch: number;
    exited: TerminalExit | null;
    exitSent: boolean;
    disposed: boolean;
    flushTimer: unknown;
    detachTimer: unknown;
    retryTimer: unknown;
    ended: Promise<void>;
    markEnded: () => void;
}

export interface TerminalManagerDeps {
    backend: PtyBackend;
    launch?: () => Promise<TerminalLaunch>;
    timers?: Timers;
    maxTerminals?: number;
}

function clamp(n: unknown, min: number, max: number, what: string): number {
    if (typeof n !== 'number' || !Number.isFinite(n)) throw new BadRequest(`${what} must be a number`);
    return Math.min(max, Math.max(min, Math.floor(n)));
}

function size(cols: unknown, rows: unknown): { cols: number; rows: number } {
    return { cols: clamp(cols, 2, TERMINAL_MAX_COLS, 'cols'), rows: clamp(rows, 1, TERMINAL_MAX_ROWS, 'rows') };
}

export class TerminalManager {
    readonly backend: PtyBackend;
    private readonly sessions = new Map<string, Session>();
    private readonly launch: () => Promise<TerminalLaunch>;
    private readonly timers: Timers;
    private readonly maxTerminals: number;

    constructor(deps: TerminalManagerDeps) {
        this.backend = deps.backend;
        this.launch = deps.launch ?? terminalLaunch;
        this.timers = deps.timers ?? realTimers;
        this.maxTerminals = deps.maxTerminals ?? MAX_TERMINALS;
    }

    count(): number {
        return this.sessions.size;
    }

    async open(owner: TerminalOwner, termId: unknown, cols: unknown, rows: unknown, cwd?: string): Promise<{ shell: string; pid: number; backend: TerminalBackend; cwd: string }> {
        if (!isUuid(termId)) throw new BadRequest('invalid termId');
        const dims = size(cols, rows);
        if (this.sessions.has(termId)) throw new BadRequest('that terminal already exists');
        let owned = 0;
        for (const s of this.sessions.values()) if (s.owner === owner) owned++;
        if (owned >= this.maxTerminals) throw new TerminalLimit(`At most ${this.maxTerminals} terminals can be open at once.`);
        if (this.sessions.size >= this.maxTerminals * TOTAL_FACTOR) throw new TerminalLimit('Too many terminals are open (some may be detached from closed windows).');

        const session = this.create(termId, owner, dims.cols, dims.rows);
        this.sessions.set(termId, session);
        try {
            const base = await this.launch();
            const launch = cwd ? { ...base, cwd } : base;
            session.shell = launch.file;
            const pty = await this.backend.spawn({ ...launch, cols: dims.cols, rows: dims.rows }, {
                onData: bytes => this.onData(session, bytes),
                onExit: exit => this.onExit(session, exit),
            });
            session.pty = pty;
            session.backend = this.backend.kind;
            if (session.disposed || session.exited) pty.kill();
            return { shell: session.shell, pid: pty.pid, backend: session.backend, cwd: launch.cwd };
        } catch (e) {
            this.dispose(session);
            throw e;
        }
    }

    async attach(owner: TerminalOwner, termId: unknown, cols: unknown, rows: unknown): Promise<{ snapshot: string; shell: string; exited: TerminalExit | null }> {
        if (!isUuid(termId)) throw new BadRequest('invalid termId');
        const dims = size(cols, rows);
        const s = this.sessions.get(termId);
        if (!s || s.disposed) throw new TerminalNotFound('no such terminal');
        const previous = s.owner;
        if (previous && previous !== owner) previous.send({ type: 'terminal.detached', termId });
        this.release(s);
        s.attaching = owner;
        const epoch = s.epoch;
        s.holding = true;
        this.resizeSession(s, dims.cols, dims.rows);
        const snapshot = await this.snapshot(s);
        if (s.epoch !== epoch || s.disposed) throw new TerminalNotFound('the terminal was taken over');
        s.attaching = null;
        s.owner = owner;
        s.epoch++;
        s.holding = false;
        s.exitSent = s.exited !== null;
        this.scheduleFlush(s);
        return { snapshot, shell: s.shell, exited: s.exited };
    }

    input(owner: TerminalOwner, termId: unknown, data: unknown): void {
        if (typeof termId !== 'string' || typeof data !== 'string' || data.length > TERMINAL_INPUT_MAX_CHARS) return;
        const s = this.sessions.get(termId);
        if (!s || s.owner !== owner || s.exited || !s.pty) return;
        s.pty.write(data);
    }

    resize(owner: TerminalOwner, termId: unknown, cols: unknown, rows: unknown): void {
        if (!isUuid(termId)) throw new BadRequest('invalid termId');
        const dims = size(cols, rows);
        const s = this.sessions.get(termId);
        if (!s || s.owner !== owner) throw new TerminalNotFound('no such terminal');
        this.resizeSession(s, dims.cols, dims.rows);
    }

    ack(owner: TerminalOwner, termId: unknown, chars: unknown): void {
        if (typeof termId !== 'string' || typeof chars !== 'number' || !Number.isFinite(chars) || chars <= 0) return;
        const s = this.sessions.get(termId);
        if (!s || s.owner !== owner) return;
        s.unacked = Math.max(0, s.unacked - chars);
        if (s.behind && !s.holding && s.unacked < TERMINAL_ACK_LOW) void this.resync(s);
    }

    close(owner: TerminalOwner, termId: unknown): void {
        if (typeof termId !== 'string') return;
        const s = this.sessions.get(termId);
        if (!s) return;
        if (s.owner && s.owner !== owner) throw new TerminalNotFound('no such terminal');
        this.dispose(s);
    }

    detachAll(owner: TerminalOwner): void {
        for (const s of this.sessions.values()) {
            if (s.owner !== owner && s.attaching !== owner) continue;
            this.release(s);
            s.detachTimer = this.timers.set(() => this.dispose(s), TERMINAL_DETACHED_TTL_MS);
        }
    }

    async closeAll(): Promise<void> {
        const all = [...this.sessions.values()];
        for (const s of all) this.dispose(s);
        let timer: unknown;
        const limit = new Promise<void>(resolve => (timer = this.timers.set(resolve, CLOSE_ALL_WAIT_MS)));
        await Promise.race([Promise.all(all.map(s => s.ended)), limit]);
        this.timers.clear(timer);
    }

    private create(id: string, owner: TerminalOwner, cols: number, rows: number): Session {
        const headless = new Terminal({ cols, rows, scrollback: TERMINAL_SCROLLBACK, allowProposedApi: true });
        headless.loadAddon(new Unicode11Addon());
        headless.unicode.activeVersion = '11';
        const serialize = new SerializeAddon();
        headless.loadAddon(serialize);
        let markEnded!: () => void;
        const ended = new Promise<void>(resolve => (markEnded = resolve));
        return {
            id, headless, serialize, decoder: new TextDecoder(), pty: null, shell: '', backend: this.backend.kind, owner, attaching: null,
            pending: '', unacked: 0, behind: false, holding: false, epoch: 0, exited: null, exitSent: false, disposed: false,
            flushTimer: null, detachTimer: null, retryTimer: null, ended, markEnded,
        };
    }

    private resizeSession(s: Session, cols: number, rows: number): void {
        if (s.headless.cols !== cols || s.headless.rows !== rows) s.headless.resize(cols, rows);
        if (!s.exited) s.pty?.resize(cols, rows);
    }

    private release(s: Session): void {
        if (s.detachTimer !== null) this.timers.clear(s.detachTimer);
        if (s.flushTimer !== null) this.timers.clear(s.flushTimer);
        if (s.retryTimer !== null) this.timers.clear(s.retryTimer);
        s.detachTimer = null;
        s.flushTimer = null;
        s.retryTimer = null;
        s.owner = null;
        s.attaching = null;
        s.epoch++;
        s.pending = '';
        s.unacked = 0;
        s.behind = false;
        s.holding = false;
    }

    private snapshot(s: Session): Promise<string> {
        return new Promise<string>(resolve => {
            s.headless.write('', () => resolve(s.serialize.serialize({ scrollback: TERMINAL_SCROLLBACK })));
        });
    }

    private onData(s: Session, bytes: Uint8Array): void {
        if (s.disposed) return;
        const text = s.decoder.decode(bytes, { stream: true });
        if (!text) return;
        s.headless.write(text);
        if (!s.holding && (!s.owner || s.behind)) return;
        s.pending += text;
        if (s.holding) return;
        if (s.pending.length >= COALESCE_CHARS) this.flush(s);
        else this.scheduleFlush(s);
    }

    private scheduleFlush(s: Session): void {
        if (s.flushTimer !== null) return;
        s.flushTimer = this.timers.set(() => {
            s.flushTimer = null;
            this.flush(s);
        }, COALESCE_MS);
    }

    private flush(s: Session): void {
        if (s.flushTimer !== null) {
            this.timers.clear(s.flushTimer);
            s.flushTimer = null;
        }
        if (!s.owner || s.holding || s.behind || s.disposed) return;
        if (s.pending) {
            const data = s.pending;
            s.pending = '';
            if (s.owner.send({ type: 'terminal.output', termId: s.id, data }) === false) {
                this.dropped(s);
                return;
            }
            s.unacked += data.length;
            if (s.unacked > TERMINAL_ACK_HIGH) s.behind = true;
        }
        this.sendExit(s);
    }

    private dropped(s: Session): void {
        s.behind = true;
        s.pending = '';
        if (s.retryTimer !== null || s.disposed) return;
        s.retryTimer = this.timers.set(() => {
            s.retryTimer = null;
            if (s.disposed || !s.owner || !s.behind || s.holding) return;
            if (s.unacked < TERMINAL_ACK_LOW) void this.resync(s);
        }, RESYNC_RETRY_MS);
    }

    private async resync(s: Session): Promise<void> {
        const epoch = s.epoch;
        s.holding = true;
        s.pending = '';
        const snapshot = await this.snapshot(s);
        if (s.epoch !== epoch || s.disposed) return;
        if (s.owner?.send({ type: 'terminal.output', termId: s.id, data: snapshot, reset: true }) === false) {
            s.holding = false;
            this.dropped(s);
            return;
        }
        s.unacked = snapshot.length;
        s.behind = false;
        s.holding = false;
        this.flush(s);
    }

    private onExit(s: Session, exit: TerminalExit): void {
        s.markEnded();
        if (s.disposed) return;
        s.exited = exit;
        s.pty?.kill();
        this.flush(s);
    }

    private sendExit(s: Session): void {
        if (!s.exited || s.exitSent || !s.owner || s.behind || s.holding) return;
        s.exitSent = true;
        if (s.owner.send({ type: 'terminal.exit', termId: s.id, code: s.exited.code, signal: s.exited.signal }) === false) {
            s.exitSent = false;
            this.dropped(s);
        }
    }

    private dispose(s: Session): void {
        if (s.disposed) return;
        s.disposed = true;
        if (s.detachTimer !== null) this.timers.clear(s.detachTimer);
        if (s.flushTimer !== null) this.timers.clear(s.flushTimer);
        if (s.retryTimer !== null) this.timers.clear(s.retryTimer);
        s.detachTimer = s.flushTimer = s.retryTimer = null;
        this.sessions.delete(s.id);
        if (s.pty && !s.exited) s.pty.kill();
        else s.markEnded();
        try {
            s.headless.dispose();
        } catch { /* already gone */ }
    }
}
