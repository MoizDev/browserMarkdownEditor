import type { ChangeGeometry } from '../change/coordinates';
import type { Op } from '../change/ops';
import type { BoardDoc } from '../model/doc';
import type { Node } from '../model/nodes';
import type { Vec2 } from './path';
import type { KindResizeContext } from './resizeKinds.types';
import type { ResizeTargetSnapshot } from './resizePlan.types';

export interface ResizePlacementServices {
    readonly doc: BoardDoc;
    readonly geometry: ChangeGeometry;
    readonly kinds: KindResizeContext;
    capture(node: Readonly<Node>): ResizeTargetSnapshot;
    projectedLocalCentre(snapshot: ResizeTargetSnapshot, ops: readonly Op[]): Vec2;
    isCurrent(): boolean;
}
