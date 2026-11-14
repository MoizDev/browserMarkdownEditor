import { createContainedFrame } from '../../platform/containedFrame';
import { svgImageFrame, svgXmlFrame } from 'virtual:whiteboard-svg-frames';
import type { SvgContainedFrame, SvgFrameFactory } from './svgProfile';

const CHUNK = 192 * 1024;
const LIMIT = 5 * 1024 * 1024;

type Reply = { readonly type: string; readonly seq?: unknown; readonly result?: unknown; readonly message?: unknown };

export const svgFrameFactory: SvgFrameFactory = {
    async open(profile, signal): Promise<SvgContainedFrame> {
        signal.throwIfAborted();
        const token = Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');
        let closed = false, expected = 'ready', waiting: ((reply: Reply) => void) | undefined;
        let rejectWait: ((error: unknown) => void) | undefined;
        let count = 0, windowStart = performance.now(), used = false, fatal: unknown;
        const fail = (error: unknown) => { fatal = error; rejectWait?.(error); waiting = undefined; rejectWait = undefined; };
        const aborted = () => fail(signal.reason ?? new DOMException('SVG job cancelled', 'AbortError'));
        const frame = createContainedFrame({
            html: profile === 'svg-xml' ? svgXmlFrame : svgImageFrame,
            init: { v: 1, token }, signal, hidden: true,
            onFailure: reason => fail(new Error(`SVG frame failed: ${reason}`)),
            onMessage(event) {
                const now = performance.now();
                if (now - windowStart >= 1000) { windowStart = now; count = 0; }
                if (++count > 120 || !event.data || typeof event.data !== 'object') { fail(new Error('Invalid SVG frame response')); return; }
                const reply = event.data as { v?: unknown; token?: unknown; type?: unknown; seq?: unknown; result?: unknown; message?: unknown };
                if (reply.v !== 1 || reply.token !== token || typeof reply.type !== 'string' || !waiting) { fail(new Error('Invalid SVG frame response')); return; }
                if (reply.type === 'error') { fail(new Error('SVG could not be read')); return; }
                if (reply.type !== expected) { fail(new Error('Unexpected SVG frame response')); return; }
                const resolve = waiting;
                waiting = undefined; rejectWait = undefined;
                resolve({ type: reply.type, seq: reply.seq, result: reply.result, message: reply.message });
            },
        });
        const wait = (type: string): Promise<Reply> => {
            if (closed) return Promise.reject(new Error('SVG frame is closed'));
            if (fatal) return Promise.reject(fatal);
            expected = type;
            return new Promise((resolve, reject) => { waiting = resolve; rejectWait = reject; });
        };
        const dispose = () => {
            if (closed) return;
            closed = true;
            signal.removeEventListener('abort', aborted);
            fail(new DOMException('SVG frame closed', 'AbortError'));
            frame.dispose();
        };
        signal.addEventListener('abort', aborted, { once: true });
        const ready = wait('ready');
        try {
            signal.throwIfAborted();
            frame.frame.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden;pointer-events:none';
            frame.mount(document.body);
            await ready;
            signal.throwIfAborted();
        } catch (error) { dispose(); throw error; }
        return {
            async request(operation, blob, requestSignal, size) {
                if (used || (profile === 'svg-xml' ? operation !== 'header' : operation !== 'probe')) throw new Error('Invalid SVG frame operation');
                if (blob.size > LIMIT) throw new RangeError('SVG files must be at most 5 MiB');
                used = true;
                const cancel = () => fail(requestSignal.reason ?? new DOMException('SVG job cancelled', 'AbortError'));
                requestSignal.addEventListener('abort', cancel, { once: true });
                try {
                    let sequence = 0;
                    for (let offset = 0; offset < blob.size; offset += CHUNK) {
                        requestSignal.throwIfAborted();
                        const bytes = await blob.slice(offset, offset + CHUNK).arrayBuffer();
                        requestSignal.throwIfAborted();
                        const ack = wait('ack');
                        frame.port.postMessage({ v: 1, token, type: 'chunk', seq: sequence, bytes }, [bytes]);
                        if ((await ack).seq !== sequence++) throw new Error('Invalid SVG chunk acknowledgement');
                    }
                    const reply = wait('result');
                    frame.port.postMessage({ v: 1, token, type: 'finish', seq: sequence, size });
                    return (await reply).result;
                } finally { requestSignal.removeEventListener('abort', cancel); }
            },
            dispose,
        };
    },
};
