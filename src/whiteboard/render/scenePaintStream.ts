import type { RenderToken } from '../../platform/render/types';
import type { BoardDoc } from '../model/doc';
import type { NodeId } from '../model/ids';
import type { PaintNode } from './paintStream';

/** One sequential consumer borrows its pinned document until release physically completes. */
export interface ScenePaintNodeStream {
    readonly token: RenderToken;
    readonly sceneRevision: number;
    readonly sourceDoc: BoardDoc;
    readonly sensitiveNodes: ReadonlySet<NodeId>;
    next(): Promise<PaintNode | null>;
    release(): Promise<void>;
}
