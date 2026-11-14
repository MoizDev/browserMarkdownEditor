import { Sha256 } from '../../utils/sha256';
import { serve } from '../../platform/workers';
import type { WorkerContext } from '../../platform/workers';
import type { RawJson } from '../model/json';
import { LineTable } from './lineTable';
import type { BaselineLine, SerializerBuild, SerializerDelta, SerializerPrime, SerializerProduct, SerializerReply } from './serializerProtocol';
import { writeFailure } from './writeTypes';
import type { WriteResult } from './writeTypes';

const decoder = new TextDecoder('utf-8', { fatal: true });
const revisions = new Map<number, LineTable>();
let current = -1;
// serve() permits concurrent handlers. Prime, delta and pruning mutate a single ordered history,
// and must not race even when callers post the next request while a prior operation yields.
let queue: Promise<void> = Promise.resolve();
function serial<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.then(work, work);
    queue = next.then(() => { }, () => { });
    return next;
}
function take<T>(result: WriteResult<T>): T {
    if (!result.ok) throw new Refusal(result.error.code, result.error.reason, result.error.field);
    return result.value;
}
class Refusal extends Error {
    constructor(readonly code: 'invalid' | 'limit' | 'points' | 'allocation' | 'integrity' | 'dirty' | 'header',
        reason: string, readonly field?: string) { super(reason); }
}
function failure<T>(error: unknown): SerializerReply<T> {
    if (error instanceof Refusal) return writeFailure(error.code, error.message, error.field);
    if (error instanceof RangeError) return writeFailure('allocation', 'Serializer could not allocate its line table or output');
    if (error instanceof TypeError) return writeFailure('invalid', 'Serializer encountered invalid UTF-8 or an unreadable baseline');
    throw error;
}
async function* baselineLines(input: SerializerPrime): AsyncIterable<BaselineLine> {
    if (input.lines && !input.index) { yield* input.lines; return; }
    if (!(input.index instanceof Blob) || input.lines) throw new Refusal('invalid', 'Missing or ambiguous baseline line index');
    const reader = input.index.stream().getReader();
    const text = new TextDecoder('utf-8', { fatal: true });
    let pending = '';
    try {
        for (; ;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            pending += text.decode(chunk.value, { stream: true });
            let newline: number;
            while ((newline = pending.indexOf('\n')) !== -1) {
                const line = pending.slice(0, newline);
                pending = pending.slice(newline + 1);
                if (!line || line.length > 4096) throw new Refusal('invalid', 'Corrupt baseline line index');
                let parsed: unknown;
                try { parsed = JSON.parse(line); } catch { throw new Refusal('invalid', 'Corrupt baseline line index'); }
                yield parsed as BaselineLine;
            }
            if (pending.length > 4096) throw new Refusal('invalid', 'Corrupt baseline line index');
        }
        pending += text.decode();
        if (pending) throw new Refusal('invalid', 'Truncated baseline line index');
    } finally { reader.releaseLock(); }
}
async function prime(input: SerializerPrime, context: WorkerContext): Promise<SerializerReply<void>> {
    try {
        if (!(input.baseline instanceof Blob) || !Number.isSafeInteger(input.revision) || input.revision < 0) {
            return writeFailure('invalid', 'Invalid parsed-byte baseline');
        }
        const table = new LineTable();
        take(table.setHeader(input.header));
        let index = 0;
        for await (const line of baselineLines(input)) {
            if (!Number.isSafeInteger(line.offset) || !Number.isSafeInteger(line.length) || line.offset < 0 || line.length < 0
                || line.offset + line.length > input.baseline.size) return writeFailure('invalid', 'Baseline line position is outside parsed bytes');
            const text = decoder.decode(await input.baseline.slice(line.offset, line.offset + line.length).arrayBuffer())
                .trim().replace(/,\s*$/u, '');
            take(table.set({ identity: line.identity, text }, line.revision));
            if ((index++ & 127) === 127) await context.slice();
        }
        // Publish atomically: a failed or cancelled prime cannot erase a usable history.
        await context.slice();
        revisions.clear();
        revisions.set(input.revision, table);
        current = input.revision;
        return { ok: true, value: undefined };
    } catch (error) { return failure(error); }
}
async function apply(input: SerializerDelta, context: WorkerContext): Promise<SerializerReply<void>> {
    try {
        if (!Number.isSafeInteger(input.revision) || input.revision <= current || input.previous !== current) {
            return writeFailure('integrity', 'Serializer revision sequence is incomplete');
        }
        const previous = revisions.get(current);
        if (!previous) return writeFailure('integrity', 'Serializer requires its parsed-byte baseline');
        const next = previous.fork();
        if (input.header !== undefined) take(next.setHeader(input.header));
        for (const identity of input.removed) take(next.remove(identity));
        for (let index = 0; index < input.changed.length; index++) {
            const change = input.changed[index];
            take(next.set({ identity: change.identity, text: decoder.decode(change.bytes) }, change.revision));
            if ((index & 127) === 127) await context.slice();
        }
        await context.slice();
        revisions.set(input.revision, next);
        current = input.revision;
        return { ok: true, value: undefined };
    } catch (error) { return failure(error); }
}
async function build(input: SerializerBuild, context: WorkerContext): Promise<SerializerReply<SerializerProduct>> {
    try {
        const table = revisions.get(input.revision);
        if (!table) return writeFailure('integrity', 'Requested revision is no longer retained by the serializer');
        const fields = new Map<string, RawJson>();
        for (const [key, value] of input.endFields) {
            if (fields.has(key)) return writeFailure('invalid', 'Duplicate preserved footer field');
            fields.set(key, value as RawJson);
        }
        const assembly = take(table.assemble(input.expected, fields.size ? { fields, raw: new Map() } : null));
        await context.slice();
        // The existing app-owned incremental hash avoids allocating a second 1 GiB buffer.
        // Hash the assembled bytes, never the line-key integrity digest.
        const hash = new Sha256();
        for (let offset = 0; offset < assembly.blob.size; offset += 1024 * 1024) {
            hash.update(new Uint8Array(await assembly.blob.slice(offset, offset + 1024 * 1024).arrayBuffer()));
            await context.slice();
        }
        const sha256 = hash.digest();
        // Keep recovery metadata in a Blob beside the exact written bytes, not a million-entry
        // structured-clone to the UI. A later worker can re-prime without re-reading the disk File.
        const parts: string[] = [];
        let batch = '', count = 0;
        for (const position of table.positions()) {
            batch += JSON.stringify(position) + '\n';
            if (batch.length >= 65536) { parts.push(batch); batch = ''; }
            if ((count++ & 127) === 127) await context.slice();
        }
        if (batch) parts.push(batch);
        const index = new Blob(parts, { type: 'application/x-board-line-index' });
        return { ok: true, value: { revision: input.revision, blob: assembly.blob, sha256, index, integrity: assembly.integrity } };
    } catch (error) { return failure(error); }
}
serve({
    protocol: 1,
    buildId: 'board-serializer-v1',
    handlers: {
        prime: (args, context) => serial(() => prime(args as SerializerPrime, context)),
        delta: (args, context) => serial(() => apply(args as SerializerDelta, context)),
        build: (args, context) => serial(() => build(args as SerializerBuild, context)),
        release: args => serial(async () => {
            const through = (args as { through: number; }).through;
            if (!Number.isSafeInteger(through) || through < 0) return writeFailure('invalid', 'Invalid revision release');
            for (const revision of revisions.keys()) if (revision < through && revision !== current) revisions.delete(revision);
            return { ok: true, value: undefined };
        }),
    },
});
