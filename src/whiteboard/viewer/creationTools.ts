import { pageAt } from '../../platform/render/pageStack';
import type { CameraController } from '../../platform/render/camera';
import { transformBox } from '../geom/bounds';
import { worldPose } from '../change/coordinates';
import { notebookGrowthOp } from '../commands/pagesAndSheets';
import { styleGeometryMetrics } from '../geom/styleMetrics';
import type { BoardRuntime } from '../host/runtime';
import type { CancelReason, FinishReason, GestureOwner, Modifiers, RealSample, Tool } from '../input/tool';
import { isSheetParent, type BoardDoc } from '../model/doc';
import { newNodeId, type ParentId } from '../model/ids';
import { createConnector, createFigure, createFrame, createPolyline, createSticky, createText, type Attachment, type Node } from '../model/nodes';
import { keyBetween } from '../model/orderKey';
import { boardPageStack, pageOrigin } from '../model/pages';
import type { FigureShape } from '../model/styles';
import type { createBoardRenderServices } from '../render/services';
import { EMPTY_RICH_TEXT } from '../text/richText';

type CreationKind = 'figure' | 'text' | 'sticky' | 'frame' | 'connector' | 'polyline';
export interface BoardCreationContext {
    readonly runtime: BoardRuntime;
    readonly render: ReturnType<typeof createBoardRenderServices>;
    readonly kind: CreationKind;
    readonly camera: CameraController;
    registerPending(cancel: () => void): () => void;
    readonly figure?: FigureShape;
    readonly preview: { show(nodes: readonly Node[]): void; clear(): void };
    current(): boolean;
    editText(id: Node['id']): void | Promise<void>;
    resolveAttachment(point: { x: number; y: number }, signal: AbortSignal): Promise<Attachment | null>;
    onError(error: unknown): void;
}
/** Sparse read-only placement view, not a second session or mutation authority. */
function candidateDocument(doc: BoardDoc, node: Node): BoardDoc {
    const base = doc.nodes;
    const nodes: BoardDoc['nodes'] = {
        size: base.size + (base.has(node.id) ? 0 : 1),
        get: id => id === node.id ? node : base.get(id), has: id => id === node.id || base.has(id),
        *entries(): MapIterator<[Node['id'], Readonly<Node>]> { for (const [id, value] of base) if (id !== node.id) yield [id, value] as [typeof id, typeof value]; yield [node.id, node] as [Node['id'], Node]; },
        *keys(): MapIterator<Node['id']> { for (const id of base.keys()) if (id !== node.id) yield id; yield node.id; },
        *values(): MapIterator<Readonly<Node>> { for (const value of base.values()) if (value.id !== node.id) yield value; yield node; },
        [Symbol.iterator]() { return this.entries(); },
        forEach(callback, receiver) { for (const [id, value] of this) callback.call(receiver, value, id, this); },
    };
    return { ...doc, nodes };
}
class CreationGesture implements GestureOwner {
    readonly kind = 'node-edit' as const;
    readonly pointerIds: ReadonlySet<number>;
    private readonly controller = new AbortController();
    private readonly revision: number;
    private readonly release: () => void;
    private readonly unregister: () => void;
    private readonly parent: ParentId;
    private readonly page: number;
    private readonly parentPose: { x: number; y: number; rotation: number };
    private readonly base: { id: Node['id']; parent: ParentId; order: string; page: number; x: number; y: number; ext: null };
    private readonly style;
    private sample: RealSample;
    private modifiers: Modifiers;
    private ended = false;
    private released = false;
    constructor(private readonly down: RealSample, modifiers: Modifiers, private readonly context: BoardCreationContext) {
        const doc = context.runtime.session.doc, selection = context.runtime.selection.getSnapshot();
        this.pointerIds = new Set([down.pointerId]); this.sample = down; this.modifiers = modifiers;
        this.revision = doc.rev; this.parent = selection.focus;
        const parent = doc.nodes.get(this.parent as Node['id']);
        if (!isSheetParent(doc, this.parent) && (!parent || (parent.kind !== 'group' && parent.kind !== 'frame'))) throw new Error('Creation focus is not a live container');
        const stack = boardPageStack(doc.host);
        this.page = isSheetParent(doc, this.parent) && stack ? pageAt(stack, down.y) : -1;
        const origin = this.page >= 0 && stack ? pageOrigin(stack, this.page) : null;
        this.parentPose = isSheetParent(doc, this.parent) ? { x: origin?.x ?? 0, y: origin?.y ?? 0, rotation: 0 } : worldPose(doc, this.parent);
        const point = this.local(down), children = doc.children.get(this.parent) ?? [];
        this.base = { id: newNodeId(doc), parent: this.parent, order: keyBetween(children.at(-1)?.order ?? null, null), page: this.page, x: point.x, y: point.y, ext: null };
        this.style = { ...doc.ui.next };
        this.release = context.runtime.session.beginGesture();
        this.unregister = context.registerPending(() => this.cancel('invalidated'));
        this.draw();
    }
    private valid(): boolean { return !this.controller.signal.aborted && this.context.current() && this.context.runtime.session.doc.rev === this.revision; }
    private local(point: { x: number; y: number }) {
        const pose = this.parentPose, dx = point.x - pose.x, dy = point.y - pose.y, c = Math.cos(pose.rotation), s = Math.sin(pose.rotation);
        return { x: c * dx + s * dy, y: -s * dx + c * dy };
    }
    private node(): Node {
        const p = this.local(this.sample), style = this.style;
        let dx = p.x - this.base.x, dy = p.y - this.base.y;
        const moved = Math.hypot(this.sample.x - this.down.x, this.sample.y - this.down.y) * this.context.camera.camera.z >= 4;
        if (this.modifiers.shift) { const size = Math.max(Math.abs(dx), Math.abs(dy)); dx = Math.sign(dx || 1) * size; dy = Math.sign(dy || 1) * size; }
        const centered = this.modifiers.alt, x = centered ? this.base.x - Math.abs(dx) : this.base.x + Math.min(0, dx),
            y = centered ? this.base.y - Math.abs(dy) : this.base.y + Math.min(0, dy);
        const factor = centered ? 2 : 1;
        const w = moved ? Math.max(.01, Math.abs(dx) * factor) : this.context.kind === 'frame' ? 320 : this.context.kind === 'sticky' ? 200 : 100;
        const h = moved ? Math.max(.01, Math.abs(dy) * factor) : this.context.kind === 'frame' ? 180 : this.context.kind === 'sticky' ? 200 : 100;
        const base = { ...this.base, x: moved ? x : this.base.x, y: moved ? y : this.base.y };
        const width = styleGeometryMetrics.actualWidth(this.context.kind === 'polyline' ? 'polyline' : this.context.kind === 'connector' ? 'connector' : 'figure', style.size, 1);
        switch (this.context.kind) {
            case 'figure': return createFigure({ ...base, shape: this.context.figure ?? 'rectangle', w, h, growY: 0,
                color: style.color, labelColor: style.color, fill: style.fill, dash: style.dash, size: style.size, font: style.font,
                align: style.align, valign: style.valign, label: null, width, flipX: false, flipY: false, url: null });
            case 'frame': return createFrame({ ...base, w, h, name: 'Frame', color: null });
            case 'text': return createText({ ...base, text: EMPTY_RICH_TEXT, color: style.color, size: style.size, font: style.font,
                align: style.textAlign, autoSize: !moved, w, scale: 1 });
            case 'sticky': return createSticky({ ...base, text: EMPTY_RICH_TEXT, color: 'yellow', labelColor: style.color,
                size: style.size, font: style.font, align: style.align, valign: style.valign, growY: 0, fit: null,
                scale: moved ? Math.max(.01, Math.max(w, h) / 200) : 1, url: null });
            case 'polyline': return createPolyline({ ...this.base, points: [{ x: centered ? -dx : 0, y: centered ? -dy : 0 }, { x: dx, y: dy }],
                spline: style.spline, color: style.color, dash: style.dash, size: style.size, width });
            case 'connector': return createConnector({ ...this.base, route: style.route, start: { x: centered ? -dx : 0, y: centered ? -dy : 0, attach: null },
                end: { x: dx, y: dy, attach: null }, bend: 0, headStart: style.headStart, headEnd: style.headEnd,
                color: style.color, labelColor: style.color, fill: style.fill, dash: style.dash, size: style.size, font: style.font, label: null, width });
        }
    }
    private draw(): void { if (this.valid()) this.context.preview.show([this.node()]); }
    update(samples: readonly RealSample[], modifiers: Modifiers): void {
        if (this.ended) return;
        if (!this.valid()) { this.cancel('invalidated'); return; }
        this.modifiers = modifiers;
        for (const sample of samples) if (this.pointerIds.has(sample.pointerId)) this.sample = sample;
        try { this.draw(); } catch (error) { this.cancel('invalidated'); this.context.onError(error); }
    }
    finish(reason: FinishReason): void {
        if (this.ended) return;
        this.ended = true;
        if (reason !== 'up' || !this.valid()) { this.cancel('invalidated'); return; }
        void this.commit().catch(error => { if (!this.controller.signal.aborted) this.context.onError(error); }).finally(() => this.cleanup());
    }
    private async commit(): Promise<void> {
        let node = this.node();
        const { render, runtime } = this.context, signal = this.controller.signal;
        if (node.kind === 'connector') {
            const start = await this.context.resolveAttachment(this.down, signal);
            if (!this.valid()) throw new DOMException('Creation invalidated', 'AbortError');
            const end = await this.context.resolveAttachment(this.sample, signal);
            node = { ...node, start: { ...node.start, attach: start }, end: { ...node.end, attach: end } };
        }
        if ('font' in node && !await render.text.fonts.load({ family: node.font, bold: false, italic: false })) throw new Error('The creation font could not be loaded');
        if (!this.valid()) throw new DOMException('Creation invalidated', 'AbortError');
        const geometry = await render.prepareForPick(node, signal, candidateDocument(runtime.session.doc, node));
        if (!this.valid()) throw new DOMException('Creation invalidated', 'AbortError');
        const pose = worldPose(candidateDocument(runtime.session.doc, node), node.id), c = Math.cos(pose.rotation), s = Math.sin(pose.rotation);
        const bounds = new Float64Array(4);
        transformBox(bounds, 0, geometry.bounds.ink, 0, [c, s, -s, c, pose.x, pose.y]);
        const growth = notebookGrowthOp(runtime.session.doc, bounds[3]);
        const applied = runtime.session.apply({ origin: 'tool', label: `Create ${this.context.kind}`, ops: [...growth ? [growth] : [], { t: 'create', node }] });
        applied.release(); runtime.selection.replace([node.id]);
        if (this.context.current() && (node.kind === 'text' || node.kind === 'sticky')) await this.context.editText(node.id);
    }
    cancel(_reason: CancelReason): void { this.ended = true; this.controller.abort(); this.cleanup(); }
    private cleanup(): void {
        if (this.released) return;
        this.released = true;
        try { this.context.preview.clear(); } finally { this.unregister(); this.release(); }
    }
}
export function boardCreationTool(id: CreationKind): Tool<BoardCreationContext> {
    return { id, begin(sample, modifiers, context) { return new CreationGesture(sample, modifiers, context); } };
}
