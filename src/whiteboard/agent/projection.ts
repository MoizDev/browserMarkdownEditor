import { pageAt } from '../../platform/render/pageStack';
import { worldPose } from '../change/coordinates';
import type { BoardDoc } from '../model/doc';
import type { Node, Point } from '../model/nodes';
import { boardPageStack } from '../model/pages';
import type { AgentProjection, AgentProjectionSource, AgentWorldBox } from './projectionTypes';

export type { AgentProjection, AgentProjectionSource, AgentWorldBox } from './projectionTypes';

// WB-D11/C8: one projection boundary converts the shared world-space scene to
// the agent's page-relative rectangles, regardless of live or closed origin.
export function createAgentProjection(doc: BoardDoc, source: AgentProjectionSource): AgentProjection {
    const box = (node: Node): AgentWorldBox => {
        const value = source.worldBox(node);
        if (![value.x, value.y, value.w, value.h].every(Number.isFinite) || value.w < 0 || value.h < 0)
            throw new RangeError('Authoritative shape bounds are unavailable');
        return value;
    };
    const center = (node: Node): Point => {
        const b = box(node);
        return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    };
    const pageIndex = (node: Node): number | undefined => {
        if (doc.kind === 'whiteboard') return undefined;
        const stack = boardPageStack(doc.host);
        if (!stack?.rects.length) throw new RangeError('Page geometry is unavailable');
        return pageAt(stack, center(node).y);
    };
    return {
        geometry: {
            bounds(node) {
                const b = box(node), page = pageIndex(node);
                const origin = page === undefined ? undefined : boardPageStack(doc.host)?.rects[page];
                return { x: b.x - (origin?.x ?? 0), y: b.y - (origin?.y ?? 0), w: b.w, h: b.h };
            },
            page(node) { const page = pageIndex(node); return page === undefined ? undefined : page + 1; },
            rotation(node) {
                const degrees = worldPose(doc, node.id).rotation * 180 / Math.PI;
                return degrees > 180 ? degrees - 360 : degrees;
            },
        },
        changeGeometry: {
            worldBoundsCenter: (_doc, node) => center(node),
            resolvedTip: (current, connector, end) => source.resolvedTip(current, connector, end),
        },
        localBox: node => source.localBox(node),
        target(node, destinationPage) {
            const point = center(node);
            if (doc.kind === 'whiteboard') return point;
            const origin = boardPageStack(doc.host)?.rects[destinationPage];
            if (!origin) throw new RangeError('Destination page does not exist');
            return { x: point.x - origin.x, y: point.y - origin.y };
        },
    };
}
