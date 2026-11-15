import { projectionLength, projectionPosition, projectionSlice, type TextProjectionPosition } from './projection';
import { textBoundaries } from './boundaries';
import type { RichText } from './richText';
import type { PlainTextOptions } from './plainText';

export interface ProjectionWindow {
    readonly from: number;
    readonly to: number;
    readonly cursor: number;
    readonly text: string;
}
export interface ProjectionReadOptions extends PlainTextOptions {
    /** A capture owner may fence this immutable revision across scheduler yields. */
    readonly current?: () => boolean;
}

function cancelled(options?: { readonly signal?: AbortSignal; readonly current?: () => boolean }): void {
    options?.signal?.throwIfAborted();
    if (options?.current && !options.current()) throw new DOMException('Text projection is stale', 'AbortError');
}
function units(value: number, name: string): void {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`Invalid projection ${name}`);
}

/** A revision-affine reader over the newline projection; it never stores a flattened document. */
export class TextProjectionReader {
    constructor(readonly text: RichText) {}
    get length(): number { return projectionLength(this.text); }
    position(offset: number): TextProjectionPosition { return projectionPosition(this.text, offset); }
    slice(from: number, to: number): string { return projectionSlice(this.text, from, to); }

    /** Select an input window on real grapheme boundaries, even across runs or CRLF. */
    window(offset: number, before: number, after: number, affinity: 'before' | 'after' = 'after'): ProjectionWindow {
        units(offset, 'offset'); units(before, 'window'); units(after, 'window');
        if (offset > this.length || (affinity !== 'before' && affinity !== 'after')) throw new RangeError('Invalid projection window');
        const cursor = textBoundaries.snap(this.text, offset, affinity === 'before' ? -1 : 1);
        const from = textBoundaries.snap(this.text, Math.max(0, cursor - before), -1);
        const to = textBoundaries.snap(this.text, Math.min(this.length, cursor + after), 1);
        return { from, to, cursor, text: projectionSlice(this.text, from, to) };
    }

    /** Chunks end on grapheme boundaries; a single oversized grapheme is never split. */
    *chunks(from = 0, to = this.length, maximum = 4096,
        options?: { readonly signal?: AbortSignal; readonly current?: () => boolean }): Generator<string> {
        units(from, 'start'); units(to, 'end'); units(maximum, 'chunk size');
        if (!maximum || to < from || to > this.length || !textBoundaries.isBoundary(this.text, from)
            || !textBoundaries.isBoundary(this.text, to)) throw new RangeError('Invalid grapheme-aligned projection range');
        let offset = from;
        while (offset < to) {
            cancelled(options);
            const candidate = Math.min(to, offset + maximum);
            let end = candidate === to ? to : textBoundaries.snap(this.text, candidate, -1);
            if (end <= offset) end = Math.min(to, textBoundaries.snap(this.text, candidate, 1));
            if (end <= offset) throw new Error('Text projection did not advance');
            yield projectionSlice(this.text, offset, end);
            offset = end;
        }
        cancelled(options);
    }

    /** Consumer backpressure and scheduler cooperation both keep large reads bounded. */
    async *chunksCooperative(from: number, to: number, maximum: number, options: ProjectionReadOptions): AsyncGenerator<string> {
        const budget = options.sliceMilliseconds ?? 3;
        if (!Number.isFinite(budget) || budget <= 0) throw new RangeError('Invalid projection read time slice');
        let started = performance.now();
        for (const chunk of this.chunks(from, to, maximum, options)) {
            cancelled(options);
            yield chunk;
            cancelled(options);
            if (performance.now() - started >= budget) {
                await options.cooperate();
                cancelled(options);
                started = performance.now();
            }
        }
    }
}
