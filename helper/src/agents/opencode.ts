// OpenCode adapter: one `opencode serve` on a free loopback port per message
// (and per history/delete/model query), driven over its HTTP API + SSE.
//
// Verified against opencode 1.18.29 by running `opencode serve` with scratch
// XDG_* folders against a local fake OpenAI-compatible provider and reading the
// chat-completions request (recordings in helper/test/fixtures/opencode/, provenance in helper/test/adapters.test.ts): the
// model was offered exactly skill, websearch and our vault_* tools —
// also when the global config allowed everything (`"*": "allow"`, bash, read),
// defined its own MCP server and shipped a plugin.
//
// Why each layer (the global config is still read, so the user's providers,
// models and credentials keep working exactly as in their terminal):
//   • our own agent `vaultagent` with `"*": "deny"` first: per-agent rules are
//     evaluated after the top-level ones and the last match wins, so nothing in
//     the user's config can re-enable a tool for this agent;
//   • OPENCODE_PURE=1: no external plugins load (verified: a plugin in the global
//     config dir did not run). Plugins are code, not just tools;
//   • every MCP server of the user's is set `enabled: false` (verified: not even
//     contacted); unknown ones would still be denied by the rule above;
//   • OPENCODE_DISABLE_PROJECT_CONFIG=1: no opencode.json / .opencode found by
//     walking up from the working folder (e.g. in ~), so AGENTS.md / CLAUDE.md
//     are named explicitly in `instructions` instead.
// Custom tools in the user's global config folder are still imported by
// OpenCode at startup (it does that for every session); they are denied and
// never offered to the model.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { Subprocess } from 'bun';
import {
    MCP_SERVER_NAME, TOOL_CALL_TIMEOUT_MS,
    type AgentEvent, type AgentStatus, type HistoryItem, type ModelInfo, type RunUsage,
} from '../../../shared/vaultAgentProtocol.ts';
import { agentEnv, drainTail, runCapture, stopProcess } from '../proc.ts';
import { VAULT_AGENT_PROMPT } from '../prompt.ts';
import { findAgentBinary, parseVersion, type FoundBinary } from './discover.ts';
import {
    MCP_TOKEN_ENV, RunRefused, SAFE_EFFORT_RE, SAFE_MODEL_RE, truncate,
    type AgentAdapter, type Foreign, type RunContext, type RunHandle, type RunOutcome,
} from './types.ts';

const IS_WIN = process.platform === 'win32';
export const OPENCODE_AGENT = 'vaultagent';
/** OpenCode names MCP tools `<server>_<tool>`: ours are `vault_vault_read`, `vault_canvas_apply`. */
const OWN_TOOL_PREFIX = `${MCP_SERVER_NAME}_`;

/**
 * Order matters: OpenCode applies the LAST matching rule, so the catch-all deny goes first.
 *
 * `webfetch` stays DENIED, unlike Claude's WebFetch: OpenCode's fetches plain
 * http and follows redirects, so it read the helper's own /health on
 * 127.0.0.1 — directly and through a public https redirect (verified) — i.e.
 * any unauthenticated local service (a dev server's /@fs/, Jupyter, a router
 * page) was one prompt injection away. 1.18.29's config takes no URL patterns
 * for it. `websearch` (Exa, which returns the pages' text) is the web access.
 */
export const OPENCODE_PERMISSION: Record<string, string> = {
    '*': 'deny',
    [`${OWN_TOOL_PREFIX}*`]: 'allow',
    skill: 'allow',
    websearch: 'allow',
};

/**
 * Give the vault's working folder its OWN OpenCode project. OpenCode files
 * every folder outside a git repository under one shared "global" project, so
 * the panel's sessions showed up in `opencode session list` (and `--continue`)
 * in any non-git folder the user works in — interference with their own use.
 * A git repo gets its own project, whose id OpenCode reads from
 * `<git dir>/opencode` before asking git for a root commit (verified against
 * 1.18.29: a session created here carried exactly this id). The repo is laid
 * out by hand — HEAD, config, empty objects/refs — so the helper never runs
 * git (on a Mac without the command-line tools that pops an install dialog).
 * Nothing is committed and nothing else in the folder changes.
 */
