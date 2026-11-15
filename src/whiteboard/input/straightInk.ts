import { LocalCurveBuilder, materializeCurveRange, type CurvePublication } from '../ink/curve';
import type { SampleBuilder, SampleSequence } from '../ink/samples';

interface Endpoint { readonly x: number; readonly y: number; readonly pressure: number | undefined }

/** A Shift run is one replaceable real segment, not a polyline through all
 * pointer samples. The immutable prefix stays in the canonical curve builder. */
export class StraightInkBuilder {
    private pending: Endpoint | null = null;
    private hasAnchor = false;
    constructor(private readonly builder: LocalCurveBuilder) {}
    append(x: number, y: number, pressure: number | undefined, straight: boolean): void {
        if (!this.hasAnchor) {
            this.builder.append(x, y, pressure, 'freehand'); this.hasAnchor = true; return;
        }
        if (straight) { this.pending = Object.freeze({ x, y, pressure }); return; }
        this.flush(); this.builder.append(x, y, pressure, 'freehand');
    }
    /** A key-up without another pointer move still seals the last straight endpoint. */
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
        // A newly extended final span may alter the preceding freehand control;
        // keep the original builder's entire uncertified tail replaceable.
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
