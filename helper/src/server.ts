// The helper's HTTP surface, bound to 127.0.0.1 only:
//   GET  /health        — who is on this port (CORS for the editor's exact origin)
//   GET  /ws            — the panel's WebSocket (Origin + Host checked on upgrade)
//   POST /mcp/<token>   — the MCP endpoint the agent CLI calls during a run
// Anything else is 404. See security.ts for why each check exists.

import type { Server, ServerWebSocket } from 'bun';
import {
    HELPER_APP_ID, HELPER_HOST, MAX_MCP_BODY_BYTES, MAX_WS_MESSAGE_BYTES, PROTOCOL_VERSION,
    type HealthResponse, type HelperPlatform,
} from '../../shared/vaultAgentProtocol.ts';
import { HELPER_VERSION } from './buildInfo.ts';
import { Connection, runForToken, type HelperContext } from './connection.ts';
import { logError } from './log.ts';
import { handleMcpMessage } from './mcp.ts';
import { bearerMatches, isAllowedHost, isAllowedOrigin, looksLikeToken, type OriginPolicy } from './security.ts';

export interface ServerOptions {
    ports: readonly number[];
    policy: OriginPolicy;
    context: Omit<HelperContext, 'mcpBaseUrl'>;
}

export interface RunningServer {
    port: number;
    stop(): void;
}

const MAX_CONNECTIONS = 16;

export function helperPlatform(): HelperPlatform {
    return process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux';
}

function health(): HealthResponse {
    return { app: HELPER_APP_ID, version: HELPER_VERSION, protocol: PROTOCOL_VERSION, platform: helperPlatform() };
}

function corsHeaders(origin: string): Record<string, string> {
    return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
}

const text = (status: number, body = '', headers: Record<string, string> = {}) =>
    new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers } });

interface WsData { conn: Connection }

export function createFetchHandler(policy: OriginPolicy, getPort: () => number, openSockets: () => number = () => 0) {
    return async function handle(req: Request, server: Server<WsData>): Promise<Response | undefined> {
        const origin = req.headers.get('origin');
        const port = getPort();

        // DNS rebinding: a hostile page resolving its own name to 127.0.0.1 still sends its name here.
        // Checked before parsing the URL, which Bun builds from Host: a malformed one threw (a 500).
        if (!isAllowedHost(req.headers.get('host'), port)) return text(403, 'forbidden host');
        const url = new URL(req.url);

        if (url.pathname === '/health') {
            if (req.method === 'OPTIONS') {
                if (!isAllowedOrigin(origin, policy)) return text(403, 'forbidden origin');
                // Chrome's Private Network Access preflight (still sent by versions that
                // predate Local Network Access) asks this of a loopback server explicitly.
                const headers: Record<string, string> = {
                    ...corsHeaders(origin!),
                    'Access-Control-Allow-Methods': 'GET',
                    'Access-Control-Max-Age': '600',
                };
                const reqHeaders = req.headers.get('access-control-request-headers');
                if (reqHeaders) headers['Access-Control-Allow-Headers'] = reqHeaders.split(',').map(s => s.trim()).filter(h => /^[A-Za-z0-9-]{1,64}$/.test(h)).join(', ');
                if (req.headers.get('access-control-request-private-network') === 'true') headers['Access-Control-Allow-Private-Network'] = 'true';
                return new Response(null, { status: 204, headers });
            }
            if (req.method !== 'GET') return text(405, '', { Allow: 'GET, OPTIONS' });
            // No Origin = not a browser page (curl, the installer's smoke test): answer without CORS.
            if (origin !== null && !isAllowedOrigin(origin, policy)) return text(403, 'forbidden origin');
            return Response.json(health(), { headers: { 'cache-control': 'no-store', ...(origin ? corsHeaders(origin) : {}) } });
        }

        if (url.pathname === '/ws') {
            // WebSockets skip CORS entirely; the Origin check on upgrade is the whole defence.
            if (!isAllowedOrigin(origin, policy)) return text(403, 'forbidden origin');
            if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') return text(426, 'websocket required', { Upgrade: 'websocket' });
            if (openSockets() >= MAX_CONNECTIONS) return text(503, 'too many connections');
            const ok = server.upgrade(req, { data: { conn: null as unknown as Connection } });
            return ok ? undefined : text(400, 'upgrade failed');
        }

        const mcp = /^\/mcp\/([^/]+)$/.exec(url.pathname);
        if (mcp) {
            // Browsers always send Origin on cross-origin requests; the CLIs never do.
            if (origin !== null) return text(403, 'forbidden origin');
            if (req.method !== 'POST') return text(405, '', { Allow: 'POST' });
            const token = mcp[1];
            if (!looksLikeToken(token) || !bearerMatches(req.headers.get('authorization'), token)) return text(401, 'unauthorized');
            const run = runForToken(token);
            if (!run) return text(404, 'no such run');
            const declared = Number(req.headers.get('content-length') ?? '0');
            if (declared > MAX_MCP_BODY_BYTES) return text(413, 'too large');
            const body = await req.arrayBuffer();
            if (body.byteLength > MAX_MCP_BODY_BYTES) return text(413, 'too large');
            let parsed: unknown;
            try {
                parsed = JSON.parse(new TextDecoder().decode(body));
            } catch {
                return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, { status: 400 });
            }
            const reply = await handleMcpMessage(parsed, (name, args) => Connection.callTool(run, name, args));
            if (reply.status === 202) return new Response(null, { status: 202 });
            return Response.json(reply.body, { status: reply.status });
        }

        return text(404, 'not found');
    };
}

