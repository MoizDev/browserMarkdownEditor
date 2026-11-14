import type { JsonSpan } from '../format/jsonRead';
import type { RawJson } from '../model/json';
import { MAX_TEXT_LENGTH } from '../model/textLimits';
import type { PlainTextOptions } from './plainText';

export interface LegacyFieldSpan { readonly key: string; readonly prefix: string; readonly span: JsonSpan }
export type LegacyFields = WeakMap<object, readonly LegacyFieldSpan[]>;
export interface LegacySpanValue {
    readonly value: unknown;
    readonly originals: WeakMap<object, RawJson | JsonSpan>;
    readonly fields: LegacyFields;
}

/** A scheduler failure is not corrupt source data and must not become a read-only repair notice. */
export class RichImportSchedulerError extends Error {
    constructor(readonly original: unknown) { super('Rich import scheduler failed'); }
}

type ArrayFrame = { readonly kind: 'array'; readonly target: unknown[]; readonly iterator: AsyncIterator<JsonSpan> };
type ObjectFrame = { readonly kind: 'object'; readonly target: Record<string, unknown>;
    readonly iterator: AsyncIterator<readonly [string, JsonSpan]>; readonly keys: Set<string>;
    readonly source: string; readonly fields: LegacyFieldSpan[]; previous: number };
type Frame = ArrayFrame | ObjectFrame;

/**
 * Build an independent JSON value without JSON.parse on the containing record.
 * The weak span table preserves every original unknown value for the mapper.
 */
export async function materializeLegacySpan(root: JsonSpan, options: PlainTextOptions): Promise<LegacySpanValue> {
    const budget = options.sliceMilliseconds ?? 3;
    if (!Number.isFinite(budget) || budget <= 0) throw new RangeError('Invalid rich import time slice');
    const originals = new WeakMap<object, RawJson | JsonSpan>(), fields: LegacyFields = new WeakMap();
    const frames: Frame[] = [];
    let visited = 0, started = performance.now();
    const cooperate = async () => {
        options.signal?.throwIfAborted();
        if (performance.now() - started < budget) return;
        try { await options.cooperate(); }
        catch (error) { throw new RichImportSchedulerError(error); }
        options.signal?.throwIfAborted();
        started = performance.now();
    };
    const make = async (span: JsonSpan): Promise<unknown> => {
        options.signal?.throwIfAborted();
        if (++visited > 200_000 || frames.length > 64) throw new RangeError('Rich text structure exceeds safe limits');
        if ((visited & 255) === 0) await cooperate();
        if (span.kind === 'string') return span.stringIncremental(MAX_TEXT_LENGTH * 4, cooperate);
        if (span.kind === 'number') return span.number();
        if (span.kind === 'boolean') return span.text() === 'true';
        if (span.kind === 'null') return null;
        if (span.kind === 'array') {
            const target: unknown[] = [];
            originals.set(target, span);
            frames.push({ kind: 'array', target, iterator: span.itemsIncremental(cooperate)[Symbol.asyncIterator]() });
            return target;
        }
        const target: Record<string, unknown> = Object.create(null);
        originals.set(target, span);
        const entries: LegacyFieldSpan[] = [];
        fields.set(target, entries);
        frames.push({ kind: 'object', target, iterator: span.fieldsIncremental(cooperate)[Symbol.asyncIterator](), keys: new Set(),
            source: span.source, fields: entries, previous: span.start + 1 });
        return target;
    };
    const value = await make(root);
    while (frames.length) {
        options.signal?.throwIfAborted();
        const frame = frames[frames.length - 1];
        if (frame.kind === 'array') {
            const next = await frame.iterator.next();
            if (next.done) { frames.pop(); continue; }
            frame.target.push(await make(next.value));
        } else {
            const next = await frame.iterator.next();
            if (next.done) { frames.pop(); continue; }
            const [key, span] = next.value;
            if (key.length > MAX_TEXT_LENGTH * 4) throw new RangeError('Unsupported rich key exceeds preservation limit');
            if (frame.keys.has(key)) throw new RangeError('Duplicate rich JSON property cannot be preserved');
            frame.keys.add(key);
            let start = frame.previous;
            while (start < span.start) {
                const code = frame.source.charCodeAt(start);
                if (code !== 32 && code !== 9 && code !== 10 && code !== 13 && code !== 44) break;
                if ((++start & 4095) === 0) await cooperate();
            }
            let keyEnd = start + 1, keyCheckpoint = keyEnd + 4096;
            while (keyEnd < span.start) {
                const code = frame.source.charCodeAt(keyEnd++);
                if (code === 92) keyEnd++;
                else if (code === 34) break;
                if (keyEnd >= keyCheckpoint) { await cooperate(); keyCheckpoint = keyEnd + 4096; }
            }
            frame.fields.push({ key, prefix: `${frame.source.slice(start, keyEnd)}:`, span });
            frame.previous = span.end;
            frame.target[key] = await make(span);
        }
    }
    options.signal?.throwIfAborted();
    return { value, originals, fields };
}
