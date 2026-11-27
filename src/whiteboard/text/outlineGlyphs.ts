import type { WorkerContext } from '../../platform/workers';

type HarfBuzz = typeof import('harfbuzzjs');
type HarfBuzzBuffer = import('harfbuzzjs').Buffer;

export interface OutlineGlyph {
    readonly id: number;
    readonly xAdvance: number;
    readonly yAdvance: number;
    readonly xOffset: number;
    readonly yOffset: number;
}

const GLYPH_BATCH = 256;

function integer(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value); }

export async function* outlineGlyphBatches(hb: HarfBuzz, buffer: HarfBuzzBuffer,
    context: WorkerContext): AsyncGenerator<readonly OutlineGlyph[]> {
    const count = buffer.getLength();
    if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('Invalid HarfBuzz glyph count');
    for (let start = 0; start < count; start += GLYPH_BATCH) {
        context.signal.throwIfAborted();
        if (context.cancelled) throw new DOMException('Text export cancelled', 'AbortError');
        const end = Math.min(count, start + GLYPH_BATCH);
        const text = buffer.serialize({ start, end, format: hb.BufferSerializeFormat.JSON,
            flags: hb.BufferSerializeFlag.NO_GLYPH_NAMES | hb.BufferSerializeFlag.NO_CLUSTERS });
        const json = start === 0 ? text : text.startsWith(',') ? `[${text.slice(1)}` : '';
        let value: unknown;
        try { value = JSON.parse(json); } catch { throw new TypeError('Invalid serialized HarfBuzz glyphs'); }
        if (!Array.isArray(value) || value.length !== end - start) throw new TypeError('Incomplete serialized HarfBuzz glyphs');
        const batch: OutlineGlyph[] = [];
        for (const entry of value) {
            if (!entry || typeof entry !== 'object') throw new TypeError('Invalid serialized HarfBuzz glyph');
            const glyph = entry as Record<string, unknown>;
            if (!integer(glyph.g) || glyph.g <= 0 || !integer(glyph.ax) || !integer(glyph.ay)
                || !integer(glyph.dx) || !integer(glyph.dy)) throw new TypeError('Invalid serialized HarfBuzz position');
            batch.push({ id: glyph.g, xAdvance: glyph.ax, yAdvance: glyph.ay, xOffset: glyph.dx, yOffset: glyph.dy });
        }
        yield batch;
        await context.slice();
    }
}
