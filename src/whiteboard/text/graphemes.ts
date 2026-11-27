const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
type Segments = ReturnType<Intl.Segmenter['segment']>;

function isSimpleAscii(text: string): boolean {
    for (let index = 0; index < text.length; index++) {
        const unit = text.charCodeAt(index);
        if (unit > 0x7f || unit === 0x0a || unit === 0x0d) return false;
    }
    return true;
}

export class GraphemeNavigator implements Iterable<number> {
    private readonly simple: boolean;
    private segments?: Segments;
    constructor(readonly text: string) {
        this.simple = isSimpleAscii(text);
    }
    private valid(offset: number): boolean {
        return Number.isSafeInteger(offset) && offset >= 0 && offset <= this.text.length;
    }
    private require(offset: number): void {
        if (!this.valid(offset)) throw new RangeError('Invalid grapheme offset');
    }
    private segmented(): Segments { return this.segments ??= segmenter.segment(this.text); }

    isBoundary(offset: number): boolean {
        if (!this.valid(offset)) return false;
        if (offset === 0 || offset === this.text.length || this.simple) return true;
        return this.segmented().containing(offset)?.index === offset;
    }
    previous(offset: number): number {
        this.require(offset);
        if (!offset) return 0;
        if (this.simple) return offset - 1;
        return this.segmented().containing(offset - 1)?.index ?? offset;
    }
    next(offset: number): number {
        this.require(offset);
        if (offset === this.text.length) return offset;
        if (this.simple) return offset + 1;
        const part = this.segmented().containing(offset);
        return part ? part.index + part.segment.length : offset;
    }
    snap(offset: number, direction: -1 | 1): number {
        this.require(offset);
        return this.isBoundary(offset) ? offset : direction < 0 ? this.previous(offset) : this.next(offset);
    }
    range(offset: number): { readonly from: number; readonly to: number } | null {
        this.require(offset);
        if (offset === this.text.length) return null;
        if (this.simple) return { from: offset, to: offset + 1 };
        const part = this.segmented().containing(offset);
        return part ? { from: part.index, to: part.index + part.segment.length } : null;
    }
    *[Symbol.iterator](): Iterator<number> {
        yield 0;
        if (this.simple) {
            for (let offset = 1; offset <= this.text.length; offset++) yield offset;
            return;
        }
        for (const part of this.segmented()) if (part.index) yield part.index;
        if (this.text.length) yield this.text.length;
    }
}

export function graphemeBoundaries(text: string): number[] { return Array.from(new GraphemeNavigator(text)); }

export function isGraphemeBoundary(text: string, offset: number): boolean {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) return false;
    if (offset === 0 || offset === text.length) return true;
    return segmenter.segment(text).containing(offset)?.index === offset;
}
