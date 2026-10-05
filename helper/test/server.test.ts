// The whole loop over real sockets, with a fake agent adapter standing in for a
// CLI: panel WebSocket ⇄ helper ⇄ MCP endpoint (called the way a CLI calls it).

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_MCP_BODY_BYTES, MAX_TERMINALS, type AgentEvent, type AgentId, type HelperMessage } from '../../shared/vaultAgentProtocol.ts';
import { SAFE_MODEL_RE, type AgentAdapter, type Foreign, type RunContext, type RunOutcome } from '../src/agents/types.ts';
import { makeOriginPolicy } from '../src/security.ts';
import { createFetchHandler, helperPlatform, startServer, type RunningServer } from '../src/server.ts';
import { inProcessBackend } from '../src/terminal/backend.ts';
import { TerminalManager } from '../src/terminal/manager.ts';
import { fakeBackend, type FakeBackend } from './fixtures/fakePty.ts';
import { Panel as BasePanel } from './fixtures/panel.ts';

const ORIGIN = 'https://notes.moizhashmi.com';
const VAULT = '6f1c2d3e-4a5b-4c6d-8e7f-001122334455';
const SESSION = '11111111-2222-4333-8444-555555555555';

interface FakeControls { lastCtx: RunContext | null; cancelled: number; toolResults: unknown[] }
const fake: FakeControls = { lastCtx: null, cancelled: 0, toolResults: [] };