export function ensureOpencodeProject(cwd: string): void {
    const git = join(cwd, '.git');
    try {
        if (!existsSync(join(git, 'HEAD'))) {
            mkdirSync(join(git, 'objects'), { recursive: true });
            mkdirSync(join(git, 'refs', 'heads'), { recursive: true });
            writeFileSync(join(git, 'config'), '[core]\n\trepositoryformatversion = 0\n\tbare = false\n');
            writeFileSync(join(git, 'HEAD'), 'ref: refs/heads/main\n');
        }
        const idFile = join(git, 'opencode');
        if (!existsSync(idFile)) {
            // Stable per vault folder, in OpenCode's own id shape (40 hex).
            writeFileSync(idFile, createHash('sha1').update(`bme-agent-sessions:${basename(cwd)}`).digest('hex'));
        }
    } catch {
        // Worst case the sessions land in OpenCode's shared project, as before.
    }
}

/** A free loopback port for `opencode serve`: its `--port 0` binds OpenCode's
 *  default 4096 (observed), colliding with the user's own `opencode serve`. */
async function freeLoopbackPort(): Promise<number> {
    return new Promise((res, rej) => {
        const srv = createServer();
        srv.unref();
        srv.once('error', rej);
        srv.listen(0, '127.0.0.1', () => {
            const addr = srv.address();
            const port = typeof addr === 'object' && addr ? addr.port : 0;
            srv.close(() => (port ? res(port) : rej(new Error('no free port'))));
        });
    });
}

/** Strips // and /* *\/ comments and trailing commas (JSONC → JSON), respecting strings. */
export function stripJsonc(text: string): string {
    let out = '';
    let i = 0;
    let inStr = false;
    while (i < text.length) {
        const c = text[i];
        if (inStr) {
            out += c;
            if (c === '\\') {
                out += text[i + 1] ?? '';
                i += 2;
                continue;
            }
            if (c === '"') inStr = false;
            i++;
            continue;
        }
        if (c === '"') {
            inStr = true;
            out += c;
            i++;
        } else if (c === '/' && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n') i++;
        } else if (c === '/' && text[i + 1] === '*') {
            i += 2;
            while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
            i += 2;
        } else {
            out += c;
            i++;
        }
    }
    return out.replace(/,(\s*[}\]])/g, '$1');
}

/** Config files OpenCode reads outside the working folder (read here, never written). */
export function opencodeGlobalConfigFiles(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
    const xdg = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim() ? env.XDG_CONFIG_HOME : join(home, '.config');
    const dirs = [join(xdg, 'opencode'), join(home, '.opencode'), ...(env.OPENCODE_CONFIG_DIR ? [env.OPENCODE_CONFIG_DIR] : [])];
    const files = dirs.flatMap(d => ['config.json', 'opencode.json', 'opencode.jsonc'].map(f => join(d, f)));
    if (env.OPENCODE_CONFIG) files.push(env.OPENCODE_CONFIG);
    return files;
}

export function userOpencodeMcpServers(files = opencodeGlobalConfigFiles()): string[] {
    const names = new Set<string>();
    for (const f of files) {
        try {
            if (!existsSync(f)) continue;
            const cfg = JSON.parse(stripJsonc(readFileSync(f, 'utf8')));
            if (cfg?.mcp && typeof cfg.mcp === 'object') for (const k of Object.keys(cfg.mcp)) names.add(k);
        } catch { /* unreadable config: its servers stay denied by the permission rule */ }
    }
    return [...names];
}

export interface OpencodeConfigInput {
    cwd: string;
    /** null for a serve that runs no turn (models, history, delete): no MCP server at all. */
    mcpBaseUrl: string | null;
    userMcpServers: string[];
}

