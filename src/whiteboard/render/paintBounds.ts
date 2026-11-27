import type { Affine, Rect } from '../../platform/types';
import type { PaintItem } from './paintStream';
import { inkCoverageChunks } from './paintStream';

function transform(box: Rect, m: Affine): Rect {
    const [a, b, c, d, e, f] = m;
    const x = e + a * box.x + c * box.y, y = f + b * box.x + d * box.y;
    const ax = a * box.width, ay = b * box.width, bx = c * box.height, by = d * box.height;
    return { x: x + Math.min(0, ax) + Math.min(0, bx), y: y + Math.min(0, ay) + Math.min(0, by),
        width: Math.abs(ax) + Math.abs(bx), height: Math.abs(ay) + Math.abs(by) };
}
export class PaintBoundsJob {
    private index = 0;
    private loX = Infinity;
    private loY = Infinity;
    private hiX = -Infinity;
    private hiY = -Infinity;
    private done = false;
    private value: Rect | null = null;
    constructor(private readonly item: PaintItem) {
        const bounds = item.allocationBounds;
        if (bounds) {
            if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width < 0 || bounds.height < 0) {
                throw new RangeError('Invalid canonical paint allocation envelope');
            }
            this.value = bounds; this.done = true;
        }
    }
    get result(): Rect | null { return this.value; }
    private point(x: number, y: number): void {
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new RangeError('Nonfinite realised paint bounds');
        this.loX = Math.min(this.loX, x); this.loY = Math.min(this.loY, y);
        this.hiX = Math.max(this.hiX, x); this.hiY = Math.max(this.hiY, y);
    }
    private box(x: number, y: number, w: number, h: number): void { this.point(x, y); this.point(x + w, y + h); }
    private finish(): void {
        this.done = true;
        if (this.loX === Infinity) return;
        const stroke = this.item.kind === 'path' ? this.item.material.stroke : undefined;
        const expansion = stroke ? stroke.width / 2 * Math.max(Math.SQRT2, stroke.miterLimit) : 0;
        this.value = transform({ x: this.loX - expansion, y: this.loY - expansion,
            width: this.hiX - this.loX + 2 * expansion, height: this.hiY - this.loY + 2 * expansion }, this.item.localToWorld);
        if (Object.values(this.value).some(x => !Number.isFinite(x))) throw new RangeError('Paint envelope overflows');
    }
    step(maxWork = 1): boolean {
        if (!Number.isSafeInteger(maxWork) || maxWork < 1) throw new RangeError('Invalid paint envelope work slice');
        for (let work = 0; work < maxWork && !this.done; work++) {
            const item = this.item;
            if (item.kind === 'path') {
                if (this.index === item.d.length) { this.finish(); continue; }
                const command = item.d[this.index++];
                for (let i = 1; i + 1 < command.length; i += 2) this.point(command[i] as number, command[i + 1] as number);
            } else if (item.kind === 'ink') {
                const chunks = inkCoverageChunks(item.coverage);
                if (this.index === chunks.length) { this.finish(); continue; }
                const box = chunks[this.index++].boundsLocal; this.box(box.x, box.y, box.w, box.h);
            } else {
                const box = item.kind === 'image' ? item.rect : item.paint.ink;
                this.box(box.x, box.y, box.width, box.height); this.finish();
            }
        }
        return this.done;
    }
}
