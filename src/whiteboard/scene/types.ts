import type { Rect } from '../../platform/types';
import type { PageStack } from '../../platform/render/pageStack';
import type { RenderToken } from '../../platform/render/types';
import type { NodeId, SheetId } from '../model/ids';
import type { BoardDoc } from '../model/doc';
import type { Node } from '../model/nodes';
import type { SceneMetadata } from './snapshotDoc';
import type { SpatialCursor } from '../pick';
import type { PaintNodeSource } from '../render/paintStream';
import type { PaintNodeOrder } from '../render/paintOrder';
import type { ScenePaintNodeStream } from '../render/scenePaintStream';
import type { ResolvedNodeCache } from '../render/resolvedNodeCache';
import type { BoundsQuality, Box } from './bounds';
import type { NearestVisitor, QueryBuffer, QueryRequest, SpatialQuery } from './query';

export interface SceneOccupiedBounds {
    readonly revision: number;
    readonly bounds: Box;
}
export interface SceneBounds {
    readonly revision: number;
    readonly quality: BoundsQuality;
    readonly ink: Box | null;
    readonly selectable: Box | null;
}
export interface SceneQueryOptions {
    readonly sheetId: SheetId;
    readonly request: QueryRequest;
    readonly purpose: 'ink' | 'selectable';
    readonly includeLocked?: boolean;
}
export interface ScenePaintRequest {
    readonly sheetId: SheetId;
    readonly page?: number;
    readonly world?: Readonly<Rect>;
    readonly viewWorld?: Readonly<Rect>;
    readonly theme: 'light' | 'dark';
    readonly includeWet?: boolean;
    readonly deviceScale?: number;
    readonly exactScale?: number;
    readonly sensitiveNodes?: ReadonlySet<NodeId>;
    readonly allowInkLod?: boolean;
    readonly scenePrecision?: boolean;
    readonly previousDeviceScale?: number;
    readonly only?: ReadonlySet<NodeId>;
}

export interface ScenePaintBinding {
    readonly token: RenderToken;
    readonly preparePaint: (doc: BoardDoc, request: ScenePaintRequest, signal: AbortSignal, order?: PaintNodeOrder) => Promise<PaintNodeSource>;
    readonly preparePaintStream?: (doc: BoardDoc, request: ScenePaintRequest, signal: AbortSignal, order?: PaintNodeOrder, resolved?: ResolvedNodeCache | null) => ScenePaintNodeStream;
    readonly retainRenderer?: () => { release(): void };
}

export interface SceneSnapshot {
    isCurrent(): boolean;
    readonly token: RenderToken;
    readonly revision: number;
    readonly layout: Readonly<PageStack> | null;
    readonly nodeCount: number;
    readonly occupiedBounds: SceneOccupiedBounds | null;
    worldBounds(id: NodeId): SceneBounds | null;
    readNodeNow(id: NodeId): Node | undefined;
    metadataNow(): SceneMetadata;
    readDocument(signal?: AbortSignal): Promise<BoardDoc>;
    paintSource(request: ScenePaintRequest, signal?: AbortSignal): Promise<PaintNodeSource>;
    paintStream?(request: ScenePaintRequest, signal?: AbortSignal, resolved?: ResolvedNodeCache | null): Promise<ScenePaintNodeStream>;
    countCandidates?(sheetId: SheetId, world: Readonly<Rect>): number | null;
    release(): void | Promise<void>;
}
export interface SceneSpatial {
    readonly revision: number;
    readonly layout: Readonly<PageStack> | null;
    worldBounds(id: NodeId): SceneBounds | null;
    ensureExactBounds(id: NodeId, signal?: AbortSignal): Promise<SceneBounds | null>;
    ensureExactBoundsMany(ids: readonly NodeId[], signal?: AbortSignal): Promise<ReadonlyMap<NodeId, SceneBounds | null>>;
    query(options: SceneQueryOptions, output?: QueryBuffer, visitor?: NearestVisitor): SpatialQuery;
    spatialCursor(options: SceneQueryOptions): SpatialCursor;
    setPaintBinding?(binding: ScenePaintBinding): void;
    pin(): SceneSnapshot;
}
