import { createContainedFrame } from '../../platform/containedFrame';
import { cpuGovernor } from '../../platform/workers';
import { videoFrame } from 'virtual:whiteboard-svg-frames';
import { closeWorkerResult, matchingIdentity, validBoardIdentity } from '../workers/protocol';
import type { BoardJobIdentity } from '../workers/protocol';
import type { InspectedMedia } from './ingest';

const CHUNK = 192 * 1024, LIMIT = 10 * 1024 * 1024;
let serial = 0;
export async function videoFrameInProfile(blob: Blob, info: Pick<InspectedMedia, 'mime' | 'width' | 'height'>,
    identity: BoardJobIdentity, isCurrent: (identity: BoardJobIdentity) => boolean, signal: AbortSignal,
    operation: 'probe' | 'frame'): Promise<number | ImageBitmap> {
    signal.throwIfAborted();
    if (!(blob instanceof Blob) || (typeof File !== 'undefined' && blob instanceof File) || blob.size < 1 || blob.size > LIMIT
        || !validBoardIdentity(identity) || !isCurrent(identity) || !Number.isSafeInteger(info.width) || !Number.isSafeInteger(info.height)
        || info.width < 1 || info.height < 1 || info.width > (2 ** 26) / info.height
        || (info.mime !== 'video/mp4' && info.mime !== 'video/webm' && info.mime !== 'video/quicktime')) throw new TypeError('Invalid contained video request');
    const pinned = Object.freeze({ ...identity }), token = Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
    const permit = cpuGovernor.acquire({ name: 'whiteboard-video-frame', id: ++serial, priority: 0, start() {}, pause() {}, resume() {} });
    if (!permit.held) { permit.release(); throw new Error('Video CPU permit unavailable'); }
    let closed = false, expected = 'ready', fatal: unknown, waiting: ((value: { seq?: unknown; result?: unknown }) => void) | undefined;
    let rejectWait: ((error: unknown) => void) | undefined, messages = 0, started = performance.now();
    const fail = (error: unknown) => { fatal = error; rejectWait?.(error); waiting = undefined; rejectWait = undefined; };
    const abort = () => fail(deadline.reason ?? new DOMException('Video frame cancelled', 'AbortError'));
    let frame: ReturnType<typeof createContainedFrame> | undefined, result: unknown;
    const check = () => { deadline.throwIfAborted(); if (!isCurrent(pinned)) throw new DOMException('Video request stale', 'AbortError'); };
    const wait = (type: string): Promise<{ seq?: unknown; result?: unknown }> => {
        if (closed || fatal) return Promise.reject(fatal ?? new Error('Video frame closed'));
        expected = type;
        const promise = new Promise<{ seq?: unknown; result?: unknown }>((resolve, reject) => { waiting = resolve; rejectWait = reject; });
        void promise.catch(() => {});
        return promise;
    };
    try {
        frame = createContainedFrame({ html: videoFrame, init: { v: 1, token, identity: pinned }, signal: deadline, hidden: true,
            onFailure: reason => fail(new Error(`Video frame failed: ${reason}`)),
            onMessage(event) {
                const time = performance.now(); if (time - started >= 1000) { started = time; messages = 0; }
                if (++messages > 120 || !event.data || typeof event.data !== 'object') { closeWorkerResult(event.data); fail(new Error('Invalid video response')); return; }
                const reply = event.data as { v?: unknown; token?: unknown; identity?: unknown; type?: unknown; seq?: unknown; result?: unknown };
                if (reply.v !== 1 || reply.token !== token || !validBoardIdentity(reply.identity) || !matchingIdentity(reply.identity, pinned)
                    || typeof reply.type !== 'string' || !waiting) { closeWorkerResult(event.data); fail(new Error('Invalid video response')); return; }
                if (reply.type === 'error') { closeWorkerResult(event.data); fail(new Error('Video frame could not be decoded')); return; }
                if (reply.type !== expected) { closeWorkerResult(event.data); fail(new Error('Unexpected video response')); return; }
                const resolve = waiting; waiting = undefined; rejectWait = undefined; resolve(reply);
            } });
        deadline.addEventListener('abort', abort, { once: true });
        const ready = wait('ready');
        frame.frame.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden;pointer-events:none';
        frame.mount(document.body); await ready; check();
        let sequence = 0;
        for (let offset = 0; offset < blob.size; offset += CHUNK) {
            check();
            const bytes = await blob.slice(offset, offset + CHUNK).arrayBuffer(); check();
            const ack = wait('ack');
            frame.port.postMessage({ v: 1, token, identity: pinned, type: 'chunk', seq: sequence, bytes }, [bytes]);
            if ((await ack).seq !== sequence++) throw new Error('Invalid video chunk acknowledgement');
        }
        const response = wait('result');
        frame.port.postMessage({ v: 1, token, identity: pinned, type: 'finish', seq: sequence,
            metadata: { width: info.width, height: info.height, mime: info.mime, operation } });
        result = (await response).result;
        check();
        if (operation === 'probe') {
            if (typeof result !== 'number' || !Number.isFinite(result) || result < 0) throw new Error('Invalid contained video duration');
            return result;
        }
        if (!(result instanceof ImageBitmap) || result.width !== info.width || result.height !== info.height) throw new Error('Invalid contained video bitmap');
        const bitmap = result; result = undefined; return bitmap;
    } finally {
        if (result instanceof ImageBitmap) result.close();
        closed = true; deadline.removeEventListener('abort', abort); fail(aborted());
        frame?.dispose(); permit.release();
    }
}
function aborted(): DOMException { return new DOMException('Video frame closed', 'AbortError'); }
