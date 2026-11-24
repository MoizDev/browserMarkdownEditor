import type { Affine } from '../platform/types';
import type { BoardDoc } from './model/doc';
import type { RegionQuery, NarrowResult } from './geom/types';
import type { NarrowWork, SpatialRef } from './pick';
import type { SceneSpatial } from './scene/types';
import type { SelectionState } from './selection';

export interface SweepSelectionServices {
    readonly doc: BoardDoc;
    readonly selection: SelectionState;
    readonly scene: SceneSpatial;
    /** Presented page/world to surface CSS transform at this query's stamp. */
    readonly worldToSurface: Affine;
    readonly radiusCss: number;
    isCurrent(): boolean;
    /** Performs exact clipped per-kind swept coverage with slot/generation validation. */
    beginNarrow(ref: SpatialRef, query: RegionQuery): NarrowWork | null;
    partPriority(part: NarrowResult['part']): number;
}
