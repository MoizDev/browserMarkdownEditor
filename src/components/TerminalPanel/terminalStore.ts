import { Terminal, type IDisposable } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import {
    MAX_TERMINALS, TERMINAL_INPUT_MAX_CHARS, TERMINAL_MAX_COLS, TERMINAL_MAX_ROWS, isUuid,
    type TerminalBackend,
} from '../../../shared/vaultAgentProtocol';
import {
    agentBridge, BridgeError, isTerminalEvent, type BridgeState, type HelperInfo, type TerminalEvent,
} from '../../utils/agentBridge';
import { CLIPBOARD_READ_BLOCKED, CLIPBOARD_WRITE_BLOCKED, copyText, readClipboardText } from '../../utils/clipboard';
import { terminalStart } from '../../utils/terminalStart';
import { detectOs } from '../../utils/platform';
import { setTerminalCount } from '../../utils/terminalCount';
import { setTerminalContextActive } from '../../utils/terminalContext';
import { removeSessionValue, writeSessionValue } from '../../utils/storage';
import { currentFont, fontsReady, startFontDetection, subscribeFont } from './terminalFont';
import { deriveTheme, watchTheme } from './terminalTheme';

export type SessionStatus =
    | 'starting'
    | 'live'
    | 'exited'
    | 'ended'
    | 'detached';

export interface SessionView {
    key: string;
    title: string;
    status: SessionStatus;
    exitCode: number | null;
}

export interface TerminalState {
    sessions: SessionView[];
    activeKey: string | null;
    privacy: { backend: TerminalBackend; fullDiskAccess: boolean | null } | null;
    notice: string | null;
}

interface Session {
    key: string;
    termId: string;
    base: string | null;
    ordinal: number;
    status: SessionStatus;
    exitCode: number | null;
    mode: 'open' | 'attach';
    wasLive: boolean;
    openIfMissing: boolean;
    requested: boolean;
    reconnectNoted: boolean;
    term: Terminal;
    fit: FitAddon;
    webgl: WebglAddon | null;
    host: HTMLDivElement;
    container: HTMLElement | null;
    opened: boolean;
    opening: Promise<void> | null;
    disposed: boolean;
    pendingInput: string;
    ackChars: number;
    ackTimer: number;
    ackFrame: number;
    resizeFrame: number;
    sentCols: number;
    sentRows: number;
    disposables: IDisposable[];
}

const SESSIONS_KEY = 'terminalSessions';
const SCROLLBACK = 10_000;
const PENDING_INPUT_MAX = 65_536;
const NOTICE_MS = 6000;
const OS = detectOs();

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function clampDim(n: number, max: number): number {
    return Math.min(max, Math.max(2, Math.floor(n) || 2));
}

function baseName(shell: string): string {
    const name = shell.split(/[\\/]/).pop() ?? shell;
    return name.replace(/\.exe$/i, '') || 'terminal';
}

function isErrorCode(e: unknown, code: string): boolean {
    return e instanceof BridgeError && e.code === code;
}

