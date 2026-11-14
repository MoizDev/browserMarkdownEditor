import { matchingIdentity, validBoardIdentity } from '../workers/protocol';
import { sniffMedia } from './sniff';

// Provenance: SEC-W2 contained-frame protocol and media admission limits;
// independent muted first-frame capture, no third-party source.
const CHUNK = 192 * 1024, LIMIT = 10 * 1024 * 1024, PIXELS = 2 ** 26;
async function decode(blob: Blob, metadata: unknown): Promise<ImageBitmap | number> {
    if (!metadata || typeof metadata !== 'object') throw new TypeError('Missing video metadata');
    const { width, height, mime, operation } = metadata as { width?: unknown; height?: unknown; mime?: unknown; operation?: unknown };
    if (typeof width !== 'number' || typeof height !== 'number' || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)
        || width < 1 || height < 1 || width > PIXELS / height
        || (operation !== 'probe' && operation !== 'frame')
        || (mime !== 'video/mp4' && mime !== 'video/webm' && mime !== 'video/quicktime') || blob.size < 1 || blob.size > LIMIT) throw new TypeError('Invalid video bounds');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (sniffMedia(bytes) !== mime) throw new Error('Video signature mismatch');
    const url = URL.createObjectURL(blob.slice(0, blob.size, mime));
    const video = document.createElement('video');
    video.muted = true; video.autoplay = false; video.playsInline = true; video.preload = 'auto';
    let canvas: OffscreenCanvas | undefined;
    try {
        await new Promise<void>((resolve, reject) => {
            const clean = () => { video.removeEventListener('loadeddata', loaded); video.removeEventListener('error', failed); };
            const loaded = () => { clean(); video.pause(); resolve(); };
            const failed = () => { clean(); reject(new Error('Video frame unavailable')); };
            video.addEventListener('loadeddata', loaded); video.addEventListener('error', failed);
            video.src = url; video.load();
        });
        if (video.videoWidth !== width || video.videoHeight !== height || !Number.isFinite(video.duration) || video.duration < 0) throw new Error('Video metadata mismatch');
        // No playback or seek: loadeddata supplies the initial frame at time zero.
        if (video.currentTime !== 0) throw new Error('Video decoder did not supply frame zero');
        if (operation === 'probe') return video.duration;
        canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error('Video canvas unavailable');
        context.drawImage(video, 0, 0, width, height);
        context.getImageData(0, 0, 1, 1);
        return canvas.transferToImageBitmap();
    } finally {
        video.pause(); video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url);
        if (canvas) { canvas.width = 1; canvas.height = 1; }
    }
}
function run(): void {
    const initialize = (event: MessageEvent) => {
        if (event.source !== parent || event.ports.length !== 1) return;
        const init = event.data as { v?: unknown; token?: unknown; identity?: unknown } | null;
        if (!init || init.v !== 1 || typeof init.token !== 'string' || !/^[0-9a-f]{32}$/.test(init.token) || !validBoardIdentity(init.identity)) return;
        removeEventListener('message', initialize);
        const token = init.token, identity = init.identity, port = event.ports[0];
        let expected = 0, total = 0, done = false;
        const parts: ArrayBuffer[] = [];
        const send = (data: Record<string, unknown>, transfer: Transferable[] = []) => port.postMessage({ v: 1, token, identity, ...data }, transfer);
        port.addEventListener('message', (message: MessageEvent<unknown>) => {
            if (done || !message.data || typeof message.data !== 'object') return;
            const data = message.data as { v?: unknown; token?: unknown; identity?: unknown; type?: unknown; seq?: unknown; bytes?: unknown; metadata?: unknown };
            if (data.v !== 1 || data.token !== token || !validBoardIdentity(data.identity) || !matchingIdentity(data.identity, identity)) return;
            if (data.type === 'chunk') {
                if (data.seq !== expected || !(data.bytes instanceof ArrayBuffer) || data.bytes.byteLength > CHUNK || data.bytes.byteLength > LIMIT - total) {
                    done = true; send({ type: 'error' }); return;
                }
                parts.push(data.bytes); total += data.bytes.byteLength; send({ type: 'ack', seq: expected++ });
            } else if (data.type === 'finish' && data.seq === expected) {
                done = true;
                const blob = new Blob(parts);
                void decode(blob, data.metadata).then(result => {
                    try { send({ type: 'result', result }, result instanceof ImageBitmap ? [result] : []); }
                    catch { if (result instanceof ImageBitmap) result.close(); }
                }, () => send({ type: 'error' }));
            }
        });
        port.start(); send({ type: 'ready' });
    };
    addEventListener('message', initialize);
}
run();
