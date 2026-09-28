// One panel connection (one WebSocket) and the run it may have in flight.
//
// Invariants (the protocol's promises to the panel):
//   • every request gets exactly one `response` with its reqId;
//   • a run streams `run.event`s only after its `run.start` response, and ends
//     with exactly one `run.done` or `run.error`;
//   • one run per connection at a time (`busy` otherwise);
//   • a run's MCP token lives exactly as long as the run; closing the socket
//     cancels the run.

import { randomUUID } from 'node:crypto';
import {
    AGENT_IDS, MAX_IMAGE_BYTES, MAX_IMAGES_PER_MESSAGE, MAX_TOOL_RESULT_BYTES, MAX_TOOL_TEXT_CHARS, PROTOCOL_VERSION,
    TOOL_CALL_TIMEOUT_MS,
    type AgentEvent, type AgentId, type ClientMessage, type ErrorCode, type HelperMessage, type HelperPlatform,
    type RequestName, type RunImage, type ToolName, type ToolResult,
} from '../../shared/vaultAgentProtocol.ts';
import { RunRefused, SAFE_EFFORT_RE, type AgentAdapter, type RunHandle, type RunOutcome } from './agents/types.ts';
import { HELPER_VERSION } from './buildInfo.ts';
import { logError } from './log.ts';
import { syncMirror } from './mirror.ts';
import { BadRequest, ensureDir, vaultDir } from './paths.ts';
import { newRunToken } from './security.ts';

export interface HelperContext {
    sessionsRoot: string;
    platform: HelperPlatform;
    adapters: Record<AgentId, AgentAdapter>;
    /** `http://127.0.0.1:<port>/mcp/` — the run token is appended. */
    mcpBaseUrl(): string;
    /** Undefined when running from source / --no-register: nothing to uninstall. */
    uninstall?: () => void;
}

interface ActiveRun {
    runId: string;
    token: string;
    handle: RunHandle | null;
    accepted: boolean;
    queued: AgentEvent[];
    finished: boolean;
    pendingTools: Map<string, { resolve(r: ToolResult): void; timer: ReturnType<typeof setTimeout> }>;
    conn: Connection;
}

/** token → run, across all connections. The MCP endpoint's only way in. */
const runsByToken = new Map<string, ActiveRun>();

export function runForToken(token: string): ActiveRun | undefined {
    return runsByToken.get(token);
}

const RUN_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const REQ_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function errorResult(text: string): ToolResult {
    return { content: [{ type: 'text', text }], isError: true };
}

/** Validates and bounds what the panel returns for a tool call. */
export function sanitizeToolResult(raw: unknown): ToolResult {
    if (!raw || typeof raw !== 'object' || !Array.isArray((raw as ToolResult).content)) return errorResult('The editor returned a malformed tool result.');
    const r = raw as ToolResult;
    let size = 0;
    const content: ToolResult['content'] = [];
    for (const c of r.content) {
        if (c?.type === 'text' && typeof c.text === 'string') {
            // Over this, Claude Code spills the result to a file its (absent) Read tool would need.
            const text = c.text.length > MAX_TOOL_TEXT_CHARS
                ? `${c.text.slice(0, MAX_TOOL_TEXT_CHARS)}\n…[truncated ${c.text.length - MAX_TOOL_TEXT_CHARS} chars; ask for a smaller range]`
                : c.text;
            size += text.length;
            content.push({ type: 'text', text });
        } else if (c?.type === 'image' && typeof c.data === 'string' && typeof c.mimeType === 'string' && IMAGE_TYPES.has(c.mimeType) && B64_RE.test(c.data)) {
            size += c.data.length;
            content.push({ type: 'image', data: c.data, mimeType: c.mimeType });
        } else {
            return errorResult('The editor returned a malformed tool result.');
        }
    }
    if (size > MAX_TOOL_RESULT_BYTES) return errorResult('The tool result was too large. Ask for less (a smaller range, fewer results, one page).');
    return { content, isError: r.isError === true };
}

export function validateImages(images: unknown): RunImage[] {
    if (images === undefined) return [];
    if (!Array.isArray(images) || images.length > MAX_IMAGES_PER_MESSAGE) throw new BadRequest(`at most ${MAX_IMAGES_PER_MESSAGE} images`);
    return images.map(img => {
        if (!img || typeof img.data !== 'string' || !IMAGE_TYPES.has(img.mimeType)) throw new BadRequest('images must be PNG, JPEG, WebP or GIF, base64');
        if (!B64_RE.test(img.data)) throw new BadRequest('image data must be plain base64');
        if (Math.floor(img.data.length * 3 / 4) > MAX_IMAGE_BYTES) throw new BadRequest('image too large');
        return { mimeType: img.mimeType, data: img.data };
    });
}

