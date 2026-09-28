// Codex adapter: one `codex app-server` (JSON-RPC over stdio) per message.
//
// Verified against codex-cli 0.157.1 (`npm pack`ed into a scratch folder, run
// with a scratch CODEX_HOME against a local fake Responses endpoint; recordings
// in helper/test/fixtures/codex/, provenance in helper/test/adapters.test.ts).
// With the settings below the model was
// offered exactly: our `mcp__vault` namespace, web_search (live),
// list/read_mcp_resource(s) (which only reach our server) and
// request_user_input (answered with an error here). No shell, no apply_patch,
// no view_image, no sub-agents, no apps/plugins/connectors.
//
// Containment has two independent layers, both checked:
//   1. `environments: []` on the thread AND on every turn — the "environment"
//      is what carries shell/apply_patch/view_image. Verified: a resumed thread
//      comes back with the local environment re-attached, and the turn-level
//      `environments: []` removes it again; so after every turn/start we
//      thread/read and refuse the run unless environments is [].
//   2. the shell/exec/view_image features off. Verified: with the environment
//      left ON, these flags alone reduce the tools to apply_patch +
//      request_user_input + web_search, and the read-only sandbox with
//      approvals "never" refuses apply_patch.
// Any command/file-change/image-view item that still shows up ends the run.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Subprocess } from 'bun';
import {
    MCP_SERVER_NAME, TOOL_CALL_TIMEOUT_MS, compareVersions, isUuid,
    type AgentEvent, type AgentStatus, type HistoryItem, type ModelInfo, type RunImage, type RunUsage,
} from '../../../shared/vaultAgentProtocol.ts';
import { logError } from '../log.ts';
import { agentEnv, drainTail, readLines, runCapture, stopProcess } from '../proc.ts';
import { VAULT_AGENT_PROMPT } from '../prompt.ts';
import { HELPER_VERSION } from '../buildInfo.ts';
import { findAgentBinary, parseVersion, type FoundBinary } from './discover.ts';
import {
    MCP_TOKEN_ENV, RunRefused, SAFE_EFFORT_RE, SAFE_MODEL_RE, truncate,
    type AgentAdapter, type Foreign, type RunContext, type RunHandle, type RunOutcome,
} from './types.ts';

/** The app-server protocol is marked experimental; these are the versions whose shape we verified. */
export const CODEX_TESTED = { min: '0.157.0', maxExclusive: '0.170.0' } as const;

export function codexIncompatibility(version: string | null): string | null {
    if (!version) return 'Could not read the Codex version.';
    if (compareVersions(version, CODEX_TESTED.min) < 0) return `Codex ${version} is older than VaultAgent supports (${CODEX_TESTED.min} or newer). Update Codex.`;
    if (compareVersions(version, CODEX_TESTED.maxExclusive) >= 0) {
        return `Codex ${version} is newer than the versions VaultAgent ${HELPER_VERSION} was tested with. Update VaultAgent to use it.`;
    }
    return null;
}

/**
 * Features switched off for every run, as per-process `-c` overrides (nothing
 * is written to ~/.codex/config.toml). All accepted by 0.157.1.
 */
export const CODEX_DISABLED_FEATURES = [
    'shell_tool', 'unified_exec', 'view_image', 'shell_snapshot',   // local execution / file viewing
    'apps', 'plugins', 'remote_plugin', 'tool_suggest', 'skill_mcp_dependency_install', // ChatGPT connectors, plugin tools/MCP
    'hooks',                                                          // user/plugin hook commands
    'multi_agent', 'multi_agent_v2',                                  // sub-agents
    'computer_use', 'browser_use', 'browser_use_external', 'in_app_browser',
    'image_generation', 'memories', 'goals', 'code_mode', 'sleep_tool',
] as const;

const MCP_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** The user's own MCP server names from ~/.codex/config.toml (read, never written). */
export function userCodexMcpServers(configToml: string): string[] {
    try {
        const parsed = Bun.TOML.parse(configToml) as { mcp_servers?: Record<string, unknown> };
        return parsed.mcp_servers && typeof parsed.mcp_servers === 'object' ? Object.keys(parsed.mcp_servers) : [];
    } catch {
        return [];
    }
}

