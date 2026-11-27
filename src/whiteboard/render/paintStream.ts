import type { RegionChanges } from '../scene/boundsVersions';
import type { Affine, PathCommand, Rect } from '../../platform/types';
import type { RenderToken } from '../../platform/render/types';
import type { InkCoverage } from '../ink/outline';
import type { Blend } from './colour';
import type { InkMaterial, PaintBand, PathMaterial, TextMaterial } from './material';
import type { TextPaint, FaceTable } from '../text/paint';
import type { BoardDoc } from '../model/doc';
import type { SessionDenseRasters } from './sessionDenseRasters';
import type { ScenePaintNodeStream } from './scenePaintStream';
import type { ResolvedNodeCache } from './resolvedNodeCache';
import type { PictureTileCrop, PictureTileSource } from '../media/tilePlan';

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
    readonly localToWorld: Affine;
    readonly clips: readonly PaintClip[];
    readonly allocationBounds?: Readonly<Rect>;
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
export interface PaintPictureFacts {
    readonly media: PictureTileSource;
    readonly box: Readonly<{ w: number; h: number }>;
    readonly crop: PictureTileCrop | null;
    readonly level: number;
}
export interface PaintImageItem extends PaintBase {
    readonly kind: 'image';
    readonly imageKey: string;
    readonly retainedTile?: true;
    readonly underlaid?: true;
    readonly picture?: PaintPictureFacts;
    readonly rect: Readonly<Rect>;
    readonly sourceRect?: Readonly<Rect>;
    readonly opacity: number;
    readonly blend: Blend;
    readonly inverted: boolean;
}
export interface PaintTextItem extends PaintBase {
    readonly kind: 'text';
    readonly paint: TextPaint;
    readonly faces: FaceTable;
    readonly material: TextMaterial;
}
export type PaintItem = PaintPathItem | PaintInkItem | PaintImageItem | PaintTextItem;

export interface PaintNode {
    readonly allocationBounds?: Readonly<Rect>;
    readonly underlay?: readonly PaintItem[];
    readonly content: readonly PaintItem[];
}
export interface PaintNodeSource {
    readonly sourceDoc?: BoardDoc;
    readonly theme?: 'light' | 'dark';
    readonly sessionRasters?: SessionDenseRasters;
    readonly rasterVariant?: string;
    readonly sourceWorld?: Readonly<Rect>;
    readonly token: RenderToken;
    readonly sceneRevision: number;
    readonly sensitiveNodes?: ReadonlySet<string>;
    readonly nodeCount: number;
    readNode(index: number): PaintNode;
    isCurrent(): boolean;
}
import type { PaintWindow } from './paintWindows';

export interface PaintFrameRoot {
    readonly theme?: 'light' | 'dark';
    readonly sourceDoc?: BoardDoc;
    readonly sessionRasters?: SessionDenseRasters;
    readonly rasterVariant?: string;
    readonly sourceWorld?: Readonly<Rect>;
    readonly regionChangesSince?: (from: number) => RegionChanges;
    readonly changedNodesSince?: (from: number) => ReadonlySet<string> | null;
    readonly sensitiveMayMeet?: (world: Readonly<Rect>, nodes: ReadonlySet<string>) => boolean;
    readonly mayPaint?: (world: Readonly<Rect>) => boolean;
    readonly occupiedRoot?: Readonly<Rect>;
    readonly openTile?: (world: Readonly<Rect>, signal: AbortSignal, resolved?: ResolvedNodeCache | null) => Promise<ScenePaintNodeStream>;
    readonly token: RenderToken;
    readonly sceneRevision: number;
    readonly inkNodeIds: ReadonlySet<string>;
    readonly sensitiveNodes?: ReadonlySet<string>;
    readonly occludedInkNodeIds?: ReadonlySet<string>;
}
export interface PaintFrame extends PaintFrameRoot {
    readonly liveOnly?: undefined;
    readonly underlay: readonly PaintItem[];
    readonly content: readonly PaintItem[];
}
export interface LivePaintFrame extends PaintFrameRoot {
    readonly liveOnly: true;
    readonly windows: readonly PaintWindow[];
}
export type PaintSource = PaintFrame | LivePaintFrame;
export type PaintEmit = (item: PaintItem, band: PaintBand) => void;
export type PaintStreamStatus = 'pending' | 'complete' | 'stale' | 'cancelled';

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
