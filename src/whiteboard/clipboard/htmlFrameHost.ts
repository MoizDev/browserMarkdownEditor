import { createContainedFrame } from '../../platform/containedFrame';
import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import { clipboardHtmlFrame } from 'virtual:whiteboard-svg-frames';
import { validRichText } from '../model/validate';
import { checkContentUrl } from '../security/urlPolicy';
import { SECURITY_LIMITS } from '../security/limits';
import type { RichFragment } from '../text/richText';
import { matchingIdentity, validBoardIdentity, type BoardJobIdentity } from '../workers/protocol';
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
export interface ClipboardHtmlFrameHost {
    markers(html: string, signal: AbortSignal): Promise<HtmlClipboardMarkers>;
    richHTML(html: string, signal: AbortSignal): Promise<RichFragment>;
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
    const request = async (html: string, mode: 'markers' | 'rich', signal: AbortSignal): Promise<unknown> => {
        signal.throwIfAborted();
        if (typeof html !== 'string' || html.length > LIMIT) throw new RangeError('Clipboard HTML is too large');
        if (!options.isCurrent(identity)) throw new DOMException('Clipboard HTML request became stale', 'AbortError');
        // Includes input copies, inert DOM and structured-cloned output; large
        // envelopes may be refused by the shared governor before parsing.
        const lease = options.memory.reserve(8 * 1024 * 1024 + html.length * 24);
        if (!lease) throw new Error('Insufficient memory to parse clipboard HTML');
        let frame: ReturnType<typeof createContainedFrame> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
        let waiting: ((reply: Reply) => void) | undefined, rejectWait: ((error: unknown) => void) | undefined;
        let expected = 'ready', fatal: unknown, closed = false;
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
            timer = setTimeout(() => fail(new DOMException('Clipboard HTML frame timed out', 'TimeoutError')),
                Math.min(120_000, 30_000 + Math.ceil(blob.size / (1024 * 1024)) * 1000));
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
            const reply = await result; check(); return reply.result;
        } finally {
            closed = true; signal.removeEventListener('abort', abort); if (timer !== undefined) clearTimeout(timer);
            fail(new DOMException('Clipboard HTML frame closed', 'AbortError')); frame?.dispose(); options.memory.release(lease);
        }
    };
    return {
        async markers(html, signal) { const value = await request(html, 'markers', signal); signal.throwIfAborted();
            if (!options.isCurrent(identity)) throw new DOMException('Clipboard HTML request became stale', 'AbortError'); return markers(value, html.length); },
        async richHTML(html, signal) { const value = await request(html, 'rich', signal); signal.throwIfAborted();
            if (!options.isCurrent(identity)) throw new DOMException('Clipboard HTML request became stale', 'AbortError'); return rich(value); },
    };
}