function messageOf(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

function soon(fn: () => void): { frame: number; timer: number } {
    let done = false;
    const run = () => { if (done) return; done = true; fn(); };
    return { frame: requestAnimationFrame(run), timer: window.setTimeout(run, 50) };
}

interface StoredSession {
    key: string;
    termId: string;
    base: string | null;
    ordinal: number;
    cols: number;
    rows: number;
}

class TerminalStore {
    private state: TerminalState = { sessions: [], activeKey: null, privacy: null, notice: null };
    private readonly listeners = new Set<() => void>();
    private readonly sessions: Session[] = [];
    private helper: HelperInfo | null = null;
    private lastHelper: HelperInfo | null = null;
    private release: (() => void) | null = null;
    private noticeTimer = 0;
    private inited = false;
    private closedLast = false;
    private readonly offs: Array<() => void> = [];

    getState = (): TerminalState => this.state;

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    };

    init(): void {
        this.closedLast = false;
        if (this.inited) return;
        this.inited = true;
        this.offs.push(
            agentBridge.subscribeState(() => this.onBridgeState()),
            agentBridge.subscribe(event => { if (isTerminalEvent(event)) this.onEvent(event); }),
            watchTheme(theme => { for (const s of this.sessions) s.term.options.theme = theme; }),
            subscribeFont(() => this.applyFont()),
        );
        this.restore();
        this.onBridgeState();
    }

    ensureOne(): void {
        if (this.sessions.length === 0 && !this.closedLast) this.create();
    }

    create(): string | null {
        if (this.sessions.length >= MAX_TERMINALS) {
            this.notify(`At most ${MAX_TERMINALS} terminals can be open at once.`);
            return null;
        }
        const s = this.build(crypto.randomUUID(), crypto.randomUUID(), 'open', null, 0, null);
        this.sessions.push(s);
        this.state = { ...this.state, activeKey: s.key };
        this.commit();
        this.tryStart(s);
        return s.key;
    }

    select(key: string): void {
        if (this.state.activeKey === key || !this.sessions.some(s => s.key === key)) return;
        this.state = { ...this.state, activeKey: key };
        this.commit();
    }

    close(key: string, byUser = true): void {
        const i = this.sessions.findIndex(s => s.key === key);
        if (i < 0) return;
        const s = this.sessions[i];
        // A detached tab belongs to another window now: closing it here must not kill that shell.
        if (s.status !== 'detached') void agentBridge.request('terminal.close', { termId: s.termId }).catch(() => {});
        this.sessions.splice(i, 1);
        this.destroy(s);
        let active = this.state.activeKey;
        if (active === key) active = (this.sessions[Math.min(i, this.sessions.length - 1)] ?? null)?.key ?? null;
        if (this.sessions.length === 0 && byUser) this.closedLast = true;
        this.state = { ...this.state, activeKey: active };
        this.commit();
    }

    attachView(key: string, container: HTMLElement): Promise<void> {
        const s = this.sessions.find(x => x.key === key);
        if (!s) return Promise.resolve();
        for (const other of this.sessions) if (other !== s) this.setWebgl(other, false);
        s.container = container;
        if (s.host.parentElement !== container) container.appendChild(s.host);
        if (s.opened) {
            this.afterAdopt(s);
            return Promise.resolve();
        }
        return (s.opening ??= this.openTerm(s));
    }

    detachView(key: string, container: HTMLElement): void {
        const s = this.sessions.find(x => x.key === key);
        if (!s || s.container !== container) return;
        s.container = null;
        this.setWebgl(s, false);
        if (s.host.parentElement === container) container.removeChild(s.host);
    }

    focus(key: string): void {
        this.sessions.find(s => s.key === key)?.term.focus();
    }

    refit(key: string): void {
        const s = this.sessions.find(x => x.key === key);
        if (s) this.fitNow(s);
    }

    hasSelection(key: string): boolean {
        return !!this.sessions.find(s => s.key === key)?.term.hasSelection();
    }

    mouseTracking(key: string): boolean {
        const t = this.sessions.find(s => s.key === key)?.term;
        return !!t && t.modes.mouseTrackingMode !== 'none';
    }

    async copySelection(key: string): Promise<void> {
        const text = this.sessions.find(s => s.key === key)?.term.getSelection() ?? '';
        if (text && !await copyText(text)) this.notify(CLIPBOARD_WRITE_BLOCKED);
    }

    async paste(key: string): Promise<void> {
        const read = await readClipboardText();
        if (!read.ok) { this.notify(CLIPBOARD_READ_BLOCKED); return; }
        if (read.text) this.sessions.find(s => s.key === key)?.term.paste(read.text);
    }

    selectAll(key: string): void {
        this.sessions.find(s => s.key === key)?.term.selectAll();
    }

    clear(key: string): void {
        this.sessions.find(s => s.key === key)?.term.clear();
    }

    async openPrivacySettings(): Promise<void> {
        try { await agentBridge.request('helper.openPrivacySettings', {}); }
        catch (e) { this.notify(`Couldn't open System Settings: ${messageOf(e)}`); }
    }

    async revealPtyHost(): Promise<void> {
        try { await agentBridge.request('helper.revealPtyHost', {}); }
        catch (e) { this.notify(`Couldn't show it in Finder: ${messageOf(e)}`); }
    }

    dispose(): void {
        for (const off of this.offs.splice(0)) off();
        for (const s of this.sessions.splice(0)) this.destroy(s);
        this.release?.();
        this.release = null;
        this.inited = false;
        setTerminalCount(0);
    }

    private build(key: string, termId: string, mode: 'open' | 'attach', base: string | null, ordinal: number, size: { cols: number; rows: number } | null): Session {
        const font = currentFont();
        const term = new Terminal({
            allowProposedApi: true,
            cursorBlink: true,
            fontFamily: font.family,
            fontSize: font.size,
            scrollback: SCROLLBACK,
            macOptionIsMeta: false,
            rescaleOverlappingGlyphs: true,
            smoothScrollDuration: 0,
            theme: deriveTheme(),
            ...(size ? { cols: size.cols, rows: size.rows } : {}),
        });
        const fit = new FitAddon();
        term.loadAddon(fit);
        term.loadAddon(new Unicode11Addon());
        term.unicode.activeVersion = '11';
        term.loadAddon(new WebLinksAddon((event, uri) => {
            if (!(event.metaKey || event.ctrlKey)) return;
            try {
                const url = new URL(uri);
                if (url.protocol === 'http:' || url.protocol === 'https:') window.open(url.href, '_blank', 'noopener');
            } catch { /* not a URL after all */ }
        }));
        term.loadAddon(new ClipboardAddon());

        const host = document.createElement('div');
        host.className = 'terminal-host';

        const s: Session = {
            key, termId, base, ordinal, status: 'starting', exitCode: null, mode, wasLive: false,
            openIfMissing: false, requested: false, reconnectNoted: false,
            term, fit, webgl: null, host, container: null, opened: false, opening: null, disposed: false,
            pendingInput: '', ackChars: 0, ackTimer: 0, ackFrame: 0, resizeFrame: 0,
            sentCols: term.cols, sentRows: term.rows, disposables: [],
        };
        s.disposables.push(
            term.onData(data => this.onUserData(s, data)),
            term.onBinary(() => {}),
            term.onResize(() => this.queueResize(s)),
        );
        term.attachCustomKeyEventHandler(e => this.onKey(s, e));
        return s;
    }

    private destroy(s: Session): void {
        s.disposed = true;
        window.clearTimeout(s.ackTimer);
        cancelAnimationFrame(s.ackFrame);
        cancelAnimationFrame(s.resizeFrame);
        this.setWebgl(s, false);
        for (const d of s.disposables) d.dispose();
        try { s.term.dispose(); } catch { /* already gone */ }
        s.host.remove();
    }

    private async openTerm(s: Session): Promise<void> {
        await fontsReady();
        s.opening = null;
        if (s.disposed || !s.container || !s.container.isConnected) return;
        const font = currentFont();
        s.term.options.fontFamily = font.family;
        s.term.options.fontSize = font.size;
        s.term.open(s.host);
        s.opened = true;
        this.afterAdopt(s);
    }

    private afterAdopt(s: Session): void {
        this.fitNow(s);
        this.setWebgl(s, true);
        this.tryStart(s);
    }

    private fitNow(s: Session): void {
        if (!s.opened || !s.container || s.container.clientWidth === 0 || s.container.clientHeight === 0) return;
        try { s.fit.fit(); } catch { /* not laid out yet */ }
    }

    private setWebgl(s: Session, on: boolean): void {
        if (!on) {
            if (s.webgl) {
                try { s.webgl.dispose(); } catch { /* already gone */ }
                s.webgl = null;
                setTerminalContextActive(false);
            }
            return;
        }
        if (s.webgl || !s.opened || s.disposed) return;
        try {
            const gl = new WebglAddon();
            gl.onContextLoss(() => {
                try { gl.dispose(); } catch { /* already gone */ }
                if (s.webgl === gl) {
                    s.webgl = null;
                    setTerminalContextActive(false);
                }
            });
            s.term.loadAddon(gl);
            s.webgl = gl;
            setTerminalContextActive(true);
        } catch {
            s.webgl = null;
        }
    }

    private applyFont(): void {
        const font = currentFont();
        for (const s of this.sessions) {
            if (s.term.options.fontFamily !== font.family) s.term.options.fontFamily = font.family;
            if (s.term.options.fontSize !== font.size) s.term.options.fontSize = font.size;
            s.webgl?.clearTextureAtlas();
            this.fitNow(s);
        }
    }

    private onKey(s: Session, e: KeyboardEvent): boolean {
        if (e.type !== 'keydown' || e.isComposing) return true;
        const key = e.key;
        if (OS === 'macos') {
            if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && key.toLowerCase() === 'k') {
                e.preventDefault();
                s.term.clear();
                return false;
            }
            const seq =
                e.altKey && !e.metaKey && !e.ctrlKey && key === 'ArrowLeft' ? '\x1bb'
                : e.altKey && !e.metaKey && !e.ctrlKey && key === 'ArrowRight' ? '\x1bf'
                : e.metaKey && !e.altKey && !e.ctrlKey && key === 'ArrowLeft' ? '\x01'
                : e.metaKey && !e.altKey && !e.ctrlKey && key === 'ArrowRight' ? '\x05'
                : e.metaKey && !e.altKey && !e.ctrlKey && key === 'Backspace' ? '\x15'
                : null;
            if (seq) {
                e.preventDefault();
                this.onUserData(s, seq);
                return false;
            }
            return true;
        }
        if (e.ctrlKey && !e.altKey && !e.metaKey && key.toLowerCase() === 'c') {
            if (e.shiftKey || s.term.hasSelection()) {
                e.preventDefault();
                const text = s.term.getSelection();
                if (text) {
                    void copyText(text).then(ok => { if (!ok) this.notify(CLIPBOARD_WRITE_BLOCKED); });
                    s.term.clearSelection();
                }
                return false;
            }
            return true;
        }
        if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && key.toLowerCase() === 'v') return false;
        return true;
    }

    private onUserData(s: Session, data: string): void {
        if (s.status === 'exited' || s.status === 'ended') {
            if (data.includes('\r')) this.restart(s);
            return;
        }
        if (s.status === 'detached') return;
        if (s.status === 'starting') {
            if (s.pendingInput.length + data.length <= PENDING_INPUT_MAX) s.pendingInput += data;
            return;
        }
        this.sendInput(s, data);
    }

    private sendInput(s: Session, data: string): void {
        for (let i = 0; i < data.length;) {
            let end = Math.min(data.length, i + TERMINAL_INPUT_MAX_CHARS);
            // Never split a surrogate pair across two frames: each half would reach
            // the shell as a replacement character.
            if (end < data.length) {
                const last = data.charCodeAt(end - 1);
                if (last >= 0xd800 && last <= 0xdbff) end--;
            }
            if (!agentBridge.send({ type: 'terminal.input', termId: s.termId, data: data.slice(i, end) })) return;
            i = end;
        }
    }

    private queueResize(s: Session): void {
        if (s.resizeFrame) return;
        s.resizeFrame = requestAnimationFrame(() => {
            s.resizeFrame = 0;
            this.flushResize(s);
            this.persist();
        });
    }

    private flushResize(s: Session): void {
        if (s.disposed || s.status !== 'live' || !this.helper) return;
        const cols = clampDim(s.term.cols, TERMINAL_MAX_COLS);
        const rows = clampDim(s.term.rows, TERMINAL_MAX_ROWS);
        if (cols === s.sentCols && rows === s.sentRows) return;
        s.sentCols = cols;
        s.sentRows = rows;
        agentBridge.request('terminal.resize', { termId: s.termId, cols, rows }).catch(e => {
            if (isErrorCode(e, 'not-found')) this.markEnded(s);
        });
    }

    private queueAck(s: Session, chars: number): void {
        s.ackChars += chars;
        if (s.ackFrame || s.ackTimer) return;
        const { frame, timer } = soon(() => {
            s.ackFrame = 0;
            s.ackTimer = 0;
            const n = s.ackChars;
            s.ackChars = 0;
            if (n > 0 && !s.disposed) agentBridge.send({ type: 'terminal.ack', termId: s.termId, chars: n });
        });
        s.ackFrame = frame;
        s.ackTimer = timer;
    }

    private tryStart(s: Session): void {
        const helper = this.helper;
        if (!helper || s.disposed || s.requested || s.status !== 'starting') return;
        if (s.mode === 'open' && !s.opened) return;
        s.requested = true;
        const cols = clampDim(s.term.cols, TERMINAL_MAX_COLS);
        const rows = clampDim(s.term.rows, TERMINAL_MAX_ROWS);
        s.sentCols = cols;
        s.sentRows = rows;
        const helperAtStart = helper;
        const stale = () => s.disposed || this.helper !== helperAtStart;
        if (s.mode === 'open') {
            void terminalStart().then(start => {
                if (stale()) return;
                agentBridge.request('terminal.open', {
                    termId: s.termId, cols, rows,
                    ...(start.vaultId ? { vaultId: start.vaultId, dir: start.dir } : {}),
                }).then(
                    result => { if (!stale()) this.goLive(s, result.shell); },
                    e => { if (!stale()) this.openFailed(s, e); },
                );
            });
        } else {
            agentBridge.request('terminal.attach', { termId: s.termId, cols, rows }).then(
                result => {
                    if (stale()) return;
                    s.term.reset();
                    if (result.snapshot) s.term.write(result.snapshot);
                    if (result.exited) this.goExited(s, result.shell, result.exited.code, result.exited.signal);
                    else this.goLive(s, result.shell);
                },
                e => { if (!stale()) this.attachFailed(s, e); },
            );
        }
    }

    private goLive(s: Session, shell: string): void {
        s.status = 'live';
        s.wasLive = true;
        s.openIfMissing = false;
        s.reconnectNoted = false;
        this.learnShell(s, shell);
        if (s.pendingInput) {
            const typed = s.pendingInput;
            s.pendingInput = '';
            this.sendInput(s, typed);
        }
        this.flushResize(s);
        this.commit();
    }

    private goExited(s: Session, shell: string, code: number | null, signal: string | null): void {
        s.status = 'exited';
        s.wasLive = true;
        s.exitCode = code;
        this.learnShell(s, shell);
        const what = code !== null ? `Process exited with code ${code}` : signal ? `Process ended by ${signal}` : 'Process exited';
        s.term.write(`\r\n${DIM}[${what}] Press Enter to start a new shell${RESET}\r\n`);
        this.commit();
    }

    private markEnded(s: Session): void {
        if (s.status === 'ended' || s.disposed) return;
        s.status = 'ended';
        s.term.write(`\r\n${DIM}[This terminal ended. Press Enter to start a new shell]${RESET}\r\n`);
        this.commit();
    }

    private openFailed(s: Session, e: unknown): void {
        if (isErrorCode(e, 'disconnected') || isErrorCode(e, 'timeout')) {
            s.requested = false;
            s.mode = 'attach';
            s.openIfMissing = true;
            return;
        }
        if (isErrorCode(e, 'limit')) {
            this.notify(e instanceof Error ? e.message : `At most ${MAX_TERMINALS} terminals can be open at once.`);
            this.close(s.key, false);
            return;
        }
        s.status = 'ended';
        s.term.write(`\r\n${DIM}[Couldn't start a shell: ${messageOf(e)}] Press Enter to try again${RESET}\r\n`);
        this.commit();
    }

    private attachFailed(s: Session, e: unknown): void {
        if (isErrorCode(e, 'disconnected') || isErrorCode(e, 'timeout')) {
            s.requested = false;
            return;
        }
        if (isErrorCode(e, 'not-found')) {
            if (s.openIfMissing) {
                s.openIfMissing = false;
                s.mode = 'open';
                s.requested = false;
                this.tryStart(s);
                return;
            }
            if (!s.wasLive) {
                this.close(s.key, false);
                return;
            }
            this.markEnded(s);
            return;
        }
        s.status = 'ended';
        s.term.write(`\r\n${DIM}[Couldn't reconnect to this terminal: ${messageOf(e)}] Press Enter to start a new shell${RESET}\r\n`);
        this.commit();
    }

    private restart(s: Session): void {
        const old = s.termId;
        void agentBridge.request('terminal.close', { termId: old }).catch(() => {});
        s.termId = crypto.randomUUID();
        s.mode = 'open';
        s.status = 'starting';
        s.exitCode = null;
        s.requested = false;
        s.wasLive = false;
        s.openIfMissing = false;
        s.pendingInput = '';
        s.term.reset();
        this.commit();
        this.tryStart(s);
    }

    private learnShell(s: Session, shell: string): void {
        if (s.base || !shell) return;
        s.base = baseName(shell);
        let n = 1;
        const taken = new Set(this.sessions.filter(o => o !== s && o.base === s.base).map(o => o.ordinal));
        while (taken.has(n)) n++;
        s.ordinal = n;
    }

    private onBridgeState(): void {
        const state: BridgeState = agentBridge.getState();
        const helper = state.status === 'connected' && state.helper.terminal ? state.helper : null;
        const connected = state.status === 'connected' ? state.helper : null;
        if (connected === this.lastHelper) return;
        const wasHelper = this.helper;
        this.lastHelper = connected;
        this.helper = helper;
        if (wasHelper && wasHelper !== helper) this.onDisconnected();
        if (helper) this.onConnected(helper);
        else if (connected) this.dropRestored();
    }

    private dropRestored(): void {
        for (const s of [...this.sessions]) if (s.status === 'starting' && s.mode === 'attach' && !s.wasLive) this.close(s.key, false);
    }

    private onDisconnected(): void {
        for (const s of this.sessions) {
            s.requested = false;
            if (s.status === 'live' || (s.status === 'starting' && s.wasLive)) {
                s.mode = 'attach';
                if (!s.reconnectNoted) {
                    s.reconnectNoted = true;
                    s.term.write(`\r\n${DIM}[Reconnecting to VaultAgent…]${RESET}\r\n`);
                }
            } else if (s.status === 'starting' && s.mode === 'open') {
                s.mode = 'attach';
                s.openIfMissing = true;
            }
        }
        this.state = { ...this.state, privacy: null };
        this.commit(false);
    }

    private onConnected(helper: HelperInfo): void {
        startFontDetection(() => agentBridge.request('terminal.fontHint', {}).then(r => r.candidates));
        agentBridge.request('terminal.privacy', {}).then(
            privacy => { if (this.helper === helper) { this.state = { ...this.state, privacy }; this.commit(false); } },
            () => { /* an answer, not a need: no notice */ },
        );
        for (const s of this.sessions) {
            if (s.status === 'live') {
                s.status = 'starting';
                s.mode = 'attach';
            }
            this.tryStart(s);
        }
        this.commit(false);
    }

    private onEvent(event: TerminalEvent): void {
        const s = this.sessions.find(x => x.termId === event.termId);
        if (!s || s.disposed) return;
        switch (event.type) {
            case 'terminal.output': {
                if (event.reset) s.term.reset();
                const chars = event.data.length;
                s.term.write(event.data, () => this.queueAck(s, chars));
                return;
            }
            case 'terminal.exit':
                this.goExited(s, '', event.code, event.signal);
                return;
            case 'terminal.detached':
                s.status = 'detached';
                s.term.write(`\r\n${DIM}[This terminal moved to another window]${RESET}\r\n`);
                this.commit();
                return;
        }
    }

    private titleOf(s: Session): string {
        if (!s.base) return 'Terminal';
        return s.ordinal > 1 ? `${s.base} ${s.ordinal}` : s.base;
    }

    private commit(persist = true): void {
        this.state = {
            ...this.state,
            sessions: this.sessions.map(s => ({ key: s.key, title: this.titleOf(s), status: s.status, exitCode: s.exitCode })),
        };
        const running = this.sessions.filter(s => s.status === 'starting' || s.status === 'live').length;
        setTerminalCount(running);
        if (running > 0 && !this.release) this.release = agentBridge.retain();
        else if (running === 0 && this.release) { this.release(); this.release = null; }
        if (persist) this.persist();
        for (const listener of this.listeners) listener();
    }

    private persist(): void {
        try {
            const stored: StoredSession[] = this.sessions
                .filter(s => s.status !== 'detached' && s.status !== 'ended')
                .map(s => ({
                    key: s.key, termId: s.termId, base: s.base, ordinal: s.ordinal,
                    cols: clampDim(s.term.cols, TERMINAL_MAX_COLS), rows: clampDim(s.term.rows, TERMINAL_MAX_ROWS),
                }));
            if (stored.length === 0) removeSessionValue(SESSIONS_KEY);
            else writeSessionValue(SESSIONS_KEY, JSON.stringify({ sessions: stored, active: this.state.activeKey }));
        } catch { /* storage blocked: a reload simply starts fresh */ }
    }

    /** sessionStorage is per browser tab (and survives a reload, and "reopen closed
     *  tab"), so only this window knows these ids. Clamped and validated: it is
     *  user-editable, and the ids reach the helper. */
    private restore(): void {
        if (this.sessions.length > 0) return;
        try {
            const raw = sessionStorage.getItem(SESSIONS_KEY);
            if (!raw) return;
            const parsed = JSON.parse(raw) as { sessions?: unknown; active?: unknown };
            if (!Array.isArray(parsed.sessions)) return;
            for (const item of parsed.sessions.slice(0, MAX_TERMINALS) as Array<Partial<StoredSession>>) {
                if (!item || !isUuid(item.termId) || !isUuid(item.key)) continue;
                if (this.sessions.some(s => s.key === item.key || s.termId === item.termId)) continue;
                const base = typeof item.base === 'string' ? item.base.slice(0, 40) : null;
                const ordinal = typeof item.ordinal === 'number' && item.ordinal >= 0 && item.ordinal < 100 ? Math.floor(item.ordinal) : 0;
                const size = {
                    cols: clampDim(Number(item.cols), TERMINAL_MAX_COLS),
                    rows: clampDim(Number(item.rows), TERMINAL_MAX_ROWS),
                };
                this.sessions.push(this.build(item.key, item.termId, 'attach', base, ordinal, size));
            }
            const active = typeof parsed.active === 'string' && this.sessions.some(s => s.key === parsed.active)
                ? parsed.active : this.sessions[0]?.key ?? null;
            this.state = { ...this.state, activeKey: active };
            this.commit(false);
        } catch { /* unreadable: start fresh */ }
    }

    private notify(text: string): void {
        window.clearTimeout(this.noticeTimer);
        this.state = { ...this.state, notice: text };
        this.noticeTimer = window.setTimeout(() => {
            this.state = { ...this.state, notice: null };
            for (const listener of this.listeners) listener();
        }, NOTICE_MS);
        for (const listener of this.listeners) listener();
    }
}

export const terminalStore = new TerminalStore();

// Dev only: a hot update re-runs this module; the old store's listeners on the
// bridge would otherwise answer every terminal event beside the new one's.
import.meta.hot?.dispose(() => terminalStore.dispose());
