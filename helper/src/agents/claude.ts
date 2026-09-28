// Claude Code adapter: one `claude -p` process per message, stream-json both ways.
//
// Every flag below was checked against claude 2.1.283 by running it against a
// local fake Anthropic endpoint with an isolated CLAUDE_CONFIG_DIR and reading
// the Messages API request it sent (recordings in helper/test/fixtures/claude/, provenance in helper/test/adapters.test.ts):
// the model saw exactly Skill, WebFetch, WebSearch and our twelve
// mcp__vault__* tools — nothing else.

import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
    MCP_SERVER_NAME, TOOL_CALL_TIMEOUT_MS, isUuid,
    type AgentEvent, type AgentStatus, type HistoryItem, type ModelInfo, type RunImage, type RunUsage, type SessionHistory,
} from '../../../shared/vaultAgentProtocol.ts';
import { agentEnv, drainTail, readLines, runCapture, stopProcess } from '../proc.ts';
import { VAULT_AGENT_PROMPT } from '../prompt.ts';
import { findAgentBinary, parseVersion, type FoundBinary } from './discover.ts';
import {
    MCP_TOKEN_ENV, RunRefused, SAFE_EFFORT_RE, SAFE_MODEL_RE, truncate,
    type AgentAdapter, type Foreign, type RunContext, type RunHandle, type RunOutcome,
} from './types.ts';

const IS_WIN = process.platform === 'win32';

/** Claude Code's own name for our tools: `mcp__vault__vault_read`. */
const OWN_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

/**
 * The built-in tools the agent keeps. `--tools` REPLACES the built-in set, so
 * Bash, Read, Edit, Write, Glob, Grep, NotebookEdit, Task, TodoWrite … are not
 * merely denied — they do not exist in the session. Skill loads the vault's
 * mirrored skills (instruction text); WebSearch/WebFetch are the user's
 * decision to allow the web.
 */
export const CLAUDE_BUILTIN_TOOLS = ['Skill', 'WebSearch', 'WebFetch'] as const;

export interface ClaudeArgsInput {
    mcpBaseUrl: string;
    sessionId: string | null;
    /** Minted by us for a new chat, so the panel learns the id before Claude says it. */
    newSessionId: string;
    model: string | null;
    effort: string | null;
}

/** argv after the binary. Pure; the containment tests assert on it. */
/** Hosts the agent's WebFetch may never reach: this machine, and the cloud metadata address. */
export const CLAUDE_WEBFETCH_DENIED_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '169.254.169.254'];

export function buildClaudeArgs(input: ClaudeArgsInput): string[] {
    const mcpConfig = {
        mcpServers: {
            [MCP_SERVER_NAME]: {
                type: 'http',
                // Claude expands ${VAR} in --mcp-config (verified), so the run's token
                // travels in the child's environment instead of its argv.
                url: `${input.mcpBaseUrl}\${${MCP_TOKEN_ENV}}`,
                headers: { Authorization: `Bearer \${${MCP_TOKEN_ENV}}` },
                // Never defer our tools behind ToolSearch (not in our --tools anyway).
                alwaysLoad: true,
            },
        },
    };
    const settings = {
        // Hooks are shell commands from the user's (or a plugin's) settings: code
        // outside the vault. Verified: a SessionStart/UserPromptSubmit hook in user
        // settings runs without this and does not run with it.
        disableAllHooks: true,
        // Auto-memory tells the model to write memory files with the Write tool,
        // which this session does not have; verified it drops the section.
        autoMemoryEnabled: false,
    };
    return [
        '-p',
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        '--verbose',                      // required by stream-json output
        '--include-partial-messages',     // token-level deltas
        // `--tools` and `--allowedTools` are variadic; each is followed by another
        // flag, never by a free value, so neither can swallow the next argument.
        '--tools', CLAUDE_BUILTIN_TOOLS.join(','),
        // Pre-approve exactly what exists; `dontAsk` denies anything else instead
        // of prompting (there is nobody to answer a prompt in -p mode).
        '--allowedTools', [`mcp__${MCP_SERVER_NAME}`, ...CLAUDE_BUILTIN_TOOLS].join(','),
        // WebFetch already upgrades http to https and does not follow a redirect
        // to another host, so a plain-http local service is out of its reach;
        // these deny the loopback/metadata hosts outright (verified: "WebFetch
        // denied access to domain:127.0.0.1"), so an https one is too.
        '--disallowedTools', ...CLAUDE_WEBFETCH_DENIED_HOSTS.map(h => `WebFetch(domain:${h})`),
        '--permission-mode', 'dontAsk',
        // Only our server: the user's ~/.claude.json, project .mcp.json and plugin
        // MCP servers are not loaded (verified: a user-level server was not contacted).
        '--strict-mcp-config',
        '--mcp-config', JSON.stringify(mcpConfig),
        // Per-invocation settings layer — nothing is written to ~/.claude/settings.json.
        '--settings', JSON.stringify(settings),
        '--append-system-prompt', VAULT_AGENT_PROMPT,
        ...(input.model ? ['--model', input.model] : []),
        ...(input.effort ? ['--effort', input.effort] : []),
        // Never `--bare`: it skips OAuth/keychain and would log a subscription user out.
        ...(input.sessionId ? ['--resume', input.sessionId] : ['--session-id', input.newSessionId]),
    ];
}

