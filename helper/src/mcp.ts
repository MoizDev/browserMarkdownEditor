import { CANVAS_PAGING_VERSION, compareVersions, type ToolName, type ToolResult } from '../../shared/vaultAgentProtocol.ts';
import { VAULT_TOOLS } from '../../shared/vaultAgentTools.ts';
import { HELPER_VERSION } from './buildInfo.ts';

export const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

const TOOL_NAMES = new Set<string>(VAULT_TOOLS.map(t => t.name));

export interface McpToolHandler {
    (name: ToolName, args: Record<string, unknown>): Promise<ToolResult>;
}

type JsonRpcId = string | number;
interface JsonRpcRequest { jsonrpc?: string; id?: JsonRpcId | null; method?: unknown; params?: unknown }

export type McpReply =
    | { status: 202 }
    | { status: 200; body: unknown }
    | { status: 400; body: unknown };

const err = (id: JsonRpcId | null, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
const ok = (id: JsonRpcId, result: unknown) => ({ jsonrpc: '2.0', id, result });

export function toolList() {
    return VAULT_TOOLS.map(t => ({
        name: t.name,
        description: t.name === 'canvas_shapes' && compareVersions(HELPER_VERSION, CANVAS_PAGING_VERSION) < 0
            ? 'List the shapes on a drawing (.drawing), a .notebook, or a PDF\'s annotation layer: id, type, position and size, text, colour and style. On notebooks and PDFs coordinates are page-relative: x/y in page units from that page\'s top-left corner, with `page` saying which page.'
            : t.description,
        inputSchema: t.name === 'canvas_shapes' && compareVersions(HELPER_VERSION, CANVAS_PAGING_VERSION) < 0
            ? { ...t.inputSchema, properties: { path: (t.inputSchema.properties as Record<string, unknown>).path,
                page: (t.inputSchema.properties as Record<string, unknown>).page } }
            : t.inputSchema,
        annotations: { readOnlyHint: !t.mutates },
        _meta: { 'anthropic/alwaysLoad': true },
    }));
}

function isValidId(id: unknown): id is JsonRpcId {
    return typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
}

export async function handleMcpMessage(raw: unknown, callTool: McpToolHandler): Promise<McpReply> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { status: 400, body: err(null, -32600, 'Invalid Request') };
    const msg = raw as JsonRpcRequest;
    if (typeof msg.method !== 'string') {
        return { status: 202 };
    }
    if (msg.id === undefined || msg.id === null) return { status: 202 };
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
