import type { Affine } from '../../platform/types';
import type { AttachmentSurface, ConnectorGeometryProvider, ConnectorLabelPaint } from '../geom/connectorTypes';
import type { NodeId } from '../model/ids';
import type { ConnectorNode } from '../model/nodes';
import type { LegacyGeometry } from './worldBounds';

export interface LegacyConnectorBoundsOptions {
    readonly provider: ConnectorGeometryProvider;
    readonly resolveTarget: (id: NodeId) => AttachmentSurface | undefined;
    readonly label: (node: Readonly<ConnectorNode>, transform: Affine) => ConnectorLabelPaint | null | undefined;
    readonly toleranceWorld: number;
    readonly maxPieces: number;
    readonly fallback: LegacyGeometry;
}
