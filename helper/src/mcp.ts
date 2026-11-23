// A minimal MCP server over streamable HTTP, JSON responses only (no SSE
// stream, no session header). That is all the three CLIs need; verified against
// claude 2.1.283 (protocol 2025-11-25, after a `server/discover` probe for the
// 2026-07-28 draft that it abandons on -32601), codex 0.157.1 (2025-06-18) and
// opencode 1.18.29 — none requires `Mcp-Session-Id`, and all accept a 405 on
// the GET that opens the optional server→client stream.
//
// Transport concerns (Origin, Host, bearer token, body size) live in server.ts;
// this module is the JSON-RPC layer only, so it can be tested without a socket.

import type { ToolName, ToolResult } from '../../shared/vaultAgentProtocol.ts';
import { VAULT_TOOLS } from '../../shared/vaultAgentTools.ts';

/** Newest first. We answer with the client's version when we know it. */
export const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

const TOOL_NAMES = new Set<string>(VAULT_TOOLS.map(t => t.name));

export interface McpToolHandler {
    (name: ToolName, args: Record<string, unknown>): Promise<ToolResult>;
}

type JsonRpcId = string | number;
interface JsonRpcRequest { jsonrpc?: string; id?: JsonRpcId | null; method?: unknown; params?: unknown }

export type McpReply =
    | { status: 202 }                       // a notification: nothing to say
    | { status: 200; body: unknown }
    | { status: 400; body: unknown };

const err = (id: JsonRpcId | null, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
const ok = (id: JsonRpcId, result: unknown) => ({ jsonrpc: '2.0', id, result });

/** `tools/list` payload. `anthropic/alwaysLoad` keeps Claude Code from deferring
 *  our tools behind its ToolSearch tool, so the model always sees them. */
export function toolList() {
    return VAULT_TOOLS.map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        annotations: { readOnlyHint: !t.mutates },
        _meta: { 'anthropic/alwaysLoad': true },
    }));
}

function isValidId(id: unknown): id is JsonRpcId {
    return typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
}

export async function handleMcpMessage(raw: unknown, callTool: McpToolHandler): Promise<McpReply> {
    // Batching was removed from MCP in 2025-06-18 and no supported CLI sends it.
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { status: 400, body: err(null, -32600, 'Invalid Request') };
    const msg = raw as JsonRpcRequest;
    if (typeof msg.method !== 'string') {
        // A response to a request we never send (we make no server→client requests).
        return { status: 202 };
    }
    if (msg.id === undefined || msg.id === null) return { status: 202 }; // notifications/initialized, cancelled, …
    if (!isValidId(msg.id)) return { status: 400, body: err(null, -32600, 'Invalid Request') };
    const id = msg.id;
    const params = (msg.params && typeof msg.params === 'object' ? msg.params : {}) as Record<string, unknown>;

    switch (msg.method) {
        case 'initialize': {
            const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
            const version = (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0];
            return {
                status: 200,
                body: ok(id, {
                    protocolVersion: version,
                    capabilities: { tools: { listChanged: false } },
                    serverInfo: { name: 'vault', title: 'VaultAgent vault', version: '1' },
                    instructions: 'Use these tools for everything in the user\'s vault — reading, searching and every change. Never change vault files any other way. Paths are vault-relative.',
                }),
            };
        }
        case 'ping':
            return { status: 200, body: ok(id, {}) };
        case 'tools/list':
            return { status: 200, body: ok(id, { tools: toolList() }) };
        case 'resources/list':
            return { status: 200, body: ok(id, { resources: [] }) };
        case 'resources/templates/list':
            return { status: 200, body: ok(id, { resourceTemplates: [] }) };
        case 'prompts/list':
            return { status: 200, body: ok(id, { prompts: [] }) };
        case 'tools/call': {
            const name = params.name;
            const args = params.arguments ?? {};
            if (typeof name !== 'string' || !TOOL_NAMES.has(name)) return { status: 200, body: err(id, -32602, `Unknown tool: ${String(name)}`) };
            if (!args || typeof args !== 'object' || Array.isArray(args)) return { status: 200, body: err(id, -32602, 'arguments must be an object') };
            const result = await callTool(name as ToolName, args as Record<string, unknown>);
            return { status: 200, body: ok(id, { content: result.content, isError: result.isError === true }) };
        }
        default:
            return { status: 200, body: err(id, -32601, `Method not found: ${msg.method}`) };
    }
}
