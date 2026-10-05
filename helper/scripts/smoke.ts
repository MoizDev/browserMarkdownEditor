// Smoke-test a COMPILED helper, the way the release workflow does on each OS:
//
//   bun helper/scripts/smoke.ts <path/to/vaultagent> [--expect-version X]
//
// 1. `serve --no-register` with HOME pointed at a scratch folder, then raw HTTP
//    against it: /health CORS, the Private Network Access preflight, Host and
//    Origin checks on /health, /ws and /mcp. Raw sockets, because fetch will not
//    send an arbitrary Host header. Then the terminal over a real WebSocket: open a
//    shell, run an echo, see its output, let it exit, close it.
// 2. `install --root` / `uninstall --root` in a scratch folder: the exact layout,
//    and that nothing is left. `--root` registers nothing with the OS. On macOS the
//    layout holds the PTY host the compiled helper embeds: it is run from there on
//    a scratch socket and one shell is spawned through it, so a compiled helper
//    that embedded a broken (or no) host fails here.
//
// Never touches the real home folder; safe to run on a developer machine.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PRODUCTION_ORIGIN, type HelperMessage } from '../../shared/vaultAgentProtocol.ts';
import { installLayout, type InstallLayout } from '../src/install/layout.ts';
import { helperPlatform } from '../src/server.ts';
import { TERMINAL_SHELL_OVERRIDE } from '../src/terminal/shell.ts';
import { ptyHostBackend } from '../src/terminal/ptyHostBackend.ts';