export function claudeEnv(bin: FoundBinary, token: string): Record<string, string> {
    return agentEnv(bin.pathDirs, {
        [MCP_TOKEN_ENV]: token,
        // Belt and braces with alwaysLoad: keep MCP tools in the prompt, not behind search.
        ENABLE_TOOL_SEARCH: 'false',
        // Our own tool timeout (TOOL_CALL_TIMEOUT_MS) must fire first and come back as
        // an MCP isError the model can read, not as Claude's transport timeout.
        MCP_TOOL_TIMEOUT: String(TOOL_CALL_TIMEOUT_MS + 30_000),
    });
}

/** The stream-json user message: images first (Anthropic's recommendation), then text. */
export function claudeUserMessage(text: string, images: RunImage[]): string {
    const content = [
        ...images.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.mimeType, data: i.data } })),
        { type: 'text', text },
    ];
    return JSON.stringify({ type: 'user', message: { role: 'user', content } });
}

/* ───────────────────────── stream parsing ───────────────────────── */

export interface ClaudeResult {
    subtype: string;
    isError: boolean;
    text: string;
    sessionId: string | null;
    usage?: RunUsage;
}

function blockText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map(c => (c && typeof c === 'object' && (c as { type?: string }).type === 'text' ? String((c as { text?: unknown }).text ?? '') : '')).join('');
}

/** Turns stdout lines into AgentEvents. Pure; fed by the run and by the fixture tests. */
export class ClaudeStreamParser {
    result: ClaudeResult | null = null;
    sessionId: string | null = null;
    private readonly openTools = new Map<string, string>();
    private sessionAnnounced = false;

    constructor(private readonly emit: (e: AgentEvent) => void) {}

    announceSession(id: string): void {
        if (this.sessionAnnounced) return;
        this.sessionAnnounced = true;
        this.sessionId = id;
        this.emit({ type: 'session', sessionId: id });
    }

