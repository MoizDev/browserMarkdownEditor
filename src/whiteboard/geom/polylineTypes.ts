import type { Affine, Rect } from '../../platform/types';
import type { PolylineNode } from '../model/nodes';
import type { PathOp } from './path';

export type PolylinePathBuilder = (node: Readonly<PolylineNode>) => readonly PathOp[];
export type PolylineWorldBounds = (node: Readonly<PolylineNode>, matrix: Affine) => Rect;
export interface PolylineGeometryOptions {
    readonly key: string;
    readonly kernelVersion: number;
    readonly lengthError: number;
    readonly maxPieces: number;
    readonly hitMarginCss: number;
    readonly hitErrorCss: number;
}
