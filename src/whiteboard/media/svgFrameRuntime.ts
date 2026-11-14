const CHUNK = 192 * 1024;
const LIMIT = 5 * 1024 * 1024;
type Processor = (blob: Blob, size: unknown) => Promise<unknown>;

export function runSvgFrame(process: Processor): void {
    const initialize = (event: MessageEvent) => {
        if (event.source !== parent || event.ports.length !== 1) return;
        const init = event.data as { v?: unknown; token?: unknown } | null;
        if (!init || init.v !== 1 || typeof init.token !== 'string' || !/^[0-9a-f]{32}$/.test(init.token)) return;
        removeEventListener('message', initialize);
        const token = init.token;
        const port = event.ports[0];
        let expected = 0, total = 0, done = false;
        const parts: ArrayBuffer[] = [];
        const send = (data: Record<string, unknown>) => port.postMessage({ v: 1, token, ...data });
        port.addEventListener('message', (message: MessageEvent<unknown>) => {
            if (done || !message.data || typeof message.data !== 'object') return;
            const data = message.data as { v?: unknown; token?: unknown; type?: unknown; seq?: unknown; bytes?: unknown; size?: unknown };
            if (data.v !== 1 || data.token !== token) return;
            if (data.type === 'chunk') {
                if (data.seq !== expected || !(data.bytes instanceof ArrayBuffer) || data.bytes.byteLength > CHUNK || data.bytes.byteLength > LIMIT - total) {
                    done = true; send({ type: 'error', message: 'Invalid SVG transfer' }); return;
                }
                parts.push(data.bytes); total += data.bytes.byteLength;
                send({ type: 'ack', seq: expected++ });
            } else if (data.type === 'finish' && data.seq === expected) {
                done = true;
                const blob = new Blob(parts, { type: 'image/svg+xml' });
                void process(blob, data.size).then(result => send({ type: 'result', result }), () => send({ type: 'error', message: 'SVG could not be read' }));
            }
        });
        port.start();
        send({ type: 'ready' });
    };
    addEventListener('message', initialize);
}