    feed(line: string): void {
        let msg: Foreign;
        try {
            msg = JSON.parse(line);
        } catch {
            return;
        }
        if (!msg || typeof msg !== 'object') return;
        // Sub-agent traffic (none: there is no Task tool) would carry a parent id.
        if (msg.parent_tool_use_id) return;
        switch (msg.type) {
            case 'system':
                if (msg.subtype === 'init' && typeof msg.session_id === 'string') this.announceSession(msg.session_id);
                else if (msg.subtype === 'compact_boundary') this.emit({ type: 'notice', message: 'The conversation was compacted to fit the context window.' });
                return;
            case 'stream_event': {
                const ev = msg.event;
                if (ev?.type !== 'content_block_delta') return;
                const d = ev.delta;
                if (d?.type === 'text_delta' && typeof d.text === 'string' && d.text) this.emit({ type: 'text-delta', text: d.text });
                else if (d?.type === 'thinking_delta' && typeof d.thinking === 'string' && d.thinking) this.emit({ type: 'reasoning-delta', text: d.thinking });
                return;
            }
            case 'assistant': {
                const content = msg.message?.content;
                if (!Array.isArray(content)) return;
                for (const block of content) {
                    if (block?.type !== 'tool_use' || typeof block.id !== 'string' || typeof block.name !== 'string') continue;
                    // Our own tools reach the panel as `tool.call`; never twice.
                    if (block.name.startsWith(OWN_TOOL_PREFIX)) continue;
                    this.openTools.set(block.id, block.name);
                    this.emit({ type: 'tool', callId: block.id, name: block.name, input: block.input, status: 'running' });
                }
                return;
            }
            case 'user': {
                const content = msg.message?.content;
                if (!Array.isArray(content)) return;
                for (const block of content) {
                    const name = block?.type === 'tool_result' ? this.openTools.get(block.tool_use_id) : undefined;
                    if (name === undefined) continue;
                    this.openTools.delete(block.tool_use_id);
                    const output = truncate(blockText(block.content));
                    this.emit({ type: 'tool', callId: block.tool_use_id, name, status: block.is_error ? 'error' : 'done', output });
                }
                return;
            }
            case 'result': {
                const u = msg.usage ?? {};
                const usage: RunUsage = {};
                const input = [u.input_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens].filter((n): n is number => typeof n === 'number');
                if (input.length) usage.inputTokens = input.reduce((a, b) => a + b, 0);
                if (typeof u.output_tokens === 'number') usage.outputTokens = u.output_tokens;
                if (typeof msg.total_cost_usd === 'number') usage.costUsd = msg.total_cost_usd;
                this.result = {
                    subtype: String(msg.subtype ?? ''),
                    isError: msg.is_error === true,
                    text: typeof msg.result === 'string' ? msg.result : '',
                    sessionId: typeof msg.session_id === 'string' ? msg.session_id : this.sessionId,
                    usage,
                };
                return;
            }
        }
    }
}

const LOGIN_HINT = /(\/login|not logged in|log in|invalid api key|authentication|unauthori[sz]ed|oauth token)/i;

export function claudeOutcome(p: ClaudeResult | null, cancelled: boolean, exitCode: number | null, stderrTail: string): RunOutcome {
    if (cancelled) return { kind: 'done', status: 'cancelled', sessionId: p?.sessionId ?? null, usage: p?.usage };
    if (p && p.subtype === 'success' && !p.isError) return { kind: 'done', status: 'ok', sessionId: p.sessionId, usage: p.usage };
    const text = `${p?.text ?? ''}\n${stderrTail}`;
    if (LOGIN_HINT.test(text)) return { kind: 'error', reason: 'logged-out', message: 'Claude Code is not logged in. Run `claude` in a terminal and log in, then try again.' };
    if (/no conversation found/i.test(text)) return { kind: 'error', reason: 'bad-request', message: 'This chat’s Claude Code session is not on this computer.' };
    const detail = p?.text?.trim() ? truncate(p.text.trim(), 500) : `Claude Code exited${exitCode === null ? '' : ` with code ${exitCode}`}.`;
    return { kind: 'error', reason: 'crashed', message: detail };
}

/* ───────────────────────── history (the CLI's own transcript) ───────────────────────── */