export function codexHome(): string {
    const h = process.env.CODEX_HOME;
    return h && h.trim() ? h : join(homedir(), '.codex');
}

/** argv after the binary. Pure; the containment tests assert on it. Throws on an MCP name we cannot express safely. */
export function buildCodexArgs(userMcpServers: string[]): string[] {
    const args = ['app-server'];
    for (const f of CODEX_DISABLED_FEATURES) args.push('-c', `features.${f}=false`);
    // "live" = real web access (the default "cached" only reads OpenAI's index);
    // verified: the request's web_search tool flips to external_web_access: true.
    args.push('-c', 'web_search="live"');
    for (const name of userMcpServers) {
        if (name === MCP_SERVER_NAME) continue; // replaced by ours in the thread config
        if (!MCP_NAME_RE.test(name)) throw new RunRefused('agent-changed', `Your Codex config has an MCP server named ${JSON.stringify(name)} that VaultAgent cannot switch off safely.`);
        // The user's own servers stay theirs — just not in this session.
        args.push('-c', `mcp_servers.${name}.enabled=false`);
    }
    return args;
}

/**
 * Our MCP server, passed as thread-level `config` over stdin (verified to
 * apply), so the URL — which carries the run token — never appears in argv.
 */
export function codexThreadConfig(mcpBaseUrl: string, token: string): Record<string, unknown> {
    return {
        mcp_servers: {
            [MCP_SERVER_NAME]: {
                enabled: true,
                url: `${mcpBaseUrl}${token}`,
                bearer_token_env_var: MCP_TOKEN_ENV,
                // Offer our tools directly; by default Codex hides MCP tools behind its
                // tool_search tool (verified), which costs the model a round trip.
                omit_tools_from: ['deferred'],
                // No approval round-trips for our tools: the editor is the gate.
                default_tools_approval_mode: 'approve',
                // Longer than ours, so our timeout comes back as a readable isError.
                tool_timeout_sec: Math.ceil(TOOL_CALL_TIMEOUT_MS / 1000) + 30,
            },
        },
    };
}

const SANDBOX = 'read-only';
const APPROVAL = 'never';

export function codexThreadStartParams(cwd: string, model: string | null, config: Record<string, unknown>) {
    return {
        cwd,
        ...(model ? { model } : {}),
        approvalPolicy: APPROVAL,
        sandbox: SANDBOX,
        environments: [],
        developerInstructions: VAULT_AGENT_PROMPT,
        config,
        serviceName: 'VaultAgent',
    };
}

export function codexThreadResumeParams(threadId: string, cwd: string, model: string | null, config: Record<string, unknown>) {
    return {
        threadId,
        cwd,
        ...(model ? { model } : {}),
        approvalPolicy: APPROVAL,
        sandbox: SANDBOX,
        developerInstructions: VAULT_AGENT_PROMPT,
        config,
        excludeTurns: true,
    };
}

export function codexTurnStartParams(threadId: string, text: string, imagePaths: string[], model: string | null, effort: string | null) {
    return {
        threadId,
        input: [
            { type: 'text', text, text_elements: [] },
            ...imagePaths.map(path => ({ type: 'localImage', path })),
        ],
        environments: [],
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        summary: 'auto',
    };
}

/* ───────────────────────── JSON-RPC over stdio ───────────────────────── */

interface Pending { resolve(v: Foreign): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }

export class CodexRpc {
    private nextId = 1;
    private readonly pending = new Map<number, Pending>();
    onNotification: (method: string, params: Foreign) => void = () => {};
    readonly closed: Promise<void>;

    constructor(private readonly proc: Subprocess<'pipe', 'pipe', 'pipe'>) {
        this.closed = (async () => {
            for await (const line of readLines(proc.stdout)) this.dispatch(line);
            for (const p of this.pending.values()) {
                clearTimeout(p.timer);
                p.reject(new Error('codex app-server exited'));
            }
            this.pending.clear();
        })().catch(() => {});
    }

