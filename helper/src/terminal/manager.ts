// The terminal sessions: the user's shells, owned by the HELPER, not by a socket.
//
//   • A socket close DETACHES a session: the shell keeps running and the page can
//     re-attach (reload, a dropped socket after sleep) until TERMINAL_DETACHED_TTL_MS.
//     Attaching from another connection STEALS it (the old one gets `terminal.detached`).
//   • Every session feeds a headless xterm (VS Code's pty-host design). A re-attach
//     sends one serialized snapshot — screen, scrollback, modes — so vim and htop
//     come back intact; a raw byte ring replayed from mid-stream corrupts them.
//   • Flow control without `pause()` (a PTY read cannot be paused): output is
//     coalesced (5 ms / 64 KiB) and counted until the panel acknowledges it
//     (`terminal.ack`, from xterm's write callback). Above HIGH the helper stops
//     streaming and lets the mirror absorb the flood; once acks bring it under LOW,
//     one `reset` snapshot resynchronizes the panel. Helper memory stays bounded by
//     the mirror's scrollback, and keystrokes (Ctrl-C) are never queued behind output.
//   • Output is decoded per session with a streaming TextDecoder, so a UTF-8
//     sequence split across two PTY reads is never mangled.
//
// Terminal bytes are never logged. The manager knows nothing of agent runs.

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

/** One panel connection, as far as the manager is concerned. Compared by identity. */
export interface TerminalOwner {
    /** `false`: the frame was DROPPED, not queued (the socket is past its backpressure
     *  limit). Anything else counts as delivered. */
    send(msg: HelperMessage): boolean | void;
}

export interface Timers {
    set(fn: () => void, ms: number): unknown;
    clear(handle: unknown): void;
}

