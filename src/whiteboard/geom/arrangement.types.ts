import type { Rect } from '../../platform/types';
import type { ChangeGeometry } from '../change/coordinates';
import type { NodeId } from '../model/ids';
import type { Align, Axis } from './arrange';
import type { ResizePlanServices } from './resizePlan.types';

export type ArrangementAction =
    | Readonly<{ kind: 'align'; mode: Align }>
    | Readonly<{ kind: 'distribute' | 'stack'; axis: Axis }>
    | Readonly<{ kind: 'pack' }>;
export interface StretchServices extends ArrangementServices { readonly resize: Extract<ResizePlanServices, { readonly kinds: unknown }> }
export interface ArrangementServices {
    readonly geometry: ChangeGeometry;
    logicalBounds(id: NodeId): Readonly<Rect>;
    rank(id: NodeId): number;
}
