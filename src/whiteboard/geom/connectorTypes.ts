import type { Affine, Rect } from '../../platform/types';
import type { NodeId } from '../model/ids';
import type { ConnectorNode } from '../model/nodes';
import type { TextPaint } from '../text/paint';
import type { PathOp, Vec2 } from './path';

export interface AttachmentSurface {
    readonly target: NodeId;
    readonly outline: readonly PathOp[];
    readonly logicalBox: Rect;
    readonly localToWorld: Affine;
    readonly revision: number;
    readonly clips: readonly Readonly<{ outline: readonly PathOp[]; localToWorld: Affine }>[];
}
export interface ResolvedConnectorEnd {
    readonly aimWorld: Vec2;
    readonly boundaryWorld: Vec2;
    readonly tipWorld: Vec2;
    readonly tangentWorld: Vec2;
    readonly degenerate: boolean;
    readonly target: NodeId | null;
}
export interface ConnectorLabelPaint {
    readonly paint: TextPaint;
    readonly localToWorld: Affine;
}
export interface ConnectorGeometry {
    readonly key: string;
    readonly start: ResolvedConnectorEnd;
    readonly end: ResolvedConnectorEnd;
    /** Body and heads are in world coordinates; callers must not apply placement twice. */
    readonly body: readonly PathOp[];
    readonly heads: readonly (readonly PathOp[])[];
    readonly label: ConnectorLabelPaint | null;
    readonly bodyExclusions: readonly Readonly<{ outline: readonly PathOp[]; localToWorld: Affine }>[];
    readonly inkBoundsWorld: Rect;
}
export type ConnectorGeometryResult =
    | Readonly<{ status: 'ready'; geometry: ConnectorGeometry }>
    | Readonly<{ status: 'pending'; reason: 'target' | 'text' | 'budget' }>
    | Readonly<{ status: 'unroutable'; connector: NodeId; reason: string }>;
export interface ConnectorGeometryRequest {
    readonly key: string;
    readonly node: Readonly<ConnectorNode>;
    readonly localToWorld: Affine;
    readonly resolveTarget: (id: NodeId) => AttachmentSurface | undefined;
    readonly label: ConnectorLabelPaint | null;
    readonly toleranceWorld: number;
    readonly maxPieces: number;
}
export type ConnectorGeometryProvider = (request: ConnectorGeometryRequest) => ConnectorGeometryResult;
