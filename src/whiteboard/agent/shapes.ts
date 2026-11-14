import { styleGeometryMetrics } from '../geom/styleMetrics';
import { forEachNodeInZOrder, type BoardDoc } from '../model/doc';
import { SIZES } from '../model/styles';
import type { SheetId } from '../model/ids';
import type { Node } from '../model/nodes';
import type { RichText } from '../text/richText';

// F-AGENT-001, C8: geometry is supplied by the same view-independent projection
// used for closed files; this layer must not estimate text, groups or ink bounds.
export interface AgentGeometry {
    bounds(node: Node): { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
    page(node: Node): number | undefined;
    rotation(node: Node): number;
}
export interface ShapeSummary {
    id: string;
    type: string;
    x: number;
    y: number;
    w: number;
    h: number;
    page?: number;
    rotation?: number;
    geo?: string;
    text?: string;
    color?: string;
    fill?: string;
    dash?: string;
    size?: string;
    startShapeId?: string;
    endShapeId?: string;
}
export interface ShapePage {
    readonly shapes: ShapeSummary[];
    readonly total: number;
    readonly revision: number;
    readonly nextOffset?: number;
    readonly revisionChanged?: true;
}
export interface ShapeQuery {
    readonly page?: number;
    readonly offset?: number;
    readonly limit?: number;
    readonly revision?: number;
}

function plainText(text: RichText): string {
    const value = text.blocks.map(block => block.runs.map(run => run.text).join('')).join('\n');
    return value.length > 2000 ? `${value.slice(0, 2000)}…` : value;
}

function summarize(node: Node, geometry: AgentGeometry, page: number | undefined): ShapeSummary {
    const bounds = geometry.bounds(node);
    const type = node.kind === 'figure' ? 'geo' : node.kind === 'sticky' ? 'note'
        : node.kind === 'connector' ? 'arrow' : node.kind === 'polyline' ? 'line'
            : node.kind === 'stroke' ? 'draw' : node.kind === 'picture' ? 'image' : node.kind;
    const result: ShapeSummary = { id: node.id, type, ...bounds };
    if (page !== undefined) result.page = page;
    const rotation = geometry.rotation(node);
    if (rotation !== 0) result.rotation = rotation;
    if ('color' in node && node.color !== null) result.color = node.color;
    if ('fill' in node) result.fill = node.fill;
    if ('dash' in node) result.dash = node.dash;
    if ('size' in node) result.size = node.size;
    if (node.kind === 'stroke') {
        const kind = node.tool === 'pen' ? 'stroke:pen' : 'stroke:highlighter';
        result.size = SIZES.reduce((best, size) =>
            Math.abs(styleGeometryMetrics.actualWidth(kind, size, 1) - node.width)
                < Math.abs(styleGeometryMetrics.actualWidth(kind, best, 1) - node.width) ? size : best);
    }
    if (node.kind === 'figure') result.geo = node.shape;
    if (node.kind === 'text' || node.kind === 'sticky') result.text = plainText(node.text);
    if ((node.kind === 'figure' || node.kind === 'connector') && node.label) result.text = plainText(node.label);
    if (node.kind === 'connector') {
        if (node.start.attach) result.startShapeId = node.start.attach.target;
        if (node.end.attach) result.endShapeId = node.end.attach.target;
    }
    return result;
}

// WB-D12: stable paint order and a revision fence allow every item to be reached.
export function listAgentShapes(doc: BoardDoc, sheet: SheetId, geometry: AgentGeometry, query: ShapeQuery = {}): ShapePage {
    const { page, revision } = query;
    if (page !== undefined && (!Number.isSafeInteger(page) || page < 1)) throw new RangeError('Invalid page');
    const requestedOffset = query.offset ?? 0;
    const limit = query.limit ?? 200;
    if (!Number.isSafeInteger(requestedOffset) || requestedOffset < 0) throw new RangeError('Invalid offset');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new RangeError('Invalid limit');
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 0)) throw new RangeError('Invalid revision');
    const changed = revision !== undefined && revision !== doc.rev;
    const offset = changed ? 0 : requestedOffset;
    const shapes: ShapeSummary[] = [];
    let total = 0, chars = 0, budgetExhausted = false;
    forEachNodeInZOrder(doc, sheet, node => {
        const nodePage = doc.kind === 'whiteboard' ? undefined : geometry.page(node);
        if (page !== undefined && nodePage !== page) return;
        if (total >= offset && shapes.length < limit && !budgetExhausted) {
            const summary = summarize(node, geometry, nodePage);
            const size = JSON.stringify(summary).length + 1;
            // Keep room for the envelope and tool text while never skipping an item.
            if (chars + size > 58_500) budgetExhausted = true;
            else { shapes.push(summary); chars += size; }
        }
        total++;
    });
    const nextOffset = offset + shapes.length;
    return {
        shapes, total, revision: doc.rev,
        ...(nextOffset < total ? { nextOffset } : {}),
        ...(changed ? { revisionChanged: true as const } : {}),
    };
}
