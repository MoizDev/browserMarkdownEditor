import type { Block, RichText } from './richText';
import { projectionLength, projectionPosition } from './projection';

export interface BoundarySelection { readonly anchor: number; readonly focus: number }
export type BoundaryDirection = -1 | 1;

type Segments = ReturnType<Intl.Segmenter['segment']>;
interface BlockEntry {
    readonly text: string;
    readonly simple: boolean;
    readonly bytes: number;
    graphemes?: Segments;
    words?: Segments;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
const DEFAULT_BYTES = 16 * 1024 * 1024;
const DEFAULT_ENTRIES = 1024;

function endsWithCR(block: Block): boolean {
    for (let index = block.runs.length - 1; index >= 0; index--) {
        const text = block.runs[index].text;
        if (text.length) return text.charCodeAt(text.length - 1) === 13;
    }
    return false;
}

function blockString(block: Block): string {
    if (block.runs.length === 1) return block.runs[0].text;
    const parts: string[] = [];
    let current = '';
    for (const run of block.runs) {
        if (current && current.length + run.text.length > 4096) { parts.push(current); current = ''; }
        if (run.text.length > 4096) parts.push(run.text);
        else current += run.text;
    }
    if (current) parts.push(current);
    return parts.join('');
}

/**
 * Navigation is indexed by immutable blocks: no joined document and no array of
 * per-character boundary objects. ICU's Segments supports indexed containing()
 * even when a grapheme spans several differently styled runs.
 */
export class TextBoundaries {
    private readonly entries = new Map<Block, BlockEntry>();
    private bytes = 0;

    constructor(private readonly byteLimit = DEFAULT_BYTES, private readonly entryLimit = DEFAULT_ENTRIES) {
        if (!Number.isSafeInteger(byteLimit) || byteLimit < 0 || !Number.isSafeInteger(entryLimit) || entryLimit < 0)
            throw new RangeError('Invalid text boundary cache limits');
    }

    private entry(block: Block): BlockEntry {
        const cached = this.entries.get(block);
        if (cached) { this.entries.delete(block); this.entries.set(block, cached); return cached; }
        const text = blockString(block);
        // ASCII without CR/LF has one UTF-16 unit per extended grapheme.
        const simple = /^[\x00-\x09\x0b-\x0c\x0e-\x7f]*$/.test(text);
        // Charge for the retained string and both possible ICU segmentation views.
        const bytes = 512 + text.length * 12;
        const result: BlockEntry = { text, simple, bytes };
        if (this.entryLimit && bytes <= this.byteLimit) {
            while (this.entries.size && (this.entries.size >= this.entryLimit || this.bytes + bytes > this.byteLimit)) {
                const oldest = this.entries.keys().next().value!;
                this.bytes -= this.entries.get(oldest)!.bytes;
                this.entries.delete(oldest);
            }
            this.entries.set(block, result); this.bytes += bytes;
        }
        return result;
    }

    private clamp(text: RichText, offset: number): number {
        return Math.max(0, Math.min(projectionLength(text), Number.isFinite(offset) ? Math.floor(offset) : 0));
    }

    /** A block separator participates in CRLF when the preceding block ends in CR. */
    isBoundary(text: RichText, offset: number): boolean {
        if (!text.blocks.length || !Number.isSafeInteger(offset) || offset < 0 || offset > projectionLength(text)) return false;
        const point = projectionPosition(text, offset);
        if (point.offset === 0 && point.length !== 0) return true;
        if (point.offset === point.length)
            return point.index + 1 >= text.blocks.length || !endsWithCR(point.block);
        const entry = this.entry(point.block);
        if (entry.simple) return true;
        return (entry.graphemes ??= graphemeSegmenter.segment(entry.text)).containing(point.offset)?.index === point.offset;
    }

