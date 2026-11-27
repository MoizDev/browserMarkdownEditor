import { LocalCurveBuilder, materializeCurveRange, type CurvePublication } from '../ink/curve';
import type { SampleBuilder, SampleSequence } from '../ink/samples';

interface Endpoint { readonly x: number; readonly y: number; readonly pressure: number | undefined }

const ANGLE_STEP = Math.PI / 12;
export function snapStraightEnd(anchor: { readonly x: number; readonly y: number }, end: { readonly x: number; readonly y: number }, enabled: boolean): { x: number; y: number } {
    const dx = end.x - anchor.x, dy = end.y - anchor.y, length = Math.hypot(dx, dy);
    if (!enabled || !(length > 0)) return { x: end.x, y: end.y };
    const angle = Math.round(Math.atan2(dy, dx) / ANGLE_STEP) * ANGLE_STEP;
    return { x: anchor.x + Math.cos(angle) * length, y: anchor.y + Math.sin(angle) * length };
}

export class StraightInkBuilder {
    private pending: Endpoint | null = null;
    private hasAnchor = false;
    private anchorX = 0;
    private anchorY = 0;
    constructor(private readonly builder: LocalCurveBuilder) {}
    append(x: number, y: number, pressure: number | undefined, straight: boolean, snapAngle = false): void {
        if (!this.hasAnchor) {
            this.builder.append(x, y, pressure, 'freehand'); this.hasAnchor = true; this.anchorX = x; this.anchorY = y; return;
        }
        if (straight) {
            const end = snapStraightEnd({ x: this.anchorX, y: this.anchorY }, { x, y }, snapAngle);
            this.pending = Object.freeze({ x: end.x, y: end.y, pressure }); return;
        }
        this.flush(); this.builder.append(x, y, pressure, 'freehand'); this.anchorX = x; this.anchorY = y;
    }
    flush(): boolean {
        const endpoint = this.pending;
        if (!endpoint) return false;
        this.builder.append(endpoint.x, endpoint.y, endpoint.pressure, 'straight');
        this.pending = null;
        return true;
    }
    publish(): CurvePublication {
        const endpoint = this.pending, base = this.builder.publish();
        if (!endpoint) return base;
        const prefix = base.samples, count = prefix.count + 1;
        const samples: SampleSequence = Object.freeze({
            count,
            x: (i: number) => i === count - 1 ? endpoint.x : prefix.x(i),
            y: (i: number) => i === count - 1 ? endpoint.y : prefix.y(i),
            pressure: (i: number) => i === count - 1 ? endpoint.pressure : prefix.pressure(i),
            segmentKind: (i: number) => i === count - 2 ? 'straight' as const : prefix.segmentKind(i),
        });
        const finalizedSpanCount = Math.min(base.finalizedSpanCount, Math.max(0, count - 4));
        return Object.freeze({ ...base, samples, finalizedSpanCount,
            replaceableTail: materializeCurveRange(samples, { firstSpan: finalizedSpanCount,
                spanCount: count - 1 - finalizedSpanCount }, base.parameters),
            endpointX: endpoint.x, endpointY: endpoint.y });
    }
    finish(): Readonly<{ samples: SampleBuilder; publication: CurvePublication }> {
        this.flush(); return this.builder.finish();
    }
}