const argv = process.argv.slice(2);
const binary = argv[0];
const expectVersion = argv.includes('--expect-version') ? argv[argv.indexOf('--expect-version') + 1].replace(/^vaultagent-v/, '') : null;
if (!binary || !existsSync(binary)) {
    console.error('usage: bun helper/scripts/smoke.ts <binary> [--expect-version X]');
    process.exit(2);
}

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `  — ${detail}`}`);
    if (!ok) failures++;
}

interface RawResponse { status: number; headers: Record<string, string>; body: string }

/** One HTTP/1.1 request over a plain socket, headers exactly as given. */
function raw(port: number, method: string, path: string, headers: Record<string, string>): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
        const sock = connect(port, '127.0.0.1');
        let data = '';
        const timer = setTimeout(() => {
            sock.destroy();
            reject(new Error(`timeout: ${method} ${path}`));
        }, 5000);
        sock.on('connect', () => {
            const lines = [`${method} ${path} HTTP/1.1`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), 'Connection: close', '', ''];
            sock.write(lines.join('\r\n'));
        });
        sock.on('data', d => {
            data += d.toString('latin1');
            // Done once the head and Content-Length bytes are in: a 101 keeps the socket
            // open by definition, and Bun keeps a refused Upgrade request's socket open too.
            const end = data.indexOf('\r\n\r\n');
            if (end < 0) return;
            const length = Number(/\r\ncontent-length:\s*(\d+)/i.exec(data.slice(0, end))?.[1] ?? 0);
            if (/^HTTP\/1\.1 101/.test(data) || data.length - end - 4 >= length) sock.destroy();
        });
        sock.on('error', e => {
            clearTimeout(timer);
            reject(e);
        });
        sock.on('close', () => {
            clearTimeout(timer);
            const [head, ...rest] = data.split('\r\n\r\n');
            const [statusLine, ...hl] = head.split('\r\n');
            const headers: Record<string, string> = {};
            for (const l of hl) {
                const i = l.indexOf(':');
                if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
            }
            resolve({ status: Number(statusLine.split(' ')[1] ?? 0), headers, body: rest.join('\r\n\r\n') });
        });
    });
}

const scratch = mkdtempSync(join(tmpdir(), 'vaultagent-smoke-'));
const home = join(scratch, 'home');
mkdirSync(home, { recursive: true });   // the terminal starts in ~, which must exist

/** A random word, for output that cannot be the shell echoing our own keystrokes back. */
const rand = () => Math.random().toString(36).slice(2, 10);

/**
 * The terminal, over the same WebSocket the panel uses (production Origin). The
 * helper's shell is forced to a plain one (see TERMINAL_SHELL_OVERRIDE): the scratch
 * HOME has no .zshrc, and zsh would answer with its first-run wizard. The marker is
 * typed with a quote (`a''b`, `a^b` in cmd.exe) in the middle and printed without it, so
 * seeing it means the shell RAN the command — the echo of our keystrokes cannot match.
 */
async function smokeTerminal(port: number): Promise<void> {
    const windows = helperPlatform() === 'windows';
    const word = rand();
    const typed = windows ? `echo smoke-a^b-${word}` : `echo smoke-a''b-${word}`;
    const marker = `smoke-ab-${word}`;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Origin: PRODUCTION_ORIGIN } } as unknown as string[]);
    const seen: HelperMessage[] = [];
    let output = '';
    ws.onmessage = e => {
        const m = JSON.parse(String(e.data)) as HelperMessage;
        seen.push(m);
        if (m.type === 'terminal.output') output += m.data;
    };
    const opened = await new Promise<boolean>(resolve => {
        ws.onopen = () => resolve(true);
        ws.onerror = () => resolve(false);
    });
    check('terminal: /ws opens', opened);
    if (!opened) return;
    const waitFor = async (what: () => boolean, ms: number) => {
        for (const until = Date.now() + ms; Date.now() < until && !what(); await Bun.sleep(50));
        return what();
    };
    try {
        const termId = crypto.randomUUID();
        ws.send(JSON.stringify({ type: 'terminal.open', reqId: 't1', termId, cols: 100, rows: 30 }));
        check('terminal.open answers', await waitFor(() => seen.some(m => m.type === 'response' && m.reqId === 't1'), 15_000));
        const opened = seen.find(m => m.type === 'response' && m.reqId === 't1');
        check('terminal.open ok', !!opened && opened.type === 'response' && opened.ok, JSON.stringify(opened));
        // Let the shell print its prompt first: a Windows ConPTY drops input that beats its init.
        await Bun.sleep(windows ? 1500 : 300);
        ws.send(JSON.stringify({ type: 'terminal.input', termId, data: `${typed}\r` }));
        check('terminal: the shell ran the command', await waitFor(() => output.includes(marker), 15_000), output.slice(-200));
        ws.send(JSON.stringify({ type: 'terminal.input', termId, data: 'exit\r' }));
        check('terminal: terminal.exit after the shell exits', await waitFor(() => seen.some(m => m.type === 'terminal.exit' && m.termId === termId), 15_000));
        ws.send(JSON.stringify({ type: 'terminal.close', reqId: 't2', termId }));
        check('terminal.close answers ok', await waitFor(() => seen.some(m => m.type === 'response' && m.reqId === 't2' && m.ok), 5000));
    } finally {
        ws.close();
    }
}

/** macOS: the host the compiled helper embedded, run as a LaunchAgent would run it, on a scratch socket. */
async function smokePtyHost(l: InstallLayout): Promise<void> {
    check('the PTY host was embedded and written', !!l.ptyHostBinary && existsSync(l.ptyHostBinary), String(l.ptyHostBinary));
    if (!l.ptyHostBinary || !existsSync(l.ptyHostBinary)) return;
    const socket = join(scratch, 'pty.sock');
    const host = Bun.spawn([l.ptyHostBinary, '--socket', socket], { stdout: 'ignore', stderr: 'inherit' });
    try {
        for (let i = 0; i < 100 && !existsSync(socket); i++) await Bun.sleep(50);
        const word = rand();
        let out = '';
        let exit = null as { code: number | null; signal: string | null } | null;   // assigned from a callback: keep TS from narrowing it to `never`
        const proc = await ptyHostBackend(socket).spawn(
            { file: '/bin/sh', args: [], env: { PATH: '/usr/bin:/bin' }, cwd: home, cols: 80, rows: 24 },
            { onData: b => (out += new TextDecoder().decode(b)), onExit: e => (exit = e) },
        );
        proc.write(`echo host-a''b-${word}; exit 3\r`);
        for (let i = 0; i < 200 && !exit; i++) await Bun.sleep(50);
        check('PTY host: the shell ran the command', out.includes(`host-ab-${word}`), out);
        check('PTY host: exit code relayed', exit?.code === 3 && exit?.signal === null, JSON.stringify(exit));
    } finally {
        host.kill();
        await host.exited;
    }
}

async function smokeServe(): Promise<void> {
    const version = Bun.spawnSync([binary, '--version']).stdout.toString().trim();
    check('--version prints a version', /^\d+\.\d+\.\d+/.test(version), version);
    if (expectVersion) check(`--version is ${expectVersion}`, version === expectVersion, version);

    const proc = Bun.spawn([binary, 'serve', '--no-register'], {
        env: { ...process.env, HOME: home, USERPROFILE: home, [TERMINAL_SHELL_OVERRIDE]: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh' },
        stdout: 'pipe',
        stderr: 'inherit',
    });
    try {
        const reader = proc.stdout.getReader();
        let out = '';
        const deadline = Date.now() + 15_000;
        let port = 0;
        while (!port && Date.now() < deadline) {
            const { value, done } = await Promise.race([
                reader.read(),
                Bun.sleep(deadline - Date.now()).then(() => ({ value: undefined, done: true })),
            ]);
            if (done) break;
            out += new TextDecoder().decode(value);
            port = Number(/listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(out)?.[1] ?? 0);
        }
        check('serve --no-register prints its port', port > 0, out);
        if (!port) return;
        reader.releaseLock();
        const host = `127.0.0.1:${port}`;
        const extra = (process.env.VAULTAGENT_ALLOWED_ORIGINS ?? '').split(/[\s,]+/).filter(Boolean);

        const h = await raw(port, 'GET', '/health', { Host: host });
        let info: { app?: string; protocol?: number; platform?: string; version?: string } = {};
        try {
            info = JSON.parse(h.body);
        } catch { /* reported below */ }
        check('/health 200', h.status === 200, `${h.status} ${h.body}`);
        check('/health identifies the helper', info.app === 'vaultagent' && info.protocol === 1 && info.platform === helperPlatform(), h.body);
        check('/health without Origin sends no CORS', !('access-control-allow-origin' in h.headers));

        for (const origin of [PRODUCTION_ORIGIN, ...extra]) {
            const r = await raw(port, 'GET', '/health', { Host: host, Origin: origin });
            check(`/health CORS for ${origin}`, r.status === 200 && r.headers['access-control-allow-origin'] === origin, JSON.stringify(r.headers));
        }
        check('/health refuses a foreign Origin', (await raw(port, 'GET', '/health', { Host: host, Origin: 'https://evil.example' })).status === 403);
        check('/health refuses a dev Origin without --dev', (await raw(port, 'GET', '/health', { Host: host, Origin: 'http://localhost:5173' })).status === 403);
        check('/health refuses a foreign Host (DNS rebinding)', (await raw(port, 'GET', '/health', { Host: `evil.example:${port}` })).status === 403);

        const pre = await raw(port, 'OPTIONS', '/health', {
            Host: host, Origin: PRODUCTION_ORIGIN, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Private-Network': 'true',
        });
        check('Private Network Access preflight', pre.status === 204 && pre.headers['access-control-allow-private-network'] === 'true', `${pre.status} ${JSON.stringify(pre.headers)}`);

        const ws = { Host: host, Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' };
        check('/ws refuses a missing Origin', (await raw(port, 'GET', '/ws', ws)).status === 403);
        check('/ws refuses a foreign Origin', (await raw(port, 'GET', '/ws', { ...ws, Origin: 'https://evil.example' })).status === 403);
        check('/ws refuses a foreign Host', (await raw(port, 'GET', '/ws', { ...ws, Host: `evil.example:${port}`, Origin: PRODUCTION_ORIGIN })).status === 403);
        const up = await raw(port, 'GET', '/ws', { ...ws, Origin: PRODUCTION_ORIGIN });
        check('/ws upgrades for the production Origin', up.status === 101, String(up.status));

        await smokeTerminal(port);

        const token = 'a'.repeat(43);
        const mcp = { Host: host, 'Content-Type': 'application/json', 'Content-Length': '2', Authorization: `Bearer ${token}` };
        check('/mcp refuses any browser (Origin present)', (await raw(port, 'POST', `/mcp/${token}`, { ...mcp, Origin: PRODUCTION_ORIGIN })).status === 403);
        check('/mcp refuses a missing bearer', (await raw(port, 'POST', `/mcp/${token}`, { ...mcp, Authorization: '' })).status === 401);
        check('/mcp: no run, no endpoint', (await raw(port, 'POST', `/mcp/${token}`, mcp)).status === 404);
    } finally {
        proc.kill();
        await proc.exited;
    }
}

async function smokeInstall(): Promise<void> {
    const platform = helperPlatform();
    const root = join(scratch, 'install-root');
    const r = Bun.spawnSync([binary, 'install', '--root', root], { stdout: 'inherit', stderr: 'inherit' });
    check('install --root exits 0', r.exitCode === 0, String(r.exitCode));
    const l = installLayout(platform, root);
    check('binary placed', existsSync(l.binary), l.binary);
    if (l.registrationFile) check('registration file written', existsSync(l.registrationFile), l.registrationFile);
    if (platform === 'macos') await smokePtyHost(l);
    const u = Bun.spawnSync([binary, 'uninstall', '--root', root], { stdout: 'inherit', stderr: 'inherit' });
    check('uninstall --root exits 0', u.exitCode === 0, String(u.exitCode));
    const left = existsSync(root) ? readdirSync(root, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => join(e.parentPath, e.name)) : [];
    check('uninstall leaves no files', left.length === 0, left.join(', '));
}

try {
    await smokeServe();
    await smokeInstall();
} catch (e) {
    check('smoke run', false, String(e));
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