    /** One extended grapheme in projection order, including a CR+separator pair. */
    adjacent(text: RichText, offset: number, direction: BoundaryDirection): number {
        const length = projectionLength(text), cursor = this.clamp(text, offset);
        if (direction < 0 && cursor === 0) return 0;
        if (direction > 0 && cursor === length) return length;
        const point = projectionPosition(text, cursor);
        if (direction < 0 && point.offset === 0) {
            if (!point.index) return 0;
            return point.start - (endsWithCR(text.blocks[point.index - 1]) ? 2 : 1);
        }
        if (direction > 0 && point.offset === point.length)
            return point.index + 1 < text.blocks.length ? cursor + 1 : length;
        const entry = this.entry(point.block);
        if (entry.simple) return cursor + direction;
        const part = (entry.graphemes ??= graphemeSegmenter.segment(entry.text)).containing(direction < 0 ? point.offset - 1 : point.offset);
        if (!part) return cursor;
        if (direction < 0) return point.start + part.index;
        const end = part.index + part.segment.length;
        return point.start + end + (end === entry.text.length && entry.text.endsWith('\r') && point.index + 1 < text.blocks.length ? 1 : 0);
    }

    /** Expand an arbitrary UTF-16 offset to the nearest stop in the requested direction. */
    snap(text: RichText, offset: number, direction: BoundaryDirection): number {
        const cursor = this.clamp(text, offset);
        return this.isBoundary(text, cursor) ? cursor : this.adjacent(text, cursor, direction);
    }

    selectWord(text: RichText, offset: number): BoundarySelection {
        const length = projectionLength(text);
        if (!length) return { anchor: 0, focus: 0 };
        const cursor = Math.min(length - 1, this.clamp(text, offset)), point = projectionPosition(text, cursor);
        const entry = this.entry(point.block), followedByBreak = point.index + 1 < text.blocks.length;
        if (followedByBreak && point.offset === entry.text.length)
            return { anchor: entry.text.endsWith('\r') ? cursor - 1 : cursor, focus: cursor + 1 };
        if (followedByBreak && point.offset === entry.text.length - 1 && entry.text.endsWith('\r'))
            return { anchor: cursor, focus: cursor + 2 };
        const part = (entry.words ??= wordSegmenter.segment(entry.text)).containing(point.offset);
        if (!part) return { anchor: cursor, focus: cursor };
        const from = this.snap(text, point.start + part.index, -1);
        const to = this.snap(text, point.start + part.index + part.segment.length, 1);
        return { anchor: from, focus: to };
    }

    selectBlock(text: RichText, offset: number): BoundarySelection {
        const point = projectionPosition(text, this.clamp(text, offset));
        // A trailing CR belongs to the following separator, not to a partial selection.
        const end = point.start + point.length;
        return { anchor: point.start, focus: this.snap(text, end, 1) };
    }

    /** Word motion skips non-word segments and the synthetic separators between blocks. */
    word(text: RichText, offset: number, direction: BoundaryDirection): number {
        const length = projectionLength(text), cursor = this.clamp(text, offset);
        if (direction < 0 && cursor === 0) return 0;
        if (direction > 0 && cursor === length) return length;
        const point = projectionPosition(text, cursor);
        let index = point.index, start = point.start, local = point.offset;
        while (index >= 0 && index < text.blocks.length) {
            const entry = this.entry(text.blocks[index]);
            if (direction < 0) {
                local = Math.min(local, entry.text.length);
                while (local > 0) {
                    const part = (entry.words ??= wordSegmenter.segment(entry.text)).containing(local - 1);
                    if (!part) break;
                    if (part.isWordLike) return this.snap(text, start + part.index, -1);
                    if (part.index >= local) break;
                    local = part.index;
                }
                if (--index < 0) break;
                const previous = this.entry(text.blocks[index]);
                start -= previous.text.length + 1; local = previous.text.length;
            } else {
                while (local < entry.text.length) {
                    const part = (entry.words ??= wordSegmenter.segment(entry.text)).containing(local);
                    if (!part) break;
                    const end = part.index + part.segment.length;
                    if (part.isWordLike) return this.snap(text, start + end, 1);
                    if (end <= local) break;
                    local = end;
                }
                start += entry.text.length + 1;
                index++; local = 0;
            }
        }
        return direction < 0 ? 0 : length;
    }

    clear(): void { this.entries.clear(); this.bytes = 0; }
}

/** Bounded shared cache for the synchronous, view-independent rich operation API. */
export const textBoundaries = new TextBoundaries();
