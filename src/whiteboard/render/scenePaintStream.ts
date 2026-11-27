import type { Rect } from '../../platform/types';
import type { RenderToken } from '../../platform/render/types';
import type { BoardDoc } from '../model/doc';
import type { RegionChanges } from '../scene/boundsVersions';
import type { NodeId } from '../model/ids';
import type { PaintNode } from './paintStream';
import type { SessionDenseRasters } from './sessionDenseRasters';

export interface ScenePaintNodeStream {
    readonly token: RenderToken;
    readonly theme: 'light' | 'dark';
    readonly sceneRevision: number;
    readonly sourceDoc: BoardDoc;
    readonly sensitiveNodes: ReadonlySet<NodeId>;
    readonly sessionRasters?: SessionDenseRasters;
    readonly rasterVariant?: string;
    readonly sourceWorld?: Readonly<Rect>;
    readonly regionChangesSince?: (from: number) => RegionChanges;
    readonly changedNodesSince?: (from: number) => ReadonlySet<string> | null;
    readonly sensitiveMayMeet?: (world: Readonly<Rect>, nodes: ReadonlySet<string>) => boolean;
    readonly mayPaint?: (world: Readonly<Rect>) => boolean;
    readonly occupiedRoot?: Readonly<Rect>;
    isCurrent(): boolean;
    next(): Promise<PaintNode | null>;
    release(): Promise<void>;
}