/** Acts like a CLI: announces its session, calls one MCP tool, streams, finishes (or waits to be cancelled). */
function fakeAdapter(id: AgentId): AgentAdapter {
    return {
        id,
        isValidSessionId: (s): s is string => typeof s === 'string' && /^[0-9a-f-]{36}$/.test(s),
        isValidModel: (m): m is string => typeof m === 'string' && SAFE_MODEL_RE.test(m), // as the real adapters
        status: async () => ({ agent: id, installed: true, version: '1.0.0', loggedIn: true, loginCommand: 'x', installCommand: 'y' }),
        models: async () => [{ id: 'm', label: 'M', efforts: [], defaultEffort: null, images: true }],
        history: async () => ({ found: true, items: [{ kind: 'assistant', text: 'hi' }] }),
        deleteSession: async () => true,
        async start(ctx) {
            fake.lastCtx = ctx;
            ctx.emit({ type: 'session', sessionId: SESSION }); // before the response: must be queued
            let cancel!: () => void;
            const cancelled = new Promise<void>(r => (cancel = r));
            const outcome = (async (): Promise<RunOutcome> => {
                if (ctx.text === 'wait') {
                    await cancelled;
                    return { kind: 'done', status: 'cancelled', sessionId: SESSION };
                }
                const r = await fetch(`${ctx.mcpBaseUrl}${ctx.mcpToken}`, {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${ctx.mcpToken}`, 'content-type': 'application/json' },
                    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'vault_read', arguments: { path: 'a.md' } } }),
                });
                const body: Foreign = await r.json();
                fake.toolResults.push(body.result);
                ctx.emit({ type: 'text-delta', text: body.result.content[0].text });
                return { kind: 'done', status: 'ok', sessionId: SESSION, usage: { outputTokens: 3 } };
            })();
            return {
                outcome,
                cancel() {
                    fake.cancelled++;
                    cancel();
                },
            };
        },
    };
}

let server: RunningServer;
let sessionsRoot: string;
let backend: FakeBackend;
let terminals: TerminalManager;

beforeAll(() => {
    sessionsRoot = mkdtempSync(join(tmpdir(), 'bme-sessions-'));
    backend = fakeBackend();
    terminals = new TerminalManager({
        backend,
        launch: async () => ({ file: '/fake/sh', args: ['-l'], env: { TERM: 'xterm-256color' }, cwd: sessionsRoot }),
    });
    server = startServer({
        ports: [0],
        policy: makeOriginPolicy([ORIGIN], false),
        context: {
            sessionsRoot,
            platform: 'macos',
            adapters: { claude: fakeAdapter('claude'), codex: fakeAdapter('codex'), opencode: fakeAdapter('opencode') },
            terminals,
            fontHints: async () => [{ source: 'ghostty', family: 'Fira Code' }],
            privacy: async () => ({ backend: 'inprocess', fullDiskAccess: null }),
        },
    });
});
afterAll(async () => {
    await terminals.closeAll();
    server.stop();
    rmSync(sessionsRoot, { recursive: true, force: true });
});

/** The shared harness, bound to this file's server. */
class Panel extends BasePanel {
    constructor() {
        super(server.port);
    }
}

const startParams = (runId: string, text = 'hello') => ({
    runId, vaultId: VAULT, agent: 'claude', sessionId: null, model: null, effort: null, text, images: [],
});

describe('HTTP surface', () => {
    test('/health: CORS for the exact origin only', async () => {
        const base = `http://127.0.0.1:${server.port}`;
        const plain = await fetch(`${base}/health`);
        expect(plain.status).toBe(200);
        // /health reports the machine it runs on (the release's test job runs on Linux), unlike
        // `hello`, which echoes the context's platform.
        expect(await plain.json()).toMatchObject({ app: 'vaultagent', protocol: 1, platform: helperPlatform() });
        expect(plain.headers.get('access-control-allow-origin')).toBeNull();
        const good = await fetch(`${base}/health`, { headers: { Origin: ORIGIN } });
        expect(good.headers.get('access-control-allow-origin')).toBe(ORIGIN);
        expect((await fetch(`${base}/health`, { headers: { Origin: 'https://evil.example' } })).status).toBe(403);
        const pre = await fetch(`${base}/health`, { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Private-Network': 'true' } });
        expect(pre.status).toBe(204);
        expect(pre.headers.get('access-control-allow-private-network')).toBe('true');
        expect((await fetch(`${base}/health`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } })).status).toBe(403);
        expect((await fetch(`${base}/nope`)).status).toBe(404);
    });

    test('Host must be the loopback name with our port (DNS rebinding)', async () => {
        const handle = createFetchHandler(makeOriginPolicy([ORIGIN], false), () => 47823);
        const req = (host: string, path = '/health', headers: Record<string, string> = {}) =>
            new Request(`http://127.0.0.1:47823${path}`, { headers: { host, ...headers } });
        const fakeServer = { upgrade: () => true } as never;
        expect((await handle(req('127.0.0.1:47823'), fakeServer))!.status).toBe(200);
        expect((await handle(req('localhost:47823'), fakeServer))!.status).toBe(200);
        for (const host of ['evil.example:47823', '127.0.0.1:1', 'attacker.test', '0.0.0.0:47823']) {
            expect((await handle(req(host), fakeServer))!.status).toBe(403);
            expect((await handle(req(host, '/ws', { origin: ORIGIN, upgrade: 'websocket' }), fakeServer))!.status).toBe(403);
        }
    });

    test('/ws refuses a missing or foreign Origin', async () => {
        const url = `http://127.0.0.1:${server.port}/ws`;
        const hdr = { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' };
        expect((await fetch(url, { headers: hdr })).status).toBe(403);
        expect((await fetch(url, { headers: { ...hdr, Origin: 'https://evil.example' } })).status).toBe(403);
        expect((await fetch(url, { headers: { ...hdr, Origin: 'http://localhost:5173' } })).status).toBe(403); // not --dev
    });

    test('/mcp: no browser, exact bearer, live token, size cap', async () => {
        const base = `http://127.0.0.1:${server.port}/mcp/`;
        const token = 'a'.repeat(43);
        const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
        expect((await fetch(base + token, { method: 'POST', body, headers: { Origin: ORIGIN, Authorization: `Bearer ${token}` } })).status).toBe(403);
        expect((await fetch(base + token, { method: 'POST', body })).status).toBe(401);
        expect((await fetch(base + token, { method: 'POST', body, headers: { Authorization: `Bearer ${'b'.repeat(43)}` } })).status).toBe(401);
        expect((await fetch(base + token, { method: 'POST', body, headers: { Authorization: `Bearer ${token}` } })).status).toBe(404); // no such run
        expect((await fetch(base + token, { method: 'GET', headers: { Authorization: `Bearer ${token}` } })).status).toBe(405);
        expect((await fetch(`${base}..%2F..%2Fhealth`, { method: 'POST', body })).status).toBe(401);
        const big = 'x'.repeat(MAX_MCP_BODY_BYTES + 10);
        const r = await fetch(base + token, { method: 'POST', body: big, headers: { Authorization: `Bearer ${token}` } });
        expect([404, 413]).toContain(r.status); // token checked first; size before parsing
    });
});

describe('WebSocket protocol', () => {
    test('hello', async () => {
        const p = await new Panel().open();
        const r = await p.request('hello', { protocol: 1 });
        expect(r.ok).toBe(true);
        expect((r as { result: Foreign }).result).toMatchObject({ protocol: 1, platform: 'macos', sessionsDir: sessionsRoot });
        p.ws.close();
    });

    test('a run: response first, then events, a forwarded tool call, exactly one run.done', async () => {
        const p = await new Panel().open();
        const r = await p.request('run.start', startParams('run-1'));
        expect(r).toMatchObject({ ok: true, result: { accepted: true } });
        const done = await p.next(m => m.type === 'run.done');
        expect(done).toMatchObject({ runId: 'run-1', sessionId: SESSION, status: 'ok', usage: { outputTokens: 3 } });

        const idx = (pred: (m: HelperMessage) => boolean) => p.messages.findIndex(pred);
        const iResp = idx(m => m.type === 'response');
        const iSession = idx(m => m.type === 'run.event' && m.event.type === 'session');
        const iCall = idx(m => m.type === 'tool.call');
        const iDelta = idx(m => m.type === 'run.event' && m.event.type === 'text-delta');
        expect(iResp).toBeLessThan(iSession); // queued until accepted
        expect(iSession).toBeLessThan(iCall);
        expect(iCall).toBeLessThan(iDelta);
        const call = p.messages[iCall] as Extract<HelperMessage, { type: 'tool.call' }>;
        expect(call).toMatchObject({ runId: 'run-1', name: 'vault_read', args: { path: 'a.md' } });
        expect((p.messages[iDelta] as { event: AgentEvent }).event).toEqual({ type: 'text-delta', text: 'read a.md' });
        expect(fake.toolResults.at(-1)).toEqual({ content: [{ type: 'text', text: 'read a.md' }], isError: false });
        expect(p.messages.filter(m => m.type === 'run.done' || m.type === 'run.error').length).toBe(1);

        // The cwd was created and the token is dead after the run.
        expect(fake.lastCtx!.cwd).toBe(join(sessionsRoot, VAULT));
        const token = fake.lastCtx!.mcpToken;
        const after = await fetch(`${fake.lastCtx!.mcpBaseUrl}${token}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: '{}' });
        expect(after.status).toBe(404);
        p.ws.close();
    });

    test('one run per connection; cancel ends it as cancelled', async () => {
        const p = await new Panel().open();
        expect((await p.request('run.start', startParams('run-2', 'wait'))).ok).toBe(true);
        const busy = await p.request('run.start', startParams('run-3'));
        expect(busy).toMatchObject({ ok: false, error: { code: 'busy' } });
        expect(await p.request('run.cancel', { runId: 'nope' })).toMatchObject({ ok: true, result: { cancelled: false } });
        expect(await p.request('run.cancel', { runId: 'run-2' })).toMatchObject({ ok: true, result: { cancelled: true } });
        expect(await p.next(m => m.type === 'run.done')).toMatchObject({ runId: 'run-2', status: 'cancelled' });
        // Free again.
        expect((await p.request('run.start', startParams('run-4'))).ok).toBe(true);
        await p.next(m => m.type === 'run.done' && m.runId === 'run-4');
        p.ws.close();
    });

    test('closing the socket cancels its run', async () => {
        const p = await new Panel().open();
        const before = fake.cancelled;
        expect((await p.request('run.start', startParams('run-5', 'wait'))).ok).toBe(true);
        p.ws.close();
        for (let i = 0; i < 50 && fake.cancelled === before; i++) await Bun.sleep(20);
        expect(fake.cancelled).toBe(before + 1);
    });

    test('validation before anything runs', async () => {
        const p = await new Panel().open();
        const bad = async (over: Record<string, unknown>) => p.request('run.start', { ...startParams(`bad-${Math.random().toString(36).slice(2)}`), ...over });
        for (const over of [
            { vaultId: '../../etc' }, { agent: 'bash' }, { sessionId: '../x' }, { model: '--dangerously-skip-permissions' },
            { effort: 'HIGH; rm' }, { text: 42 }, { runId: '../x' },
            { images: [{ mimeType: 'image/svg+xml', data: 'AAAA' }] }, { images: [{ mimeType: 'image/png', data: 'not base64!' }] },
            { images: Array.from({ length: 9 }, () => ({ mimeType: 'image/png', data: 'AAAA' })) },
        ]) {
            expect(await bad(over)).toMatchObject({ ok: false, error: { code: 'bad-request' } });
        }
        expect(await p.request('session.history', { vaultId: VAULT, agent: 'claude', sessionId: '../../x' })).toMatchObject({ ok: false, error: { code: 'bad-request' } });
        expect(await p.request('session.delete', { vaultId: 'x', agent: 'claude', sessionId: SESSION })).toMatchObject({ ok: false, error: { code: 'bad-request' } });
        expect(await p.request('nope.nope')).toMatchObject({ ok: false, error: { code: 'unsupported' } });
        p.ws.close();
    });

    test('status, models, history, delete, sync; uninstall refused when not installed', async () => {
        const p = await new Panel().open();
        expect(((await p.request('agents.status')) as { result: Foreign[] }).result.map(s => s.agent)).toEqual(['claude', 'codex', 'opencode']);
        expect(await p.request('models.list', { agent: 'codex' })).toMatchObject({ ok: true, result: [{ id: 'm' }] });
        expect(await p.request('session.history', { vaultId: VAULT, agent: 'opencode', sessionId: SESSION })).toMatchObject({ ok: true, result: { found: true } });
        expect(await p.request('session.delete', { vaultId: VAULT, agent: 'codex', sessionId: SESSION })).toMatchObject({ ok: true, result: { deleted: true } });
        expect(await p.request('vault.sync', { vaultId: VAULT, files: [{ path: 'AGENTS.md', text: 'be brief' }] })).toMatchObject({ ok: true, result: { written: 1, removed: 0 } });
        expect(readFileSync(join(sessionsRoot, VAULT, 'AGENTS.md'), 'utf8')).toBe('be brief');
        expect(await p.request('vault.sync', { vaultId: VAULT, files: [{ path: '.mcp.json', text: '{}' }] })).toMatchObject({ ok: false, error: { code: 'bad-request' } });
        expect(await p.request('helper.uninstall')).toMatchObject({ ok: false, error: { code: 'unsupported' } });
        p.ws.close();
    });

    test('a helper with no updater (source / --no-register): no update offered, update refused', async () => {
        const p = await new Panel().open();
        expect(await p.request('helper.checkUpdate', { force: true })).toMatchObject({ ok: true, result: { available: false, installed: false, latest: null } });
        expect(await p.request('helper.update')).toMatchObject({ ok: false, error: { code: 'unsupported' } });
        expect(p.messages.some(m => m.type === 'update.progress')).toBe(false);
        p.ws.close();
    });
});

describe('terminal over the socket', () => {
    const id = () => crypto.randomUUID();
    const outputOf = (p: BasePanel, termId: string) =>
        p.messages.flatMap(m => (m.type === 'terminal.output' && m.termId === termId ? [m.data] : [])).join('');

    test('open, input, output, resize, close', async () => {
        const p = await new Panel().open();
        const termId = id();
        const opened = await p.request('terminal.open', { termId, cols: 100, rows: 30 });
        expect(opened).toMatchObject({ ok: true, result: { shell: '/fake/sh', pid: 1000 + backend.spawned.length - 1, backend: 'inprocess' } });
        const pty = backend.spawned.at(-1)!;
        expect(pty.size).toEqual({ cols: 100, rows: 30 });

        p.send({ type: 'terminal.input', termId, data: 'echo hi\r' });
        for (let i = 0; i < 50 && !pty.written.length; i++) await Bun.sleep(10);
        expect(pty.written).toEqual(['echo hi\r']);

        pty.emit('hi\r\n');
        await p.next(m => m.type === 'terminal.output' && m.termId === termId);
        expect(outputOf(p, termId)).toBe('hi\r\n');
        // Acknowledged, so it stops counting against the flow-control budget.
        p.send({ type: 'terminal.ack', termId, chars: 4 });

        expect(await p.request('terminal.resize', { termId, cols: 90, rows: 20 })).toMatchObject({ ok: true });
        expect(pty.size).toEqual({ cols: 90, rows: 20 });

        expect(await p.request('terminal.close', { termId })).toMatchObject({ ok: true });
        expect(pty.kills).toBe(1);
        expect(await p.request('terminal.resize', { termId, cols: 90, rows: 20 })).toMatchObject({ ok: false, error: { code: 'not-found' } });
        p.ws.close();
    });

    test('a shell that ends reports terminal.exit after its last output', async () => {
        const p = await new Panel().open();
        const termId = id();
        await p.request('terminal.open', { termId, cols: 80, rows: 24 });
        const pty = backend.spawned.at(-1)!;
        pty.emit('bye\r\n');
        pty.end({ code: 3, signal: null });
        const exit = await p.next(m => m.type === 'terminal.exit' && m.termId === termId);
        expect(exit).toMatchObject({ code: 3, signal: null });
        const iOut = p.messages.findIndex(m => m.type === 'terminal.output' && m.termId === termId);
        expect(iOut).toBeGreaterThanOrEqual(0);
        expect(iOut).toBeLessThan(p.messages.indexOf(exit));
        await p.request('terminal.close', { termId });
        p.ws.close();
    });

    test('a closed socket detaches; another one re-attaches with the screen and steals it', async () => {
        const first = await new Panel().open();
        const termId = id();
        await first.request('terminal.open', { termId, cols: 80, rows: 24 });
        const pty = backend.spawned.at(-1)!;
        pty.emit('one\r\ntwo');
        first.ws.close();
        for (let i = 0; i < 50 && terminals.count() === 0; i++) await Bun.sleep(10);
        await Bun.sleep(50);
        expect(pty.kills).toBe(0); // still running, detached

        const second = await new Panel().open();
        const attached = await second.request('terminal.attach', { termId, cols: 80, rows: 24 });
        expect(attached).toMatchObject({ ok: true, result: { shell: '/fake/sh', exited: null } });
        const snapshot = (attached as { result: { snapshot: string } }).result.snapshot;
        expect(snapshot).toContain('one');
        expect(snapshot).toContain('two');

        // Output after the attach follows the response, never precedes it.
        pty.emit('!');
        await second.next(m => m.type === 'terminal.output' && m.termId === termId);
        expect(second.messages.findIndex(m => m.type === 'terminal.output')).toBeGreaterThan(second.messages.findIndex(m => m.type === 'response'));

        const third = await new Panel().open();
        await third.request('terminal.attach', { termId, cols: 80, rows: 24 });
        await second.next(m => m.type === 'terminal.detached' && m.termId === termId);
        // The old owner can no longer type into it.
        second.send({ type: 'terminal.input', termId, data: 'nope' });
        third.send({ type: 'terminal.input', termId, data: 'yes' });
        for (let i = 0; i < 50 && !pty.written.length; i++) await Bun.sleep(10);
        expect(pty.written).toEqual(['yes']);
        await third.request('terminal.close', { termId });
        second.ws.close();
        third.ws.close();
    });

    test('validation and the per-connection limit', async () => {
        const p = await new Panel().open();
        expect(await p.request('terminal.open', { termId: '../x', cols: 80, rows: 24 })).toMatchObject({ ok: false, error: { code: 'bad-request' } });
        expect(await p.request('terminal.open', { termId: id(), cols: 'wide', rows: 24 })).toMatchObject({ ok: false, error: { code: 'bad-request' } });
        const ids = Array.from({ length: MAX_TERMINALS }, id);
        for (const termId of ids) expect(await p.request('terminal.open', { termId, cols: 80, rows: 24 })).toMatchObject({ ok: true });
        expect(await p.request('terminal.open', { termId: id(), cols: 80, rows: 24 })).toMatchObject({ ok: false, error: { code: 'limit' } });
        // The same id twice is refused, not silently re-spawned.
        expect(await p.request('terminal.open', { termId: ids[0], cols: 80, rows: 24 })).toMatchObject({ ok: false, error: { code: 'bad-request' } });
        for (const termId of ids) await p.request('terminal.close', { termId });
        p.ws.close();
    });

    test('font hints and privacy answer', async () => {
        const p = await new Panel().open();
        expect(await p.request('terminal.fontHint')).toMatchObject({ ok: true, result: { candidates: [{ source: 'ghostty', family: 'Fira Code' }] } });
        expect(await p.request('terminal.privacy')).toMatchObject({ ok: true, result: { backend: 'inprocess', fullDiskAccess: null } });
        // Not an installed helper: no PTY host to show.
        expect(await p.request('helper.revealPtyHost')).toMatchObject({ ok: false, error: { code: 'unsupported' } });
        p.ws.close();
    });
});

// The same round trip through a real PTY and a real shell (what a user's keystrokes reach).
describe.skipIf(process.platform === 'win32')('terminal over the socket, real /bin/sh', () => {
    test('type a command, see its output, exit', async () => {
        const real = new TerminalManager({
            backend: inProcessBackend(),
            launch: async () => ({ file: '/bin/sh', args: [], env: { PATH: process.env.PATH ?? '/usr/bin:/bin', TERM: 'xterm-256color', PS1: '$ ' }, cwd: tmpdir() }),
        });
        const own = startServer({
            ports: [0],
            policy: makeOriginPolicy([ORIGIN], false),
            context: { sessionsRoot, platform: 'linux', adapters: { claude: fakeAdapter('claude'), codex: fakeAdapter('codex'), opencode: fakeAdapter('opencode') }, terminals: real },
        });
        try {
            const p = await new BasePanel(own.port).open();
            const termId = crypto.randomUUID();
            expect(await p.request('terminal.open', { termId, cols: 80, rows: 24 })).toMatchObject({ ok: true, result: { shell: '/bin/sh', backend: 'inprocess' } });
            const marker = `marker-${crypto.randomUUID().slice(0, 8)}`;
            p.send({ type: 'terminal.input', termId, data: `echo ${marker}$((6*7))\r` });
            await p.next(m => m.type === 'terminal.output' && m.data.includes(`${marker}42`));
            p.send({ type: 'terminal.input', termId, data: 'exit 7\r' });
            expect(await p.next(m => m.type === 'terminal.exit')).toMatchObject({ termId, code: 7 });
            expect(await p.request('terminal.close', { termId })).toMatchObject({ ok: true });
            p.ws.close();
        } finally {
            await real.closeAll();
            own.stop();
        }
    });
});
