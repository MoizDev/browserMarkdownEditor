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

const OWN_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

export interface ClaudeArgsInput {
    mcpBaseUrl: string;
    sessionId: string | null;
    newSessionId: string;
    model: string | null;
    effort: string | null;
    userPlugins: readonly string[];
}

export function buildClaudeArgs(input: ClaudeArgsInput): string[] {
    const mcpConfig = {
        mcpServers: {
            [MCP_SERVER_NAME]: {
                type: 'http',
                // Claude expands ${VAR} in --mcp-config (verified), so the run's token
                // travels in the child's environment instead of its argv.
                url: `${input.mcpBaseUrl}\${${MCP_TOKEN_ENV}}`,
                headers: { Authorization: `Bearer \${${MCP_TOKEN_ENV}}` },
                alwaysLoad: true,
            },
        },
    };
    const settings = {
        disableAllHooks: true,
        ...(input.userPlugins.length ? { enabledPlugins: Object.fromEntries(input.userPlugins.map(id => [id, false])) } : {}),
    };
    return [
        '-p',
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        '--verbose',
        '--include-partial-messages',
        '--permission-mode', 'bypassPermissions',
        '--strict-mcp-config',
        '--mcp-config', JSON.stringify(mcpConfig),
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
        ENABLE_TOOL_SEARCH: 'false',
        MCP_TOOL_TIMEOUT: String(TOOL_CALL_TIMEOUT_MS + 30_000),
    });
}

export function claudeUserMessage(text: string, images: RunImage[]): string {
    const content = [
        ...images.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.mimeType, data: i.data } })),
        { type: 'text', text },
    ];
    return JSON.stringify({ type: 'user', message: { role: 'user', content } });
}

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
    if (/cannot be used with root\/sudo/i.test(text)) return { kind: 'error', reason: 'crashed', message: 'Claude Code will not run without permission prompts as root. Run VaultAgent as your own user, not as root.' };
    if (/no conversation found/i.test(text)) return { kind: 'error', reason: 'bad-request', message: 'This chat’s Claude Code session is not on this computer.' };
    const detail = p?.text?.trim() ? truncate(p.text.trim(), 500) : `Claude Code exited${exitCode === null ? '' : ` with code ${exitCode}`}.`;
    return { kind: 'error', reason: 'crashed', message: detail };
}

export function encodeProjectDir(cwd: string): string {
    return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

export function claudeConfigDir(): string {
    const configDir = process.env.CLAUDE_CONFIG_DIR;
    return configDir && configDir.trim() ? configDir : join(homedir(), '.claude');
}

export function claudeProjectsDir(): string {
    return join(claudeConfigDir(), 'projects');
}

export function userClaudePlugins(settingsJson: string): string[] {
    try {
        const plugins = (JSON.parse(settingsJson) as Foreign)?.enabledPlugins;
        if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) return [];
        return Object.keys(plugins);
    } catch {
        return [];
    }
}

function readUserClaudePlugins(): string[] {
    try {
        return userClaudePlugins(readFileSync(join(claudeConfigDir(), 'settings.json'), 'utf8'));
    } catch {
        return [];
    }
}

const INTERRUPTED = /^\[Request interrupted by user/;

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

export function findClaudeTranscript(projectsDir: string, cwd: string, sessionId: string): string | null {
    if (!isUuid(sessionId)) return null;
    const direct = join(projectsDir, encodeProjectDir(cwd), `${sessionId}.jsonl`);
    if (existsSync(direct)) return direct;
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

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const CLAUDE_FALLBACK_MODELS: ModelInfo[] = [
    { id: 'default', label: 'Default (recommended)', efforts: CLAUDE_EFFORTS, defaultEffort: 'high', images: true, isDefault: true },
    { id: 'opus', label: 'Opus', efforts: CLAUDE_EFFORTS, defaultEffort: 'high', images: true },
    { id: 'sonnet', label: 'Sonnet', efforts: CLAUDE_EFFORTS, defaultEffort: 'high', images: true },
    { id: 'haiku', label: 'Haiku', efforts: [], defaultEffort: null, images: true },
];

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
            defaultEffort: efforts.includes('high') ? 'high' : null,
            images: true,
            ...(m.value === 'default' ? { isDefault: true } : {}),
        });
    }
    return out;
}

async function queryModels(bin: FoundBinary, cwd: string): Promise<ModelInfo[] | null> {
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
            const base: AgentStatus = { agent: 'claude', installed: !!bin, version: null, loggedIn: null, loginCommand, installCommand };
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
            const args = buildClaudeArgs({
                mcpBaseUrl: ctx.mcpBaseUrl, sessionId: ctx.sessionId, newSessionId, model: ctx.model, effort: ctx.effort,
                userPlugins: readUserClaudePlugins(),
            });
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
            if (!parsed.cwd || resolve(parsed.cwd) !== resolve(cwd)) return { found: false, items: [] };
            return { found: true, items: parsed.items } satisfies SessionHistory;
        },

        async deleteSession(cwd, sessionId) {
            const file = findClaudeTranscript(claudeProjectsDir(), cwd, sessionId);
            if (!file) return false;
            const parsed = parseClaudeTranscript(readFileSync(file, 'utf8'));
            if (!parsed.cwd || resolve(parsed.cwd) !== resolve(cwd)) return false;
            unlinkSync(file);
            const sibling = file.replace(/\.jsonl$/, '');
            try {
                if (statSync(sibling).isDirectory()) rmSync(sibling, { recursive: true, force: true });
            } catch { /* none */ }
            return true;
        },
    };
}