/** OPENCODE_CONFIG_CONTENT — merged last, over the user's config. Pure; the containment tests assert on it. */
export function buildOpencodeConfig(input: OpencodeConfigInput): Record<string, unknown> {
    const mcp: Record<string, unknown> = {};
    for (const name of input.userMcpServers) if (name !== MCP_SERVER_NAME) mcp[name] = { enabled: false };
    if (input.mcpBaseUrl) {
        mcp[MCP_SERVER_NAME] = {
            type: 'remote',
            // `{env:X}` is substituted by OpenCode (verified in url and headers):
            // the run token stays out of argv and out of the config text.
            url: `${input.mcpBaseUrl}{env:${MCP_TOKEN_ENV}}`,
            headers: { Authorization: `Bearer {env:${MCP_TOKEN_ENV}}` },
            oauth: false,
            enabled: true,
            // Per tool call; longer than ours so our timeout is the one the model reads.
            timeout: TOOL_CALL_TIMEOUT_MS + 30_000,
        };
    } else {
        mcp[MCP_SERVER_NAME] = { type: 'remote', url: 'http://127.0.0.1:9/', enabled: false };
    }
    return {
        $schema: 'https://opencode.ai/config.json',
        share: 'disabled',
        autoupdate: false,
        snapshot: false,   // snapshots are git commits of the working folder
        lsp: false,
        formatter: false,
        instructions: [join(input.cwd, 'AGENTS.md'), join(input.cwd, 'CLAUDE.md')],
        permission: OPENCODE_PERMISSION,
        mcp,
        agent: {
            [OPENCODE_AGENT]: {
                mode: 'primary',
                description: 'browserMarkdownEditor vault agent',
                permission: OPENCODE_PERMISSION,
            },
        },
    };
}

export function opencodeEnv(bin: FoundBinary, password: string, config: Record<string, unknown>, token: string | null): Record<string, string> {
    return agentEnv(bin.pathDirs, {
        OPENCODE_SERVER_USERNAME: 'opencode',
        OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
        OPENCODE_PURE: '1',
        OPENCODE_DISABLE_PROJECT_CONFIG: '1',
        // OpenCode offers `websearch` only for its own provider unless one of these
        // is set (verified in 1.18.29's tool registry); Exa's endpoint needs no key.
        OPENCODE_ENABLE_EXA: '1',
        OPENCODE_DISABLE_AUTOUPDATE: '1',
        OPENCODE_DISABLE_SHARE: '1',
        OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
        // An inherited permission override must not widen our agent's rules.
        OPENCODE_PERMISSION: undefined,
        [MCP_TOKEN_ENV]: token ?? undefined,
    });
}

export function buildOpencodeServeArgs(port: number): string[] {
    return ['serve', '--hostname', '127.0.0.1', '--port', String(port), '--pure'];
}

/* ───────────────────────── one serve process ───────────────────────── */

export class OpencodeServer {
    private constructor(readonly proc: Subprocess<'pipe', 'pipe', 'pipe'>, readonly base: string, private readonly auth: string) {}

    static async start(bin: FoundBinary, cwd: string, mcpBaseUrl: string | null, token: string | null): Promise<OpencodeServer> {
        const password = randomBytes(24).toString('base64url');
        const config = buildOpencodeConfig({ cwd, mcpBaseUrl, userMcpServers: userOpencodeMcpServers() });
        const proc = Bun.spawn([...bin.command, ...buildOpencodeServeArgs(await freeLoopbackPort())], {
            cwd,
            env: opencodeEnv(bin, password, config, token),
            stdin: 'ignore' as never,
            stdout: 'pipe',
            stderr: 'pipe',
            windowsHide: true,
        }) as unknown as Subprocess<'pipe', 'pipe', 'pipe'>;
        void drainTail(proc.stderr).catch(() => {});
        const base = await new Promise<string | null>(res => {
            const timer = setTimeout(() => res(null), 30_000);
            (async () => {
                const decoder = new TextDecoder();
                let buf = '';
                for await (const chunk of proc.stdout) {
                    buf += decoder.decode(chunk, { stream: true });
                    const m = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(buf);
                    if (m) {
                        clearTimeout(timer);
                        res(m[1]);
                        break;
                    }
                    if (buf.length > 64_000) buf = buf.slice(-4000);
                }
                res(null);
            })().catch(() => res(null));
        });
        void drainTail(proc.stdout).catch(() => {});
        if (!base) {
            void stopProcess(proc);
            throw new RunRefused('crashed', 'OpenCode did not start.');
        }
        return new OpencodeServer(proc, base, `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`);
    }

