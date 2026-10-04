// The three CLI adapters, without the CLIs.
//
// 1. The exact argv / config / env each adapter hands its CLI — the never-ask,
//    full-access mode, plus the stable exclusions (the user's MCP servers,
//    hooks, and plugins where a single switch exists). A refactor that drops
//    one must fail here, not in a user's home folder.
// 2. Zero interference: nothing points the CLI at another config, and nothing
//    is ever written into the user's own (~/.claude, ~/.codex, ~/.config/opencode).
// 3. Stream parsers and history/model mappers against recorded output.
//
// Fixture provenance (helper/test/fixtures/**). Recorded 2026-09-27 on macOS
// against the real CLIs — Claude Code 2.1.283, Codex 0.157.1 (npm pack, run with
// CODEX_HOME in a scratch folder), OpenCode 1.18.29 — each pointed at a local fake
// model server (Anthropic / OpenAI Responses / OpenAI chat shapes) that always
// calls `vault_read` once and then says "Hello from fake.", with the helper's MCP
// endpoint served by the same fake. Machine-specific values were then replaced:
// home → /home/user, the vault folder → /home/user/.bme-agent-sessions/6f1c2d3e-…,
// session ids, hostnames and installation ids → placeholders.
// Hand-written (shapes observed live, never persisted): claude/interrupted,
// claude/logged-out, claude/web-search-thinking, codex/turn-interrupted.
// codex/resume-turn is a resumed thread whose late `turn/interrupt` found no
// active turn.

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { MCP_SERVER_NAME, type AgentEvent } from '../../shared/vaultAgentProtocol.ts';
import {
    ClaudeStreamParser, buildClaudeArgs, claudeEnv, claudeOutcome, claudeUserMessage,
    encodeProjectDir, mapClaudeModels, parseClaudeTranscript, userClaudePlugins,
} from '../src/agents/claude.ts';
import {
    CodexEventMapper, buildCodexArgs, codexOutcome, codexServerReply, codexStartupError, unwrapShell, codexThreadConfig, codexThreadResumeParams,
    codexThreadStartParams, codexToolItem, codexTurnStartParams, mapCodexModels, mapCodexTurns, userCodexMcpServers,
} from '../src/agents/codex.ts';
import { resolveCmdShim, parseVersion, type FoundBinary } from '../src/agents/discover.ts';
import {
    OPENCODE_AGENT, OPENCODE_PERMISSION, OpencodeEventMapper, buildOpencodeConfig, buildOpencodeServeArgs, ensureOpencodeProject, mapOpencodeMessages,
    mapOpencodeModels, opencodeEnv, opencodeGlobalConfigFiles, opencodeOutcome, stripJsonc, userOpencodeMcpServers,
} from '../src/agents/opencode.ts';
import { MCP_TOKEN_ENV, type Foreign } from '../src/agents/types.ts';
import { newRunToken } from '../src/security.ts';

const FIX = join(import.meta.dir, 'fixtures');
const fixture = (p: string) => readFileSync(join(FIX, p), 'utf8');
const lines = (p: string) => fixture(p).split('\n').filter(l => l.trim());
const MCP_BASE = 'http://127.0.0.1:47823/mcp/';
const CWD = '/home/user/.bme-agent-sessions/6f1c2d3e-4a5b-4c6d-8e7f-001122334455';
const BIN: FoundBinary = { command: ['/opt/bin/x'], path: '/opt/bin/x', pathDirs: ['/opt/bin'] };

/** Anything that would point a CLI at a config other than its own default, or name the user's stores. */
const GLOBAL_CONFIG = /(\/|\\)\.claude(\/|\\|\.json|$)|(\/|\\)\.codex(\/|\\|$)|\.config[/\\]opencode|(\/|\\)\.opencode(\/|\\|$)|settings\.json|config\.toml/;
const CONFIG_REDIRECT_ENV = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME'];

function flagValue(args: string[], flag: string): string {
    const i = args.indexOf(flag);
    expect(i).toBeGreaterThanOrEqual(0);
    return args[i + 1];
}

/** The env overrides alone (agentEnv starts from process.env, which is the user's own and passed through untouched). */
function added(env: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.entries(env).filter(([k, v]) => process.env[k] !== v));
}

/* ═════════════════════════════ Claude Code ═════════════════════════════ */

