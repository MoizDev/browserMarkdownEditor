// Codex adapter: one `codex app-server` (JSON-RPC over stdio) per message.
//
// Codex runs with its full normal tools — shell, apply_patch, view_image,
// sub-agents, web search — in its never-ask mode: `sandbox: 'danger-full-access'`
// with `approvalPolicy: 'never'`, and the default (local) environment left
// attached. Nobody can answer an approval in the panel, so nothing may ask.
// Verified against codex-cli 0.160.0 (`npm pack`ed into a scratch folder, run
// with a scratch CODEX_HOME against a local fake Responses endpoint): both
// thread/start and thread/resume accept it, and shell/apply_patch/view_image ran
// with no approval request. The vault itself is still reached only through our
// `vault` MCP server; the prompt tells the agent so.
//
// The user's own MCP servers are switched off in the thread `config`, NOT in
// argv: once the thread config carries `mcp_servers` (ours always does), an argv
// `-c mcp_servers.<name>.enabled=false` is ignored (verified: the server still
// started), and a dotted name in a `-c` key is fatal at startup. Verified on both
// thread/start and thread/resume: only `vault` starts.
//
// Hooks, plugins and apps are deliberately NOT switched off: Codex offers only
// per-feature `features.<name>` keys for them, i.e. a deny-list that has to be
// tracked per Codex version, which is what once forced a Codex version gate.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Subprocess } from 'bun';
import {
    MCP_SERVER_NAME, TOOL_CALL_TIMEOUT_MS, isUuid,
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

/** argv after the binary. Pure; the tests assert on it. */
export function buildCodexArgs(): string[] {
    // "live" = real web access (the default "cached" only reads OpenAI's index);
    // verified: the request's web_search tool flips to external_web_access: true.
    return ['app-server', '-c', 'web_search="live"'];
}

/**
 * Our MCP server, passed as thread-level `config` over stdin (verified to
 * apply), so the URL — which carries the run token — never appears in argv.
 * The user's own servers are switched off here too (see top of file): they stay
 * theirs, just not in this session. JSON keys need no quoting, so any name works
 * (verified with "my.server" and "has space").
 */
export function codexThreadConfig(mcpBaseUrl: string, token: string, userMcpServers: string[]): Record<string, unknown> {
    const off = Object.fromEntries(userMcpServers.filter(n => n !== MCP_SERVER_NAME).map(n => [n, { enabled: false }]));
    return {
        mcp_servers: {
            ...off,
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

const SANDBOX = 'danger-full-access';
const APPROVAL = 'never';

export function codexThreadStartParams(cwd: string, model: string | null, config: Record<string, unknown>) {
    return {
        cwd,
        ...(model ? { model } : {}),
        approvalPolicy: APPROVAL,
        sandbox: SANDBOX,
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
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        summary: 'auto',
    };
}

/* ───────────────────────── JSON-RPC over stdio ───────────────────────── */

/**
 * The answer to a server→client request, or null for a JSON-RPC error. Pure.
 * Method names and reply shapes are 0.160.0's generated `ServerRequest` schema.
 */
export function codexServerReply(method: string, params: Foreign): Record<string, unknown> | null {
    switch (method) {
        case 'item/commandExecution/requestApproval':
        case 'item/fileChange/requestApproval':
            return { decision: 'accept' };
        case 'execCommandApproval':   // the legacy (v1) approvals
        case 'applyPatchApproval':
            return { decision: 'approved' };
        case 'item/permissions/requestApproval': {
            // Grant what was asked. The request's profile spells "none" as null; the
            // granted one as an absent key.
            const asked = params?.permissions && typeof params.permissions === 'object' ? params.permissions : {};
            return { permissions: Object.fromEntries(Object.entries(asked).filter(([, v]) => v != null)), scope: 'turn' };
        }
        case 'mcpServer/elicitation/request':
            return { action: 'decline', content: null, _meta: null };
        default:
            // item/tool/requestUserInput included: there is no one to ask.
            return null;
    }
}

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
            // A server→client request. A backstop: under `never` + full access none
            // arrived in testing (0.160.0). Never-ask mode approves; a question or a
            // form has no one to answer it.
            const result = codexServerReply(msg.method, msg.params);
            if (result) this.write({ id: msg.id, result });
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
            case 'webSearch': {
                const query = typeof item.query === 'string' ? item.query : item.action?.query ?? undefined;
                const input = item.action?.type === 'openPage' ? { url: item.action.url } : { query };
                this.emit({ type: 'tool', callId: String(item.id), name: 'web_search', input, status: completed ? 'done' : 'running' });
                return;
            }
            case 'mcpToolCall':
                // Ours reach the panel as `tool.call`; another server's falls through.
                if (item.server === MCP_SERVER_NAME) return;
        }
        const t = codexToolItem(item);
        if (!t) return;
        this.emit({
            type: 'tool', callId: String(item.id), name: t.name, input: t.input,
            status: completed ? t.status : 'running',
            ...(completed && t.output ? { output: t.output } : {}),
        });
    }
}

/** `/bin/zsh -lc 'a && b'` → `a && b`: Codex wraps every command in the user's
 *  login shell, single-quoted ('"'"' for a quote inside); a chained command
 *  parses into several actions, so only the wrapper names it whole. Anything
 *  else is returned as is. */
export function unwrapShell(command: string): string {
    const m = /^\S*\b(?:ba|z|fi)?sh -l?c '([\s\S]*)'$/.exec(command);
    return m ? m[1].replace(/'"'"'|'\\''/g, "'") : command;
}

export interface CodexToolItem { name: string; input: unknown; output?: string; status: 'done' | 'error' }

const FAILED = new Set(['failed', 'declined', 'interrupted']);

/**
 * One of Codex's own tool items (not ours, not web search) → what the panel shows,
 * as if completed; null for anything that is not a tool (messages, reasoning,
 * plans…). Pure; shared by the live mapper and history so both read the same.
 * Field names are 0.160.0's, as captured.
 */
export function codexToolItem(item: Foreign): CodexToolItem | null {
    if (!item || typeof item !== 'object') return null;
    const failed = FAILED.has(item.status);
    const done = (name: string, input: unknown, output?: string, error = failed): CodexToolItem => ({
        name, input, ...(output ? { output: truncate(output) } : {}), status: error ? 'error' : 'done',
    });
    switch (item.type) {
        case 'commandExecution': {
            // `command` is the shell-wrapped form ("/bin/zsh -lc 'echo hi'", observed);
            // a single parsed action carries the command the model actually wrote.
            const actions = Array.isArray(item.commandActions) ? item.commandActions : [];
            const command = actions.length === 1 && typeof actions[0]?.command === 'string' ? actions[0].command : unwrapShell(String(item.command ?? ''));
            const exited = typeof item.exitCode === 'number' && item.exitCode !== 0;
            return done('shell', { command, cwd: item.cwd }, typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : undefined, failed || exited);
        }
        case 'fileChange': {
            const changes = (Array.isArray(item.changes) ? item.changes : []).filter((c: Foreign) => typeof c?.path === 'string');
            const diff = changes.map((c: Foreign) => `${c.path}\n${typeof c.diff === 'string' ? c.diff : ''}`).join('\n\n');
            return done('apply_patch', { paths: changes.map((c: Foreign) => c.path as string) }, diff);
        }
        case 'imageView':
            return done('view_image', { path: item.path });
        case 'mcpToolCall':
            return done(
                `${item.server}.${item.tool}`, item.arguments,
                item.result ? mcpResultText(item.result) : item.error?.message,
                failed || !!item.result?.isError,
            );
        case 'dynamicToolCall':
            return done(String(item.tool), item.arguments, undefined, failed || item.success === false);
        case 'collabAgentToolCall':
            // A sub-agent: spawn/send/wait… on another Codex thread.
            return done('agent', { tool: item.tool, prompt: item.prompt });
        default:
            return null;
    }
}

export function codexOutcome(m: CodexEventMapper, threadId: string, cancelled: boolean, crashed: string | null): RunOutcome {
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

function pushTool(out: HistoryItem[], item: Foreign): void {
    const t = codexToolItem(item);
    if (t) out.push({ kind: 'tool', name: t.name, input: t.input, output: t.output, ...(t.status === 'error' ? { isError: true } : {}) });
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
                    if (item.server !== MCP_SERVER_NAME) {
                        pushTool(out, item);
                        break;
                    }
                    out.push({
                        kind: 'tool',
                        name: String(item.tool),
                        input: item.arguments,
                        output: item.result ? mcpResultText(item.result) : item.error?.message,
                        ...(item.status === 'failed' || item.result?.isError ? { isError: true } : {}),
                    });
                    break;
                case 'webSearch':
                    out.push({ kind: 'tool', name: 'web_search', input: { query: item.query } });
                    break;
                default:
                    pushTool(out, item);
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
    const proc = Bun.spawn([...bin.command, ...buildCodexArgs()], {
        cwd,
        env: agentEnv(bin.pathDirs, token ? { [MCP_TOKEN_ENV]: token } : {}),
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        windowsHide: true,
    });
    // Drained so a chatty stderr can never fill the pipe and stall the CLI; never
    // logged — only shown, when Codex dies before answering `initialize`.
    const stderrTail = drainTail(proc.stderr).catch(() => '');
    const rpc = new CodexRpc(proc);
    try {
        await codexInitialize(rpc);
    } catch (e) {
        void stopProcess(proc);
        if (e instanceof RunRefused) throw e;
        // With no version gate, a Codex that cannot start (a setting the user's
        // config.toml has that this version rejects, a newer app-server) ends
        // here. Its own words say why (observed on 0.160.0: `Error:
        // approval_policy = "untrusted" is no longer supported; remove this
        // setting`); without them the panel showed only "codex app-server exited".
        const why = codexStartupError(await Promise.race([stderrTail, Bun.sleep(1000).then(() => '')]));
        throw new RunRefused('crashed', why ? `Codex could not start: ${why}` : 'Codex could not start.');
    }
    return { proc, rpc };
}

/** The line of Codex's stderr that says why it would not start, or ''. Pure. */
export function codexStartupError(stderr: string): string {
    const lines = stderr.split('\n').map(l => l.trim()).filter(Boolean);
    const error = lines.find(l => /^error\b/i.test(l)) ?? lines.at(-1) ?? '';
    return truncate(error.replace(/^error:\s*/i, ''), 300);
}

export function createCodexAdapter(opts: { sessionsRoot: string }): AgentAdapter {
    let statusCache: { at: number; status: AgentStatus } | null = null;
    let modelCache: { at: number; models: ModelInfo[] } | null = null;

    // Any installed version runs: nothing here may refuse on a version.
    async function ready(): Promise<FoundBinary> {
        const bin = await findAgentBinary('codex');
        if (!bin) throw new RunRefused('agent-missing', 'Codex is not installed.');
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
                agent: 'codex', installed: !!bin, version: null, loggedIn: null,
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
            return (statusCache = { at: Date.now(), status: { ...base, version, loggedIn } }).status;
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
            let userServers: string[] = [];
            try {
                userServers = userCodexMcpServers(readFileSync(join(codexHome(), 'config.toml'), 'utf8'));
            } catch { /* no user config */ }
            const config = codexThreadConfig(ctx.mcpBaseUrl, ctx.mcpToken, userServers);
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
                }
                ctx.emit({ type: 'session', sessionId: threadId });
                mapper = new CodexEventMapper(threadId, ctx.emit);
                for (const [m, p] of buffered) mapper.feed(m, p);
                rpc.onNotification = (m, p) => mapper.feed(m, p);

                const imagePaths = writeImages(ctx.cwd, ctx.images);
                const turn: Foreign = await rpc.request('turn/start', codexTurnStartParams(threadId, ctx.text, imagePaths, ctx.model, ctx.effort));
                mapper.turnId ??= turn?.turn?.id ?? null;
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
                // Ends on turn/completed or the process dying.
                await new Promise<void>(res => {
                    const tick = setInterval(() => {
                        if (mapper.end) {
                            clearInterval(tick);
                            res();
                        }
                    }, 50);
                    rpc.closed.then(() => {
                        clearInterval(tick);
                        res();
                    });
                });
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