    async request(method: string, path: string, body?: unknown, timeoutMs = 30_000): Promise<Response> {
        return fetch(this.base + path, {
            method,
            headers: { Authorization: this.auth, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
        });
    }

    async json<T = Foreign>(method: string, path: string, body?: unknown): Promise<T> {
        const r = await this.request(method, path, body);
        if (!r.ok) throw Object.assign(new Error(`opencode ${method} ${path} → ${r.status}`), { status: r.status });
        const text = await r.text();
        return (text ? JSON.parse(text) : null) as T;
    }

    /** SSE `/event`, one parsed event per callback, until `signal` aborts or the server goes. */
    async events(onEvent: (ev: Foreign) => void, signal: AbortSignal): Promise<void> {
        const r = await fetch(`${this.base}/event`, { headers: { Authorization: this.auth, accept: 'text/event-stream' }, signal });
        if (!r.ok || !r.body) throw new Error(`opencode /event → ${r.status}`);
        const decoder = new TextDecoder();
        let buf = '';
        for await (const chunk of r.body) {
            buf += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
            let k: number;
            while ((k = buf.indexOf('\n\n')) >= 0) {
                const block = buf.slice(0, k);
                buf = buf.slice(k + 2);
                const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
                if (!data) continue;
                try {
                    onEvent(JSON.parse(data));
                } catch { /* not JSON: ignore */ }
            }
        }
    }

    stop(): Promise<void> {
        return stopProcess(this.proc, 2000);
    }
}

/* ───────────────────────── events → AgentEvents ───────────────────────── */

export interface OpencodeError { name: string; message: string }

/** Maps `/event` payloads for one session. Pure; fixture-tested. */
export class OpencodeEventMapper {
    busySeen = false;
    idle = false;
    error: OpencodeError | null = null;
    usage: RunUsage = {};
    private readonly partTypes = new Map<string, string>();
    private readonly userMessages = new Set<string>();
    private readonly assistantTokens = new Map<string, { input: number; output: number; cost: number }>();
    private readonly toolStates = new Map<string, string>();

    constructor(private readonly sessionId: string, private readonly emit: (e: AgentEvent) => void) {}

    feed(ev: Foreign): void {
        const p = ev?.properties;
        if (!p || typeof p !== 'object') return;
        const sid = p.sessionID ?? p.info?.sessionID ?? p.part?.sessionID;
        if (sid !== this.sessionId) return;
        switch (ev.type) {
            case 'session.status':
                if (p.status?.type === 'busy') this.busySeen = true;
                else if (p.status?.type === 'idle' && this.busySeen) this.idle = true;
                return;
            case 'session.idle':
                if (this.busySeen) this.idle = true;
                return;
            case 'session.error':
                if (p.error) this.error = { name: String(p.error.name ?? 'Error'), message: String(p.error.data?.message ?? p.error.message ?? p.error.name ?? 'OpenCode error') };
                return;
            case 'message.updated': {
                const info = p.info;
                if (info?.role === 'user') this.userMessages.add(info.id);
                else if (info?.role === 'assistant') {
                    this.busySeen = true;
                    const t = info.tokens;
                    if (t) this.assistantTokens.set(info.id, { input: (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0), output: (t.output ?? 0) + (t.reasoning ?? 0), cost: info.cost ?? 0 });
                    if (info.error && !this.error) this.error = { name: String(info.error.name ?? 'Error'), message: String(info.error.data?.message ?? info.error.name ?? '') };
                    let input = 0, output = 0, cost = 0;
                    for (const v of this.assistantTokens.values()) {
                        input += v.input;
                        output += v.output;
                        cost += v.cost;
                    }
                    this.usage = { inputTokens: input, outputTokens: output, ...(cost ? { costUsd: cost } : {}) };
                }
                return;
            }
            case 'message.part.updated': {
                const part = p.part;
                if (!part || typeof part.id !== 'string') return;
                this.partTypes.set(part.id, part.type);
                if (part.type === 'tool') this.tool(part);
                return;
            }
            case 'message.part.delta': {
                if (typeof p.delta !== 'string' || !p.delta || p.field !== 'text') return;
                if (this.userMessages.has(p.messageID)) return;
                const type = this.partTypes.get(p.partID);
                if (type === 'reasoning') this.emit({ type: 'reasoning-delta', text: p.delta });
                else if (type === undefined || type === 'text') this.emit({ type: 'text-delta', text: p.delta });
                return;
            }
        }
    }

