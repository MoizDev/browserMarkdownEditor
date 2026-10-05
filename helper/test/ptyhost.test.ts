// The frozen PTY host (helper/ptyhost): its pin, its wire protocol through
// ptyHostBackend, and how it is installed. macOS only — the host is a macOS
// program — and nothing here touches the real launchd or the real home folder.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TerminalExit } from '../../shared/vaultAgentProtocol.ts';
import { ensurePtyHost } from '../src/install/ptyhost.ts';
import { PTYHOST_LABEL, installLayout } from '../src/install/layout.ts';
import type { Launchctl } from '../src/install/launchctl.ts';
import { ptyHostBackend, probePtyHost } from '../src/terminal/ptyHostBackend.ts';
import { cleanupLeftovers } from '../src/update.ts';

const darwin = process.platform === 'darwin';
const suite = darwin ? describe : describe.skip;
const HOST = join(import.meta.dir, '..', 'ptyhost', 'vaultagent-pty');
const PINNED = join(import.meta.dir, '..', 'ptyhost', 'PINNED.json');

let scratch = '';
beforeAll(() => {
    // Short on purpose: a unix socket path holds 104 bytes, and an install layout adds
    // 48 of them (`Library/Application Support/VaultAgent/pty.sock`) to its root. macOS's
    // own tmpdir (/var/folders/xx/…/T) alone is 49.
    scratch = mkdtempSync(join(darwin ? '/tmp' : tmpdir(), 'vp-'));
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function sha256(path: string): string {
    const h = new Bun.CryptoHasher('sha256');
    h.update(readFileSync(path));
    return h.digest('hex');
}

suite('the pinned binary', () => {
    test('the committed vaultagent-pty is the one PINNED.json names (sha256 and cdhash)', () => {
        const pinned = JSON.parse(readFileSync(PINNED, 'utf8')) as { sha256: string; cdhash: string; cdhashX86_64: string };
        expect(sha256(HOST)).toBe(pinned.sha256);
        const cdhash = (arch: string) => {
            const r = Bun.spawnSync(['/usr/bin/codesign', '-dvvv', '--arch', arch, HOST], { stderr: 'pipe' });
            return /^CDHash=(\w+)$/m.exec(r.stderr.toString())?.[1];
        };
        expect(cdhash('arm64')).toBe(pinned.cdhash);
        expect(cdhash('x86_64')).toBe(pinned.cdhashX86_64);
        expect(Bun.spawnSync(['/usr/bin/codesign', '--verify', '--strict', HOST]).exitCode).toBe(0);
    });
});

/** A running host on a fresh socket. */
async function startHost(): Promise<{ socket: string; stop: () => void }> {
    const dir = mkdtempSync(join(scratch, 'h-'));
    const socket = join(dir, 'pty.sock');
    const proc = Bun.spawn([HOST, '--socket', socket], { stdout: 'ignore', stderr: 'inherit' });
    for (let i = 0; i < 100 && !existsSync(socket); i++) await Bun.sleep(20);
    return { socket, stop: () => proc.kill() };
}

interface Run { out: () => string; exit: Promise<TerminalExit>; proc: Awaited<ReturnType<ReturnType<typeof ptyHostBackend>['spawn']>> }

async function run(socket: string, file: string, args: string[], extra: Partial<{ cwd: string; cols: number; rows: number; env: Record<string, string>; argv0: string }> = {}): Promise<Run> {
    let out = '';
    let done!: (e: TerminalExit) => void;
    const exit = new Promise<TerminalExit>(r => (done = r));
    const dec = new TextDecoder();
    const proc = await ptyHostBackend(socket).spawn(
        { file, args, env: { PATH: '/usr/bin:/bin', TERM: 'xterm-256color', ...extra.env }, cwd: extra.cwd ?? '/', cols: extra.cols ?? 80, rows: extra.rows ?? 24, argv0: extra.argv0 },
        { onData: b => (out += dec.decode(b, { stream: true })), onExit: done },
    );
    return { out: () => out, exit, proc };
}

async function until(what: () => boolean, ms = 5000): Promise<void> {
    for (const end = Date.now() + ms; !what(); await Bun.sleep(20)) if (Date.now() > end) throw new Error('timed out');
}

const alive = (pid: number) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};

suite('the host, through ptyHostBackend', () => {
    let host: Awaited<ReturnType<typeof startHost>>;
    beforeAll(async () => {
        host = await startHost();
    });
    afterAll(() => host.stop());

    test('the socket is private (0600)', () => {
        expect(statSync(host.socket).mode & 0o777).toBe(0o600);
    });

    test('probe: true for a live host, false for a stale socket file and a missing one', async () => {
        expect(await probePtyHost(host.socket)).toBe(true);
        const stale = join(scratch, 'stale.sock');
        writeFileSync(stale, '');
        expect(await probePtyHost(stale, 500)).toBe(false);
        expect(await probePtyHost(join(scratch, 'none.sock'), 500)).toBe(false);
    });

    test('a shell: cwd, env and argv0 arrive; echo comes back; exit code is reported', async () => {
        const dir = mkdtempSync(join(scratch, 'cwd-'));
        const r = await run(host.socket, '/bin/sh', [], { cwd: dir, env: { VA_PROBE: 'héllo wörld' }, argv0: '-sh' });
        expect(r.proc.pid).toBeGreaterThan(0);
        r.proc.write('echo "m-$((6*7))" "$VA_PROBE" "$0"; pwd -P; exit 7\r');
        const exit = await r.exit;
        expect(exit).toEqual({ code: 7, signal: null });
        expect(r.out()).toContain('m-42 héllo wörld -sh');
        expect(r.out()).toContain(realpathSync(dir));
    });

    test('resize is visible to the program (stty size), at spawn and later', async () => {
        const r = await run(host.socket, '/bin/sh', [], { cols: 100, rows: 30 });
        r.proc.write('stty size\r');
        await until(() => r.out().includes('30 100'));
        r.proc.resize(60, 20);
        r.proc.write('stty size\r');
        await until(() => r.out().includes('20 60'));
        r.proc.write('exit\r');
        await r.exit;
    });

    test('a signalled child reports code null and the signal name', async () => {
        const r = await run(host.socket, '/bin/sh', ['-c', 'kill -TERM $$']);
        expect(await r.exit).toEqual({ code: null, signal: 'SIGTERM' });
    });

    test('output written just before the exit is not lost', async () => {
        const r = await run(host.socket, '/bin/sh', ['-c', 'i=0; while [ $i -lt 2000 ]; do echo line-$i; i=$((i+1)); done; echo END-MARK']);
        expect(await r.exit).toEqual({ code: 0, signal: null });
        expect(r.out()).toContain('line-0\r\n');
        expect(r.out()).toContain('line-1999\r\nEND-MARK');
    });

    test('a program that cannot be run says so in the terminal and exits 127', async () => {
        const r = await run(host.socket, '/nonexistent/prog', []);
        expect(await r.exit).toEqual({ code: 127, signal: null });
        expect(r.out()).toContain('cannot run');
    });

    test('a closed session kills its whole process group (no stray child)', async () => {
        const marker = join(scratch, 'bg.pid');
        const r = await run(host.socket, '/bin/sh', ['-c', `sleep 300 & echo $! > "${marker}"; wait`]);
        await until(() => existsSync(marker) && readFileSync(marker, 'utf8').trim() !== '');
        const child = Number(readFileSync(marker, 'utf8').trim());
        expect(alive(child)).toBe(true);
        expect(alive(r.proc.pid)).toBe(true);
        r.proc.kill();
        const exit = await r.exit;
        expect(exit.signal).toBe('SIGHUP');
        await until(() => !alive(child) && !alive(r.proc.pid));
    });

    test('a client that just disconnects (a crashed helper) kills the shell too', async () => {
        let socketClosed!: () => void;
        const closed = new Promise<void>(r => (socketClosed = r));
        // Speak the protocol by hand so the connection can be dropped without a kill frame.
        const frames: Uint8Array[] = [];
        const sock = await Bun.connect({ unix: host.socket, socket: { open() {}, data(_s, d) { frames.push(d.slice()); }, close() { socketClosed(); } } });
        const enc = new TextEncoder();
        const strings = ['/', '/bin/sh', '/bin/sh', 'PATH=/usr/bin:/bin'].map(s => enc.encode(`${s}\0`));
        const body = new Uint8Array(12 + strings.reduce((n, s) => n + s.length, 0));
        const dv = new DataView(body.buffer);
        dv.setUint16(0, 80); dv.setUint16(2, 24); dv.setUint32(4, 1); dv.setUint32(8, 1);
        let at = 12;
        for (const s of strings) { body.set(s, at); at += s.length; }
        const frame = new Uint8Array(5 + body.length);
        frame[0] = 1; new DataView(frame.buffer).setUint32(1, body.length); frame.set(body, 5);
        sock.write(frame);
        await until(() => frames.length > 0);
        const first = frames[0];
        expect(first[0]).toBe(1);
        const pid = new DataView(first.buffer, first.byteOffset + 5, 4).getUint32(0);
        expect(alive(pid)).toBe(true);
        sock.terminate();
        await closed;
        await until(() => !alive(pid));
    });

    test('backpressure: a reader that never reads does not make the host buffer the flood', async () => {
        // A client that stops reading: the host must stop reading the PTY, so `yes`
        // blocks in the kernel instead of growing the host.
        const sock = await Bun.connect({ unix: host.socket, socket: { open() {}, data() {}, close() {} } });
        const enc = new TextEncoder();
        const strings = ['/', '/usr/bin/yes', '/usr/bin/yes', 'PATH=/usr/bin:/bin'].map(s => enc.encode(`${s}\0`));
        const body = new Uint8Array(12 + strings.reduce((n, s) => n + s.length, 0));
        const dv = new DataView(body.buffer);
        dv.setUint16(0, 80); dv.setUint16(2, 24); dv.setUint32(4, 1); dv.setUint32(8, 1);
        let at = 12;
        for (const s of strings) { body.set(s, at); at += s.length; }
        const frame = new Uint8Array(5 + body.length);
        frame[0] = 1; new DataView(frame.buffer).setUint32(1, body.length); frame.set(body, 5);
        sock.write(frame);
        await Bun.sleep(1500);
        const ps = Bun.spawnSync(['/bin/ps', '-axo', 'rss=,command=']);
        const rss = ps.stdout.toString().split('\n').filter(l => l.includes('vaultagent-pty') && l.includes(host.socket)).map(l => Number(l.trim().split(/\s+/)[0]));
        expect(rss.length).toBeGreaterThan(0);
        expect(Math.max(...rss)).toBeLessThan(30_000);   // KB; a buffered flood would be hundreds of MB by now
        sock.terminate();
    });
});

/** A launchctl that records its calls; `loaded` is what `print` answers. */
function stubLaunchctl(state: { loaded: boolean }): { run: Launchctl; calls: string[][] } {
    const calls: string[][] = [];
    const run: Launchctl = async (...args) => {
        calls.push(args);
        if (args[0] === 'print') return { code: state.loaded ? 0 : 113 };
        if (args[0] === 'bootstrap') {
            state.loaded = true;
            return { code: 0 };
        }
        if (args[0] === 'bootout') state.loaded = false;
        return { code: 0 };
    };
    return { run, calls };
}

suite('ensurePtyHost', () => {
    const layoutIn = () => installLayout('macos', mkdtempSync(join(scratch, 'root-')));

    test('writes the embedded binary 0755 + the plist, and loads the job', async () => {
        const l = layoutIn();
        const state = { loaded: false };
        const { run, calls } = stubLaunchctl(state);
        const r = await ensurePtyHost(l, { launchctl: run });
        expect(r).toEqual({ wrote: true, bootstrapped: true });
        expect(sha256(l.ptyHostBinary!)).toBe(sha256(HOST));
        expect(statSync(l.ptyHostBinary!).mode & 0o777).toBe(0o755);
        const plist = readFileSync(l.ptyHostRegistration!, 'utf8');
        expect(plist).toContain(`<string>${PTYHOST_LABEL}</string>`);
        expect(plist).toContain(`<string>${l.ptyHostBinary}</string>\n\t\t<string>--socket</string>\n\t\t<string>${l.ptyHostSocket}</string>`);
        for (const key of ['RunAtLoad', 'KeepAlive']) expect(plist).toContain(`<key>${key}</key>\n\t<true/>`);
        expect(plist).toContain('<key>ProcessType</key>\n\t<string>Interactive</string>');
        expect(Bun.spawnSync(['/usr/bin/plutil', '-lint', l.ptyHostRegistration!]).exitCode).toBe(0);
        expect(calls.some(c => c[0] === 'bootstrap' && c[2] === l.ptyHostRegistration)).toBe(true);
        expect(readdirSync(l.appDir).sort()).toEqual(['vaultagent-pty']);
    });

    test('identical bytes + a loaded job: nothing is touched, launchd is only asked', async () => {
        const l = layoutIn();
        const state = { loaded: false };
        await ensurePtyHost(l, { launchctl: stubLaunchctl(state).run });
        const before = statSync(l.ptyHostBinary!);
        const { run, calls } = stubLaunchctl(state);
        const r = await ensurePtyHost(l, { launchctl: run });
        expect(r).toEqual({ wrote: false, bootstrapped: false });
        expect(statSync(l.ptyHostBinary!).ino).toBe(before.ino);
        expect(calls.map(c => c[0])).toEqual(['print']);
    });

    test('identical bytes but not loaded: bootstrapped without a rewrite', async () => {
        const l = layoutIn();
        await ensurePtyHost(l, { launchctl: stubLaunchctl({ loaded: false }).run });
        const ino = statSync(l.ptyHostBinary!).ino;
        const { run, calls } = stubLaunchctl({ loaded: false });
        expect(await ensurePtyHost(l, { launchctl: run })).toEqual({ wrote: false, bootstrapped: true });
        expect(statSync(l.ptyHostBinary!).ino).toBe(ino);
        expect(calls.map(c => c[0])).toEqual(['print', 'bootstrap']);
    });

    test('different bytes on disk are replaced (atomically, 0755) and the running job restarted', async () => {
        const l = layoutIn();
        await ensurePtyHost(l, { launchctl: stubLaunchctl({ loaded: false }).run });
        writeFileSync(l.ptyHostBinary!, 'tampered');
        chmodSync(l.ptyHostBinary!, 0o644);
        const state = { loaded: true };
        const { run, calls } = stubLaunchctl(state);
        const r = await ensurePtyHost(l, { launchctl: run });
        expect(r).toEqual({ wrote: true, bootstrapped: true });
        expect(sha256(l.ptyHostBinary!)).toBe(sha256(HOST));
        expect(statSync(l.ptyHostBinary!).mode & 0o777).toBe(0o755);
        expect(calls.map(c => c[0])).toEqual(['print', 'bootout', 'print', 'bootstrap']);
        expect(readdirSync(l.appDir).sort()).toEqual(['vaultagent-pty']);
    });

    test('register: false (a --root layout, the pkg) writes files and never calls launchctl', async () => {
        const l = layoutIn();
        const { run, calls } = stubLaunchctl({ loaded: false });
        expect(await ensurePtyHost(l, { register: false, launchctl: run })).toEqual({ wrote: true, bootstrapped: false });
        expect(calls).toEqual([]);
    });

    test('a failing bootstrap is logged, never thrown', async () => {
        const l = layoutIn();
        const run: Launchctl = async (...args) => ({ code: args[0] === 'print' ? 113 : 5 });
        const r = await ensurePtyHost(l, { launchctl: run, retryMs: 1 });
        expect(r.bootstrapped).toBe(false);
    });

    test('a no-op off macOS', async () => {
        const l = installLayout('linux', mkdtempSync(join(scratch, 'root-')));
        expect(await ensurePtyHost(l)).toEqual({ wrote: false, bootstrapped: false });
        expect(readdirSync(l.home)).toEqual([]);
    });
});

describe('update cleanup', () => {
    test('never touches vaultagent-pty or pty.sock, only its own leftovers', () => {
        const appDir = mkdtempSync(join(tmpdir(), 'vacl-'));
        try {
            const keep = ['vaultagent', 'vaultagent-pty', 'pty.sock', 'vaultagent-pty.new-123', 'vaultagent.update-notes'];
            const drop = ['vaultagent.update-123', 'vaultagent.previous-45.exe', 'vaultagent.update-9.exe'];
            mkdirSync(appDir, { recursive: true });
            for (const n of [...keep, ...drop]) writeFileSync(join(appDir, n), 'x');
            cleanupLeftovers(appDir);
            expect(readdirSync(appDir).sort()).toEqual([...keep].sort());
        } finally {
            rmSync(appDir, { recursive: true, force: true });
        }
    });
});
