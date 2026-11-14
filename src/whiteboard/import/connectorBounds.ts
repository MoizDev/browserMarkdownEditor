import type { LegacyConnectorBoundsOptions } from './connectorBoundsTypes';
import type { LegacyGeometry } from './worldBounds';

// Unroutable received elbows remain read-only; never invent a straight route for page assignment.
export function legacyConnectorBounds(options: LegacyConnectorBoundsOptions): LegacyGeometry {
    return { worldBounds(node, transform) {
        if (node.kind !== 'connector') return options.fallback.worldBounds(node, transform);
        const label = options.label(node, transform);
        if (label === undefined) throw new Error(`Connector label layout is unavailable for ${node.id}`);
        const result = options.provider({ key: `legacy:${node.id}`, node, localToWorld: transform,
            resolveTarget: options.resolveTarget, label, toleranceWorld: options.toleranceWorld, maxPieces: options.maxPieces });
        if (result.status !== 'ready') {
            throw new Error(`Connector ${node.id} cannot be routed: ${result.reason}`);
        }
        const r = result.geometry.inkBoundsWorld;
        return [r.x, r.y, r.x + r.width, r.y + r.height];
    } };
}
