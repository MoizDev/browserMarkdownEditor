import { createContainedFrame } from '../../platform/containedFrame';
import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import { clipboardHtmlFrame } from 'virtual:whiteboard-svg-frames';
import { validRichText } from '../model/validate';
import { checkContentUrl } from '../security/urlPolicy';
import { SECURITY_LIMITS } from '../security/limits';
import type { RichFragment } from '../text/richText';
import { matchingIdentity, validBoardIdentity, type BoardJobIdentity } from '../workers/protocol';
import { boardWorker } from '../workers/client';
import type { HtmlClipboardMarkers } from './classify';

// Provenance: opaque clipboard profile, bounded transport and shared-memory
// ownership contracts; independent host protocol, no third-party source.
const CHUNK = 192 * 1024, LIMIT = SECURITY_LIMITS.clipboardHtmlBytes;
type Reply = { readonly type: string; readonly seq?: unknown; readonly result?: unknown };
export interface ClipboardHtmlFrameOptions {
    readonly memory: MemoryAllocator;
    readonly identity: BoardJobIdentity;
    isCurrent(identity: BoardJobIdentity): boolean;
}
export interface ClipboardHtmlProjection {
    readonly rich: RichFragment;
    readonly dataImages: readonly Readonly<{ blob: Blob; alt: string; order: number; textOffset: number }>[];
    readonly refusedImages: readonly Readonly<{ name: string; reason: string }>[];
    /** Keeps decoded bytes accounted until the caller has retained or discarded them. */
    release(): void;
}
export interface ClipboardHtmlFrameHost {
    markers(html: string, signal: AbortSignal): Promise<HtmlClipboardMarkers>;
    richHTML(html: string, signal: AbortSignal): Promise<RichFragment>;
    projectHTML(html: string, signal: AbortSignal): Promise<ClipboardHtmlProjection>;
    metadata(html: string, signal: AbortSignal): Promise<Readonly<{ title: string; description: string }>>;
}
function markers(value: unknown, limit: number): HtmlClipboardMarkers {
    if (!value || typeof value !== 'object') throw new Error('Invalid clipboard marker response');
    const result = value as Record<string, unknown>;
    if (Object.keys(result).sort().join(',') !== 'hasPrivate,legacyPayload,privatePayload' || typeof result.hasPrivate !== 'boolean'
        || !(result.privatePayload === null || typeof result.privatePayload === 'string' && result.privatePayload.length <= limit)
        || !(result.legacyPayload === null || typeof result.legacyPayload === 'string' && result.legacyPayload.length <= limit)
        || (!result.hasPrivate && result.privatePayload !== null)) throw new Error('Invalid clipboard marker response');
    return { hasPrivate: result.hasPrivate, privatePayload: result.privatePayload, legacyPayload: result.legacyPayload };
}
function rich(value: unknown): RichFragment {
    if (!validRichText(value)) throw new Error('Invalid clipboard rich-text response');
    for (const block of value.blocks) {
        if (block.tail !== undefined) throw new Error('Unexpected clipboard block metadata');
        for (const run of block.runs) {
            if (run.tail !== undefined || run.marks.x !== undefined) throw new Error('Unexpected clipboard run metadata');
            if (run.marks.link !== undefined) {
                const decision = checkContentUrl(run.marks.link, 'click', { appOrigin: '' });
                if (!decision.ok || decision.url !== run.marks.link) throw new Error('Invalid clipboard link');
            }
        }
    }
    return value;
}
export function createClipboardHtmlFrameHost(options: ClipboardHtmlFrameOptions): ClipboardHtmlFrameHost {
    if (!validBoardIdentity(options.identity)) throw new TypeError('Invalid clipboard job identity');
    const identity = Object.freeze({ ...options.identity });
    const request = async (html: string, mode: 'markers' | 'rich' | 'metadata', signal: AbortSignal): Promise<{ value: unknown; release(): void }> => {
        signal = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
        signal.throwIfAborted();
        if (typeof html !== 'string' || html.length > LIMIT) throw new RangeError('Clipboard HTML is too large');
        if (!options.isCurrent(identity)) throw new DOMException('Clipboard HTML request became stale', 'AbortError');
        // Includes input copies, inert DOM and structured-cloned output; large
        // envelopes may be refused by the shared governor before parsing.
        const lease = options.memory.reserve(8 * 1024 * 1024 + html.length * 24);
        if (!lease) throw new Error('Insufficient memory to parse clipboard HTML');
        let frame: ReturnType<typeof createContainedFrame> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
        let waiting: ((reply: Reply) => void) | undefined, rejectWait: ((error: unknown) => void) | undefined;
        let expected = 'ready', fatal: unknown, closed = false, handed = false, held = true;
        const release = () => { if (held) { held = false; options.memory.release(lease); } };
        const fail = (error: unknown) => { fatal = error; rejectWait?.(error); waiting = undefined; rejectWait = undefined; };
        const abort = () => fail(signal.reason ?? new DOMException('Clipboard HTML request cancelled', 'AbortError'));
        const check = () => {
            signal.throwIfAborted(); if (fatal) throw fatal;
            if (!options.isCurrent(identity)) throw new DOMException('Clipboard HTML request became stale', 'AbortError');
        };
        const wait = (type: string): Promise<Reply> => {
            check(); if (closed || waiting) throw new Error('Invalid clipboard frame state');
            expected = type;
            return new Promise((resolve, reject) => { waiting = resolve; rejectWait = reject; });
        };
        try {
            const blob = new Blob([html], { type: 'text/html' });
            if (blob.size > LIMIT) throw new RangeError('Clipboard HTML is too large');
            const worker = boardWorker('parse'); let preflight: unknown;
            try {
                preflight = await worker.request('clipboardDecode', { htmlPreflight: blob }, identity,
                    { priority: 0, cpu: 'governed', deadlineMs: 5000, signal }, options.isCurrent);
            } catch (error) {
                if (signal.aborted) await worker.recycle('HTML preflight cancelled').catch(() => undefined);
                throw error;
            }
            check(); if (preflight !== true) throw new Error('Invalid HTML preflight response');
            const token = Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');
            frame = createContainedFrame({ html: clipboardHtmlFrame, init: { v: 1, token, identity }, signal, hidden: true,
                onFailure: reason => fail(new Error(`Clipboard HTML frame failed: ${reason}`)),
                onMessage(event) {
                    const data = event.data as { v?: unknown; token?: unknown; identity?: unknown; type?: unknown; seq?: unknown; result?: unknown } | null;
                    if (!data || data.v !== 1 || data.token !== token || !validBoardIdentity(data.identity)
                        || !matchingIdentity(data.identity, identity) || typeof data.type !== 'string' || !waiting) {
                        fail(new Error('Invalid clipboard HTML frame response')); return;
                    }
                    if (data.type === 'error') { fail(new Error('Clipboard HTML could not be read')); return; }
                    if (data.type !== expected) { fail(new Error('Unexpected clipboard HTML frame response')); return; }
                    const resolve = waiting; waiting = undefined; rejectWait = undefined;
                    resolve({ type: data.type, seq: data.seq, result: data.result });
                },
            });
            signal.addEventListener('abort', abort, { once: true });
            timer = setTimeout(() => fail(new DOMException('Clipboard HTML frame timed out', 'TimeoutError')), 5000);
            const ready = wait('ready');
            frame.frame.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden;pointer-events:none';
            try { frame.mount(document.body); } catch (error) { fail(error); }
            await ready; check();
            let seq = 0;
            for (let offset = 0; offset < blob.size; offset += CHUNK) {
                const bytes = await blob.slice(offset, offset + CHUNK).arrayBuffer(); check();
                const ack = wait('ack');
                try { frame.port.postMessage({ v: 1, token, identity, type: 'chunk', seq, bytes }, [bytes]); }
                catch (error) { fail(error); }
                if ((await ack).seq !== seq++) throw new Error('Invalid clipboard HTML acknowledgement');
                check();
            }
            const result = wait('result');
            try { frame.port.postMessage({ v: 1, token, identity, type: 'finish', seq, mode }); }
            catch (error) { fail(error); }
            const reply = await result; check(); handed = true; return { value: reply.result, release };
        } finally {
            closed = true; signal.removeEventListener('abort', abort); if (timer !== undefined) clearTimeout(timer);
            fail(new DOMException('Clipboard HTML frame closed', 'AbortError')); frame?.dispose(); if (!handed) release();
        }
    };
    const projectHTML = async (html: string, signal: AbortSignal): Promise<ClipboardHtmlProjection> => {
        const result = await request(html, 'rich', signal);
        try {
            signal.throwIfAborted();
            if (!options.isCurrent(identity)) throw new DOMException('Clipboard HTML request became stale', 'AbortError');
            const value = result.value;
            if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'dataImages,refusedImages,rich') throw new Error('Invalid clipboard HTML response');
            const reply = value as { rich: unknown; dataImages: unknown; refusedImages: unknown }, text = rich(reply.rich);
            if (!Array.isArray(reply.dataImages) || !Array.isArray(reply.refusedImages)
                || reply.dataImages.length + reply.refusedImages.length > SECURITY_LIMITS.mediaBatch) throw new Error('Invalid clipboard image response');
            const maxOffset = text.blocks.reduce((sum, block) => sum + block.runs.reduce((n, run) => n + run.text.length, 0), text.blocks.length - 1);
            let total = 0, previous = 0;
            const dataImages = reply.dataImages.map((item: unknown, index: number) => {
                if (!item || typeof item !== 'object' || Object.keys(item).sort().join(',') !== 'alt,blob,order,textOffset') throw new Error('Invalid clipboard image response');
                const image = item as { blob: unknown; alt: unknown; order: unknown; textOffset: unknown };
                if (!(image.blob instanceof Blob) || (typeof File !== 'undefined' && image.blob instanceof File)
                    || !/^image\/[a-z0-9.+-]+$/.test(image.blob.type) || image.blob.size > SECURITY_LIMITS.mediaBytes || image.blob.size > SECURITY_LIMITS.inlineMediaBytes - total
                    || typeof image.alt !== 'string' || image.alt.length > 1_000_000 || image.order !== index
                    || typeof image.textOffset !== 'number' || !Number.isSafeInteger(image.textOffset) || image.textOffset < previous || image.textOffset > maxOffset) {
                    throw new Error('Invalid clipboard image response');
                }
                previous = image.textOffset; total += image.blob.size;
                return Object.freeze({ blob: new Blob([image.blob], { type: image.blob.type }), alt: image.alt, order: index, textOffset: image.textOffset });
            });
            const refusedImages = reply.refusedImages.map((item: unknown) => {
                if (!item || typeof item !== 'object' || Object.keys(item).sort().join(',') !== 'name,reason') throw new TypeError('Invalid refused clipboard image');
                const value = item as { name?: unknown; reason?: unknown };
                if (typeof value.name !== 'string' || value.name.length > 10_000 || typeof value.reason !== 'string' || value.reason.length > 500) throw new TypeError('Invalid refused clipboard image');
                return Object.freeze({ name: value.name, reason: value.reason });
            });
            return { rich: text, dataImages: Object.freeze(dataImages), refusedImages: Object.freeze(refusedImages), release: result.release };
        } catch (error) { result.release(); throw error; }
    };
    return {
        async markers(html, signal) { const result = await request(html, 'markers', signal);
            try {
                signal.throwIfAborted(); if (!options.isCurrent(identity)) throw new DOMException('Clipboard HTML request became stale', 'AbortError');
                const value = markers(result.value, html.length), bytes = 2 * ((value.privatePayload?.length ?? 0) + (value.legacyPayload?.length ?? 0));
                if (!bytes) { result.release(); return value; }
                const retained = options.memory.reserve(bytes + 4096);
                if (!retained) throw new Error('Insufficient memory for clipboard markers');
                result.release(); let held = true;
                return { ...value, release() { if (held) { held = false; options.memory.release(retained); } } };
            } catch (error) { result.release(); throw error; } },
        projectHTML,
        async metadata(html, signal) {
            const result = await request(html, 'metadata', signal);
            try {
                signal.throwIfAborted();
                if (!options.isCurrent(identity)) throw new DOMException('Preview became stale', 'AbortError');
                const value = result.value as { title?: unknown; description?: unknown } | null;
                if (!value || Object.keys(value).sort().join(',') !== 'description,title' || typeof value.title !== 'string' || value.title.length > 500
                    || typeof value.description !== 'string' || value.description.length > 2000) throw new TypeError('Invalid preview metadata');
                return Object.freeze({ title: value.title, description: value.description });
            } finally { result.release(); }
        },
        async richHTML(html, signal) { const result = await projectHTML(html, signal);
            try { if (result.dataImages.length || result.refusedImages.length) throw new Error('Clipboard HTML contains images; use projectHTML'); return result.rich; }
            finally { result.release(); } },
    };
}
