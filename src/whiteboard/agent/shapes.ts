import { styleGeometryMetrics } from '../geom/styleMetrics';
import { forEachNodeInZOrder, type BoardDoc, type Sheet } from '../model/doc';
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
    /** Closed drawings retain sheet labels without changing shape records. */
    readonly sections?: readonly { readonly offset: number; readonly name: string; readonly index: number }[];
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
    const selected = doc.sheets.get(sheet);
    if (!selected) throw new RangeError('Sheet does not exist');
    return listAcrossSheets(doc, [selected], geometry, query, false, doc.rev);
}

/** Saved drawings retain all sheet labels; a live view instead uses its current sheet. */
export function listAgentSheets(doc: BoardDoc, geometry: AgentGeometry, query: ShapeQuery = {}, diskRevision = doc.rev): ShapePage {
    return listAcrossSheets(doc, doc.sheetOrder, geometry, query, true, diskRevision);
}

function listAcrossSheets(doc: BoardDoc, sheets: readonly Sheet[], geometry: AgentGeometry, query: ShapeQuery,
    labelled: boolean, currentRevision: number): ShapePage {
    if (!Number.isSafeInteger(currentRevision) || currentRevision < 0) throw new RangeError('Invalid board revision');
    const { page, revision } = query;
    if (page !== undefined && (!Number.isSafeInteger(page) || page < 1)) throw new RangeError('Invalid page');
    const requestedOffset = query.offset ?? 0;
    const limit = query.limit ?? 200;
    if (!Number.isSafeInteger(requestedOffset) || requestedOffset < 0) throw new RangeError('Invalid offset');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new RangeError('Invalid limit');
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 0)) throw new RangeError('Invalid revision');
    const changed = revision !== undefined && revision !== currentRevision;
    const offset = changed ? 0 : requestedOffset;
    const shapes: ShapeSummary[] = [];
    const sections: Array<{ offset: number; name: string; index: number }> = [];
    let total = 0, chars = 0, budgetExhausted = false;
    for (const sheet of sheets) {
        let started = false;
        forEachNodeInZOrder(doc, sheet.id, node => {
            const nodePage = doc.kind === 'whiteboard' ? undefined : geometry.page(node);
            if (page !== undefined && nodePage !== page) return;
            if (total >= offset && shapes.length < limit && !budgetExhausted) {
                const summary = summarize(node, geometry, nodePage);
                const size = JSON.stringify(summary).length + 1;
                // Keep room for the envelope and tool text while never skipping an item.
                if (chars + size > 58_500) budgetExhausted = true;
                else {
                    if (labelled && !started) {
                        sections.push({ offset: total, name: sheet.name, index: doc.sheetOrder.indexOf(sheet) });
                        started = true;
                    }
                    shapes.push(summary); chars += size;
                }
            }
            total++;
        });
    }
    const nextOffset = offset + shapes.length;
    return {
        shapes, total, revision: currentRevision,
        ...(nextOffset < total ? { nextOffset } : {}),
        ...(changed ? { revisionChanged: true as const } : {}),
        ...(labelled ? { sections } : {}),
    };
}
