import type { Rect } from '../../platform/types';
import type { ChangeGeometry } from '../change/coordinates';
import type { NodeId } from '../model/ids';
import type { Align, Axis } from './arrange';

export type ArrangementAction =
    | Readonly<{ kind: 'align'; mode: Align }>
    | Readonly<{ kind: 'distribute' | 'stack'; axis: Axis }>
    | Readonly<{ kind: 'pack' }>;
export interface ArrangementServices {
    readonly geometry: ChangeGeometry;
    /** Current unclipped logical world bounds, including text-driven growth. */
    logicalBounds(id: NodeId): Readonly<Rect>;
    /** Stable selected-root ordering, not a spatial slot. */
    rank(id: NodeId): number;
}
