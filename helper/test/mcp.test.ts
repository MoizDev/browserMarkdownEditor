import { describe, expect, test } from 'bun:test';
import { VAULT_TOOLS } from '../../shared/vaultAgentTools.ts';
import { handleMcpMessage, toolList } from '../src/mcp.ts';
import type { Foreign } from '../src/agents/types.ts';

const never = async () => {
    throw new Error('tool should not be called');
};

describe('MCP framing', () => {
    test('initialize echoes a known protocol version (claude 2025-11-25, codex 2025-06-18)', async () => {
        for (const v of ['2025-11-25', '2025-06-18', '2025-03-26']) {
            const r = await handleMcpMessage({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: v, capabilities: {}, clientInfo: { name: 'x', version: '1' } } }, never);
            expect(r.status).toBe(200);
            expect((r as { body: Foreign }).body.result.protocolVersion).toBe(v);
            expect((r as { body: Foreign }).body.result.capabilities.tools).toBeDefined();
        }
        const r = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2099-01-01' } }, never);
        expect((r as { body: Foreign }).body.result.protocolVersion).toBe('2025-11-25');
    });

    test('Claude Code\'s `server/discover` probe gets -32601, so it falls back to initialize', async () => {
        const r = await handleMcpMessage({ jsonrpc: '2.0', id: 'server-discover-probe-1', method: 'server/discover', params: {} }, never);
        expect((r as { body: Foreign }).body).toEqual({ jsonrpc: '2.0', id: 'server-discover-probe-1', error: { code: -32601, message: 'Method not found: server/discover' } });
    });

    test('notifications get 202 and no body', async () => {
        expect(await handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, never)).toEqual({ status: 202 });
        expect(await handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 3 } }, never)).toEqual({ status: 202 });
    });

    test('batches and garbage are invalid requests', async () => {
        expect((await handleMcpMessage([{ jsonrpc: '2.0', id: 1, method: 'ping' }], never)).status).toBe(400);
        expect((await handleMcpMessage('x', never)).status).toBe(400);
        expect((await handleMcpMessage({ jsonrpc: '2.0', id: { x: 1 }, method: 'ping' }, never)).status).toBe(400);
    });

    test('tools/list serves the shared definitions, never-deferred', async () => {
        const r = await handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, never);
        const tools = (r as { body: Foreign }).body.result.tools;
        expect(tools.map((t: { name: string }) => t.name)).toEqual(VAULT_TOOLS.map(t => t.name));
        for (const t of tools) {
            expect(t.inputSchema.type).toBe('object');
            expect(t._meta['anthropic/alwaysLoad']).toBe(true);
        }
        expect(toolList().find(t => t.name === 'vault_read')!.annotations.readOnlyHint).toBe(true);
        expect(toolList().find(t => t.name === 'vault_edit')!.annotations.readOnlyHint).toBe(false);
    });

    test('tools/call forwards known tools only', async () => {
        const calls: unknown[] = [];
        const handler = async (name: string, args: Record<string, unknown>) => {
            calls.push([name, args]);
            return { content: [{ type: 'text' as const, text: 'ok' }] };
        };
        const r = await handleMcpMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'vault_read', arguments: { path: 'a.md' } } }, handler);
        expect((r as { body: Foreign }).body.result).toEqual({ content: [{ type: 'text', text: 'ok' }], isError: false });
        expect(calls).toEqual([['vault_read', { path: 'a.md' }]]);

        for (const name of ['Bash', 'read_file', 'mcp__vault__vault_read', '__proto__', 'constructor']) {
            const bad = await handleMcpMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name, arguments: {} } }, handler);
            expect((bad as { body: Foreign }).body.error.code).toBe(-32602);
        }
        const badArgs = await handleMcpMessage({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'vault_read', arguments: ['x'] } }, handler);
        expect((badArgs as { body: Foreign }).body.error.code).toBe(-32602);
        expect(calls.length).toBe(1);
    });

    test('ping, empty resource lists, unknown methods', async () => {
        expect((await handleMcpMessage({ jsonrpc: '2.0', id: 6, method: 'ping' }, never) as { body: Foreign }).body.result).toEqual({});
        expect((await handleMcpMessage({ jsonrpc: '2.0', id: 7, method: 'resources/list' }, never) as { body: Foreign }).body.result).toEqual({ resources: [] });
        expect((await handleMcpMessage({ jsonrpc: '2.0', id: 8, method: 'sampling/createMessage' }, never) as { body: Foreign }).body.error.code).toBe(-32601);
    });
});
