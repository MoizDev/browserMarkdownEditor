import { nextUp } from '../geom/numeric';

export const CURVE_CONTROL_REACH = 1 / 3;

export class CurveReach {
    minX = Infinity; minY = Infinity; maxX = -Infinity; maxY = -Infinity;
    private maxSpan = 0;
    private maxRounding = 0;
    private lastX = 0; private lastY = 0; private count = 0;
    add(x: number, y: number): void {
        if (this.count++) {
            const chord = Math.hypot(x - this.lastX, y - this.lastY), r = chord * CURVE_CONTROL_REACH;
            const reach = r + 4 * Number.EPSILON * (r + Math.abs(x) + Math.abs(y) + Math.abs(this.lastX) + Math.abs(this.lastY));
            this.maxSpan = Math.max(this.maxSpan, chord); this.maxRounding = Math.max(this.maxRounding, reach - r);
            this.grow(this.lastX, this.lastY, reach); this.grow(x, y, reach);
        } else this.grow(x, y, 0);
        this.lastX = x; this.lastY = y;
    }
    maxReach(slack = 0): number { return this.maxSpan * CURVE_CONTROL_REACH + this.maxRounding + slack; }
    clone(): CurveReach { return Object.assign(new CurveReach(), this); }
    box(slack = 0): readonly [number, number, number, number] {
        const x = this.minX - slack, y = this.minY - slack, w = this.maxX + slack - x, h = this.maxY + slack - y;
        return Object.freeze([x, y, w ? nextUp(w) : 0, h ? nextUp(h) : 0] as const);
    }
    private grow(x: number, y: number, reach: number): void {
        this.minX = Math.min(this.minX, x - reach); this.minY = Math.min(this.minY, y - reach);
        this.maxX = Math.max(this.maxX, x + reach); this.maxY = Math.max(this.maxY, y + reach);
    }
}
