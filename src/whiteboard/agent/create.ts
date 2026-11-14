import type { CanvasOp } from '../../../shared/vaultAgentProtocol';
import type { TxBuilder } from '../change/ops';
import { childrenOf, type BoardDoc } from '../model/doc';
import { newNodeId, type SheetId } from '../model/ids';
import { createFigure, createPolyline, createSticky, createText, type Node, type Point } from '../model/nodes';
import { keyBetween } from '../model/orderKey';
import { boardPageStack } from '../model/pages';
import type { RichText } from '../text/richText';
import { AgentOpRefused } from './errors';

export type SimpleCreate = Extract<CanvasOp, { op: 'create'; type: 'text' | 'note' | 'geo' | 'line' }>;
export interface CreateContext {
    readonly doc: BoardDoc;
    readonly sheet: SheetId;
    /** Zero-based physical page; ignored on an unpaged board. */
    readonly currentPage: number;
    readonly builder: TxBuilder;
}
export interface CreatedShape { readonly id: Node['id']; readonly notes: readonly string[] }

export function plainRichText(text: string): RichText {
    return { blocks: text.split('\n').map(line => ({ kind: 'p', level: 0, dir: 'auto', runs: [{ text: line, marks: {} }] })) };
}

// F-AGENT-013: growth is staged in the same savepoint as its shape. The caller
// validates the whole operation before this function can change the paper.
export function createPage(context: CreateContext, requested: number | undefined): { page: number; clamp(point: Point): Point; notes: string[] } {
    const { doc, builder } = context;
    const notes: string[] = [];
    if (doc.kind === 'whiteboard') return { page: -1, clamp: point => point, notes };
    const page = requested === undefined ? context.currentPage : requested - 1;
    if (!Number.isSafeInteger(page) || page < 0) throw new AgentOpRefused('invalid page');
    if (doc.host.kind === 'notebook' && page >= doc.host.paper.pageCount) {
        if (page >= 500 || page + 1 > doc.host.paper.pageCount + 5) throw new AgentOpRefused('page exceeds notebook growth limit');
        builder.push({ t: 'board', key: 'host.paper', value: { ...doc.host.paper, pageCount: page + 1 } });
    }
    const rect = boardPageStack(doc.host)?.rects[page];
    if (!rect) throw new AgentOpRefused('page does not exist');
    return { page, notes, clamp(point) {
        const x = Math.max(0, Math.min(rect.width, point.x));
        const y = Math.max(0, Math.min(rect.height, point.y));
        if (x !== point.x || y !== point.y) notes.push('position clamped to page');
        return { x, y };
    } };
}

export function stageSimpleCreate(op: SimpleCreate, context: CreateContext): CreatedShape {
    const { doc, sheet, builder } = context;
    if (!doc.sheets.has(sheet)) throw new AgentOpRefused('sheet no longer exists');
    const target = createPage(context, op.page);
    const id = newNodeId(doc);
    const siblings = childrenOf(doc, sheet);
    const base = { id, parent: sheet, order: keyBetween(siblings.at(-1)?.order ?? null, null), page: target.page, ext: null };
    let node: Node;
    switch (op.type) {
        case 'text': {
            const point = target.clamp(op);
            node = createText({ ...base, ...point, text: plainRichText(op.text), color: op.color ?? 'black',
                size: op.size ?? 'm', font: 'draw', align: op.align ?? 'start',
                autoSize: op.w === undefined, w: op.w ?? 200, scale: 1 });
            break;
        }
        case 'note': {
            const point = target.clamp(op);
            node = createSticky({ ...base, ...point, text: plainRichText(op.text), color: op.color ?? 'yellow',
                labelColor: 'black', size: op.size ?? 'm', font: 'draw', align: 'middle', valign: 'middle',
                growY: 0, fit: null, scale: 1, url: null });
            break;
        }
        case 'geo': {
            const point = target.clamp(op);
            const rotation = ((((op.rotation ?? 0) % 360) + 360) % 360) * Math.PI / 180;
            node = createFigure({ ...base, ...point, rotation, shape: op.geo, w: op.w, h: op.h, growY: 0,
                color: op.color ?? 'black', labelColor: 'black', fill: op.fill ?? 'none', dash: op.dash ?? 'solid',
                size: op.size ?? 'm', font: 'draw', align: 'middle', valign: 'middle',
                label: op.text ? plainRichText(op.text) : null, width: 1, flipX: false, flipY: false, url: null });
            break;
        }
        case 'line': {
            const points = op.points.map(p => target.clamp({ x: p[0], y: p[1] }));
            const origin = points[0];
            node = createPolyline({ ...base, ...origin, points: points.map(p => ({ x: p.x - origin.x, y: p.y - origin.y })),
                spline: 'line', color: op.color ?? 'black', dash: op.dash ?? 'solid', size: op.size ?? 'm', width: 1 });
        }
    }
    builder.push({ t: 'create', node });
    return { id, notes: target.notes };
}