const realTimers: Timers = {
    set(fn, ms) {
        const t = setTimeout(fn, ms);
        // The server keeps the process alive; a pending flush or TTL must not.
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

/** One frame carries at most this much, or what has gathered for this long. */
const COALESCE_MS = 5;
const COALESCE_CHARS = 65_536;
/** After a frame was dropped, how soon to try the resynchronizing snapshot again. */
const RESYNC_RETRY_MS = 250;
/** closeAll waits this long for the shells to report their end. */
const CLOSE_ALL_WAIT_MS = 3000;
/** Detached shells outlive their connection, so unbounded reconnect loops could
 *  pile them up past the per-connection cap: this bounds them all. */
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
    /** A connection whose attach is awaiting its snapshot: not the owner yet, but
     *  its socket closing must still leave the session detached (with a TTL). */
    attaching: TerminalOwner | null;
    /** Output not yet sent: coalescing, or held back while a snapshot is taken. */
    pending: string;
    /** Characters sent in `terminal.output` that the panel has not acknowledged. */
    unacked: number;
    /** Streaming is paused (over HIGH); the mirror alone absorbs output. */
    behind: boolean;
    /** A snapshot is being taken: everything after its marker must follow it, in order. */
    holding: boolean;
    /** Bumped whenever the owner changes, so a snapshot in flight can tell it went stale. */
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
    /** The shell and environment of a new terminal (real machine by default). */
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

    /**
     * `cwd` is where the shell starts: the folder of the file the user is
     * looking at, already resolved to a real directory by the caller
     * (helper/src/vaultPath.ts). Undefined keeps the old behaviour, the home
     * directory, which is also what a vault the helper cannot find falls back to.
     */
    async open(owner: TerminalOwner, termId: unknown, cols: unknown, rows: unknown, cwd?: string): Promise<{ shell: string; pid: number; backend: TerminalBackend; cwd: string }> {
        if (!isUuid(termId)) throw new BadRequest('invalid termId');
        const dims = size(cols, rows);
        if (this.sessions.has(termId)) throw new BadRequest('that terminal already exists');
        let owned = 0;
        for (const s of this.sessions.values()) if (s.owner === owner) owned++;
        if (owned >= this.maxTerminals) throw new TerminalLimit(`At most ${this.maxTerminals} terminals can be open at once.`);
        if (this.sessions.size >= this.maxTerminals * TOTAL_FACTOR) throw new TerminalLimit('Too many terminals are open (some may be detached from closed windows).');

        const session = this.create(termId, owner, dims.cols, dims.rows);
        // Registered before the spawn resolves: a socket that closes meanwhile
        // must still detach (and so eventually reap) this session.
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
            // Closed (or exited) while the spawn was still in flight.
            if (session.disposed || session.exited) pty.kill();
            return { shell: session.shell, pid: pty.pid, backend: session.backend, cwd: launch.cwd };
        } catch (e) {
            this.dispose(session);
            throw e;
        }
    }

    /** Takes the session over: the previous owner is told, and the snapshot is what to write into a freshly reset xterm. */
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
        // A bumped epoch: taken over meanwhile, or this very connection closed
        // (detachAll released it and armed the TTL; nobody is left to own it).
        if (s.epoch !== epoch || s.disposed) throw new TerminalNotFound('the terminal was taken over');
        s.attaching = null;
        s.owner = owner;
        s.epoch++;
        s.holding = false;
        // The result already carries the end; do not announce it again.
        s.exitSent = s.exited !== null;
        // After a macrotask, not now: the caller's response (snapshot) must reach the
        // panel before the output that gathered while it was being taken.
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

    /** Ends the shell and forgets the session. Idempotent: closing what is already gone is fine. */
    close(owner: TerminalOwner, termId: unknown): void {
        if (typeof termId !== 'string') return;
        const s = this.sessions.get(termId);
        if (!s) return;
        if (s.owner && s.owner !== owner) throw new TerminalNotFound('no such terminal');
        this.dispose(s);
    }

    /** The owner's socket closed: its shells keep running, detached, until the TTL. */
    detachAll(owner: TerminalOwner): void {
        for (const s of this.sessions.values()) {
            if (s.owner !== owner && s.attaching !== owner) continue;
            this.release(s);
            s.detachTimer = this.timers.set(() => this.dispose(s), TERMINAL_DETACHED_TTL_MS);
        }
    }

    /** Helper shutdown: hang up every shell and give them a moment to report it. */
    async closeAll(): Promise<void> {
        const all = [...this.sessions.values()];
        for (const s of all) this.dispose(s);
        let timer: unknown;
        const limit = new Promise<void>(resolve => (timer = this.timers.set(resolve, CLOSE_ALL_WAIT_MS)));
        await Promise.race([Promise.all(all.map(s => s.ended)), limit]);
        this.timers.clear(timer);
    }

    /* ───────────── internals ───────────── */

    private create(id: string, owner: TerminalOwner, cols: number, rows: number): Session {
        const headless = new Terminal({ cols, rows, scrollback: TERMINAL_SCROLLBACK, allowProposedApi: true });
        // The panel draws with unicode 11 widths (emoji, CJK); the mirror must lay
        // the same characters out the same way or a snapshot shifts them.
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

    /** No owner any more (detach or a takeover in progress): nothing is streamed, and flow control starts over. */
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

    /**
     * The serialized screen + scrollback exactly as of now: once the mirror's parser has
     * caught up with everything written so far — and serialized INSIDE the write callback.
     * Measured: the parser works through its queue in time slices and a promise
     * continuation only runs after the slice, so output queued after the marker had
     * already been parsed by then and showed up twice (in the snapshot and after it).
     */
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
        // Not streaming (detached, or behind): the mirror has it, and a snapshot will carry it.
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

    /**
     * A frame never left (Bun DROPS frames past the socket's backpressure limit — it
     * does not queue them). The panel's screen now has a hole, and the frame will never
     * be acknowledged, so the ack-driven resync might never come: stop streaming, and
     * resynchronize with a snapshot as soon as one can be sent.
     */
    private dropped(s: Session): void {
        s.behind = true;
        s.pending = '';
        if (s.retryTimer !== null || s.disposed) return;
        s.retryTimer = this.timers.set(() => {
            s.retryTimer = null;
            if (s.disposed || !s.owner || !s.behind || s.holding) return;
            // Acks still in flight bring it under LOW themselves (ack → resync).
            if (s.unacked < TERMINAL_ACK_LOW) void this.resync(s);
        }, RESYNC_RETRY_MS);
    }

    /** Back under LOW after a stall: one snapshot replaces everything the panel missed. */
    private async resync(s: Session): Promise<void> {
        const epoch = s.epoch;
        s.holding = true;
        s.pending = '';
        const snapshot = await this.snapshot(s);
        if (s.epoch !== epoch || s.disposed) return; // detached or taken over meanwhile: that path reset the flags
        if (s.owner?.send({ type: 'terminal.output', termId: s.id, data: snapshot, reset: true }) === false) {
            s.holding = false;
            this.dropped(s);
            return;
        }
        // The panel acknowledges a reset like any output, so it counts: but it never
        // trips HIGH by itself (only the next flush can), or one big snapshot would loop.
        s.unacked = snapshot.length;
        s.behind = false;
        s.holding = false;
        this.flush(s);
    }

    private onExit(s: Session, exit: TerminalExit): void {
        s.markEnded();
        if (s.disposed) return;
        s.exited = exit;
        // Releases the backend's handle (it hangs up an already-dead PTY harmlessly).
        s.pty?.kill();
        this.flush(s);
    }

    /** The end is announced after the last output, and only to an owner that is caught up. */
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
        // A running shell reports its end through onExit; anything else is over already
        // (or, still spawning, is killed the moment its spawn resolves).
        if (s.pty && !s.exited) s.pty.kill();
        else s.markEnded();
        try {
            s.headless.dispose();
        } catch { /* already gone */ }
    }
}