function isAgent(a: unknown): a is AgentId {
    return typeof a === 'string' && (AGENT_IDS as readonly string[]).includes(a);
}

export class Connection {
    private active: ActiveRun | null = null;
    private closed = false;

    constructor(private readonly ctx: HelperContext, private readonly sendRaw: (text: string) => void) {}

    private send(msg: HelperMessage): void {
        if (this.closed) return;
        try {
            this.sendRaw(JSON.stringify(msg));
        } catch (e) {
            logError('ws send failed', e);
        }
    }

    private reply(reqId: string, result: unknown): void {
        this.send({ type: 'response', reqId, ok: true, result });
    }

    private fail(reqId: string, code: ErrorCode, message: string): void {
        this.send({ type: 'response', reqId, ok: false, error: { code, message } });
    }

    async onMessage(text: string): Promise<void> {
        let msg: ClientMessage;
        try {
            msg = JSON.parse(text);
        } catch {
            return;
        }
        if (!msg || typeof msg !== 'object' || typeof (msg as { type?: unknown }).type !== 'string') return;
        if (msg.type === 'tool.result') {
            this.onToolResult(msg.runId, msg.callId, msg.result);
            return;
        }
        const reqId = (msg as { reqId?: unknown }).reqId;
        if (typeof reqId !== 'string' || !REQ_ID_RE.test(reqId)) return;
        try {
            await this.dispatch(msg.type as RequestName, msg as unknown as Record<string, unknown>, reqId);
        } catch (e) {
            if (e instanceof BadRequest) this.fail(reqId, 'bad-request', e.message);
            else if (e instanceof RunRefused) this.fail(reqId, e.reason, e.message);
            else {
                logError(`request ${msg.type} failed`, e);
                this.fail(reqId, 'internal', e instanceof Error ? e.message : 'internal error');
            }
        }
    }

    private adapter(agent: unknown): AgentAdapter {
        if (!isAgent(agent)) throw new BadRequest('unknown agent');
        return this.ctx.adapters[agent];
    }

    private async dispatch(type: RequestName, p: Record<string, unknown>, reqId: string): Promise<void> {
        switch (type) {
            case 'hello':
                this.reply(reqId, { version: HELPER_VERSION, protocol: PROTOCOL_VERSION, platform: this.ctx.platform, sessionsDir: this.ctx.sessionsRoot });
                return;
            case 'agents.status': {
                const refresh = p.refresh === true;
                const list = await Promise.all(AGENT_IDS.map(a => this.ctx.adapters[a].status(refresh).catch(e => {
                    logError(`${a} status failed`, e);
                    return null;
                })));
                this.reply(reqId, list.filter(Boolean));
                return;
            }
            case 'models.list':
                this.reply(reqId, await this.adapter(p.agent).models(false));
                return;
            case 'vault.sync':
                this.reply(reqId, syncMirror(this.ctx.sessionsRoot, p.vaultId, p.files));
                return;
            case 'run.start':
                await this.startRun(p, reqId);
                return;
            case 'run.cancel': {
                const run = this.active;
                if (run && run.runId === p.runId && !run.finished) {
                    run.handle?.cancel();
                    this.reply(reqId, { cancelled: true });
                } else this.reply(reqId, { cancelled: false });
                return;
            }
            case 'session.history': {
                const adapter = this.adapter(p.agent);
                if (!adapter.isValidSessionId(p.sessionId)) throw new BadRequest('invalid sessionId');
                this.reply(reqId, await adapter.history(vaultDir(this.ctx.sessionsRoot, p.vaultId), p.sessionId));
                return;
            }
            case 'session.delete': {
                const adapter = this.adapter(p.agent);
                if (!adapter.isValidSessionId(p.sessionId)) throw new BadRequest('invalid sessionId');
                this.reply(reqId, { deleted: await adapter.deleteSession(vaultDir(this.ctx.sessionsRoot, p.vaultId), p.sessionId) });
                return;
            }
            case 'helper.uninstall': {
                const uninstall = this.ctx.uninstall;
                if (!uninstall) {
                    this.fail(reqId, 'unsupported', 'This VaultAgent is not installed (it is running from source).');
                    return;
                }
                this.reply(reqId, { ok: true });
                // Respond first; the socket has to carry the answer before we go.
                setTimeout(uninstall, 300);
                return;
            }
            default:
                this.fail(reqId, 'unsupported', `unknown request ${String(type)}`);
        }
    }