    private write(msg: unknown): void {
        try {
            this.proc.stdin.write(`${JSON.stringify(msg)}\n`);
            this.proc.stdin.flush();
        } catch { /* process gone; pending requests fail on close */ }
    }

    private dispatch(line: string): void {
        let msg: Foreign;
        try {
            msg = JSON.parse(line);
        } catch {
            return;
        }
        if (!msg || typeof msg !== 'object') return;
        if (msg.id !== undefined && msg.method === undefined) {
            const p = this.pending.get(msg.id);
            if (!p) return;
            this.pending.delete(msg.id);
            clearTimeout(p.timer);
            if (msg.error) p.reject(Object.assign(new Error(String(msg.error.message ?? 'codex error')), { code: msg.error.code }));
            else p.resolve(msg.result);
            return;
        }
        if (msg.id !== undefined && typeof msg.method === 'string') {
            // A server→client request: approvals, user-input questions, elicitations.
            // There is no one to ask and nothing should need approval; decline.
            if (/requestApproval$/i.test(msg.method)) this.write({ id: msg.id, result: { decision: 'decline' } });
            else this.write({ id: msg.id, error: { code: -32000, message: 'Not available in VaultAgent.' } });
            return;
        }
        if (typeof msg.method === 'string') this.onNotification(msg.method, msg.params);
    }

    request<T = Foreign>(method: string, params: unknown, timeoutMs = 60_000): Promise<T> {
        const id = this.nextId++;
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`codex ${method} timed out`));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this.write({ id, method, params });
        });
    }

    notify(method: string, params?: unknown): void {
        this.write(params === undefined ? { method } : { method, params });
    }
}

export async function codexInitialize(rpc: CodexRpc): Promise<void> {
    const init = await rpc.request('initialize', {
        clientInfo: { name: 'vaultagent', title: 'VaultAgent', version: HELPER_VERSION },
        capabilities: { experimentalApi: true, requestAttestation: false },
    }, 30_000);
    if (!init || typeof init.userAgent !== 'string') throw new RunRefused('agent-changed', 'Codex answered `initialize` in a shape VaultAgent does not know.');
    rpc.notify('initialized');
}

/* ───────────────────────── notifications → AgentEvents ───────────────────────── */

export interface CodexTurnEnd { status: string; error: string | null }

/** Maps app-server notifications for one thread to AgentEvents. Pure; fixture-tested. */
export class CodexEventMapper {
    turnId: string | null = null;
    end: CodexTurnEnd | null = null;
    /** Set when an item appears that containment says cannot exist. */
    breach: string | null = null;
    lastError: string | null = null;
    usage: RunUsage = {};
    private reasoningOpen = new Set<string>();

    constructor(private readonly threadId: string, private readonly emit: (e: AgentEvent) => void) {}

    feed(method: string, params: Foreign): void {
        if (!params || typeof params !== 'object') return;
        if (params.threadId !== undefined && params.threadId !== this.threadId) return;
        switch (method) {
            case 'turn/started':
                this.turnId = params.turn?.id ?? this.turnId;
                return;
            case 'item/agentMessage/delta':
                if (typeof params.delta === 'string' && params.delta) this.emit({ type: 'text-delta', text: params.delta });
                return;
            case 'item/reasoning/summaryTextDelta':
            case 'item/reasoning/textDelta':
                if (typeof params.delta === 'string' && params.delta) {
                    this.reasoningOpen.add(params.itemId);
                    this.emit({ type: 'reasoning-delta', text: params.delta });
                }
                return;
            case 'item/reasoning/summaryPartAdded':
                if (this.reasoningOpen.has(params.itemId)) this.emit({ type: 'reasoning-delta', text: '\n\n' });
                return;
            case 'item/started':
            case 'item/completed':
                this.item(method === 'item/completed', params.item);
                return;
            case 'thread/tokenUsage/updated': {
                const last = params.tokenUsage?.last;
                if (last && typeof last.inputTokens === 'number') this.usage.inputTokens = (this.usage.inputTokens ?? 0) + last.inputTokens;
                if (last && typeof last.outputTokens === 'number') this.usage.outputTokens = (this.usage.outputTokens ?? 0) + last.outputTokens;
                return;
            }
            case 'error':
                if (params.willRetry !== true && typeof params.error?.message === 'string') this.lastError = params.error.message;
                return;
            case 'turn/completed':
                this.end = { status: String(params.turn?.status ?? ''), error: typeof params.turn?.error?.message === 'string' ? params.turn.error.message : null };
                return;
        }
    }

