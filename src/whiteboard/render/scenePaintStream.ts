import type { Rect } from '../../platform/types';
import type { RenderToken } from '../../platform/render/types';
import type { BoardDoc } from '../model/doc';
import type { NodeId } from '../model/ids';
import type { PaintNode } from './paintStream';
import type { SessionDenseRasters } from './sessionDenseRasters';

/** One sequential consumer borrows its pinned document until release physically completes.
 * The optional fields are the same frame identity `paintSource` forwards; a stream reports them
 * at the moment of publication, so a font epoch that moved mid-stream withdraws the raster variant. */
export interface ScenePaintNodeStream {
    readonly token: RenderToken;
    readonly sceneRevision: number;
    readonly sourceDoc: BoardDoc;
    readonly sensitiveNodes: ReadonlySet<NodeId>;
    readonly sessionRasters?: SessionDenseRasters;
    readonly rasterVariant?: string;
    readonly sourceWorld?: Readonly<Rect>;
    /** False once the pinned scene, document revision or the stream itself has been retired. */
    isCurrent(): boolean;
    next(): Promise<PaintNode | null>;
    release(): Promise<void>;
}
