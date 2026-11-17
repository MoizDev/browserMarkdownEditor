import type { Rect } from '../../platform/types';
import type { RenderToken } from '../../platform/render/types';
import type { BoardDoc } from '../model/doc';
import type { RegionChanges } from '../scene/boundsVersions';
import type { NodeId } from '../model/ids';
import type { PaintNode } from './paintStream';
import type { SessionDenseRasters } from './sessionDenseRasters';

/** One sequential consumer borrows its pinned document until release physically completes.
 * The optional fields are the same frame identity `paintSource` forwards; a stream reports them
 * at the moment of publication, so a font epoch that moved mid-stream withdraws the raster variant. */
export interface ScenePaintNodeStream {
    readonly token: RenderToken;
    readonly theme: 'light' | 'dark';
    readonly sceneRevision: number;
    readonly sourceDoc: BoardDoc;
    readonly sensitiveNodes: ReadonlySet<NodeId>;
    readonly sessionRasters?: SessionDenseRasters;
    readonly rasterVariant?: string;
    readonly sourceWorld?: Readonly<Rect>;
    /** Where pixels changed since an earlier raster revision of this pinned scene; full when unknown. */
    readonly regionChangesSince?: (from: number) => RegionChanges;
    /** The node ids changed since an older revision of this pinned scene; absent or null means unknown. */
    readonly changedNodesSince?: (from: number) => ReadonlySet<string> | null;
    /** False only when provably no node of `nodes` paints inside `world`; unknown is true. */
    readonly sensitiveMayMeet?: (world: Readonly<Rect>, nodes: ReadonlySet<string>) => boolean;
    /** False only when provably no node of the pinned sheet paints inside `world`; unknown is true. */
    readonly mayPaint?: (world: Readonly<Rect>) => boolean;
    /** Bounds of every occupied node of the pinned sheet; absent when not conservatively known. */
    readonly occupiedRoot?: Readonly<Rect>;
    /** False once the pinned scene, document revision or the stream itself has been retired. */
    isCurrent(): boolean;
    next(): Promise<PaintNode | null>;
    release(): Promise<void>;
}
