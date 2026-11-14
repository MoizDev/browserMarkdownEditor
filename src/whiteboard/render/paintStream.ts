import type { Affine, PathCommand, Rect } from '../../platform/types';
import type { RenderToken } from '../../platform/render/types';
import type { InkCoverage } from '../ink/outline';
import type { Blend } from './colour';
import type { InkMaterial, PaintBand, PathMaterial, TextMaterial } from './material';
import type { TextPaint, FaceTable } from '../text/paint';

export type FillRule = 'nonzero' | 'evenodd';
export interface PaintClip {
    readonly key: string;
    readonly d: readonly PathCommand[];
    readonly fillRule: FillRule;
    readonly localToWorld: Affine;
}
export interface PaintBase {
    readonly key: string;
    readonly nodeId: string;
    readonly geometryKey: string;
    // Absolute Float64 affine: includes page/ancestor placement ONCE. Ink point-factor resize
    // has already happened in coverage; this transform must not rescale its circular radii.
    // A backend's rebased path composes Translate(path.origin) AFTER this affine, exactly once.
    readonly localToWorld: Affine;
    readonly clips: readonly PaintClip[]; // Root-to-leaf intersection, each in its OWN transform.
}
export interface PaintPathItem extends PaintBase {
    readonly kind: 'path';
    readonly d: readonly PathCommand[];
    readonly fillRule: FillRule;
    readonly material: PathMaterial;
}
export type PaintInkCoverage = InkCoverage | readonly InkCoverage[];
export function inkCoverageChunks(coverage: PaintInkCoverage): readonly InkCoverage[] {
    return Array.isArray(coverage) ? coverage : [coverage as InkCoverage];
}
export interface PaintInkItem extends PaintBase {
    readonly kind: 'ink';
    readonly coverage: PaintInkCoverage;
    readonly material: InkMaterial;
}
export interface PaintImageItem extends PaintBase {
    readonly kind: 'image';
    readonly imageKey: string; // Hash/frame revision key; preparation acquires its decoded lease.
    readonly rect: Readonly<Rect>;
    readonly sourceRect?: Readonly<Rect>; // Crop in SOURCE IMAGE PIXELS, not normalised UV.
    readonly opacity: number; // Final inherited alpha, once; source pixels retain their alpha.
    readonly blend: Blend;
    readonly inverted: boolean; // Content invert+hue-rotate180; page inversion is OUTSIDE stream.
}
export interface PaintTextItem extends PaintBase {
    readonly kind: 'text';
    readonly paint: TextPaint;
    readonly faces: FaceTable;
    readonly material: TextMaterial;
}
export type PaintItem = PaintPathItem | PaintInkItem | PaintImageItem | PaintTextItem;

// Already-resolved geometry/materials, reusable by screen and export. Ordinary groups flatten
// into inherited transforms/clips/colour alpha, never an isolated group-opacity operation.
// Effect-only rasters occupy their actual position in content, not a separate topmost pass.
export interface PaintNode {
    readonly underlay?: readonly PaintItem[];
    readonly content: readonly PaintItem[];
}
export interface PaintNodeSource {
    readonly token: RenderToken;
    readonly sceneRevision: number;
    readonly nodeCount: number;
    readNode(index: number): PaintNode;
    isCurrent(): boolean;
}
export interface PaintFrame {
    readonly token: RenderToken;
    readonly sceneRevision: number;
    readonly underlay: readonly PaintItem[];
    readonly content: readonly PaintItem[];
}
export type PaintEmit = (item: PaintItem, band: PaintBand) => void;
export type PaintStreamStatus = 'pending' | 'complete' | 'stale' | 'cancelled';

// Source owns/pins immutable arrays and image/geometry leases until its completed frame retires.
// readNode is O(1), synchronous and side-effect free; it does NOT walk the model or create layout.
// No global command-count cap and no forced document-sized result array. Callers can stream
// ordered bounded chunks. A partial stream is never a publishable replacement/capture.
export class PaintStreamJob {
    private source: PaintNodeSource | undefined;
    private emit: PaintEmit | undefined;
    private state: PaintStreamStatus | 'failed' = 'pending';
    private failure: unknown;
    private band: PaintBand = 'underlay';
    private node = 0;
    private item = 0;
    private items: readonly PaintItem[] | undefined;
    private stepping = false;
    constructor(source: PaintNodeSource, emit: PaintEmit) {
        if (!Number.isSafeInteger(source.nodeCount) || source.nodeCount < 0) throw new RangeError('Invalid paint node count');
        this.source = source; this.emit = emit;
    }
    cancel(): void { if (this.state === 'pending') this.finish('cancelled'); }
    private get cancelled(): boolean { return this.state === 'cancelled'; }
    private finish(state: PaintStreamStatus): PaintStreamStatus {
        this.state = state; this.source = undefined; this.emit = undefined; this.items = undefined;
        return state;
    }
    step(maxWork: number): PaintStreamStatus {
        if (this.state === 'failed') throw this.failure;
        if (this.state !== 'pending') return this.state;
        if (!Number.isSafeInteger(maxWork) || maxWork <= 0) throw new RangeError('Invalid paint stream work slice');
        if (this.stepping) throw new Error('Paint stream step is not reentrant');
        this.stepping = true;
        try {
            for (let work = 0; work < maxWork; work++) {
                if (!this.source!.isCurrent()) return this.finish('stale');
                if (this.items && this.item < this.items.length) {
                    this.emit!(this.items[this.item++], this.band);
                    if (this.cancelled) return 'cancelled';
                    if (!this.source!.isCurrent()) return this.finish('stale');
                } else if (this.node < this.source!.nodeCount) {
                    const node = this.source!.readNode(this.node++);
                    this.items = this.band === 'underlay' ? node.underlay : node.content;
                    this.item = 0;
                } else if (this.band === 'underlay') {
                    this.band = 'content'; this.node = 0; this.items = undefined;
                } else return this.finish('complete');
            }
            return 'pending';
        } catch (error) {
            this.failure = error; this.finish('cancelled'); this.state = 'failed';
            throw error;
        } finally { this.stepping = false; }
    }
}
