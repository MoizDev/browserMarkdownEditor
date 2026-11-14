import type { Jbig2ImageRegion, Jbig2SampleStatus, Jbig2SampleTile } from './jbig2.types';

const GRID = 32, MIN_COVERED = 256, ALGORITHM = 'jbig2-grid-v1';
const mix = (value: number) => {
    value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
    value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
    return (value ^ (value >>> 16)) >>> 0;
};

/** One exact document/page/variant/scale observation; never reuse after the
 * source generation, algorithm, visible pixels or render variant changes. */
export class Jbig2ImageSampler {
    readonly algorithm = ALGORITHM;
    private readonly covered = new Uint8Array(GRID * GRID);
    private readonly ink = new Uint8Array(GRID * GRID);
    constructor(readonly identity: string, readonly region: Jbig2ImageRegion, readonly scale: number) {
        if (!identity || identity.length > 2048 || !Number.isSafeInteger(region.id) || region.id < 0 ||
            !region.box.every(Number.isFinite) || region.box[2] <= region.box[0] || region.box[3] <= region.box[1] ||
            !Number.isFinite(scale) || scale <= 0) throw new RangeError('Invalid JBIG2 sample identity');
    }
    private point(index: number): readonly [number, number] {
        const [left, top, right, bottom] = this.region.box;
        const hash = mix((this.region.id ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0);
        const jx = ((hash & 255) / 255 - 0.5) * 0.4, jy = (((hash >>> 8) & 255) / 255 - 0.5) * 0.4;
        return [left + ((index % GRID) + 0.5 + jx) * (right - left) / GRID,
            top + (Math.floor(index / GRID) + 0.5 + jy) * (bottom - top) / GRID];
    }
    add(tile: Jbig2SampleTile): void {
        const { rect, w, h, pixels } = tile;
        if (tile.scale !== this.scale || ![rect.x, rect.y, rect.w, rect.h, w, h].every(Number.isSafeInteger) ||
            rect.w <= 0 || rect.h <= 0 || w !== rect.w + 2 || h !== rect.h + 2 ||
            !Number.isSafeInteger(w * h * 4) || !(pixels instanceof ArrayBuffer) || pixels.byteLength !== w * h * 4) throw new RangeError('Invalid JBIG2 sample tile');
        const [left, top, right, bottom] = this.region.box;
        if (right * this.scale <= rect.x || left * this.scale >= rect.x + rect.w ||
            bottom * this.scale <= rect.y || top * this.scale >= rect.y + rect.h) return;
        const rgba = new Uint8Array(pixels);
        for (let i = 0; i < GRID * GRID; i++) {
            const [x, y] = this.point(i), px = Math.floor(x * this.scale), py = Math.floor(y * this.scale);
            if (px < rect.x || px >= rect.x + rect.w || py < rect.y || py >= rect.y + rect.h) continue;
            const offset = ((py - rect.y + 1) * w + px - rect.x + 1) * 4, alpha = rgba[offset + 3];
            this.covered[i] = 1;
            const white = 255 * (255 - alpha), threshold = 245 * 255;
            this.ink[i] = rgba[offset] * alpha + white < threshold || rgba[offset + 1] * alpha + white < threshold ||
                rgba[offset + 2] * alpha + white < threshold ? 1 : 0;
        }
    }
    status(visible: readonly [number, number, number, number]): Jbig2SampleStatus {
        if (!visible.every(Number.isFinite) || visible[2] < visible[0] || visible[3] < visible[1]) throw new RangeError('Invalid visible PDF area');
        let relevant = 0, covered = 0, hasInk = false;
        for (let i = 0; i < GRID * GRID; i++) {
            const [x, y] = this.point(i);
            if (x < visible[0] || x >= visible[2] || y < visible[1] || y >= visible[3]) continue;
            relevant++;
            if (this.covered[i]) { covered++; hasInk ||= this.ink[i] !== 0; }
        }
        if (hasInk) return { state: 'clear', covered };
        if (covered < MIN_COVERED || covered !== relevant) return { state: 'pending', covered };
        return { state: 'suspect', covered };
    }
}
