import type { ChangeGeometry } from '../change/coordinates';
import type { BoardDoc } from '../model/doc';
import type { Node } from '../model/nodes';
import type { Vec2 } from './path';
import type { RotationTargetSnapshot } from './rotationPlan.types';

export interface RotationPlacementServices {
    readonly doc: BoardDoc;
    readonly geometry: ChangeGeometry;
    capture(node: Readonly<Node>): RotationTargetSnapshot;
    localCentre(snapshot: RotationTargetSnapshot): Vec2;
    isCurrent(): boolean;
}
