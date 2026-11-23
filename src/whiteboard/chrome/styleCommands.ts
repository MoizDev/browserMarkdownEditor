import { isLocked } from '../change/commands';
import type { Op } from '../change/ops';
import { styleGeometryMetrics } from '../geom/styleMetrics';
import type { FigureNode } from '../model/nodes';
import type { BoardDoc } from '../model/doc';
import type { NodeId } from '../model/ids';
import type { Node } from '../model/nodes';
import type { Arrowhead, Dash, Fill, FigureShape, Font, HAlign, Size, Swatch, TextAlign, VAlign } from '../model/styles';
import type { BoardSession } from '../session/BoardSession';
import { clampPenScale } from './penWidth';

/** The nodes a style applies to: groups give way to their children, and locked nodes are never restyled. */
export function selectedNodes(doc: BoardDoc, selected: readonly NodeId[]): Node[] {
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

interface StyleGesture { readonly label: string; readonly release: () => void }

/** Style changes. Each one is one undo step, except the steps inside a gesture (a slider drag, a held arrow key, a
 * swatch scrub), which share one step until the gesture ends. Next-shape defaults are history-silent. */
export class BoardStyleCommands {
    private gesture: StyleGesture | null = null;
    constructor(
        private readonly session: BoardSession,
        private readonly selection: () => readonly NodeId[],
        private readonly activeTool: () => string,
        /** A figure's label must stay inside its figure after a size or width change (R-9): the caller measures it. */
        private readonly figureGrowY: (node: Readonly<FigureNode>) => number | undefined = () => undefined,
    ) {}

    private refitLabel(ops: Op[], node: FigureNode): void {
        const growY = this.figureGrowY(node);
        if (growY !== undefined && growY !== node.growY) ops.push({ t: 'set', id: node.id, key: 'growY', value: growY });
    }

    /** A different action ends the open gesture first, so it never joins the gesture's undo step. */
    private commit(label: string, ops: readonly Op[]): void {
        if (this.gesture && this.gesture.label !== label) this.end();
        // Undo or Redo during a gesture closes its group; the rest of the gesture opens a new one, not one step per event.
        if (this.gesture && !this.session.history.isOpen) this.session.history.open(this.gesture.label);
        apply(this.session, label, ops, this.gesture !== null);
    }

    /** Opens one undo step that every change until `end` shares. */
    begin(label: string): void {
        if (this.gesture || this.session.isReadOnly) return;
        const release = this.session.beginGesture();
        try { this.session.history.open(label); }
        catch (error) { release(); throw error; }
        this.gesture = { label, release };
    }

    end(): void {
        if (!this.gesture) return;
        const { release } = this.gesture;
        this.gesture = null;
        try { this.session.history.close(); }
        finally { release(); }
    }

    get gestureActive(): boolean { return this.gesture !== null; }

    currentColor(): Swatch | null {
        const doc = this.session.doc;
        const colors = selectedNodes(doc, this.selection()).flatMap(node =>
            'color' in node && node.color !== null ? [node.color] : []);
        if (!colors.length) return this.activeTool() === 'highlighter' ? doc.ui.next.highlighterColor : doc.ui.next.color;
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
        this.end();
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
        const doc = this.session.doc, next = doc.ui.next;
        const key = this.activeTool() === 'highlighter' ? 'highlighterColor' : 'color';
        const ops: Op[] = [];
        if (next[key] !== color) ops.push({ t: 'board', key: 'ui.next', value: { ...next, [key]: color } });
        for (const node of selectedNodes(doc, this.selection())) {
            if ('color' in node && node.color !== color) ops.push({ t: 'set', id: node.id, key: 'color', value: color });
        }
        this.commit('Change colour', ops);
    }

    setOpacity(value: number): void {
        const doc = this.session.doc, opacity = Math.min(1, Math.max(0, value)), ops: Op[] = [];
        for (const node of selectedNodes(doc, this.selection())) {
            if (node.opacity !== opacity) ops.push({ t: 'set', id: node.id, key: 'opacity', value: opacity });
        }
        this.commit('Change opacity', ops);
    }

    setFill(fill: Fill): void {
        const doc = this.session.doc, ops: Op[] = [];
        if (doc.ui.next.fill !== fill) ops.push({ t: 'board', key: 'ui.next', value: { ...doc.ui.next, fill } });
        for (const node of selectedNodes(doc, this.selection())) {
            if ((node.kind === 'figure' || node.kind === 'connector') && node.fill !== fill) {
                ops.push({ t: 'set', id: node.id, key: 'fill', value: fill });
            }
        }
        this.commit('Change fill', ops);
    }

    setDash(dash: Dash): void {
        const doc = this.session.doc, ops: Op[] = [];
        if (doc.ui.next.dash !== dash) ops.push({ t: 'board', key: 'ui.next', value: { ...doc.ui.next, dash } });
        for (const node of selectedNodes(doc, this.selection())) {
            if ('dash' in node && node.dash !== dash) ops.push({ t: 'set', id: node.id, key: 'dash', value: dash });
        }
        this.commit('Change dash style', ops);
    }

    setFont(font: Font): void {
        const doc = this.session.doc, ops: Op[] = [];
        if (doc.ui.next.font !== font) ops.push({ t: 'board', key: 'ui.next', value: { ...doc.ui.next, font } });
        for (const node of selectedNodes(doc, this.selection())) {
            if ('font' in node && node.font !== font) ops.push({ t: 'set', id: node.id, key: 'font', value: font });
        }
        this.commit('Change font', ops);
    }

    /** Text's own horizontal alignment: a text node has no label alignment, so the two rows never write each other's key. */
    setTextAlignment(textAlign: TextAlign): void {
        const doc = this.session.doc, ops: Op[] = [];
        if (doc.ui.next.textAlign !== textAlign) ops.push({ t: 'board', key: 'ui.next', value: { ...doc.ui.next, textAlign } });
        for (const node of selectedNodes(doc, this.selection())) {
            if (node.kind === 'text' && node.align !== textAlign) ops.push({ t: 'set', id: node.id, key: 'align', value: textAlign });
        }
        this.commit('Change alignment', ops);
    }

    /** A figure's or note's label alignment, the horizontal one. */
    setLabelAlignment(align: HAlign): void {
        const doc = this.session.doc, ops: Op[] = [];
        if (doc.ui.next.align !== align) ops.push({ t: 'board', key: 'ui.next', value: { ...doc.ui.next, align } });
        for (const node of selectedNodes(doc, this.selection())) {
            if ((node.kind === 'figure' || node.kind === 'sticky') && node.align !== align) {
                ops.push({ t: 'set', id: node.id, key: 'align', value: align });
            }
        }
        this.commit('Change label alignment', ops);
    }

    setVerticalAlignment(valign: VAlign): void {
        const doc = this.session.doc, ops: Op[] = [];
        if (doc.ui.next.valign !== valign) ops.push({ t: 'board', key: 'ui.next', value: { ...doc.ui.next, valign } });
        for (const node of selectedNodes(doc, this.selection())) {
            if ('valign' in node && node.valign !== valign) ops.push({ t: 'set', id: node.id, key: 'valign', value: valign });
        }
        this.commit('Change vertical alignment', ops);
    }

    /** The geo shape of selected figures. With nothing selected the figure tool's own variant is the next shape. */
    setShape(shape: FigureShape): void {
        const ops: Op[] = [];
        for (const node of selectedNodes(this.session.doc, this.selection())) {
            if (node.kind === 'figure' && node.shape !== shape) ops.push({ t: 'set', id: node.id, key: 'shape', value: shape });
        }
        this.commit('Change shape', ops);
    }

    setRoute(route: 'arc' | 'elbow'): void {
        const doc = this.session.doc, ops: Op[] = [];
        if (doc.ui.next.route !== route) ops.push({ t: 'board', key: 'ui.next', value: { ...doc.ui.next, route } });
        for (const node of selectedNodes(doc, this.selection())) {
            if (node.kind === 'connector' && node.route !== route) ops.push({ t: 'set', id: node.id, key: 'route', value: route });
        }
        this.commit('Change arrow kind', ops);
    }

    setArrowhead(end: 'start' | 'end', head: Arrowhead): void {
        const doc = this.session.doc, ops: Op[] = [], key = end === 'start' ? 'headStart' : 'headEnd';
        if (doc.ui.next[key] !== head) ops.push({ t: 'board', key: 'ui.next', value: { ...doc.ui.next, [key]: head } });
        for (const node of selectedNodes(doc, this.selection())) {
            if (node.kind === 'connector' && node[key] !== head) ops.push({ t: 'set', id: node.id, key, value: head });
        }
        this.commit(end === 'start' ? 'Change start arrowhead' : 'Change end arrowhead', ops);
    }

    setSpline(spline: 'line' | 'cubic'): void {
        const doc = this.session.doc, ops: Op[] = [];
        if (doc.ui.next.spline !== spline) ops.push({ t: 'board', key: 'ui.next', value: { ...doc.ui.next, spline } });
        for (const node of selectedNodes(doc, this.selection())) {
            if (node.kind === 'polyline' && node.spline !== spline) ops.push({ t: 'set', id: node.id, key: 'spline', value: spline });
        }
        this.commit('Change line type', ops);
    }

    setSize(size: Size): void {
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
                const width = styleGeometryMetrics.actualWidth(node.kind, size, scale);
                ops.push({ t: 'set', id: node.id, key: 'width', value: width });
                if (node.kind === 'figure') this.refitLabel(ops, { ...node, size, width });
            }
        }
        this.commit('Change style size', ops);
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
                if (node.kind === 'figure') this.refitLabel(ops, { ...node, width });
            }
        }
        this.commit('Change pen width', ops);
    }
}