describe('claude: argv', () => {
    const base = { mcpBaseUrl: MCP_BASE, sessionId: null, newSessionId: '11111111-2222-4333-8444-555555555555', model: null, effort: null, userPlugins: [] };
    const args = buildClaudeArgs(base);

    test('never asks, with the full default tool set: nothing narrows it', () => {
        expect(flagValue(args, '--permission-mode')).toBe('bypassPermissions');
        for (const bad of ['--tools', '--allowedTools', '--disallowedTools', '--bare', '--add-dir', '--plugin-dir', '--agents', '--continue', '--setting-sources', '--safe-mode']) {
            expect(args).not.toContain(bad);
        }
    });

    test('only our MCP server; hooks off; the user\'s plugins off by their own ids', () => {
        expect(args).toContain('--strict-mcp-config');
        const mcp = JSON.parse(flagValue(args, '--mcp-config'));
        expect(Object.keys(mcp.mcpServers)).toEqual([MCP_SERVER_NAME]);
        expect(mcp.mcpServers.vault).toEqual({
            type: 'http',
            url: `${MCP_BASE}\${${MCP_TOKEN_ENV}}`,
            headers: { Authorization: `Bearer \${${MCP_TOKEN_ENV}}` },
            alwaysLoad: true,
        });
        // --mcp-config is variadic: the next argument must be a flag, never a free value.
        expect(args[args.indexOf('--mcp-config') + 2].startsWith('--')).toBe(true);
        expect(JSON.parse(flagValue(args, '--settings'))).toEqual({ disableAllHooks: true });
        const withPlugins = buildClaudeArgs({ ...base, userPlugins: ['a@m', 'b@n'] });
        expect(JSON.parse(flagValue(withPlugins, '--settings'))).toEqual({ disableAllHooks: true, enabledPlugins: { 'a@m': false, 'b@n': false } });
    });

    test('userClaudePlugins reads the ids, tolerating anything else', () => {
        expect(userClaudePlugins('{"enabledPlugins":{"a@m":true,"b@n":false}}')).toEqual(['a@m', 'b@n']);
        for (const bad of ['not json', '{}', '{"enabledPlugins":[1]}', 'null', '{"enabledPlugins":"x"}']) expect(userClaudePlugins(bad)).toEqual([]);
    });

    test('session: new chats get our id, old ones resume; model/effort only when chosen', () => {
        expect(flagValue(args, '--session-id')).toBe(base.newSessionId);
        expect(args).not.toContain('--resume');
        const resumed = buildClaudeArgs({ ...base, sessionId: '6f1c2d3e-0000-4000-8000-000000000001', model: 'opus', effort: 'high' });
        expect(flagValue(resumed, '--resume')).toBe('6f1c2d3e-0000-4000-8000-000000000001');
        expect(resumed).not.toContain('--session-id');
        expect(flagValue(resumed, '--model')).toBe('opus');
        expect(flagValue(resumed, '--effort')).toBe('high');
        expect(args).not.toContain('--model');
    });

    test('zero interference: config is inline, token only in the env', () => {
        const token = newRunToken();
        for (const a of args) {
            expect(a).not.toContain(token);
            expect(GLOBAL_CONFIG.test(a)).toBe(false);
            expect(a.includes(homedir())).toBe(false);
        }
        const env = added(claudeEnv(BIN, token));
        expect(env[MCP_TOKEN_ENV]).toBe(token);
        expect(env.ENABLE_TOOL_SEARCH).toBe('false');
        for (const k of CONFIG_REDIRECT_ENV) expect(env[k]).toBeUndefined();
    });

    test('stream-json user message: images first', () => {
        const m = JSON.parse(claudeUserMessage('hi', [{ mimeType: 'image/png', data: 'AAAA' }]));
        expect(m.message.content).toEqual([
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
            { type: 'text', text: 'hi' },
        ]);
    });
});

function parseClaude(file: string) {
    const events: AgentEvent[] = [];
    const p = new ClaudeStreamParser(e => events.push(e));
    for (const l of lines(file)) p.feed(l);
    return { events, p };
}

describe('claude: stream parser (fixtures)', () => {
    test('run with a vault tool call: our tool never becomes a `tool` event', () => {
        expect(fixture('claude/run-tool-call.jsonl')).toContain('mcp__vault__vault_read');
        const { events, p } = parseClaude('claude/run-tool-call.jsonl');
        expect(events).toEqual([
            { type: 'session', sessionId: '11111111-2222-4333-8444-555555555555' },
            { type: 'text-delta', text: 'Hello ' },
            { type: 'text-delta', text: 'from ' },
            { type: 'text-delta', text: 'fake.' },
        ]);
        expect(claudeOutcome(p.result, false, 0, '')).toMatchObject({ kind: 'done', status: 'ok', sessionId: '11111111-2222-4333-8444-555555555555', usage: { inputTokens: 20, outputTokens: 10 } });
    });

    test('thinking + web search; a sub-agent line is ignored', () => {
        const { events } = parseClaude('claude/web-search-thinking.jsonl');
        expect(events.map(e => e.type)).toEqual(['session', 'reasoning-delta', 'tool', 'tool', 'text-delta']);
        expect(events[2]).toMatchObject({ type: 'tool', name: 'WebSearch', status: 'running', callId: 'toolu_web' });
        expect(events[3]).toMatchObject({ type: 'tool', name: 'WebSearch', status: 'done', callId: 'toolu_web' });
        expect(JSON.stringify(events)).not.toContain('toolu_task');
        expect(JSON.stringify(events)).not.toContain('vault_');
    });

    test('interrupted: cancelled when we asked, otherwise an error', () => {
        const { p } = parseClaude('claude/interrupted.jsonl');
        expect(p.result?.subtype).toBe('error_during_execution');
        expect(claudeOutcome(p.result, true, 0, '')).toMatchObject({ kind: 'done', status: 'cancelled', sessionId: '6f1c2d3e-0000-4000-8000-000000000001' });
        expect(claudeOutcome(p.result, false, 0, '')).toMatchObject({ kind: 'error', reason: 'crashed' });
    });

    test('logged out', () => {
        const { p } = parseClaude('claude/logged-out.jsonl');
        expect(claudeOutcome(p.result, false, 1, '')).toMatchObject({ kind: 'error', reason: 'logged-out' });
        expect(claudeOutcome(null, false, 1, 'No conversation found with session ID x')).toMatchObject({ kind: 'error', reason: 'bad-request' });
        expect(claudeOutcome(null, false, 1, '--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons'))
            .toMatchObject({ kind: 'error', reason: 'crashed', message: expect.stringContaining('as root') });
        expect(claudeOutcome(null, false, 137, '')).toEqual({ kind: 'error', reason: 'crashed', message: 'Claude Code exited with code 137.' });
    });

    test('garbage lines are skipped', () => {
        const events: AgentEvent[] = [];
        const p = new ClaudeStreamParser(e => events.push(e));
        for (const l of ['', 'not json', 'null', '42', '{"type":"assistant","message":{"content":"x"}}']) p.feed(l);
        expect(events).toEqual([]);
    });
});

