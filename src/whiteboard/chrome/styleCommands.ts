import { isLocked } from '../change/commands';
import type { Op } from '../change/ops';
import { styleGeometryMetrics } from '../geom/styleMetrics';
import type { BoardDoc } from '../model/doc';
import type { NodeId } from '../model/ids';
import type { Node } from '../model/nodes';
import type { Dash, Fill, Font, HAlign, Size, Swatch, TextAlign, VAlign } from '../model/styles';
import type { BoardSession } from '../session/BoardSession';
import { clampPenScale } from './penWidth';

function selectedNodes(doc: BoardDoc, selected: readonly NodeId[]): Node[] {
    const stack = [...selected];
    const seen = new Set<NodeId>();
    const result: Node[] = [];
    while (stack.length) {
        const id = stack.pop()!;
        if (seen.has(id)) continue;
        seen.add(id);
        const node = doc.nodes.get(id);
        if (!node || isLocked(doc, node)) continue;
        if (node.kind === 'group') {
            for (const child of doc.children.get(node.id) ?? []) stack.push(child.id);
        } else result.push(node);
    }
    return result;
}

function apply(session: BoardSession, label: string, ops: readonly Op[], grouped = false): void {
    if (!ops.length || session.isReadOnly) return;
    const ownGroup = !grouped && ops.some(op => op.t === 'set');
    if (ownGroup) session.history.open(label);
    try {
        const receipt = session.apply({ origin: 'tool', label, ops });
        receipt.release();
    } finally {
        if (ownGroup) session.history.close();
    }
}

/** A slider drag opens one fresh history group; next-tool defaults remain history-silent. */
export class BoardStyleCommands {
    private widthGesture = false;
    private releaseGesture: (() => void) | null = null;
    constructor(private readonly session: BoardSession, private readonly selection: () => readonly NodeId[]) {}

    currentColor(): Swatch | null {
        const doc = this.session.doc;
        const colors = selectedNodes(doc, this.selection()).flatMap(node =>
            'color' in node && node.color !== null ? [node.color] : []);
        if (!colors.length) return doc.ui.tool === 'highlighter' ? doc.ui.next.highlighterColor : doc.ui.next.color;
        return colors.every(color => color === colors[0]) ? colors[0] : null;
    }

    currentWidthScale(): number | null {
        const doc = this.session.doc;
        const values = selectedNodes(doc, this.selection()).flatMap(node => {
            if (node.kind === 'text' || node.kind === 'sticky') return [node.scale];
            if (node.kind === 'stroke') return [styleGeometryMetrics.legacyEquivalent(
                node.tool === 'pen' ? 'stroke:pen' : 'stroke:highlighter', 's', node.width)];
            if (node.kind === 'figure' || node.kind === 'connector' || node.kind === 'polyline') {
                return [styleGeometryMetrics.legacyEquivalent(node.kind, node.size, node.width)];
            }
            return [];
        });
        if (!values.length) return styleGeometryMetrics.legacyEquivalent('stroke:pen', 's', doc.ui.penWidth);
        return values.every(value => Math.abs(value - values[0]) < 1e-9) ? values[0] : null;
    }

    sampleStyle(id: NodeId): void {
        this.endWidth();
        const doc = this.session.doc, node = doc.nodes.get(id);
        if (!node) return;
        const next = { ...doc.ui.next };
        if ('color' in node && node.color !== null) {
            if (node.kind === 'stroke' && node.tool === 'highlighter') next.highlighterColor = node.color;
            else next.color = node.color;
        }
        if ('fill' in node && node.kind !== 'stroke') next.fill = node.fill;
        if ('dash' in node) next.dash = node.dash;
        if ('size' in node) next.size = node.size;
        if ('font' in node) next.font = node.font;
        if (node.kind === 'text') next.textAlign = node.align;
        else if (node.kind === 'figure' || node.kind === 'sticky') next.align = node.align;
        if ('valign' in node) next.valign = node.valign;
        if (node.kind === 'connector') {
            next.headStart = node.headStart;
            next.headEnd = node.headEnd;
            next.route = node.route;
        }
        if (node.kind === 'polyline') next.spline = node.spline;
        if (Object.keys(next).some(key => next[key as keyof typeof next] !== doc.ui.next[key as keyof typeof next])) {
            apply(this.session, 'Sample style', [{ t: 'board', key: 'ui.next', value: next }]);
        }
    }

    setColor(color: Swatch): void {
        this.endWidth();
        const doc = this.session.doc, next = doc.ui.next;
        const key = doc.ui.tool === 'highlighter' ? 'highlighterColor' : 'color';
        const ops: Op[] = [];
        if (next[key] !== color) ops.push({ t: 'board', key: 'ui.next', value: { ...next, [key]: color } });
        for (const node of selectedNodes(doc, this.selection())) {
            if ('color' in node && node.color !== color) ops.push({ t: 'set', id: node.id, key: 'color', value: color });
        }
        apply(this.session, 'Change colour', ops);
    }

    setFill(fill: Fill): void {
        this.endWidth();
        const doc = this.session.doc, ops: Op[] = [];
        if (doc.ui.next.fill !== fill) ops.push({ t: 'board', key: 'ui.next', value: { ...doc.ui.next, fill } });
        for (const node of selectedNodes(doc, this.selection())) {
            if ((node.kind === 'figure' || node.kind === 'connector') && node.fill !== fill) {
                ops.push({ t: 'set', id: node.id, key: 'fill', value: fill });
            }
        }
        apply(this.session, 'Change fill', ops);
    }

