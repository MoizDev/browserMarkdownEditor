import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { ByteLease } from '../../platform/render/gfx/api';
import type { BoardRuntime } from '../host/runtime';
import { SECURITY_LIMITS } from '../security/limits';
import type { CopySnapshot } from './snapshot';

// Provenance: clipboard §2.4 native-record JSON and C2 job ownership;
// independent incremental JSON-string serialization, no upstream engine source.
/** Capture is the real C2 in-job snapshot; ClipboardItem is installed while activation is live. */
export async function copyBoardJsonFresh(options: {
    readonly runtime: BoardRuntime; readonly memory: MemoryAllocator; readonly signal?: AbortSignal;
    current(): boolean;
    capture(signal: AbortSignal): Promise<CopySnapshot>;
}): Promise<void> {
    const { runtime, memory } = options, session = runtime.session, controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const check = () => { signal.throwIfAborted(); if (runtime.session !== session || !options.current()) throw new DOMException('Clipboard capture became stale', 'AbortError'); };
    check();
    let finished = false, owned: { release(): void } | undefined;
    const task = runtime.jobs.run(async context => {
        const snapshot = await options.capture(context.signal), retained: ByteLease[] = [], chunks: Blob[] = [];
        let released = false, bytes = 0;
        const release = () => {
            if (released) return;
            released = true;
            try { for (const lease of snapshot.leases) lease.release(); }
            finally { for (const lease of retained) memory.release(lease); }
        };
        const add = (text: string) => {
            const lease = memory.reserve(256 + text.length * 6);
            if (!lease) throw new Error('Insufficient memory for clipboard JSON');
            try {
                const chunk = new Blob([text], { type: 'text/plain' });
                if (chunk.size > SECURITY_LIMITS.clipboardExpandedBytes - bytes) throw new RangeError('Clipboard JSON exceeds the expanded-byte limit');
                retained.push(lease); chunks.push(chunk); bytes += chunk.size;
            } catch (error) { memory.release(lease); throw error; }
        };
        const cooperate = async () => { await new Promise<void>(resolve => setTimeout(resolve, 0)); context.assertCurrent(); check(); };
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
    const data = task.then(result => {
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
