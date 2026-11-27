import type { Face } from './paint';

export interface ReferenceMetrics {
    readonly width: number;
    readonly left: number;
    readonly right: number;
    readonly ascent: number;
    readonly descent: number;
}
type MeasureContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
interface Entry { readonly value: ReferenceMetrics; readonly bytes: number }
const MAX_CACHE_TEXT = 4096;
const DEFAULT_CACHE_BYTES = 8 * 1024 * 1024;

export class ReferenceMeasurer {
    private readonly entries = new Map<string, Entry>();
    private epoch = -1;
    private bytes = 0;
    constructor(private readonly context: MeasureContext, private readonly capacity = 20000, private readonly maxBytes = DEFAULT_CACHE_BYTES) {}
    measure(face: Face, text: string, rtl: boolean, fontEpoch: number): ReferenceMetrics {
        if (fontEpoch !== this.epoch) { this.clear(); this.epoch = fontEpoch; }
        // Prefix geometry of a long line otherwise retained gigabytes of distinct, growing keys.
        const key = this.capacity > 0 && this.maxBytes > 0 && text.length <= MAX_CACHE_TEXT ? JSON.stringify([face.css, rtl, text]) : null;
        const cached = key === null ? undefined : this.entries.get(key);
        if (cached && key !== null) {
            this.entries.delete(key);
            this.entries.set(key, cached);
            return cached.value;
        }
        const ctx = this.context;
        ctx.font = face.css;
        ctx.direction = rtl ? 'rtl' : 'ltr';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fontKerning = 'normal';
        ctx.textRendering = 'geometricPrecision';
        ctx.letterSpacing = '0px';
        ctx.wordSpacing = '0px';
        ctx.fontVariantCaps = 'normal';
        const measured = ctx.measureText(text);
        const result: ReferenceMetrics = {
            width: measured.width,
            left: measured.actualBoundingBoxLeft,
            right: measured.actualBoundingBoxRight,
            ascent: measured.actualBoundingBoxAscent,
            descent: measured.actualBoundingBoxDescent,
        };
        if (key !== null) {
            const bytes = key.length * 2 + 160;
            if (bytes <= this.maxBytes) {
                while (this.entries.size && (this.entries.size >= this.capacity || this.bytes + bytes > this.maxBytes)) {
                    const oldest = this.entries.keys().next().value!;
                    const entry = this.entries.get(oldest)!;
                    this.entries.delete(oldest); this.bytes -= entry.bytes;
                }
                this.entries.set(key, { value: result, bytes }); this.bytes += bytes;
            }
        }
        return result;
    }
    clear(): void { this.entries.clear(); this.bytes = 0; }
}