    private tool(part: Foreign): void {
        const name = String(part.tool ?? '');
        // Ours reach the panel as `tool.call`; never twice.
        if (!name || name.startsWith(OWN_TOOL_PREFIX)) return;
        const status = part.state?.status;
        const mapped = status === 'completed' ? 'done' : status === 'error' ? 'error' : 'running';
        const key = String(part.callID ?? part.id);
        if (this.toolStates.get(key) === mapped) return;
        this.toolStates.set(key, mapped);
        this.emit({
            type: 'tool',
            callId: key,
            name,
            input: part.state?.input,
            status: mapped,
            ...(mapped === 'done' ? { output: truncate(String(part.state?.output ?? '')) } : {}),
            ...(mapped === 'error' ? { output: truncate(String(part.state?.error ?? '')) } : {}),
        });
    }
}

export function opencodeOutcome(m: OpencodeEventMapper, sessionId: string, cancelled: boolean, crashed: string | null): RunOutcome {
    if (cancelled || m.error?.name === 'MessageAbortedError') return { kind: 'done', status: 'cancelled', sessionId, usage: m.usage };
    if (m.error) {
        if (m.error.name === 'ProviderAuthError') return { kind: 'error', reason: 'logged-out', message: `OpenCode is not logged in to that provider. Run \`opencode auth login\` in a terminal. (${truncate(m.error.message, 200)})` };
        return { kind: 'error', reason: 'crashed', message: truncate(m.error.message || m.error.name, 500) };
    }
    if (crashed) return { kind: 'error', reason: 'crashed', message: crashed };
    return { kind: 'done', status: 'ok', sessionId, usage: m.usage };
}

/* ───────────────────────── history & models ───────────────────────── */

export function mapOpencodeMessages(messages: Foreign[]): HistoryItem[] {
    const out: HistoryItem[] = [];
    for (const msg of Array.isArray(messages) ? messages : []) {
        const role = msg?.info?.role;
        const parts: Foreign[] = Array.isArray(msg?.parts) ? msg.parts : [];
        if (role === 'user') {
            const text = parts.filter(p => p?.type === 'text' && !p.synthetic).map(p => String(p.text ?? '')).join('\n');
            const imageCount = parts.filter(p => p?.type === 'file' && String(p.mime ?? '').startsWith('image/')).length;
            if (text || imageCount) out.push({ kind: 'user', text, imageCount });
        } else if (role === 'assistant') {
            for (const p of parts) {
                if (p?.type === 'text' && p.text && !p.synthetic) out.push({ kind: 'assistant', text: String(p.text) });
                else if (p?.type === 'reasoning' && p.text) out.push({ kind: 'reasoning', text: String(p.text) });
                else if (p?.type === 'tool' && typeof p.tool === 'string') {
                    const st = p.state ?? {};
                    out.push({
                        kind: 'tool',
                        name: p.tool.startsWith(OWN_TOOL_PREFIX) ? p.tool.slice(OWN_TOOL_PREFIX.length) : p.tool,
                        input: st.input,
                        output: st.status === 'completed' ? truncate(String(st.output ?? '')) : st.status === 'error' ? truncate(String(st.error ?? '')) : undefined,
                        ...(st.status === 'error' ? { isError: true } : {}),
                    });
                }
            }
        }
    }
    return out;
}

/** `GET /config/providers` (+ the configured default model) → ModelInfo[]. */
export function mapOpencodeModels(providersRes: Foreign, configuredModel: string | null): ModelInfo[] {
    const out: ModelInfo[] = [];
    const providers: Foreign[] = Array.isArray(providersRes?.providers) ? providersRes.providers : [];
    for (const p of providers) {
        if (typeof p?.id !== 'string' || !p.models || typeof p.models !== 'object') continue;
        for (const m of Object.values<Foreign>(p.models)) {
            if (typeof m?.id !== 'string') continue;
            const id = `${p.id}/${m.id}`;
            if (!SAFE_MODEL_RE.test(id)) continue;
            const efforts = Object.keys(m.variants ?? {}).filter(e => SAFE_EFFORT_RE.test(e));
            out.push({
                id,
                label: `${m.name ?? m.id} · ${p.name ?? p.id}`,
                efforts,
                defaultEffort: null, // no variant = the model's own default
                images: m.capabilities?.input?.image === true,
                ...(configuredModel === id ? { isDefault: true } : {}),
            });
        }
    }
    return out;
}

const SESSION_RE = /^ses_[A-Za-z0-9]{8,64}$/;

function sameDir(a: string, b: string): boolean {
    const x = resolve(a), y = resolve(b);
    return IS_WIN ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/* ───────────────────────── adapter ───────────────────────── */

export function createOpencodeAdapter(opts: { sessionsRoot: string }): AgentAdapter {
    let statusCache: { at: number; status: AgentStatus } | null = null;
    let modelCache: { at: number; models: ModelInfo[] } | null = null;

    async function withServer<T>(cwd: string, fn: (s: OpencodeServer) => Promise<T>): Promise<T> {
        const bin = await findAgentBinary('opencode');
        if (!bin) throw new RunRefused('agent-missing', 'OpenCode is not installed.');
        // A vault's folder, never the sessions root (the model listing runs
        // there): a repo at the root would contain every vault folder.
        if (resolve(cwd) !== resolve(opts.sessionsRoot)) ensureOpencodeProject(cwd);
        const server = await OpencodeServer.start(bin, cwd, null, null);
        try {
            return await fn(server);
        } finally {
            void server.stop();
        }
    }

    async function loadModels(): Promise<ModelInfo[]> {
        return withServer(opts.sessionsRoot, async s => {
            const [providers, config] = await Promise.all([s.json('GET', '/config/providers'), s.json('GET', '/config').catch(() => null)]);
            return mapOpencodeModels(providers, typeof config?.model === 'string' ? config.model : null);
        });
    }

    return {
        id: 'opencode',
        isValidSessionId: (id): id is string => typeof id === 'string' && SESSION_RE.test(id),
        isValidModel: (id): id is string => typeof id === 'string' && SAFE_MODEL_RE.test(id) && id.includes('/'),

        async status(refresh) {
            if (statusCache && !refresh && Date.now() - statusCache.at < 30_000) return statusCache.status;
            const bin = await findAgentBinary('opencode', refresh);
            const base: AgentStatus = {
                agent: 'opencode', installed: !!bin, version: null, loggedIn: null, incompatible: null,
                loginCommand: 'opencode auth login',
                installCommand: IS_WIN ? 'npm install -g opencode-ai' : 'curl -fsSL https://opencode.ai/install | bash',
            };
            if (!bin) return (statusCache = { at: Date.now(), status: { ...base, loggedIn: false } }).status;
            const ver = await runCapture([...bin.command, '--version'], { env: agentEnv(bin.pathDirs), timeoutMs: 15_000 });
            // "Logged in" for OpenCode = at least one model it can actually use.
            let loggedIn: boolean | null = null;
            try {
                const models = await loadModels();
                modelCache = { at: Date.now(), models };
                loggedIn = models.length > 0;
            } catch { /* could not tell */ }
            return (statusCache = { at: Date.now(), status: { ...base, version: parseVersion(ver.stdout), loggedIn } }).status;
        },

        async models(refresh) {
            if (modelCache && !refresh && Date.now() - modelCache.at < 10 * 60_000) return modelCache.models;
            const models = await loadModels();
            modelCache = { at: Date.now(), models };
            return models;
        },

        async start(ctx: RunContext): Promise<RunHandle> {
            const bin = await findAgentBinary('opencode');
            if (!bin) throw new RunRefused('agent-missing', 'OpenCode is not installed.');
            ensureOpencodeProject(ctx.cwd);
            const server = await OpencodeServer.start(bin, ctx.cwd, ctx.mcpBaseUrl, ctx.mcpToken);
            const abort = new AbortController();
            let sessionId: string;
            let mapper: OpencodeEventMapper | null = null;
            const early: Foreign[] = [];
            let eventsDone: Promise<void>;
            try {
                // Subscribe before prompting so no event is missed.
                eventsDone = server.events(ev => (mapper ? mapper.feed(ev) : early.push(ev)), abort.signal).catch(() => {});
                if (ctx.sessionId) {
                    const r = await server.request('GET', `/session/${ctx.sessionId}`);
                    if (r.status === 404) throw new RunRefused('bad-request', 'This chat’s OpenCode session is not on this computer.');
                    const info: Foreign = await r.json();
                    if (!info?.directory || !sameDir(info.directory, ctx.cwd)) throw new RunRefused('bad-request', 'That OpenCode session belongs to another folder.');
                    sessionId = ctx.sessionId;
                } else {
                    const created: Foreign = await server.json('POST', '/session', { permission: Object.entries(OPENCODE_PERMISSION).map(([permission, action]) => ({ permission, pattern: '*', action })) })
                        .catch(() => server.json('POST', '/session', {}));
                    sessionId = created?.id;
                    if (typeof sessionId !== 'string' || !SESSION_RE.test(sessionId)) throw new RunRefused('agent-changed', 'OpenCode answered in a shape VaultAgent does not know.');
                }
                ctx.emit({ type: 'session', sessionId });
                mapper = new OpencodeEventMapper(sessionId, ctx.emit);
                for (const ev of early) mapper.feed(ev);

                const [providerID, ...rest] = (ctx.model ?? '').split('/');
                const body = {
                    agent: OPENCODE_AGENT,
                    system: VAULT_AGENT_PROMPT,
                    ...(ctx.model ? { model: { providerID, modelID: rest.join('/') } } : {}),
                    ...(ctx.effort ? { variant: ctx.effort } : {}),
                    parts: [
                        { type: 'text', text: ctx.text },
                        ...ctx.images.map((img, i) => ({ type: 'file', mime: img.mimeType, filename: `image-${i + 1}.${img.mimeType.split('/')[1]}`, url: `data:${img.mimeType};base64,${img.data}` })),
                    ],
                };
                const r = await server.request('POST', `/session/${sessionId}/prompt_async`, body);
                if (!r.ok) throw new RunRefused(r.status === 400 ? 'bad-request' : 'crashed', `OpenCode refused the message (${r.status}).`);
            } catch (e) {
                abort.abort();
                void server.stop();
                if (e instanceof RunRefused) throw e;
                throw new RunRefused('crashed', e instanceof Error ? truncate(e.message, 300) : 'OpenCode failed.');
            }

            const m = mapper;
            let cancelled = false;
            // Nobody can answer a permission prompt; anything that asks is refused
            // (with `"*": "deny"` nothing should ask, this is the backstop).
            const answered = new Set<string>();
            const original = m.feed.bind(m);
            m.feed = (ev: Foreign) => {
                original(ev);
                const p = ev?.properties;
                if (p?.sessionID !== sessionId || typeof p?.id !== 'string' || answered.has(p.id)) return;
                if (ev.type === 'permission.asked') {
                    answered.add(p.id);
                    void server.request('POST', `/permission/${p.id}/reply`, { reply: 'reject' }).catch(() => {});
                } else if (ev.type === 'question.asked') {
                    answered.add(p.id);
                    void server.request('POST', `/question/${p.id}/reject`, {}).catch(() => {});
                }
            };

            const outcome = (async (): Promise<RunOutcome> => {
                let crashed: string | null = null;
                await new Promise<void>(res => {
                    const tick = setInterval(() => {
                        if (m.idle) finish();
                    }, 50);
                    const finish = () => {
                        clearInterval(tick);
                        res();
                    };
                    server.proc.exited.then(() => {
                        if (!m.idle) crashed = 'OpenCode exited unexpectedly.';
                        finish();
                    });
                    void eventsDone.then(() => {
                        if (!m.idle && !abort.signal.aborted) {
                            crashed = 'Lost the connection to OpenCode.';
                            finish();
                        }
                    });
                });
                abort.abort();
                await server.stop();
                return opencodeOutcome(m, sessionId, cancelled, crashed);
            })().catch((e): RunOutcome => ({ kind: 'error', reason: 'crashed', message: e instanceof Error ? e.message : 'OpenCode failed.' }));

            return {
                outcome,
                cancel() {
                    if (cancelled) return;
                    cancelled = true;
                    void server.request('POST', `/session/${sessionId}/abort`, {}, 5000).catch(() => {});
                    setTimeout(() => void server.stop(), 5000);
                },
            };
        },

        async history(cwd, sessionId) {
            return withServer(cwd, async s => {
                const r = await s.request('GET', `/session/${sessionId}`);
                if (r.status === 404) return { found: false, items: [] };
                const info: Foreign = r.ok ? await r.json() : null;
                if (!info?.directory || !sameDir(info.directory, cwd)) return { found: false, items: [] };
                const messages = await s.json('GET', `/session/${sessionId}/message`);
                return { found: true, items: mapOpencodeMessages(messages) };
            });
        },

        async deleteSession(cwd, sessionId) {
            return withServer(cwd, async s => {
                const r = await s.request('GET', `/session/${sessionId}`);
                if (!r.ok) return false;
                const info: Foreign = await r.json();
                // Only a session recorded in this vault's folder is ours to delete.
                if (!info?.directory || !sameDir(info.directory, cwd)) return false;
                const d = await s.request('DELETE', `/session/${sessionId}`);
                return d.ok;
            });
        },
    };
}
