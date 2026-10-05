// The panel's side of the WebSocket, for the tests that drive a real helper server.

import type { HelperMessage } from '../../../shared/vaultAgentProtocol.ts';

export const TEST_ORIGIN = 'https://notes.moizhashmi.com';

export class Panel {
    readonly messages: HelperMessage[] = [];
    private waiters: { pred: (m: HelperMessage) => boolean; resolve: (m: HelperMessage) => void }[] = [];
    ws!: WebSocket;
    private n = 0;

    constructor(private readonly port: number) {}

    async open(origin = TEST_ORIGIN): Promise<this> {
        this.ws = new WebSocket(`ws://127.0.0.1:${this.port}/ws`, { headers: { Origin: origin } } as unknown as string[]);
        this.ws.onmessage = e => {
            const m = JSON.parse(String(e.data)) as HelperMessage;
            this.messages.push(m);
            if (m.type === 'tool.call') {
                this.ws.send(JSON.stringify({ type: 'tool.result', runId: m.runId, callId: m.callId, result: { content: [{ type: 'text', text: `read ${m.args.path}` }] } }));
            }
            this.waiters = this.waiters.filter(w => (w.pred(m) ? (w.resolve(m), false) : true));
        };
        await new Promise<void>((res, rej) => {
            this.ws.onopen = () => res();
            this.ws.onerror = () => rej(new Error('ws error'));
        });
        return this;
    }

    next(pred: (m: HelperMessage) => boolean, timeoutMs = 5000): Promise<HelperMessage> {
        const seen = this.messages.find(pred);
        if (seen) return Promise.resolve(seen);
        return new Promise((resolve, reject) => {
            this.waiters.push({ pred, resolve });
            setTimeout(() => reject(new Error('timeout waiting for message')), timeoutMs);
        });
    }

    /** Fire-and-forget client message (`terminal.input`, `terminal.ack`). */
    send(msg: Record<string, unknown>): void {
        this.ws.send(JSON.stringify(msg));
    }

    async request(type: string, params: Record<string, unknown> = {}): Promise<Extract<HelperMessage, { type: 'response' }>> {
        const reqId = `r${++this.n}`;
        this.ws.send(JSON.stringify({ type, reqId, ...params }));
        return (await this.next(m => m.type === 'response' && m.reqId === reqId)) as Extract<HelperMessage, { type: 'response' }>;
    }
}
