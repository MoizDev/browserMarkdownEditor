import type { Block, RichText } from './richText';

export interface TextProjectionPosition {
    readonly block: Block;
    readonly index: number;
    readonly start: number;
    readonly offset: number;
}
interface ProjectionIndex {
    readonly starts: readonly number[];
    readonly lengths: readonly number[];
    readonly length: number;
    plain?: string;
}
const indexes = new WeakMap<RichText, ProjectionIndex>();
const blockLengths = new WeakMap<Block, number>();

function indexFor(text: RichText): ProjectionIndex {
    let index = indexes.get(text);
    if (index) return index;
    const starts: number[] = [], lengths: number[] = [];
    let position = 0;
    for (const block of text.blocks) {
        let length = blockLengths.get(block);
        if (length === undefined) {
            length = block.runs.reduce((sum, run) => sum + run.text.length, 0);
            blockLengths.set(block, length);
        }
        starts.push(position); lengths.push(length); position += length + 1;
    }
    index = { starts, lengths, length: Math.max(0, position - 1) };
    indexes.set(text, index);
    return index;
}

/** Newline belongs to the preceding block; the next offset starts the next block. */
export function projectionPosition(text: RichText, offset: number): TextProjectionPosition {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError('Invalid text offset');
    const index = indexFor(text);
    if (!text.blocks.length || offset > index.length) throw new RangeError('Text offset exceeds projection');
    let lo = 0, hi = index.starts.length;
    while (lo + 1 < hi) {
        const mid = (lo + hi) >>> 1;
        if (index.starts[mid] <= offset) lo = mid; else hi = mid;
    }
    return { block: text.blocks[lo], index: lo, start: index.starts[lo], offset: offset - index.starts[lo] };
}
export function projectionLength(text: RichText): number { return indexFor(text).length; }
export function projectionText(text: RichText): string {
    const index = indexFor(text);
    return index.plain ??= text.blocks.map(block => block.runs.map(run => run.text).join('')).join('\n');
}