describe('claude: history and models', () => {
    test('transcript → items; own tool names unprefixed; meta/synthetic/interrupt lines dropped', () => {
        const { items, cwd } = parseClaudeTranscript(fixture('claude/transcript.jsonl'));
        expect(cwd).toBe(CWD);
        expect(items).toEqual([
            { kind: 'user', text: 'hi there', imageCount: 0 },
            { kind: 'tool', name: 'vault_read', input: { path: 'Notes/a.md' }, output: 'FAKE-TOOL-RESULT: hello' },
            { kind: 'assistant', text: 'Hello from fake.' },
            { kind: 'user', text: '<bme-context>ctx</bme-context>\nwhat is this?', imageCount: 1 },
            { kind: 'assistant', text: 'Hello from fake.' },
        ]);
    });

    test('project folder name', () => {
        expect(encodeProjectDir(CWD)).toBe('-home-user--bme-agent-sessions-6f1c2d3e-4a5b-4c6d-8e7f-001122334455');
        expect(encodeProjectDir('C:\\Users\\a b\\.bme-agent-sessions\\x')).toBe('C--Users-a-b--bme-agent-sessions-x');
    });

    test('models from the initialize control response', () => {
        const models = mapClaudeModels(JSON.parse(lines('claude/initialize.jsonl')[0]).response.response.models)!;
        expect(models[0]).toEqual({ id: 'default', label: 'Default (recommended)', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high', images: true, isDefault: true });
        expect(models.find(m => m.id === 'haiku')).toMatchObject({ efforts: [], defaultEffort: null });
        expect(models.every(m => !m.id.startsWith('-'))).toBe(true);
        expect(mapClaudeModels([{ value: '--dangerously-skip-permissions' }])).toBeNull();
        expect(mapClaudeModels(undefined)).toBeNull();
    });
});

/* ═════════════════════════════ Codex ═════════════════════════════ */

describe('codex: shell rows show the command, not its wrapper', () => {
    test('unwrapShell', () => {
        expect(unwrapShell("/bin/zsh -lc 'echo hi && ls -la'")).toBe('echo hi && ls -la');
        expect(unwrapShell(`/bin/bash -lc 'echo '"'"'quoted'"'"' | wc -c'`)).toBe("echo 'quoted' | wc -c");
        expect(unwrapShell('git status')).toBe('git status');
        expect(unwrapShell('powershell.exe -Command "dir"')).toBe('powershell.exe -Command "dir"');
    });
});

describe('codex: a startup failure says why', () => {
    test('the error line of stderr, else its last line', () => {
        // Observed on 0.160.0 with that setting in config.toml.
        expect(codexStartupError('Error: approval_policy = "untrusted" is no longer supported; remove this setting\n'))
            .toBe('approval_policy = "untrusted" is no longer supported; remove this setting');
        expect(codexStartupError('warming up\nsomething broke\n')).toBe('something broke');
        expect(codexStartupError('')).toBe('');
    });
});

describe('codex: argv and thread params', () => {
    const args = buildCodexArgs();

    test('app-server with live web search, and no per-version feature deny-list', () => {
        expect(args).toEqual(['app-server', '-c', 'web_search="live"']);
        expect(args.some(a => a.startsWith('features.'))).toBe(false);
    });

    test('full access, never asks, default environment; the user\'s MCP servers off by name in the thread config', () => {
        const token = newRunToken();
        const cfg = codexThreadConfig(MCP_BASE, token, ['github', 'my.server', MCP_SERVER_NAME]);
        const servers = cfg.mcp_servers as Record<string, Record<string, unknown>>;
        // Dotted names are fine as JSON keys (a `-c` key would split them).
        expect(Object.keys(servers).sort()).toEqual(['github', 'my.server', MCP_SERVER_NAME]);
        expect(servers.github).toEqual({ enabled: false });
        expect(servers['my.server']).toEqual({ enabled: false });
        // Ours is replaced, not disabled.
        expect(servers.vault).toMatchObject({ enabled: true, url: `${MCP_BASE}${token}`, bearer_token_env_var: MCP_TOKEN_ENV, omit_tools_from: ['deferred'], default_tools_approval_mode: 'approve' });
        const start = codexThreadStartParams(CWD, 'gpt-5.5', cfg);
        expect(start).toMatchObject({ cwd: CWD, model: 'gpt-5.5', approvalPolicy: 'never', sandbox: 'danger-full-access', config: cfg });
        expect(start).not.toHaveProperty('environments');
        expect(codexThreadResumeParams('t', CWD, null, cfg)).toMatchObject({ approvalPolicy: 'never', sandbox: 'danger-full-access', config: cfg });
        const turn = codexTurnStartParams('t', 'hi', ['/x/a.png'], null, 'high');
        expect(turn).not.toHaveProperty('environments');
        expect(turn.input).toEqual([{ type: 'text', text: 'hi', text_elements: [] }, { type: 'localImage', path: '/x/a.png' }]);
        expect(Object.keys(codexThreadConfig(MCP_BASE, token, []).mcp_servers as object)).toEqual([MCP_SERVER_NAME]);
    });

    test('server→client requests: approvals approve, questions and forms are declined', () => {
        expect(codexServerReply('item/commandExecution/requestApproval', {})).toEqual({ decision: 'accept' });
        expect(codexServerReply('item/fileChange/requestApproval', {})).toEqual({ decision: 'accept' });
        expect(codexServerReply('execCommandApproval', {})).toEqual({ decision: 'approved' });
        expect(codexServerReply('applyPatchApproval', {})).toEqual({ decision: 'approved' });
        const fileSystem = { read: ['/x'], write: null };
        expect(codexServerReply('item/permissions/requestApproval', { permissions: { network: null, fileSystem } })).toEqual({ permissions: { fileSystem }, scope: 'turn' });
        expect(codexServerReply('mcpServer/elicitation/request', {})).toMatchObject({ action: 'decline' });
        expect(codexServerReply('item/tool/requestUserInput', {})).toBeNull();
        expect(codexServerReply('something/new', {})).toBeNull();
    });

    test('zero interference: the token never reaches argv; no config file is named', () => {
        const token = newRunToken();
        for (const a of buildCodexArgs()) {
            expect(a).not.toContain(token);
            expect(GLOBAL_CONFIG.test(a)).toBe(false);
            expect(a.includes(homedir())).toBe(false);
        }
    });

    test('reads user MCP names from TOML, tolerating garbage', () => {
        expect(userCodexMcpServers('model = "x"\n[mcp_servers.github]\ncommand = "gh"\n[mcp_servers."my-db"]\nurl = "http://x"\n')).toEqual(['github', 'my-db']);
        expect(userCodexMcpServers('this is [not toml')).toEqual([]);
        expect(userCodexMcpServers('')).toEqual([]);
    });
});

function mapCodex(file: string) {
    const msgs = lines(file).map(l => JSON.parse(l));
    const threadId: string = msgs.find(m => m.result?.thread?.id)?.result.thread.id ?? msgs.find(m => m.params?.threadId)?.params.threadId;
    const events: AgentEvent[] = [];
    const m = new CodexEventMapper(threadId, e => events.push(e));
    for (const x of msgs) if (x.method) m.feed(x.method, x.params);
    return { msgs, threadId, events, m };
}

describe('codex: event mapper (fixtures)', () => {
    test('turn with a vault tool call', () => {
        expect(fixture('codex/turn-tool-call.jsonl')).toContain('"server":"vault"');
        const { threadId, events, m } = mapCodex('codex/turn-tool-call.jsonl');
        expect(threadId).toBe('01a0e5da-8462-7052-80fd-7f0d557d43d3');
        expect(events).toEqual([
            { type: 'text-delta', text: 'Hello ' },
            { type: 'text-delta', text: 'from ' },
            { type: 'text-delta', text: 'fake.' },
        ]);
        expect(codexOutcome(m, threadId, false, null)).toEqual({ kind: 'done', status: 'ok', sessionId: threadId, usage: { inputTokens: 20, outputTokens: 10 } });
    });

    test('resumed thread: the reply streams and completes; a late interrupt\'s "no active turn" is harmless', () => {
        const { threadId, events, m } = mapCodex('codex/resume-turn.jsonl');
        expect(events).toEqual([
            { type: 'text-delta', text: 'Hello ' },
            { type: 'text-delta', text: 'from ' },
            { type: 'text-delta', text: 'fake.' },
        ]);
        expect(codexOutcome(m, threadId, false, null)).toMatchObject({ kind: 'done', status: 'ok', sessionId: threadId });
    });

    test('interrupted, with reasoning, web search, and another thread\'s noise', () => {
        const { threadId, events, m } = mapCodex('codex/turn-interrupted.jsonl');
        expect(events).toEqual([
            { type: 'reasoning-delta', text: 'Looking for the file' },
            { type: 'reasoning-delta', text: '\n\n' },
            { type: 'reasoning-delta', text: 'Then reading it' },
            { type: 'tool', callId: 'ws_1', name: 'web_search', input: { query: '' }, status: 'running' },
            { type: 'tool', callId: 'ws_1', name: 'web_search', input: { query: 'release notes' }, status: 'done' },
            { type: 'text-delta', text: 'Let me' },
        ]);
        expect(codexOutcome(m, threadId, true, null)).toMatchObject({ kind: 'done', status: 'cancelled', sessionId: threadId });
    });

    test('Codex\'s own tools stream as `tool` events and never end the run (shapes captured from 0.160.0)', () => {
        const events: AgentEvent[] = [];
        const m = new CodexEventMapper('t', e => events.push(e));
        const item = (method: string, it: Record<string, unknown>) => m.feed(method, { threadId: 't', item: it });
        const shell = {
            type: 'commandExecution', id: 'exec-1', command: "/bin/zsh -lc 'echo hi'", cwd: '/w', source: 'unifiedExecStartup',
            status: 'inProgress', commandActions: [{ type: 'unknown', command: 'echo hi' }], aggregatedOutput: null, exitCode: null,
        };
        item('item/started', shell);
        item('item/completed', { ...shell, status: 'completed', aggregatedOutput: 'hi\n', exitCode: 0 });
        item('item/completed', { ...shell, id: 'exec-2', status: 'completed', commandActions: [], command: 'false', aggregatedOutput: '', exitCode: 1 });
        const patch = { type: 'fileChange', id: 'exec-3', changes: [{ path: '/w/a.txt', kind: { type: 'add' }, diff: 'hello\n' }], status: 'completed' };
        item('item/completed', patch);
        item('item/completed', { type: 'imageView', id: 'call_view_5', path: '/w/img.png' });
        item('item/completed', { type: 'mcpToolCall', id: 'call_m', server: 'github', tool: 'x', status: 'completed', arguments: { q: 1 }, result: { content: [{ type: 'text', text: 'ok' }] }, error: null });
        item('item/completed', { type: 'mcpToolCall', id: 'call_v', server: MCP_SERVER_NAME, tool: 'vault_read', status: 'completed', arguments: { path: 'a.md' }, result: { content: [] } });
        m.feed('turn/completed', { threadId: 't', turn: { status: 'completed' } });
        expect(events).toEqual([
            { type: 'tool', callId: 'exec-1', name: 'shell', input: { command: 'echo hi', cwd: '/w' }, status: 'running' },
            { type: 'tool', callId: 'exec-1', name: 'shell', input: { command: 'echo hi', cwd: '/w' }, status: 'done', output: 'hi\n' },
            { type: 'tool', callId: 'exec-2', name: 'shell', input: { command: 'false', cwd: '/w' }, status: 'error' },
            { type: 'tool', callId: 'exec-3', name: 'apply_patch', input: { paths: ['/w/a.txt'] }, status: 'done', output: '/w/a.txt\nhello\n' },
            { type: 'tool', callId: 'call_view_5', name: 'view_image', input: { path: '/w/img.png' }, status: 'done' },
            { type: 'tool', callId: 'call_m', name: 'github.x', input: { q: 1 }, status: 'done', output: 'ok' },
            // Ours (vault) reaches the panel as `tool.call`, never as a `tool` event.
        ]);
        expect(codexOutcome(m, 't', false, null)).toMatchObject({ kind: 'done', status: 'ok' });
    });

    test('tool items: failures, sub-agents, dynamic tools; non-tools are not tools', () => {
        expect(codexToolItem({ type: 'fileChange', id: 'f', changes: [], status: 'declined' })).toMatchObject({ name: 'apply_patch', status: 'error' });
        expect(codexToolItem({ type: 'mcpToolCall', server: 'gh', tool: 'x', status: 'failed', error: { message: 'boom' } })).toEqual({ name: 'gh.x', input: undefined, output: 'boom', status: 'error' });
        expect(codexToolItem({ type: 'collabAgentToolCall', id: 'c', tool: 'spawnAgent', prompt: 'look', status: 'completed' })).toEqual({ name: 'agent', input: { tool: 'spawnAgent', prompt: 'look' }, status: 'done' });
        expect(codexToolItem({ type: 'dynamicToolCall', id: 'd', tool: 'thing', arguments: { a: 1 }, status: 'completed', success: false })).toMatchObject({ name: 'thing', status: 'error' });
        expect(codexToolItem({ type: 'commandExecution', command: 'ls', commandActions: [], aggregatedOutput: 'x'.repeat(5000), exitCode: 0 })!.output!.length).toBeLessThan(4100);
        for (const type of ['agentMessage', 'reasoning', 'userMessage', 'plan', 'webSearch', 'somethingNew']) expect(codexToolItem({ type })).toBeNull();
    });

    test('failures', () => {
        const m = new CodexEventMapper('t', () => {});
        m.feed('turn/completed', { threadId: 't', turn: { status: 'failed', error: { message: 'unexpected status 401 Unauthorized' } } });
        expect(codexOutcome(m, 't', false, null)).toMatchObject({ kind: 'error', reason: 'logged-out' });
        expect(codexOutcome(new CodexEventMapper('t', () => {}), 't', false, 'app-server exited')).toEqual({ kind: 'error', reason: 'crashed', message: 'app-server exited' });
    });
});

describe('codex: history and models', () => {
    test('thread/turns/list → items', () => {
        expect(mapCodexTurns(JSON.parse(fixture('codex/turns-list.json')).result.data)).toEqual([
            { kind: 'user', text: 'hi there', imageCount: 0 },
            { kind: 'tool', name: 'vault_read', input: { path: 'Notes/a.md' }, output: 'FAKE-TOOL-RESULT: hello' },
            { kind: 'assistant', text: 'Hello from fake.' },
            { kind: 'user', text: 'second message', imageCount: 1 },
            { kind: 'assistant', text: 'Hello from fake.' },
        ]);
    });

    test('Codex\'s own tool items become `tool` history items, named as live', () => {
        const turns = [{ items: [
            { type: 'commandExecution', id: 'e', command: "/bin/zsh -lc 'echo hi'", commandActions: [{ type: 'unknown', command: 'echo hi' }], cwd: '/w', status: 'completed', aggregatedOutput: 'hi\n', exitCode: 0 },
            { type: 'commandExecution', id: 'e2', command: 'false', commandActions: [], cwd: '/w', status: 'failed', aggregatedOutput: '', exitCode: 1 },
            { type: 'mcpToolCall', id: 'm', server: 'github', tool: 'x', status: 'completed', arguments: {}, result: { content: [{ type: 'text', text: 'ok' }] } },
            { type: 'plan', id: 'p', text: 'later' },
        ] }];
        expect(mapCodexTurns(turns)).toEqual([
            { kind: 'tool', name: 'shell', input: { command: 'echo hi', cwd: '/w' }, output: 'hi\n' },
            { kind: 'tool', name: 'shell', input: { command: 'false', cwd: '/w' }, isError: true },
            { kind: 'tool', name: 'github.x', input: {}, output: 'ok' },
        ]);
    });

    test('model/list → models (hidden dropped, default kept)', () => {
        const raw = JSON.parse(fixture('codex/model-list.json')).result.data;
        const models = mapCodexModels(raw);
        expect(models.length).toBe(raw.filter((m: { hidden?: boolean }) => !m.hidden).length);
        expect(models.filter(m => m.isDefault).length).toBe(1);
        for (const m of models) if (m.defaultEffort) expect(m.efforts).toContain(m.defaultEffort);
        expect(mapCodexModels([{ id: '-x' }, { id: 'ok', hidden: true }, null])).toEqual([]);
    });
});

/* ═════════════════════════════ OpenCode ═════════════════════════════ */

describe('opencode: its own project per vault folder', () => {
    test('a hand-made git dir with a stable id, idempotent, nothing else written', () => {
        const dir = mkdtempSync(join(tmpdir(), 'va-ocproj-'));
        const vault = join(dir, '0f8b2c3d-1111-4222-8333-444455556666');
        mkdirSync(vault);
        try {
            ensureOpencodeProject(vault);
            const id = readFileSync(join(vault, '.git', 'opencode'), 'utf8');
            expect(id).toMatch(/^[0-9a-f]{40}$/);
            expect(readFileSync(join(vault, '.git', 'HEAD'), 'utf8')).toBe('ref: refs/heads/main\n');
            ensureOpencodeProject(vault);
            expect(readFileSync(join(vault, '.git', 'opencode'), 'utf8')).toBe(id);
            expect(readdirSync(vault)).toEqual(['.git']);
            // Another vault folder, another project.
            const other = join(dir, '0f8b2c3d-1111-4222-8333-444455556667');
            mkdirSync(other);
            ensureOpencodeProject(other);
            expect(readFileSync(join(other, '.git', 'opencode'), 'utf8')).not.toBe(id);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('opencode: config', () => {
    const cfg = buildOpencodeConfig({ cwd: CWD, mcpBaseUrl: MCP_BASE, userMcpServers: ['github', 'vault'] }) as Record<string, Foreign>;

    test('allow everything, never ask — except a question nobody could answer', () => {
        // OpenCode applies the LAST matching rule: the catch-all must be first.
        expect(Object.entries(OPENCODE_PERMISSION)).toEqual([['*', 'allow'], ['question', 'deny']]);
        expect(cfg.permission).toEqual(OPENCODE_PERMISSION);
        expect(cfg.agent[OPENCODE_AGENT].permission).toEqual(OPENCODE_PERMISSION);
    });

    test('only our MCP server is enabled; the token is an {env:} reference', () => {
        expect(cfg.mcp.github).toEqual({ enabled: false });
        expect(cfg.mcp.vault).toMatchObject({
            type: 'remote', enabled: true, oauth: false,
            url: `${MCP_BASE}{env:${MCP_TOKEN_ENV}}`,
            headers: { Authorization: `Bearer {env:${MCP_TOKEN_ENV}}` },
        });
        const idle = buildOpencodeConfig({ cwd: CWD, mcpBaseUrl: null, userMcpServers: [] }) as Record<string, Foreign>;
        expect(idle.mcp.vault.enabled).toBe(false);
    });

    test('nothing that writes outside the session: no share, snapshots, LSP, formatter, updates', () => {
        expect(cfg).toMatchObject({ share: 'disabled', autoupdate: false, snapshot: false, lsp: false, formatter: false });
        expect(cfg.instructions).toEqual([join(CWD, 'AGENTS.md'), join(CWD, 'CLAUDE.md')]);
    });

    test('zero interference: env-only config, plugins and project config off, token not in argv', () => {
        const token = newRunToken();
        const env = added(opencodeEnv(BIN, 'pw', cfg, token));
        expect(env.OPENCODE_PURE).toBe('1');
        expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1');
        expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT)).toEqual(cfg);
        expect(env.OPENCODE_CONFIG_CONTENT).not.toContain(token);
        expect(env[MCP_TOKEN_ENV]).toBe(token);
        for (const k of CONFIG_REDIRECT_ENV) expect(env[k]).toBeUndefined();
        expect(opencodeEnv(BIN, 'pw', cfg, null).OPENCODE_PERMISSION).toBeUndefined();
        const args = buildOpencodeServeArgs(51234);
        // An explicit port: OpenCode's `--port 0` binds its default 4096.
        expect(args).toEqual(['serve', '--hostname', '127.0.0.1', '--port', '51234', '--pure']);
        for (const a of [...args, env.OPENCODE_CONFIG_CONTENT]) {
            expect(a).not.toContain(token);
            expect(GLOBAL_CONFIG.test(a)).toBe(false);
        }
    });

    test('user MCP servers are read from the global config files (JSONC)', () => {
        const dir = join(import.meta.dir, '..', 'dist', '.probe', `oc-cfg-${process.pid}`);
        mkdirSync(dir, { recursive: true });
        try {
            writeFileSync(join(dir, 'opencode.jsonc'), '{\n // c\n "mcp": { "gh": {"type":"local"}, /* x */ "db": {"url": "http://a//b"}, },\n}');
            writeFileSync(join(dir, 'config.json'), 'not json');
            expect(userOpencodeMcpServers([join(dir, 'opencode.jsonc'), join(dir, 'config.json'), join(dir, 'missing.json')]).sort()).toEqual(['db', 'gh']);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
        const files = opencodeGlobalConfigFiles({ XDG_CONFIG_HOME: '/x' }, '/h');
        expect(files).toContain(join('/x', 'opencode', 'opencode.json'));
        expect(files).toContain(join('/h', '.opencode', 'opencode.jsonc'));
    });

    test('stripJsonc keeps strings intact', () => {
        expect(JSON.parse(stripJsonc('{"a":"http://x//y /* no */", // c\n"b":[1,2,],}'))).toEqual({ a: 'http://x//y /* no */', b: [1, 2] });
        expect(JSON.parse(stripJsonc('{"a":"q\\"//"}'))).toEqual({ a: 'q"//' });
    });
});

describe('opencode: event mapper (fixtures)', () => {
    const events = lines('opencode/events.jsonl').map(l => JSON.parse(l));
    const sessionId: string = events.find(e => e.type === 'session.created').properties.sessionID;

    test('run with a vault tool call', () => {
        expect(fixture('opencode/events.jsonl')).toContain('vault_vault_read');
        const out: AgentEvent[] = [];
        const m = new OpencodeEventMapper(sessionId, e => out.push(e));
        for (const e of events) m.feed(e);
        expect(out).toEqual([
            { type: 'text-delta', text: 'Hello ' },
            { type: 'text-delta', text: 'from ' },
            { type: 'text-delta', text: 'fake.' },
        ]);
        expect(m.idle).toBe(true);
        expect(opencodeOutcome(m, sessionId, false, null)).toEqual({ kind: 'done', status: 'ok', sessionId, usage: { inputTokens: 20, outputTokens: 10 } });
    });

    test('another session\'s events are ignored', () => {
        const out: AgentEvent[] = [];
        const m = new OpencodeEventMapper('ses_someoneElse123', e => out.push(e));
        for (const e of events) m.feed(e);
        expect(out).toEqual([]);
        expect(m.idle).toBe(false);
    });

    test('a tool\'s real input, which arrives with `running` after an empty `pending`, is emitted', () => {
        const out: AgentEvent[] = [];
        const m = new OpencodeEventMapper('ses_a', e => out.push(e));
        const part = (status: string, input: object, extra = {}) => ({ type: 'message.part.updated', properties: { part: { id: 'p1', sessionID: 'ses_a', type: 'tool', tool: 'bash', callID: 'c1', state: { status, input, ...extra } } } });
        m.feed(part('pending', {}));
        m.feed(part('running', { command: 'echo hi' }));
        m.feed(part('running', { command: 'echo hi' }));
        m.feed(part('completed', { command: 'echo hi' }, { output: 'hi\n' }));
        expect(out).toEqual([
            { type: 'tool', callId: 'c1', name: 'bash', input: {}, status: 'running' },
            { type: 'tool', callId: 'c1', name: 'bash', input: { command: 'echo hi' }, status: 'running' },
            { type: 'tool', callId: 'c1', name: 'bash', input: { command: 'echo hi' }, status: 'done', output: 'hi\n' },
        ]);
    });

    test('other tools stream running → done; reasoning; errors', () => {
        const out: AgentEvent[] = [];
        const m = new OpencodeEventMapper('ses_a', e => out.push(e));
        const part = (status: string, extra = {}) => ({ type: 'message.part.updated', properties: { part: { id: 'p1', sessionID: 'ses_a', type: 'tool', tool: 'websearch', callID: 'c1', state: { status, input: { query: 'q' }, ...extra } } } });
        m.feed(part('pending'));
        m.feed(part('running'));
        m.feed(part('completed', { output: 'results' }));
        m.feed({ type: 'message.part.updated', properties: { part: { id: 'r1', sessionID: 'ses_a', type: 'reasoning' } } });
        m.feed({ type: 'message.part.delta', properties: { sessionID: 'ses_a', partID: 'r1', messageID: 'm', field: 'text', delta: 'hmm' } });
        expect(out).toEqual([
            { type: 'tool', callId: 'c1', name: 'websearch', input: { query: 'q' }, status: 'running' },
            { type: 'tool', callId: 'c1', name: 'websearch', input: { query: 'q' }, status: 'done', output: 'results' },
            { type: 'reasoning-delta', text: 'hmm' },
        ]);
        m.feed({ type: 'session.error', properties: { sessionID: 'ses_a', error: { name: 'ProviderAuthError', data: { message: 'no key' } } } });
        expect(opencodeOutcome(m, 'ses_a', false, null)).toMatchObject({ kind: 'error', reason: 'logged-out' });
        const aborted = new OpencodeEventMapper('ses_a', () => {});
        aborted.feed({ type: 'session.error', properties: { sessionID: 'ses_a', error: { name: 'MessageAbortedError' } } });
        expect(opencodeOutcome(aborted, 'ses_a', false, null)).toMatchObject({ kind: 'done', status: 'cancelled' });
    });
});

describe('opencode: history and models', () => {
    test('/session/:id/message → items', () => {
        expect(mapOpencodeMessages(JSON.parse(fixture('opencode/messages.json')))).toEqual([
            { kind: 'user', text: 'hi there', imageCount: 1 },
            { kind: 'tool', name: 'vault_read', input: { path: 'Notes/a.md' }, output: 'FAKE-TOOL-RESULT: hello' },
            { kind: 'assistant', text: 'Hello from fake.' },
        ]);
    });

    test('/config/providers → provider/model ids', () => {
        const models = mapOpencodeModels(JSON.parse(fixture('opencode/config-providers.json')), 'fake/fake-model');
        expect(models.length).toBeGreaterThan(0);
        for (const m of models) expect(m.id).toMatch(/^[^/]+\/.+/);
        expect(models.find(m => m.id === 'fake/fake-model')).toMatchObject({ isDefault: true, images: true });
        expect(models.filter(m => m.isDefault).length).toBe(1);
    });
});

/* ═════════════════════════════ discovery ═════════════════════════════ */

describe('discovery', () => {
    test('npm .cmd shims run their script with node, never through cmd.exe', () => {
        const shim = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n';
        expect(resolveCmdShim(join('C:', 'npm', 'codex.cmd'), shim, 'C:/node/node.exe')).toEqual(['C:/node/node.exe', join('C:', 'npm', 'node_modules\\@openai\\codex\\bin\\codex.js')]);
        expect(resolveCmdShim('C:/npm/codex.cmd', shim, null)).toBeNull();
        expect(resolveCmdShim('C:/npm/codex.cmd', '@echo off\r\ncmd /c whatever', 'node')).toBeNull();
    });

    test('npm .cmd shims in front of a native exe (claude, opencode-ai) run the exe itself', () => {
        const shim = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n';
        expect(resolveCmdShim(join('C:', 'npm', 'claude.cmd'), shim, null)).toEqual([join('C:', 'npm', 'node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe')]);
    });

    test('version parsing', () => {
        expect(parseVersion('2.1.283 (Claude Code)')).toBe('2.1.283');
        expect(parseVersion('codex-cli 0.157.1')).toBe('0.157.1');
        expect(parseVersion('nope')).toBeNull();
    });
});