/** Binds the first free port of `ports`. Throws when none is free. */
export function startServer(opts: ServerOptions): RunningServer {
    let port = 0;
    let sockets = 0;
    const fetch = createFetchHandler(opts.policy, () => port, () => sockets);
    let lastError: unknown = null;
    for (const candidate of opts.ports) {
        try {
            const context: HelperContext = { ...opts.context, mcpBaseUrl: () => `http://${HELPER_HOST}:${port}/mcp/` };
            const server: Server<WsData> = Bun.serve<WsData>({
                hostname: HELPER_HOST,
                port: candidate,
                // Bun's own cap on the request body; the MCP route re-checks exactly.
                maxRequestBodySize: MAX_WS_MESSAGE_BYTES,
                fetch,
                error(e) {
                    logError('http handler failed', e);
                    return text(500, 'internal error');
                },
                websocket: {
                    maxPayloadLength: MAX_WS_MESSAGE_BYTES,
                    // Terminal output is the first thing here that can outrun a socket. The
                    // real control is application-level: the panel's `terminal.ack`s pause
                    // streaming above TERMINAL_ACK_HIGH (512k chars, at worst ~3 MB as
                    // JSON-escaped control codes), so this is only an explicit ceiling well
                    // above that — stated rather than inherited from Bun's default. The
                    // socket is not closed at it: it also carries an agent run, which a
                    // terminal flood must not take down. Past it Bun DROPS frames (measured:
                    // `send` answers 0) — the terminal manager notices and resyncs that
                    // shell with a snapshot (TerminalManager.dropped).
                    backpressureLimit: 8 * 1024 * 1024,
                    closeOnBackpressureLimit: false,
                    idleTimeout: 120,
                    sendPings: true,
                    open(ws: ServerWebSocket<WsData>) {
                        sockets++;
                        ws.data.conn = new Connection(context, t => ws.send(t));
                    },
                    message(ws: ServerWebSocket<WsData>, message) {
                        const t = typeof message === 'string' ? message : new TextDecoder().decode(message);
                        void ws.data.conn.onMessage(t);
                    },
                    close(ws: ServerWebSocket<WsData>) {
                        sockets = Math.max(0, sockets - 1);
                        ws.data.conn?.onClose();
                    },
                },
            });
            port = server.port ?? candidate;
            return { port, stop: () => void server.stop(true) };
        } catch (e) {
            lastError = e;
        }
    }
    throw Object.assign(new Error(`none of the ports ${opts.ports.join(', ')} is free`), { cause: lastError });
}

/** Is a VaultAgent already answering on one of the ports? (Avoids two helpers after a reinstall race.) */
export async function findRunningHelper(ports: readonly number[]): Promise<{ port: number; version: string } | null> {
    for (const port of ports) {
        try {
            const r = await fetch(`http://${HELPER_HOST}:${port}/health`, { signal: AbortSignal.timeout(800) });
            if (!r.ok) continue;
            const h = (await r.json()) as Partial<HealthResponse>;
            if (h.app === HELPER_APP_ID && typeof h.version === 'string') return { port, version: h.version };
        } catch { /* nothing there */ }
    }
    return null;
}
