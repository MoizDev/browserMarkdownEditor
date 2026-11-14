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
    readonly theme: 'light' | 'dark';
    readonly includeWet?: boolean;
    /** Frozen world-to-device scale; absent for non-raster callers without a capture scale. */
    readonly deviceScale?: number;
    readonly sensitiveNodes?: ReadonlySet<NodeId>;
    readonly allowInkLod?: boolean;
}

export interface ScenePaintBinding {
    readonly token: RenderToken;
    readonly preparePaint: (doc: BoardDoc, request: ScenePaintRequest, signal: AbortSignal, order?: PaintNodeOrder) => Promise<PaintNodeSource>;
    readonly retainRenderer?: () => { release(): void };
}

/** Pin is synchronous. Its canonical values/geometry/sample leases never follow later edits.
 * paintSource may await exact offscreen layout/media, but only for this captured revision.
 * isCurrent on the resulting source means "this lease remains valid", NOT live-doc equality.
 */
export interface SceneSnapshot {
    readonly token: RenderToken;
    readonly revision: number;
    readonly layout: Readonly<PageStack> | null;
    readonly nodeCount: number;
    /** Null means empty or not conservatively known; nodeCount distinguishes an empty pin. */
    readonly occupiedBounds: SceneOccupiedBounds | null;
    worldBounds(id: NodeId): SceneBounds | null;
    /** Pinned immutable row and metadata reads; neither scans the document. */
    readNodeNow(id: NodeId): Node | undefined;
    metadataNow(): SceneMetadata;
    /** Immutable read side owned by this pin; never a mutation authority. */
    readDocument(signal?: AbortSignal): Promise<BoardDoc>;
    paintSource(request: ScenePaintRequest, signal?: AbortSignal): Promise<PaintNodeSource>;
    release(): void | Promise<void>;
}
export interface SceneSpatial {
    readonly revision: number;
    readonly layout: Readonly<PageStack> | null;
    worldBounds(id: NodeId): SceneBounds | null;
    ensureExactBounds(id: NodeId, signal?: AbortSignal): Promise<SceneBounds | null>;
    query(options: SceneQueryOptions, output?: QueryBuffer, visitor?: NearestVisitor): SpatialQuery;
    /** Adapter for GE-3 pick: resume(deadline/maxVisits, visit(ref)), same generation guards. */
    spatialCursor(options: SceneQueryOptions): SpatialCursor;
    /** Future snapshots only; the host supplies an actual replacement-source binding. */
    setPaintBinding?(binding: ScenePaintBinding): void;
    /** Includes swept tests: pass the conservative swept world AABB, then exact narrow phase. */
    pin(): SceneSnapshot;
}