/** Claude files transcripts under `projects/<cwd with every non-alphanumeric replaced by '-'>/`. */
export function encodeProjectDir(cwd: string): string {
    return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

export function claudeProjectsDir(): string {
    const configDir = process.env.CLAUDE_CONFIG_DIR;
    return join(configDir && configDir.trim() ? configDir : join(homedir(), '.claude'), 'projects');
}

const INTERRUPTED = /^\[Request interrupted by user/;

/** Normalizes one transcript to history items. `cwd` is returned so callers can check ownership. */
export function parseClaudeTranscript(text: string): { items: HistoryItem[]; cwd: string | null } {
    const items: HistoryItem[] = [];
    const tools = new Map<string, Extract<HistoryItem, { kind: 'tool' }>>();
    let cwd: string | null = null;
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let d: Foreign;
        try {
            d = JSON.parse(line);
        } catch {
            continue;
        }
        if (!d || d.isSidechain) continue;
        if (typeof d.cwd === 'string' && !cwd) cwd = d.cwd;
        const content = d.message?.content;
        if (d.type === 'user' && !d.isMeta) {
            if (typeof content === 'string') {
                if (!INTERRUPTED.test(content)) items.push({ kind: 'user', text: content, imageCount: 0 });
                continue;
            }
            if (!Array.isArray(content)) continue;
            let textParts = '';
            let images = 0;
            for (const b of content) {
                if (b?.type === 'text') textParts += (textParts ? '\n' : '') + String(b.text ?? '');
                else if (b?.type === 'image') images++;
                else if (b?.type === 'tool_result') {
                    const t = tools.get(b.tool_use_id);
                    if (t) {
                        t.output = truncate(blockText(b.content));
                        if (b.is_error) t.isError = true;
                    }
                }
            }
            if ((textParts && !INTERRUPTED.test(textParts)) || images) items.push({ kind: 'user', text: textParts, imageCount: images });
        } else if (d.type === 'assistant') {
            if (d.message?.model === '<synthetic>' || !Array.isArray(content)) continue;
            for (const b of content) {
                if (b?.type === 'text' && b.text) items.push({ kind: 'assistant', text: String(b.text) });
                else if (b?.type === 'thinking' && b.thinking) items.push({ kind: 'reasoning', text: String(b.thinking) });
                else if (b?.type === 'tool_use' && typeof b.name === 'string') {
                    const item: Extract<HistoryItem, { kind: 'tool' }> = {
                        kind: 'tool',
                        name: b.name.startsWith(OWN_TOOL_PREFIX) ? b.name.slice(OWN_TOOL_PREFIX.length) : b.name,
                        input: b.input,
                    };
                    tools.set(b.id, item);
                    items.push(item);
                }
            }
        }
    }
    return { items, cwd };
}

/** The transcript for `sessionId` that was recorded in `cwd`, or null. */
export function findClaudeTranscript(projectsDir: string, cwd: string, sessionId: string): string | null {
    if (!isUuid(sessionId)) return null;
    const direct = join(projectsDir, encodeProjectDir(cwd), `${sessionId}.jsonl`);
    if (existsSync(direct)) return direct;
    // Very long cwds are hashed by Claude; fall back to a scan, ownership checked by the caller.
    let dirs: string[] = [];
    try {
        dirs = readdirSync(projectsDir);
    } catch {
        return null;
    }
    for (const d of dirs) {
        const p = join(projectsDir, d, `${sessionId}.jsonl`);
        if (existsSync(p)) return p;
    }
    return null;
}

/* ───────────────────────── models ───────────────────────── */

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
/** Used when the CLI's `initialize` answer is missing or not the shape we know. */
export const CLAUDE_FALLBACK_MODELS: ModelInfo[] = [
    { id: 'default', label: 'Default (recommended)', efforts: CLAUDE_EFFORTS, defaultEffort: 'high', images: true, isDefault: true },
    { id: 'opus', label: 'Opus', efforts: CLAUDE_EFFORTS, defaultEffort: 'high', images: true },
    { id: 'sonnet', label: 'Sonnet', efforts: CLAUDE_EFFORTS, defaultEffort: 'high', images: true },
    { id: 'haiku', label: 'Haiku', efforts: [], defaultEffort: null, images: true },
];

/** Maps the `models` array of the stream-json `initialize` control response. */
export function mapClaudeModels(models: unknown): ModelInfo[] | null {
    if (!Array.isArray(models) || !models.length) return null;
    const out: ModelInfo[] = [];
    for (const m of models) {
        if (!m || typeof m.value !== 'string' || !SAFE_MODEL_RE.test(m.value)) return null;
        const efforts = m.supportsEffort && Array.isArray(m.supportedEffortLevels)
            ? m.supportedEffortLevels.filter((e: unknown): e is string => typeof e === 'string' && SAFE_EFFORT_RE.test(e))
            : [];
        out.push({
            id: m.value,
            label: typeof m.displayName === 'string' ? m.displayName : m.value,
            efforts,
            // Claude's default when --effort is absent (observed: output_config.effort "high").
            defaultEffort: efforts.includes('high') ? 'high' : null,
            images: true,
            ...(m.value === 'default' ? { isDefault: true } : {}),
        });
    }
    return out;
}

/* ───────────────────────── adapter ───────────────────────── */

async function queryModels(bin: FoundBinary, cwd: string): Promise<ModelInfo[] | null> {
    // A throwaway print-mode session: no tools, no MCP, no hooks, not persisted.
    const cmd = [...bin.command, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
        '--tools', '', '--strict-mcp-config', '--settings', JSON.stringify({ disableAllHooks: true }), '--no-session-persistence'];
    const proc = Bun.spawn(cmd, { cwd, env: agentEnv(bin.pathDirs), stdin: 'pipe', stdout: 'pipe', stderr: 'ignore', windowsHide: true });
    const timer = setTimeout(() => void stopProcess(proc, 500), 20_000);
    try {
        proc.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: 'bme-models', request: { subtype: 'initialize' } })}\n`);
        proc.stdin.flush();
        for await (const line of readLines(proc.stdout)) {
            let msg: Foreign;
            try {
                msg = JSON.parse(line);
            } catch {
                continue;
            }
            if (msg?.type === 'control_response' && msg.response?.request_id === 'bme-models') {
                return msg.response.subtype === 'success' ? mapClaudeModels(msg.response.response?.models) : null;
            }
        }
        return null;
    } finally {
        clearTimeout(timer);
        try {
            proc.stdin.end();
        } catch { /* closed */ }
        void stopProcess(proc, 1000);
    }
}

export function createClaudeAdapter(opts: { sessionsRoot: string }): AgentAdapter {
    let modelCache: { at: number; models: ModelInfo[] } | null = null;
    let statusCache: { at: number; status: AgentStatus } | null = null;

    const loginCommand = 'claude auth login';
    const installCommand = IS_WIN ? 'irm https://claude.ai/install.ps1 | iex' : 'curl -fsSL https://claude.ai/install.sh | bash';

    return {
        id: 'claude',
        isValidSessionId: (id): id is string => isUuid(id),
        isValidModel: (id): id is string => typeof id === 'string' && SAFE_MODEL_RE.test(id),

        async status(refresh) {
            if (statusCache && !refresh && Date.now() - statusCache.at < 30_000) return statusCache.status;
            const bin = await findAgentBinary('claude', refresh);
            const base: AgentStatus = { agent: 'claude', installed: !!bin, version: null, loggedIn: null, incompatible: null, loginCommand, installCommand };
            if (!bin) return (statusCache = { at: Date.now(), status: { ...base, loggedIn: false } }).status;
            const env = agentEnv(bin.pathDirs);
            const [ver, auth] = await Promise.all([
                runCapture([...bin.command, '--version'], { env, timeoutMs: 10_000 }),
                runCapture([...bin.command, 'auth', 'status', '--json'], { env, timeoutMs: 15_000 }),
            ]);
            let loggedIn: boolean | null = null;
            try {
                const j = JSON.parse(auth.stdout);
                if (typeof j.loggedIn === 'boolean') loggedIn = j.loggedIn;
            } catch {
                if (!auth.timedOut && auth.code !== null) loggedIn = auth.code === 0;
            }
            return (statusCache = { at: Date.now(), status: { ...base, version: parseVersion(ver.stdout), loggedIn } }).status;
        },

        async models(refresh) {
            if (modelCache && !refresh && Date.now() - modelCache.at < 10 * 60_000) return modelCache.models;
            const bin = await findAgentBinary('claude');
            if (!bin) return CLAUDE_FALLBACK_MODELS;
            const models = await queryModels(bin, opts.sessionsRoot).catch(() => null);
            if (!models) return CLAUDE_FALLBACK_MODELS;
            modelCache = { at: Date.now(), models };
            return models;
        },

        async start(ctx: RunContext): Promise<RunHandle> {
            const bin = await findAgentBinary('claude');
            if (!bin) throw new RunRefused('agent-missing', 'Claude Code is not installed.');
            const newSessionId = randomUUID();
            const args = buildClaudeArgs({ mcpBaseUrl: ctx.mcpBaseUrl, sessionId: ctx.sessionId, newSessionId, model: ctx.model, effort: ctx.effort });
            const proc = Bun.spawn([...bin.command, ...args], {
                cwd: ctx.cwd,
                env: claudeEnv(bin, ctx.mcpToken),
                stdin: 'pipe',
                stdout: 'pipe',
                stderr: 'pipe',
                windowsHide: true,
            });
            const parser = new ClaudeStreamParser(ctx.emit);
            parser.announceSession(ctx.sessionId ?? newSessionId);
            // stdin stays open: closing it is how a stream-json session is told to end,
            // and an open stdin is how we send the graceful interrupt.
            proc.stdin.write(`${claudeUserMessage(ctx.text, ctx.images)}\n`);
            proc.stdin.flush();

            let cancelled = false;
            const timers: ReturnType<typeof setTimeout>[] = [];
            const endInput = () => {
                try {
                    proc.stdin.end();
                } catch { /* closed */ }
            };
            const stderrTail = drainTail(proc.stderr);
            const outcome = (async (): Promise<RunOutcome> => {
                for await (const line of readLines(proc.stdout)) {
                    parser.feed(line);
                    if (parser.result) endInput();
                }
                endInput();
                const code = await proc.exited;
                timers.forEach(clearTimeout);
                return claudeOutcome(parser.result, cancelled, code, await stderrTail.catch(() => ''));
            })().catch((e): RunOutcome => ({ kind: 'error', reason: 'crashed', message: e instanceof Error ? e.message : 'Claude Code failed.' }));

            return {
                outcome,
                cancel() {
                    if (cancelled) return;
                    cancelled = true;
                    // Verified: an `interrupt` control request ends the turn within
                    // milliseconds with result/error_during_execution and keeps the
                    // transcript consistent; signals are the fallback.
                    try {
                        proc.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: `bme-int-${ctx.runId}`, request: { subtype: 'interrupt' } })}\n`);
                        proc.stdin.flush();
                    } catch { /* closed */ }
                    timers.push(setTimeout(() => { try { proc.kill('SIGINT'); } catch { /* gone */ } }, 3000));
                    timers.push(setTimeout(() => void stopProcess(proc, 3000), 6000));
                },
            };
        },

        async history(cwd, sessionId) {
            const file = findClaudeTranscript(claudeProjectsDir(), cwd, sessionId);
            if (!file) return { found: false, items: [] };
            const parsed = parseClaudeTranscript(readFileSync(file, 'utf8'));
            // Only sessions recorded in this vault's folder belong to this vault.
            if (!parsed.cwd || resolve(parsed.cwd) !== resolve(cwd)) return { found: false, items: [] };
            return { found: true, items: parsed.items } satisfies SessionHistory;
        },

        async deleteSession(cwd, sessionId) {
            const file = findClaudeTranscript(claudeProjectsDir(), cwd, sessionId);
            if (!file) return false;
            const parsed = parseClaudeTranscript(readFileSync(file, 'utf8'));
            if (!parsed.cwd || resolve(parsed.cwd) !== resolve(cwd)) return false;
            unlinkSync(file);
            // Sub-agent transcripts and spilled tool results live beside it.
            const sibling = file.replace(/\.jsonl$/, '');
            try {
                if (statSync(sibling).isDirectory()) rmSync(sibling, { recursive: true, force: true });
            } catch { /* none */ }
            return true;
        },
    };
}