    private async startRun(p: Record<string, unknown>, reqId: string): Promise<void> {
        const runId = p.runId;
        if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) throw new BadRequest('invalid runId');
        const adapter = this.adapter(p.agent);
        const cwdPath = vaultDir(this.ctx.sessionsRoot, p.vaultId);
        const sessionId = p.sessionId ?? null;
        if (sessionId !== null && !adapter.isValidSessionId(sessionId)) throw new BadRequest('invalid sessionId');
        const model = p.model ?? null;
        if (model !== null && !adapter.isValidModel(model)) throw new BadRequest('invalid model');
        const effort = p.effort ?? null;
        if (effort !== null && (typeof effort !== 'string' || !SAFE_EFFORT_RE.test(effort))) throw new BadRequest('invalid effort');
        if (typeof p.text !== 'string') throw new BadRequest('text must be a string');
        const images = validateImages(p.images);
        if (this.active) throw new RunRefused('busy', 'A reply is already being written in this chat window.');

        const run: ActiveRun = {
            runId, token: newRunToken(), handle: null, accepted: false, queued: [], finished: false, pendingTools: new Map(), conn: this,
        };
        this.active = run; // reserved before any await: a second start is `busy`
        runsByToken.set(run.token, run);
        try {
            const cwd = ensureDir(cwdPath);
            run.handle = await adapter.start({
                runId, cwd, sessionId: sessionId as string | null, model: model as string | null, effort: effort as string | null,
                text: p.text, images,
                mcpBaseUrl: this.ctx.mcpBaseUrl(),
                mcpToken: run.token,
                emit: ev => {
                    if (run.finished) return;
                    if (!run.accepted) run.queued.push(ev);
                    else this.send({ type: 'run.event', runId, event: ev });
                },
            });
        } catch (e) {
            this.release(run);
            throw e;
        }
        if (this.closed) run.handle.cancel();
        this.reply(reqId, { accepted: true });
        run.accepted = true;
        for (const ev of run.queued) this.send({ type: 'run.event', runId, event: ev });
        run.queued = [];
        void run.handle.outcome.then(o => this.finish(run, o), e => this.finish(run, { kind: 'error', reason: 'crashed', message: e instanceof Error ? e.message : 'run failed' }));
    }

    private release(run: ActiveRun): void {
        run.finished = true;
        runsByToken.delete(run.token);
        for (const [, t] of run.pendingTools) {
            clearTimeout(t.timer);
            t.resolve(errorResult('The run ended before the editor answered.'));
        }
        run.pendingTools.clear();
        if (this.active === run) this.active = null;
    }

    private finish(run: ActiveRun, outcome: RunOutcome): void {
        if (run.finished) return;
        this.release(run);
        if (outcome.kind === 'done') this.send({ type: 'run.done', runId: run.runId, sessionId: outcome.sessionId, status: outcome.status, ...(outcome.usage ? { usage: outcome.usage } : {}) });
        else this.send({ type: 'run.error', runId: run.runId, reason: outcome.reason, message: outcome.message });
    }

    /** Called by the MCP endpoint: forward to the panel, wait for its `tool.result`. */
    static callTool(run: ActiveRun, name: ToolName, args: Record<string, unknown>): Promise<ToolResult> {
        if (run.finished) return Promise.resolve(errorResult('The run has ended.'));
        const callId = randomUUID();
        return new Promise<ToolResult>(resolve => {
            const timer = setTimeout(() => {
                run.pendingTools.delete(callId);
                resolve(errorResult('The editor did not answer in time. The document may still be opening; try again.'));
            }, TOOL_CALL_TIMEOUT_MS);
            run.pendingTools.set(callId, { resolve, timer });
            run.conn.send({ type: 'tool.call', runId: run.runId, callId, name, args });
        });
    }

    private onToolResult(runId: unknown, callId: unknown, result: unknown): void {
        const run = this.active;
        if (!run || run.runId !== runId || typeof callId !== 'string') return;
        const pending = run.pendingTools.get(callId);
        if (!pending) return;
        run.pendingTools.delete(callId);
        clearTimeout(pending.timer);
        pending.resolve(sanitizeToolResult(result));
    }

    onClose(): void {
        this.closed = true;
        const run = this.active;
        if (!run) return;
        // The panel is gone: nobody can see the reply or answer tool calls.
        run.handle?.cancel();
        for (const [, t] of run.pendingTools) {
            clearTimeout(t.timer);
            t.resolve(errorResult('The editor disconnected.'));
        }
        run.pendingTools.clear();
    }
}