    private item(completed: boolean, item: Foreign): void {
        if (!item || typeof item !== 'object') return;
        switch (item.type) {
            case 'commandExecution':
            case 'fileChange':
            case 'imageView':
            case 'collabAgentToolCall':
                this.breach = `Codex tried to use ${item.type}, which VaultAgent keeps switched off.`;
                return;
            case 'webSearch': {
                const query = typeof item.query === 'string' ? item.query : item.action?.query ?? undefined;
                const input = item.action?.type === 'openPage' ? { url: item.action.url } : { query };
                this.emit({ type: 'tool', callId: String(item.id), name: 'web_search', input, status: completed ? 'done' : 'running' });
                return;
            }
            case 'mcpToolCall': {
                // Ours reach the panel as `tool.call`. Any other server is a leak we switched off.
                if (item.server === MCP_SERVER_NAME) return;
                this.breach = `Codex called a tool on the MCP server ${JSON.stringify(item.server)}, which VaultAgent keeps switched off.`;
                return;
            }
            case 'dynamicToolCall':
                this.breach = 'Codex called a tool VaultAgent did not provide.';
                return;
        }
    }
}

export function codexOutcome(m: CodexEventMapper, threadId: string, cancelled: boolean, crashed: string | null): RunOutcome {
    if (m.breach) return { kind: 'error', reason: 'agent-changed', message: m.breach };
    if (m.end?.status === 'interrupted' || (cancelled && !m.end)) return { kind: 'done', status: 'cancelled', sessionId: threadId, usage: m.usage };
    if (m.end?.status === 'completed') return { kind: 'done', status: 'ok', sessionId: threadId, usage: m.usage };
    const message = m.end?.error ?? m.lastError ?? crashed ?? 'Codex stopped without finishing the turn.';
    if (/401|unauthori[sz]ed|log ?in|not logged|auth/i.test(message)) return { kind: 'error', reason: 'logged-out', message: 'Codex is not logged in. Run `codex login` in a terminal, then try again.' };
    return { kind: 'error', reason: 'crashed', message: truncate(message, 500) };
}

/* ───────────────────────── history & models ───────────────────────── */

function mcpResultText(result: Foreign): string {
    const content = Array.isArray(result?.content) ? result.content : [];
    return truncate(content.map((c: Foreign) => (c?.type === 'text' ? String(c.text ?? '') : c?.type === 'image' ? '[image]' : '')).join('\n'));
}

/** Items of `thread/turns/list` (itemsView "full") → history. */
export function mapCodexTurns(turns: Foreign[]): HistoryItem[] {
    const out: HistoryItem[] = [];
    for (const turn of turns) {
        for (const item of Array.isArray(turn?.items) ? turn.items : []) {
            switch (item?.type) {
                case 'userMessage': {
                    const content = Array.isArray(item.content) ? item.content : [];
                    const text = content.filter((c: Foreign) => c?.type === 'text').map((c: Foreign) => String(c.text ?? '')).join('\n');
                    const imageCount = content.filter((c: Foreign) => c?.type === 'image' || c?.type === 'localImage').length;
                    out.push({ kind: 'user', text, imageCount });
                    break;
                }
                case 'agentMessage':
                    if (item.text) out.push({ kind: 'assistant', text: String(item.text) });
                    break;
                case 'reasoning': {
                    const parts: string[] = [...(item.summary ?? []), ...(item.summary?.length ? [] : item.content ?? [])].filter((s: unknown) => typeof s === 'string' && s);
                    if (parts.length) out.push({ kind: 'reasoning', text: parts.join('\n\n') });
                    break;
                }
                case 'mcpToolCall':
                    out.push({
                        kind: 'tool',
                        name: item.server === MCP_SERVER_NAME ? String(item.tool) : `${item.server}.${item.tool}`,
                        input: item.arguments,
                        output: item.result ? mcpResultText(item.result) : item.error?.message,
                        ...(item.status === 'failed' || item.result?.isError ? { isError: true } : {}),
                    });
                    break;
                case 'webSearch':
                    out.push({ kind: 'tool', name: 'web_search', input: { query: item.query } });
                    break;
            }
        }
    }
    return out;
}

