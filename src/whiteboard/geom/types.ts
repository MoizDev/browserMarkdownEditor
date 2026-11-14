import type { Affine, Rect } from '../../platform/types';
import type { Node } from '../model/nodes';
import type { PathOp, Vec2 } from './path';

export type { Vec2, PathOp } from './path';
export type Sign = -1 | 0 | 1;
export type InputKind = 'mouse' | 'pen' | 'touch';
export interface PointQuery {
    readonly point: Vec2;
    readonly localToSurface: Affine;
    readonly input: InputKind;
}
export type RegionQuery =
    | Readonly<{ kind: 'polygon'; points: readonly Vec2[]; localToSurface: Affine; containment: boolean }>
    | Readonly<{ kind: 'swept'; points: readonly Vec2[]; radiusCss: number; localToSurface: Affine }>;
export interface NarrowResult {
    readonly hit: boolean;
    readonly distanceCss: number;
    readonly part: 'body' | 'label' | 'title' | 'head' | 'handle' | 'none';
}
// Provider-owned text, ink, attachment and realised-path descriptors are injected rather than
// recast as competing schemas while their owning lanes finish their public contracts.
export interface GeometryContext<TextProvider, InkProvider> {
    readonly session: number;
    readonly revision: number;
    readonly fontEpoch: number;
    readonly kernelVersion: number;
    readonly resolveNode: (id: string) => Readonly<Node> | undefined;
    readonly text: TextProvider;
    readonly ink: InkProvider;
}
export interface KindGeometry<RealisedPath, PositionedTextPaint, AttachmentSurface> {
    readonly key: string;
    readonly boxLocal: Rect;
    readonly inkBoundsLocal: Rect;
    readonly selectBoundsLocal: Rect;
    readonly paths: readonly RealisedPath[];
    readonly text: readonly PositionedTextPaint[];
    readonly attachments: AttachmentSurface | null;
    point(query: PointQuery): NarrowResult;
    region(query: RegionQuery): NarrowResult;
}
export type GeometryPath = readonly PathOp[];
