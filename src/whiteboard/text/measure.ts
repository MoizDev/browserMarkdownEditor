import type { Face } from './paint';

export interface ReferenceMetrics {
    /** All values are measured at the fixed 64px reference size. */
    readonly width: number;
    readonly left: number;
    readonly right: number;
    readonly ascent: number;
    readonly descent: number;
}
type MeasureContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Per-context bounded cache: font arrival invalidates widths measured in a fallback face. */
export class ReferenceMeasurer {
    private readonly entries = new Map<string, ReferenceMetrics>();
    private epoch = -1;
    constructor(private readonly context: MeasureContext, private readonly capacity = 20000) {}
    measure(face: Face, text: string, rtl: boolean, fontEpoch: number): ReferenceMetrics {
        if (fontEpoch !== this.epoch) { this.entries.clear(); this.epoch = fontEpoch; }
        const key = JSON.stringify([face.css, rtl, text]);
        const cached = this.entries.get(key);
        if (cached) {
            this.entries.delete(key);
            this.entries.set(key, cached);
            return cached;
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
        if (this.capacity > 0) {
            this.entries.set(key, result);
            if (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
        }
        return result;
    }
    clear(): void { this.entries.clear(); }
}