export function mapCodexModels(data: unknown): ModelInfo[] {
    if (!Array.isArray(data)) return [];
    const out: ModelInfo[] = [];
    for (const m of data) {
        if (!m || m.hidden || typeof m.id !== 'string' || !SAFE_MODEL_RE.test(m.id)) continue;
        const efforts = (Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts : [])
            .map((e: Foreign) => e?.reasoningEffort)
            .filter((e: unknown): e is string => typeof e === 'string' && SAFE_EFFORT_RE.test(e));
        out.push({
            id: m.id,
            label: typeof m.displayName === 'string' ? m.displayName : m.id,
            efforts,
            defaultEffort: typeof m.defaultReasoningEffort === 'string' && efforts.includes(m.defaultReasoningEffort) ? m.defaultReasoningEffort : null,
            images: Array.isArray(m.inputModalities) ? m.inputModalities.includes('image') : false,
            ...(m.isDefault ? { isDefault: true } : {}),
        });
    }
    return out;
}

/* ───────────────────────── adapter ───────────────────────── */

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

/** Codex takes images as files; they live beside the session so history paths stay valid. */
function writeImages(cwd: string, images: RunImage[]): string[] {
    if (!images.length) return [];
    const dir = join(cwd, '.bme', 'images');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return images.map(img => {
        const bytes = Buffer.from(img.data, 'base64');
        const path = join(dir, `${createHash('sha256').update(bytes).digest('hex')}.${EXT[img.mimeType] ?? 'png'}`);
        writeFileSync(path, bytes, { mode: 0o600 });
        return path;
    });
}

interface Spawned { proc: Subprocess<'pipe', 'pipe', 'pipe'>; rpc: CodexRpc }

async function spawnAppServer(bin: FoundBinary, cwd: string, token: string | null): Promise<Spawned> {
    let userServers: string[] = [];
    try {
        userServers = userCodexMcpServers(readFileSync(join(codexHome(), 'config.toml'), 'utf8'));
    } catch { /* no user config */ }
    const proc = Bun.spawn([...bin.command, ...buildCodexArgs(userServers)], {
        cwd,
        env: agentEnv(bin.pathDirs, token ? { [MCP_TOKEN_ENV]: token } : {}),
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        windowsHide: true,
    });
    // Drained so a chatty stderr can never fill the pipe and stall the CLI; never logged.
    void drainTail(proc.stderr).catch(() => {});
    const rpc = new CodexRpc(proc);
    try {
        await codexInitialize(rpc);
    } catch (e) {
        void stopProcess(proc);
        throw e;
    }
    return { proc, rpc };
}

