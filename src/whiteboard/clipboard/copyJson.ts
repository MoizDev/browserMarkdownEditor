import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { ByteLease } from '../../platform/render/gfx/api';
import type { BoardRuntime } from '../host/runtime';
import { SECURITY_LIMITS } from '../security/limits';
import type { CopySnapshot } from './snapshot';
import { yieldToHost } from '../../platform/yieldToHost';

function utf8Bytes(value: string): number {
    let bytes = 0;
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code < 0x80) bytes++;
        else if (code < 0x800) bytes += 2;
        else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length
            && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
        else bytes += 3;
    }
    return bytes;
}
export async function buildBoardJson(options: {
    readonly runtime: BoardRuntime; readonly memory: MemoryAllocator; readonly signal: AbortSignal;
    current(): boolean;
    capture(signal: AbortSignal): Promise<CopySnapshot>;
}): Promise<{ readonly blob: Blob; release(): void }> {
    const { runtime, memory, signal } = options, session = runtime.session;
    const check = () => { signal.throwIfAborted(); if (runtime.session !== session || !options.current()) throw new DOMException('Clipboard capture became stale', 'AbortError'); };
    check();
    return runtime.jobs.run(async context => {
        const snapshot = await options.capture(context.signal), retained: ByteLease[] = [], chunks: Blob[] = [];
        let released = false, bytes = 0;
        const release = () => {
            if (released) return;
            released = true;
            try { for (const lease of snapshot.leases) lease.release(); }
            finally { for (const lease of retained) memory.release(lease); }
        };
        const add = (text: string) => {
            const size = utf8Bytes(text);
            if (size > SECURITY_LIMITS.clipboardExpandedBytes - bytes) throw new RangeError('Clipboard JSON exceeds the expanded-byte limit');
            const lease = memory.reserve(256 + size * 2);
            if (!lease) throw new Error('Insufficient memory for clipboard JSON');
            try {
                const chunk = new Blob([text], { type: 'text/plain' });
                retained.push(lease); chunks.push(chunk); bytes += size;
            } catch (error) { memory.release(lease); throw error; }
        };
        let steps = 0, started = performance.now();
        const cooperate = async () => {
            context.assertCurrent(); check();
            if (++steps < 128 && performance.now() - started < 3) return;
            await yieldToHost(); context.assertCurrent(); check(); steps = 0; started = performance.now();
        };
        try {
            context.assertCurrent(); check();
            if (snapshot.payload.records.length > SECURITY_LIMITS.clipboardRecords) throw new RangeError('Clipboard JSON has too many records');
            add('[');
            let work = 0;
            for (const line of snapshot.payload.records) {
                context.assertCurrent(); check();
                if (typeof line !== 'string' || line.length > SECURITY_LIMITS.recordBytes) throw new RangeError('Invalid clipboard record');
                add(work++ ? ',"' : '"');
                for (let offset = 0; offset < line.length; offset += 65536) {
                    context.assertCurrent(); check();
                    const size = Math.min(65536, line.length - offset), scratch = memory.reserve(size * 18 + 512);
                    if (!scratch) throw new Error('Insufficient memory to encode clipboard JSON');
                    try { add(JSON.stringify(line.slice(offset, offset + size)).slice(1, -1)); }
                    finally { memory.release(scratch); }
                    await cooperate();
                }
                add('"');
                if ((work & 127) === 0) await cooperate();
            }
            add(']'); context.assertCurrent(); check();
            const blob = new Blob(chunks, { type: 'text/plain' });
            return { blob, release };
        } catch (error) { release(); throw error; }
    }, { signal, deadlineMs: 120_000 });
}

export async function copyBoardJsonFresh(options: {
    readonly runtime: BoardRuntime; readonly memory: MemoryAllocator; readonly signal?: AbortSignal;
    current(): boolean;
    capture(signal: AbortSignal): Promise<CopySnapshot>;
}): Promise<void> {
    const controller = new AbortController(), session = options.runtime.session;
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const check = () => { signal.throwIfAborted(); if (options.runtime.session !== session || !options.current()) throw new DOMException('Clipboard capture became stale', 'AbortError'); };
    check();
    let finished = false, owned: { release(): void } | undefined;
    const data = buildBoardJson({ ...options, signal }).then(result => {
        if (finished) { result.release(); throw new DOMException('Clipboard operation ended', 'AbortError'); }
        owned = result; return result.blob;
    });
    void data.catch(() => undefined);
    try {
        await navigator.clipboard.write([new ClipboardItem({ 'text/plain': data })]);
        check();
    } finally {
        finished = true; controller.abort(); owned?.release();
    }
}