    setDash(dash: Dash): void {
        this.endWidth();
        const doc = this.session.doc, ops: Op[] = [];
        if (doc.ui.next.dash !== dash) ops.push({ t: 'board', key: 'ui.next', value: { ...doc.ui.next, dash } });
        for (const node of selectedNodes(doc, this.selection())) {
            if ('dash' in node && node.dash !== dash) ops.push({ t: 'set', id: node.id, key: 'dash', value: dash });
        }
        apply(this.session, 'Change dash style', ops);
    }

    setFont(font: Font): void {
        this.endWidth();
        const doc = this.session.doc, ops: Op[] = [];
        if (doc.ui.next.font !== font) ops.push({ t: 'board', key: 'ui.next', value: { ...doc.ui.next, font } });
        for (const node of selectedNodes(doc, this.selection())) {
            if ('font' in node && node.font !== font) ops.push({ t: 'set', id: node.id, key: 'font', value: font });
        }
        apply(this.session, 'Change font', ops);
    }

    setAlignment(align: HAlign, textAlign: TextAlign): void {
        this.endWidth();
        const doc = this.session.doc, ops: Op[] = [];
        if (doc.ui.next.align !== align || doc.ui.next.textAlign !== textAlign) {
            ops.push({ t: 'board', key: 'ui.next', value: { ...doc.ui.next, align, textAlign } });
        }
        for (const node of selectedNodes(doc, this.selection())) {
            if (node.kind === 'text' && node.align !== textAlign) ops.push({ t: 'set', id: node.id, key: 'align', value: textAlign });
            else if ((node.kind === 'figure' || node.kind === 'sticky') && node.align !== align) {
                ops.push({ t: 'set', id: node.id, key: 'align', value: align });
            }
        }
        apply(this.session, 'Change alignment', ops);
    }

    setVerticalAlignment(valign: VAlign): void {
        this.endWidth();
        const doc = this.session.doc, ops: Op[] = [];
        if (doc.ui.next.valign !== valign) ops.push({ t: 'board', key: 'ui.next', value: { ...doc.ui.next, valign } });
        for (const node of selectedNodes(doc, this.selection())) {
            if ('valign' in node && node.valign !== valign) ops.push({ t: 'set', id: node.id, key: 'valign', value: valign });
        }
        apply(this.session, 'Change vertical alignment', ops);
    }

    setSize(size: Size): void {
        this.endWidth();
        const doc = this.session.doc, ops: Op[] = [];
        if (doc.ui.next.size !== size) ops.push({ t: 'board', key: 'ui.next', value: { ...doc.ui.next, size } });
        for (const node of selectedNodes(doc, this.selection())) {
            if (node.kind === 'stroke') {
                const width = styleGeometryMetrics.actualWidth(node.tool === 'pen' ? 'stroke:pen' : 'stroke:highlighter', size, 1);
                if (width !== node.width) {
                    ops.push({ t: 'set', id: node.id, key: 'width', value: width });
                    if (node.widthModel.id === 'pressure-linear-v1' && node.width > 0) {
                        const factor = width / node.width;
                        ops.push({ t: 'set', id: node.id, key: 'widthModel', value: {
                            id: 'pressure-linear-v1', rMin: node.widthModel.rMin * factor, rMax: node.widthModel.rMax * factor,
                        } });
                    }
                }
                continue;
            }
            if (!('size' in node) || node.size === size) continue;
            ops.push({ t: 'set', id: node.id, key: 'size', value: size });
            if (node.kind === 'figure' || node.kind === 'connector' || node.kind === 'polyline') {
                const scale = styleGeometryMetrics.legacyEquivalent(node.kind, node.size, node.width);
                ops.push({ t: 'set', id: node.id, key: 'width', value: styleGeometryMetrics.actualWidth(node.kind, size, scale) });
            }
        }
        apply(this.session, 'Change style size', ops);
    }

    beginWidth(): void {
        if (this.widthGesture || this.session.isReadOnly) return;
        const release = this.session.beginGesture();
        try { this.session.history.open('Change pen width'); }
        catch (error) { release(); throw error; }
        this.widthGesture = true;
        this.releaseGesture = release;
    }

    setWidth(scale: number): void {
        const doc = this.session.doc, value = clampPenScale(scale), ops: Op[] = [];
        const penWidth = styleGeometryMetrics.actualWidth('stroke:pen', 's', value);
        if (doc.ui.penWidth !== penWidth) ops.push({ t: 'board', key: 'ui.penWidth', value: penWidth });
        for (const node of selectedNodes(doc, this.selection())) {
            if (node.kind === 'text' || node.kind === 'sticky') {
                if (node.scale !== value) ops.push({ t: 'set', id: node.id, key: 'scale', value });
            } else if (node.kind === 'stroke') {
                const width = styleGeometryMetrics.actualWidth(node.tool === 'pen' ? 'stroke:pen' : 'stroke:highlighter', 's', value);
                if (node.width !== width) {
                    ops.push({ t: 'set', id: node.id, key: 'width', value: width });
                    if (node.widthModel.id === 'pressure-linear-v1' && node.width > 0) {
                        const factor = width / node.width;
                        ops.push({ t: 'set', id: node.id, key: 'widthModel', value: {
                            id: 'pressure-linear-v1', rMin: node.widthModel.rMin * factor, rMax: node.widthModel.rMax * factor,
                        } });
                    }
                }
            } else if (node.kind === 'figure' || node.kind === 'connector' || node.kind === 'polyline') {
                const width = styleGeometryMetrics.actualWidth(node.kind, node.size, value);
                if (node.width !== width) ops.push({ t: 'set', id: node.id, key: 'width', value: width });
            }
        }
        apply(this.session, 'Change pen width', ops, this.widthGesture);
    }

    endWidth(): void {
        if (!this.widthGesture) return;
        this.widthGesture = false;
        try { this.session.history.close(); }
        finally { this.releaseGesture?.(); this.releaseGesture = null; }
    }
}