export function createCodexAdapter(opts: { sessionsRoot: string }): AgentAdapter {
    let statusCache: { at: number; status: AgentStatus } | null = null;
    let modelCache: { at: number; models: ModelInfo[] } | null = null;

    async function ready(): Promise<FoundBinary> {
        const bin = await findAgentBinary('codex');
        if (!bin) throw new RunRefused('agent-missing', 'Codex is not installed.');
        const st = await adapter.status(false);
        if (st.incompatible) throw new RunRefused('agent-changed', st.incompatible);
        return bin;
    }

    const adapter: AgentAdapter = {
        id: 'codex',
        isValidSessionId: (id): id is string => isUuid(id),
        isValidModel: (id): id is string => typeof id === 'string' && SAFE_MODEL_RE.test(id),

        async status(refresh) {
            if (statusCache && !refresh && Date.now() - statusCache.at < 30_000) return statusCache.status;
            const bin = await findAgentBinary('codex', refresh);
            const base: AgentStatus = {
                agent: 'codex', installed: !!bin, version: null, loggedIn: null, incompatible: null,
                loginCommand: 'codex login', installCommand: 'npm install -g @openai/codex',
            };
            if (!bin) return (statusCache = { at: Date.now(), status: { ...base, loggedIn: false } }).status;
            const env = agentEnv(bin.pathDirs);
            const [ver, login] = await Promise.all([
                runCapture([...bin.command, '--version'], { env, timeoutMs: 10_000 }),
                runCapture([...bin.command, 'login', 'status'], { env, timeoutMs: 15_000 }),
            ]);
            const version = parseVersion(ver.stdout);
            const loggedIn = login.timedOut || login.code === null ? null : login.code === 0;
            return (statusCache = { at: Date.now(), status: { ...base, version, loggedIn, incompatible: codexIncompatibility(version) } }).status;
        },

        async models(refresh) {
            if (modelCache && !refresh && Date.now() - modelCache.at < 10 * 60_000) return modelCache.models;
            const bin = await ready();
            const { proc, rpc } = await spawnAppServer(bin, opts.sessionsRoot, null);
            try {
                const all: unknown[] = [];
                let cursor: string | null = null;
                for (let page = 0; page < 10; page++) {
                    const res: Foreign = await rpc.request('model/list', { includeHidden: false, ...(cursor ? { cursor } : {}) }, 30_000);
                    if (Array.isArray(res?.data)) all.push(...res.data);
                    cursor = typeof res?.nextCursor === 'string' ? res.nextCursor : null;
                    if (!cursor) break;
                }
                const models = mapCodexModels(all);
                modelCache = { at: Date.now(), models };
                return models;
            } finally {
                void stopProcess(proc, 1000);
            }
        },

        async start(ctx: RunContext): Promise<RunHandle> {
            const bin = await ready();
            const { proc, rpc } = await spawnAppServer(bin, ctx.cwd, ctx.mcpToken);
            const config = codexThreadConfig(ctx.mcpBaseUrl, ctx.mcpToken);
            let threadId: string;
            let mapper: CodexEventMapper;
            const buffered: [string, Foreign][] = [];
            rpc.onNotification = (m, p) => buffered.push([m, p]);
            try {
                if (ctx.sessionId) {
                    const res: Foreign = await rpc.request('thread/resume', codexThreadResumeParams(ctx.sessionId, ctx.cwd, ctx.model, config));
                    threadId = res?.thread?.id;
                    if (threadId !== ctx.sessionId) throw new RunRefused('agent-changed', 'Codex resumed a different thread than asked.');
                } else {
                    const res: Foreign = await rpc.request('thread/start', codexThreadStartParams(ctx.cwd, ctx.model, config));
                    threadId = res?.thread?.id;
                    if (!isUuid(threadId)) throw new RunRefused('agent-changed', 'Codex answered `thread/start` in a shape VaultAgent does not know.');
                    if (!Array.isArray(res.thread.environments) || res.thread.environments.length) {
                        throw new RunRefused('agent-changed', 'Codex did not switch off its local environment (shell and file access). The run was stopped.');
                    }
                }
                ctx.emit({ type: 'session', sessionId: threadId });
                mapper = new CodexEventMapper(threadId, ctx.emit);
                for (const [m, p] of buffered) mapper.feed(m, p);
                rpc.onNotification = (m, p) => mapper.feed(m, p);

                const imagePaths = writeImages(ctx.cwd, ctx.images);
                const turn: Foreign = await rpc.request('turn/start', codexTurnStartParams(threadId, ctx.text, imagePaths, ctx.model, ctx.effort));
                mapper.turnId ??= turn?.turn?.id ?? null;
                // The containment check that matters for resumed threads (see top of file).
                const read: Foreign = await rpc.request('thread/read', { threadId }, 30_000);
                const envs = read?.thread?.environments;
                if (!Array.isArray(envs) || envs.length) {
                    if (mapper.turnId) void rpc.request('turn/interrupt', { threadId, turnId: mapper.turnId }, 5000).catch(() => {});
                    throw new RunRefused('agent-changed', 'Codex did not switch off its local environment (shell and file access). The run was stopped.');
                }
            } catch (e) {
                void stopProcess(proc);
                if (e instanceof RunRefused) throw e;
                const msg = e instanceof Error ? e.message : String(e);
                if (/not loaded|not found|no rollout/i.test(msg) && ctx.sessionId) throw new RunRefused('bad-request', 'This chat’s Codex session is not on this computer.');
                logError('codex start failed', e);
                throw new RunRefused('crashed', truncate(msg, 300));
            }

            let cancelled = false;
            const outcome = (async (): Promise<RunOutcome> => {
                // Ends on turn/completed, a containment breach, or the process dying.
                await new Promise<void>(res => {
                    const tick = setInterval(() => {
                        if (mapper.end || mapper.breach) {
                            clearInterval(tick);
                            res();
                        }
                    }, 50);
                    rpc.closed.then(() => {
                        clearInterval(tick);
                        res();
                    });
                });
                if (mapper.breach && !mapper.end && mapper.turnId) {
                    await rpc.request('turn/interrupt', { threadId, turnId: mapper.turnId }, 5000).catch(() => {});
                }
                const crashed = mapper.end ? null : 'Codex exited unexpectedly.';
                await stopProcess(proc);
                return codexOutcome(mapper, threadId, cancelled, crashed);
            })().catch((e): RunOutcome => ({ kind: 'error', reason: 'crashed', message: e instanceof Error ? e.message : 'Codex failed.' }));

            return {
                outcome,
                cancel() {
                    if (cancelled) return;
                    cancelled = true;
                    if (mapper.turnId) void rpc.request('turn/interrupt', { threadId, turnId: mapper.turnId }, 5000).catch(() => {});
                    setTimeout(() => void stopProcess(proc), 5000);
                },
            };
        },

        async history(cwd, sessionId) {
            const bin = await findAgentBinary('codex');
            if (!bin) return { found: false, items: [] };
            const { proc, rpc } = await spawnAppServer(bin, cwd, null);
            try {
                let thread: Foreign;
                try {
                    thread = (await rpc.request('thread/read', { threadId: sessionId }, 30_000))?.thread;
                } catch {
                    return { found: false, items: [] };
                }
                if (!thread || typeof thread.cwd !== 'string' || resolve(thread.cwd) !== resolve(cwd)) return { found: false, items: [] };
                const turns: unknown[] = [];
                let cursor: string | null = null;
                for (let page = 0; page < 50; page++) {
                    const res: Foreign = await rpc.request('thread/turns/list', { threadId: sessionId, itemsView: 'full', sortDirection: 'asc', limit: 100, ...(cursor ? { cursor } : {}) }, 30_000);
                    if (Array.isArray(res?.data)) turns.push(...res.data);
                    cursor = typeof res?.nextCursor === 'string' ? res.nextCursor : null;
                    if (!cursor) break;
                }
                return { found: true, items: mapCodexTurns(turns) };
            } finally {
                void stopProcess(proc, 1000);
            }
        },

        async deleteSession(cwd, sessionId) {
            const bin = await findAgentBinary('codex');
            if (!bin) return false;
            const { proc, rpc } = await spawnAppServer(bin, cwd, null);
            try {
                let thread: Foreign;
                try {
                    thread = (await rpc.request('thread/read', { threadId: sessionId }, 30_000))?.thread;
                } catch {
                    return false;
                }
                // Only a thread recorded in this vault's folder is ours to delete.
                if (!thread || typeof thread.cwd !== 'string' || resolve(thread.cwd) !== resolve(cwd)) return false;
                await rpc.request('thread/delete', { threadId: sessionId }, 30_000);
                return true;
            } finally {
                void stopProcess(proc, 1000);
            }
        },
    };
    return adapter;
}
