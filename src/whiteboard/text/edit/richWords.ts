import { blockTextLength } from '../../model/textOffsets';
import { projectionLength, projectionPosition } from '../projection';
import type { Block, RichText } from '../richText';
import type { EditSelection } from './host';

interface Entry {
    readonly text: string;
    readonly segments: ReturnType<Intl.Segmenter['segment']>;
    graphemes?: ReturnType<Intl.Segmenter['segment']>;
    readonly bytes: number;
}
const WORD_CACHE_BYTES = 8 * 1024 * 1024;

/** The immutable block, not a joined million-character document, is the word-navigation cache key. */
export class RichWordNavigation {
    private readonly segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
    private readonly graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    private readonly entries = new Map<number, Entry>();
    private readonly ids = new WeakMap<Block, number>();
    private nextId = 1;
    private bytes = 0;

    private block(block: Block): Entry {
        let id = this.ids.get(block);
        if (id === undefined) { id = this.nextId++; this.ids.set(block, id); }
        const cached = this.entries.get(id);
        if (cached) { this.entries.delete(id); this.entries.set(id, cached); return cached; }
        const chunks: string[] = [];
        let chunk = '';
        for (const run of block.runs) {
            if (chunk.length + run.text.length > 4096 && chunk) { chunks.push(chunk); chunk = ''; }
            if (run.text.length > 4096) chunks.push(run.text); else chunk += run.text;
        }
        if (chunk) chunks.push(chunk);
        const text = chunks.join(''), bytes = 512 + text.length * 8;
        const entry = { text, segments: this.segmenter.segment(text), bytes };
        if (bytes <= WORD_CACHE_BYTES) {
            while (this.entries.size && (this.entries.size >= 1024 || this.bytes + bytes > WORD_CACHE_BYTES)) {
                const oldest = this.entries.keys().next().value!, removed = this.entries.get(oldest)!;
                this.entries.delete(oldest); this.bytes -= removed.bytes;
            }
            this.entries.set(id, entry); this.bytes += bytes;
        }
        return entry;
    }

    private offset(text: RichText, value: number): number {
        const length = projectionLength(text);
        return Math.max(0, Math.min(length, Number.isFinite(value) ? Math.floor(value) : 0));
    }

    selectWord(text: RichText, offset: number): EditSelection {
        const length = projectionLength(text);
        if (!length) return { anchor: 0, focus: 0 };
        const cursor = Math.min(length - 1, this.offset(text, offset)), point = projectionPosition(text, cursor);
        const entry = this.block(point.block), followedByBreak = point.index + 1 < text.blocks.length;
        if (followedByBreak && point.offset === entry.text.length)
            return { anchor: entry.text.endsWith('\r') ? cursor - 1 : cursor, focus: cursor + 1 };
        if (followedByBreak && point.offset === entry.text.length - 1 && entry.text.endsWith('\r'))
            return { anchor: cursor, focus: cursor + 2 };
        const part = entry.segments.containing(point.offset);
        return part ? { anchor: point.start + part.index, focus: point.start + part.index + part.segment.length }
            : { anchor: cursor, focus: cursor };
    }

    selectBlock(text: RichText, offset: number): EditSelection {
        const point = projectionPosition(text, this.offset(text, offset));
        return { anchor: point.start, focus: point.start + blockTextLength(point.block) };
    }

    adjacent(text: RichText, offset: number, direction: -1 | 1): number {
        const length = projectionLength(text), cursor = this.offset(text, offset);
        if (direction < 0 && cursor === 0) return 0;
        if (direction > 0 && cursor === length) return length;
        const point = projectionPosition(text, cursor), entry = this.block(point.block);
        if (direction < 0 && point.offset === 0) {
            if (point.index === 0) return 0;
            const previous = this.block(text.blocks[point.index - 1]);
            return point.start - (previous.text.endsWith('\r') ? 2 : 1);
        }
        if (direction > 0 && point.offset === entry.text.length)
            return point.index + 1 < text.blocks.length ? cursor + 1 : length;
        const segments = entry.graphemes ??= this.graphemeSegmenter.segment(entry.text);
        const part = segments.containing(direction < 0 ? point.offset - 1 : point.offset);
        if (!part) return cursor;
        if (direction < 0) return point.start + part.index;
        const end = part.index + part.segment.length;
        return point.start + end + (end === entry.text.length && entry.text.endsWith('\r') && point.index + 1 < text.blocks.length ? 1 : 0);
    }

    boundary(text: RichText, offset: number, direction: -1 | 1): number {
        const length = projectionLength(text), cursor = this.offset(text, offset);
        if (direction < 0 && cursor === 0) return 0;
        if (direction > 0 && cursor === length) return length;
        const point = projectionPosition(text, cursor);
        let index = point.index, start = point.start, local = point.offset;
        while (index >= 0 && index < text.blocks.length) {
            const block = text.blocks[index], entry = this.block(block);
            if (direction < 0) {
                local = Math.min(local, entry.text.length);
                while (local > 0) {
                    const part = entry.segments.containing(local - 1);
                    if (!part) break;
                    if (part.isWordLike) return start + part.index;
                    if (part.index >= local) break;
                    local = part.index;
                }
                index--;
                if (index < 0) break;
                const previousLength = blockTextLength(text.blocks[index]);
                start -= previousLength + 1; local = previousLength;
            } else {
                while (local < entry.text.length) {
                    const part = entry.segments.containing(local);
                    if (!part) break;
                    const end = part.index + part.segment.length;
                    if (part.isWordLike) return start + end;
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
