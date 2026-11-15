import { pageAt } from '../../platform/render/pageStack';
import type { CameraController } from '../../platform/render/camera';
import { transformBox } from '../geom/bounds';
import { allocateOrderKeys, isLocked, reparentNode } from '../change/commands';
import { poseInParent, worldPose, type ChangeGeometry } from '../change/coordinates';
import { inverse } from '../geom/affine';
import { acquireBoardGeometryScope } from '../commands/geometryScope';
import { figureClickBox, figureDragBox } from '../geom/figures';
import { snapBoardBounds, type BoardSnapGuide } from '../geom/runtimeSnap';
import { gridRectangle } from '../input/gridCreation';
import { notebookGrowthOp } from '../commands/pagesAndSheets';
import { styleGeometryMetrics } from '../geom/styleMetrics';
import type { BoardRuntime } from '../host/runtime';
import { CLICK_SLOP_CSS, sampleSurface, type CancelReason, type FinishReason, type GestureOwner, type Modifiers, type RealSample, type Tool } from '../input/tool';
import { hasOpaqueDescendant, isSheetParent, sheetOf } from '../model/doc';
import { polylineHandleGesture } from '../input/polylineHandles';
import { createAddedBoardDoc } from '../model/overlayDoc';
import { newNodeId, type NodeId, type ParentId } from '../model/ids';
import { createConnector, createFigure, createFrame, createPolyline, createSticky, createText, type Attachment, type Node } from '../model/nodes';
import { keyBetween } from '../model/orderKey';
import { boardPageStack, pageOrigin } from '../model/pages';
import type { FigureShape } from '../model/styles';
import type { createBoardRenderServices } from '../render/services';
import { EMPTY_RICH_TEXT } from '../text/richText';
import type { AttachmentRequest } from './attachments';
import type { BoardPreview } from './preview';

type CreationKind = 'figure' | 'text' | 'sticky' | 'frame' | 'connector' | 'polyline';
export interface BoardCreationContext {
    readonly runtime: BoardRuntime;
    readonly render: ReturnType<typeof createBoardRenderServices>;
    readonly kind: CreationKind;
    readonly camera: CameraController;
    readonly sampleToSurface: (sample: RealSample) => { readonly x: number; readonly y: number };
    registerPending(cancel: () => void): () => void;
    readonly figure?: FigureShape;
    readonly preview: Pick<BoardPreview, 'show' | 'showOps' | 'waitUntilReady' | 'armCommit' | 'finishCommit' | 'cancelCommit' | 'clear'>;
    readonly guides?: (guides: readonly BoardSnapGuide[]) => void;
    readonly alwaysSnap?: () => boolean;
    current(): boolean;
    editText(id: Node['id']): void | Promise<void>;
    resolveAttachment(point: { x: number; y: number }, signal: AbortSignal, request?: AttachmentRequest): Promise<Attachment | null>;
    onError(error: unknown): void;
}
class CreationGesture implements GestureOwner {
    readonly kind = 'node-edit' as const;
    readonly pointerIds: ReadonlySet<number>;
    private readonly controller = new AbortController();
    private readonly revision: number;
    private readonly toolEpoch: number;
    private readonly toolStart: ReturnType<BoardCreationContext['runtime']['tools']['getSnapshot']>;
    private readonly document: BoardRuntime['session']['doc'];
    private readonly owner: BoardRuntime['session']['owner'];
    private readonly selection: ReturnType<BoardRuntime['selection']['getSnapshot']>;
    private readonly release: () => void;
    private readonly unregister: () => void;
    private readonly parent: ParentId;
    private readonly page: number;
    private readonly parentPose: { x: number; y: number; rotation: number };
    private readonly downSurface: { x: number; y: number };
    private lastSurface: { x: number; y: number };
    private readonly base: { id: Node['id']; parent: ParentId; order: string; page: number; x: number; y: number; ext: null };
    private readonly style;
    private fontEpoch: number | undefined;
    private previewRequest: AbortController | undefined;
    private previewGeneration = 0;
    private lastMovedAt: number;
    private sample: RealSample;
    private readonly downModifiers: Modifiers;
    private modifiers: Modifiers;
    private ended = false;
    private released = false;
    constructor(private readonly down: RealSample, modifiers: Modifiers, private readonly context: BoardCreationContext) {
        const doc = context.runtime.session.doc, selection = context.runtime.selection.getSnapshot();
        this.pointerIds = new Set([down.pointerId]); this.sample = down; this.lastMovedAt = down.time; this.downModifiers = modifiers; this.modifiers = modifiers;
        this.downSurface = sampleSurface(down, context.sampleToSurface); this.lastSurface = this.downSurface;
        this.revision = doc.rev; this.toolStart = context.runtime.tools.getSnapshot(); this.toolEpoch = this.toolStart.selectionEpoch;
        this.document = doc; this.owner = context.runtime.session.owner; this.selection = selection; this.parent = selection.focus;
        const parent = doc.nodes.get(this.parent as Node['id']);
        if (!isSheetParent(doc, this.parent) && (!parent || (parent.kind !== 'group' && parent.kind !== 'frame') || isLocked(doc, parent))) throw new Error('Creation focus is not an editable container');
        const stack = boardPageStack(doc.host);
        this.page = isSheetParent(doc, this.parent) && stack ? pageAt(stack, down.y) : -1;
        const origin = this.page >= 0 && stack ? pageOrigin(stack, this.page) : null;
        this.parentPose = isSheetParent(doc, this.parent) ? { x: origin?.x ?? 0, y: origin?.y ?? 0, rotation: 0 } : worldPose(doc, this.parent);
        const point = this.local(down), children = doc.children.get(this.parent) ?? [];
        this.base = { id: newNodeId(doc), parent: this.parent, order: keyBetween(children.at(-1)?.order ?? null, null), page: this.page, x: point.x, y: point.y, ext: null };
        this.style = { ...doc.ui.next };
        this.release = context.runtime.session.beginGesture();
        try { this.unregister = context.registerPending(() => this.cancel('invalidated')); }
        catch (error) { this.release(); throw error; }
        try { this.draw(); } catch (error) { this.cancel('invalidated'); throw error; }
    }
    private valid(): boolean {
        const { runtime } = this.context, session = runtime.session;
        return !this.controller.signal.aborted && this.context.current() && session.owner === this.owner
            && session.doc === this.document && this.document.rev === this.revision && !session.isReadOnly
            && runtime.selection.getSnapshot() === this.selection
            && (this.fontEpoch === undefined || runtime.render.text.fonts.epoch === this.fontEpoch);
    }
    private local(point: { x: number; y: number }) {
        const pose = this.parentPose, dx = point.x - pose.x, dy = point.y - pose.y, c = Math.cos(pose.rotation), s = Math.sin(pose.rotation);
        return { x: c * dx + s * dy, y: -s * dx + c * dy };
    }
    private isClick(): boolean {
        const surface = sampleSurface(this.sample, this.context.sampleToSurface);
        return Math.hypot(surface.x - this.downSurface.x, surface.y - this.downSurface.y) < CLICK_SLOP_CSS;
    }
    private node(sample = this.sample, modifiers = this.modifiers): Node {
        const p = this.local(sample), style = this.style;
        let dx = p.x - this.base.x, dy = p.y - this.base.y;
        const surface = sampleSurface(sample, this.context.sampleToSurface);
        const moved = Math.hypot(surface.x - this.downSurface.x, surface.y - this.downSurface.y) >= CLICK_SLOP_CSS;
        if (modifiers.shift) {
            if (this.context.kind === 'connector' || this.context.kind === 'polyline') {
                const length = Math.hypot(dx, dy), step = Math.PI / 12, angle = Math.round(Math.atan2(dy, dx) / step) * step;
                dx = length * Math.cos(angle); dy = length * Math.sin(angle);
            } else { const size = Math.max(Math.abs(dx), Math.abs(dy)); dx = Math.sign(dx || 1) * size; dy = Math.sign(dy || 1) * size; }
        }
        const centered = modifiers.alt, x = centered ? this.base.x - Math.abs(dx) : this.base.x + Math.min(0, dx),
            y = centered ? this.base.y - Math.abs(dy) : this.base.y + Math.min(0, dy);
        const factor = centered ? 2 : 1;
        const w = moved ? Math.max(1, Math.abs(dx) * factor) : this.context.kind === 'frame' ? 320 : this.context.kind === 'sticky' ? 200 : 100;
        const h = moved ? Math.max(1, Math.abs(dy) * factor) : this.context.kind === 'frame' ? 180 : this.context.kind === 'sticky' ? 200 : 100;
        const base = { ...this.base, x: moved ? x : this.base.x, y: moved ? y : this.base.y };
        const width = styleGeometryMetrics.actualWidth(this.context.kind === 'polyline' ? 'polyline' : this.context.kind === 'connector' ? 'connector' : 'figure', style.size, 1);
        switch (this.context.kind) {
            case 'figure': {
                const shape = this.context.figure ?? 'rectangle', down = { x: this.base.x, y: this.base.y };
                const box = moved ? figureDragBox(shape, down, p, modifiers) : figureClickBox(shape, down);
                return createFigure({ ...base, x: box.x, y: box.y, shape, w: box.width, h: box.height, growY: 0,
                    color: style.color, labelColor: style.color, fill: style.fill, dash: style.dash, size: style.size, font: style.font,
                    align: style.align, valign: style.valign, label: null, width, flipX: false, flipY: false, url: null });
            }
            case 'frame': {
                const down = { x: this.base.x, y: this.base.y };
                const box = moved ? figureDragBox('rectangle', down, p, modifiers)
                    : { x: down.x - 160, y: down.y - 90, width: 320, height: 180 };
                return createFrame({ ...base, x: box.x, y: box.y, w: box.width, h: box.height, name: '', color: null });
            }
            case 'text': return createText({ ...base, text: EMPTY_RICH_TEXT, color: style.color, size: style.size, font: style.font,
                align: style.textAlign, autoSize: !moved, w, scale: 1 });
            case 'sticky': {
                // A click's note is centred on the pointer (200 units at scale 1); its origin is the top-left corner.
                const centred = moved ? base : { ...base, x: base.x - 100, y: base.y - 100 };
                return createSticky({ ...centred, text: EMPTY_RICH_TEXT, color: 'yellow', labelColor: style.color,
                size: style.size, font: style.font, align: style.align, valign: style.valign, growY: 0, fit: null,
                scale: moved ? Math.max(.01, Math.max(w, h) / 200) : 1, url: null });
            }
            case 'polyline': return createPolyline({ ...this.base, points: [{ x: centered ? -dx : 0, y: centered ? -dy : 0 }, moved ? { x: dx, y: dy } : { x: .1, y: .1 }],
                spline: style.spline, color: style.color, dash: style.dash, size: style.size, width });
            case 'connector': return createConnector({ ...this.base, route: style.route, start: { x: centered ? -dx : 0, y: centered ? -dy : 0, attach: null },
                end: { x: moved ? dx : .1, y: moved ? dy : .1, attach: null }, bend: 0, headStart: style.headStart, headEnd: style.headEnd,
                color: style.color, labelColor: style.color, fill: style.fill, dash: style.dash, size: style.size, font: style.font, label: null, width });
        }
    }
    private async snapped(sample: RealSample, modifiers: Modifiers, signal: AbortSignal): Promise<Node> {
        const node = this.node(sample, modifiers), surface = sampleSurface(sample, this.context.sampleToSurface);
        const moved = Math.hypot(surface.x - this.downSurface.x, surface.y - this.downSurface.y) >= CLICK_SLOP_CSS;
        if (moved && this.context.runtime.session.doc.view.grid && node.kind === 'figure' && node.shape === 'rectangle' && this.parentPose.rotation === 0) {
            this.context.guides?.([]); return gridRectangle(node, this.parentPose);
        }
        // Default: creation snapping is off unless Always Snap is inverted by the accelerator.
        if ((this.context.alwaysSnap?.() ?? false) === modifiers.accel
            || Math.hypot(surface.x - this.downSurface.x, surface.y - this.downSurface.y) < CLICK_SLOP_CSS) {
            this.context.guides?.([]); return node;
        }
        const { runtime } = this.context;
        const active = () => !signal.aborted && this.valid();
        if (node.kind === 'connector' || node.kind === 'polyline') {
            const endpoint = (value: Extract<Node, { kind: 'connector' | 'polyline' }>) => {
                const p = value.kind === 'connector' ? value.end : value.points[value.points.length - 1];
                const pose = this.parentPose, c = Math.cos(pose.rotation), s = Math.sin(pose.rotation);
                const x = value.x + p.x, y = value.y + p.y;
                return { x: pose.x + c * x - s * y, y: pose.y + s * x + c * y };
            };
            const point = endpoint(node);
            if (node.kind === 'connector' && !modifiers.accel) {
                const attached = await this.context.resolveAttachment(point, signal, { precise: modifiers.shift, exact: modifiers.alt,
                    input: sample.source === 'keyboard' ? 'mouse' : sample.source });
                if (!active()) throw new DOMException('Creation snap invalidated', 'AbortError');
                if (attached) { this.context.guides?.([]); return node; }
            }
            const snapped = await snapBoardBounds({ runtime, bounds: { ...point, width: 0, height: 0 }, selected: [],
                zoom: this.context.camera.camera.z, current: active, signal });
            if (!active()) throw new DOMException('Creation snap invalidated', 'AbortError');
            const next = this.node({ ...sample, x: sample.x + snapped.delta.x, y: sample.y + snapped.delta.y }, modifiers);
            if (next.kind !== 'connector' && next.kind !== 'polyline') throw new Error('Creation kind changed');
            const actual = endpoint(next), zoom = this.context.camera.camera.z;
            this.context.guides?.(snapped.guides.filter(guide => Math.abs((guide.axis === 'x' ? actual.x : actual.y) - guide.value) * zoom <= 0.5));
            return next;
        }
        if (node.kind !== 'figure' && node.kind !== 'frame' && node.kind !== 'sticky') { this.context.guides?.([]); return node; }
        const candidate = createAddedBoardDoc(this.document, [node]);
        const scope = await acquireBoardGeometryScope(runtime, [node.id], { doc: candidate, signal, current: active });
        let bounds: ReturnType<typeof scope.logicalBounds>;
        try { bounds = scope.logicalBounds(node.id); } finally { scope.release(); }
        signal.throwIfAborted(); if (!active()) throw new DOMException('Creation snap invalidated', 'AbortError');
        const result = await snapBoardBounds({ runtime, bounds, selected: [], zoom: this.context.camera.camera.z, current: active, signal });
        signal.throwIfAborted(); if (!active()) throw new DOMException('Creation snap invalidated', 'AbortError');
        this.context.guides?.(result.guides);
        return result.delta.x || result.delta.y ? this.node({ ...sample, x: sample.x + result.delta.x, y: sample.y + result.delta.y }, modifiers) : node;
    }
    private draw(): void {
        if (!this.valid()) return;
        const sample = this.sample, modifiers = this.modifiers, turn = ++this.previewGeneration;
        this.previewRequest?.abort(); const request = new AbortController(); this.previewRequest = request;
        this.context.preview.show([this.node(sample, modifiers)]);
        void this.snapped(sample, modifiers, request.signal).then(node => {
            if (!request.signal.aborted && turn === this.previewGeneration && this.valid() && !this.ended) this.context.preview.show([node]);
        }).catch(error => { if (!request.signal.aborted && turn === this.previewGeneration && this.valid()) this.context.onError(error); });
    }
    update(samples: readonly RealSample[], modifiers: Modifiers): void {
        if (this.ended) return;
        if (!this.valid()) { this.cancel('invalidated'); return; }
        this.modifiers = modifiers;
        for (const sample of samples) if (this.pointerIds.has(sample.pointerId)) {
            const surface = sampleSurface(sample, this.context.sampleToSurface);
            if (surface.x !== this.lastSurface.x || surface.y !== this.lastSurface.y) this.lastMovedAt = sample.time;
            this.lastSurface = surface; this.sample = sample;
        }
        try { this.draw(); } catch (error) { this.cancel('invalidated'); this.context.onError(error); }
    }
    finish(reason: FinishReason): void {
        if (this.ended) return;
        this.ended = true;
        this.previewGeneration++; this.previewRequest?.abort();
        if (reason !== 'up' || !this.valid()) { this.cancel('invalidated'); return; }
        if (this.context.kind === 'connector' && this.isClick()) {
            this.context.runtime.tools.keepToolOnce(this.toolEpoch); this.cancel('invalidated'); this.completeTool(); return;
        }
        if (this.context.kind === 'polyline' && this.isClick()) this.context.runtime.tools.keepToolOnce(this.toolEpoch);
        void this.commit().catch(error => { if (!this.controller.signal.aborted) this.context.onError(error); }).finally(() => { this.cleanup(); this.completeTool(); });
    }
    private async enclosedFrameChildren(node: Extract<Node, { kind: 'frame' }>, pose: { x: number; y: number; rotation: number }): Promise<NodeId[]> {
        const { runtime } = this.context, doc = runtime.session.doc, signal = this.controller.signal;
        const scene = runtime.scene ?? await runtime.ready;
        if (!this.valid() || !scene.ready || scene.revision !== this.revision) throw new DOMException('Frame containment source changed', 'AbortError');
        const c = Math.cos(pose.rotation), s = Math.sin(pose.rotation), transform = [c, s, -s, c, pose.x, pose.y] as const;
        const back = inverse(transform, 1e12); if (!back) throw new RangeError('Frame transform is not invertible');
        const box = new Float64Array(4); transformBox(box, 0, [0, 0, node.w, node.h], 0, transform);
        const cursor = scene.spatialCursor({ sheetId: runtime.selection.getSnapshot().sheet, purpose: 'selectable',
            request: { kind: 'box', box: [box[0], box[1], box[2], box[3]] } });
        const candidates = new Set<NodeId>();
        try {
            for (;;) {
                signal.throwIfAborted(); if (!this.valid()) throw new DOMException('Frame creation changed', 'AbortError');
                const status = cursor.resume({ deadline: performance.now() + 3, maxVisits: 256 }, ref => {
                    const resolved = scene.resolveSpatial(ref); if (!resolved) throw new DOMException('Frame candidate expired', 'AbortError');
                    let item = doc.nodes.get(resolved.id);
                    for (let depth = 0; item && item.parent !== node.parent && depth < 64; depth++) item = doc.nodes.get(item.parent as NodeId);
                    if (item && item.parent === node.parent && item.kind !== 'opaque' && !isLocked(doc, item) && !hasOpaqueDescendant(doc, item.id)) candidates.add(item.id);
                });
                if (status === 'complete') break;
                if (status !== 'pending') throw new DOMException('Frame containment query expired', 'AbortError');
                await new Promise<void>(resolve => setTimeout(resolve, 0));
            }
        } finally { cursor.cancel(); }
        if (!candidates.size) return [];
        const scope = await acquireBoardGeometryScope(runtime, candidates, { signal, current: () => this.valid() });
        try {
            const inside = new Set<NodeId>();
            for (const id of candidates) {
                const b = await scope.boundsInSpace(id, back);
                if (!this.valid()) throw new DOMException('Frame containment source changed', 'AbortError');
                if (b[0] >= 0 && b[1] >= 0 && b[2] <= node.w && b[3] <= node.h) inside.add(id);
            }
            return (doc.children.get(node.parent) ?? []).filter(child => inside.has(child.id)).map(child => child.id);
        } finally { scope.release(); }
    }
    private async commit(): Promise<void> {
        const { render, runtime } = this.context, signal = this.controller.signal;
        let node = await this.snapped(this.sample, this.modifiers, signal);
        if (node.kind === 'connector') {
            const request = (sample: RealSample, keys: Modifiers, dwell: boolean): AttachmentRequest => ({ precise: keys.shift || dwell, exact: keys.alt,
                input: sample.source === 'keyboard' ? 'mouse' : sample.source });
            const world = (point: { x: number; y: number }) => {
                const pose = this.parentPose, c = Math.cos(pose.rotation), s = Math.sin(pose.rotation);
                const x = node.x + point.x, y = node.y + point.y;
                return { x: pose.x + c * x - s * y, y: pose.y + s * x + c * y };
            };
            const start = this.downModifiers.accel ? null : await this.context.resolveAttachment(world(node.start), signal, request(this.down, this.downModifiers, false));
            if (!this.valid()) throw new DOMException('Creation invalidated', 'AbortError');
            const end = this.modifiers.accel ? null : await this.context.resolveAttachment(world(node.end), signal,
                request(this.sample, this.modifiers, this.sample.time - this.lastMovedAt >= 1000));
            node = { ...node, start: { ...node.start, attach: start }, end: { ...node.end, attach: end } };
        }
        if ('font' in node && !await render.text.fonts.load({ family: node.font, bold: false, italic: false })) throw new Error('The creation font could not be loaded');
        if (!this.valid()) throw new DOMException('Creation invalidated', 'AbortError');
        this.fontEpoch = render.text.fonts.epoch;
        const doc = runtime.session.doc, candidate = createAddedBoardDoc(doc, [node]);
        const geometry = await render.prepareForPick(node, signal, candidate);
        if (!this.valid()) throw new DOMException('Creation invalidated', 'AbortError');
        const scope = await acquireBoardGeometryScope(runtime, [node.id], { doc: candidate, signal, current: () => this.valid() });
        try {
            if (!this.valid()) throw new DOMException('Creation invalidated', 'AbortError');
            const pose = worldPose(candidate, node.id), c = Math.cos(pose.rotation), s = Math.sin(pose.rotation), logical = scope.logicalBounds(node.id);
            const placementGeometry: ChangeGeometry = { resolvedTip: (d, connector, terminal) => render.changeGeometry.resolvedTip(d, connector, terminal),
                worldBoundsCenter: () => ({ x: logical.x + logical.width / 2, y: logical.y + logical.height / 2 }) };
            const placement = poseInParent(doc, node, node.parent, pose, placementGeometry);
            node = { ...node, x: placement.x, y: placement.y, page: placement.page, rotation: placement.rotation };
            const bounds = new Float64Array(4);
            transformBox(bounds, 0, geometry.bounds.ink, 0, [c, s, -s, c, pose.x, pose.y]);
            const growth = notebookGrowthOp(doc, Math.max(bounds[3], logical.y + logical.height));
            const adopted = node.kind === 'frame' ? await this.enclosedFrameChildren(node, pose) : [];
            const lease = adopted.length ? await render.pinChangeGeometry(adopted, signal, doc, () => this.valid()) : undefined;
            try {
                if (!this.valid()) throw new DOMException('Creation invalidated', 'AbortError');
                this.context.preview.show([node]);
                await this.context.preview.waitUntilReady(signal);
                if (!this.valid()) throw new DOMException('Creation invalidated', 'AbortError');
                const builder = runtime.session.begin('tool', `Create ${this.context.kind}`);
                try {
                    this.context.preview.armCommit();
                    if (growth) builder.push(growth);
                    builder.push({ t: 'create', node });
                    if (adopted.length) {
                        const keys = allocateOrderKeys(doc, builder, node.id, null, null, adopted.length);
                        for (let i = 0; i < adopted.length; i++) {
                            const child = doc.nodes.get(adopted[i]); if (!child) throw new Error('Frame content disappeared');
                            reparentNode(doc, builder, child, node.id, render.changeGeometry, keys[i]);
                        }
                    }
                    const applied = builder.commit(); applied.release(); this.context.preview.finishCommit();
                } catch (error) { builder.abort(); this.context.preview.cancelCommit(); throw error; }
                runtime.selection.replace([node.id]);
                if (node.kind === 'polyline') runtime.tools.rememberPolyline(node.id, this.toolEpoch, this.isClick());
            } finally { lease?.release(); }
        } finally { scope.release(); }
        if (this.context.current() && (node.kind === 'text' || node.kind === 'sticky')) await this.context.editText(node.id);
    }
    cancel(_reason: CancelReason): void { this.ended = true; this.previewGeneration++; this.previewRequest?.abort(); this.controller.abort(); this.cleanup(); }
    /** The single-use return to Select, after the commit (see PointerRoute.completesTool). */
    private completeTool(): void {
        if (!this.context.current()) return;
        try { this.context.runtime.tools.complete(this.toolStart); } catch (error) { this.context.onError(error); }
    }
    private cleanup(): void {
        if (this.released) return;
        this.released = true;
        try { this.context.guides?.([]); this.context.preview.clear(); } finally { this.unregister(); this.release(); }
    }
}
export function boardCreationTool(id: CreationKind): Tool<BoardCreationContext> {
    return { id, begin(sample, modifiers, context) {
        if (id === 'polyline' && modifiers.shift) {
            const { runtime } = context, session = runtime.session, doc = session.doc;
            const choice = runtime.tools.getSnapshot(), prior = runtime.tools.getLastPolyline(), node = prior ? doc.nodes.get(prior.id) : undefined;
            // Default: an attached terminal stays bound; continuation starts a new line rather than moving the binding.
            if (prior && choice.active.id === 'polyline' && choice.selectionEpoch === prior.epoch && node?.kind === 'polyline'
                && node.points.length < 5000 && !node.endAttach && !isLocked(doc, node)
                && sheetOf(doc, node.id) === runtime.selection.getSnapshot().sheet) {
                const first = node.points[0], last = node.points[node.points.length - 1];
                const replaceTiny = prior.tiny && node.points.length === 2
                    && Math.hypot(last.x - first.x, last.y - first.y) * context.camera.camera.z < 2;
                // A click-created tiny endpoint is replaced; subsequent Shift clicks append in the same active tool flow.
                return polylineHandleGesture(sample, modifiers, { runtime, id: node.id,
                    index: replaceTiny ? node.points.length - 1 : node.points.length, insert: !replaceTiny,
                    onFinishUp: () => runtime.tools.keepToolOnce(prior.epoch), onCommit: () => runtime.tools.extendedPolyline(node.id, prior.epoch),
                    snap: { zoom: () => context.camera.camera.z, alwaysSnap: context.alwaysSnap ?? (() => false), guides: value => context.guides?.(value) },
                    current: context.current, hold: () => session.beginGesture(), registerPending: context.registerPending,
                    show: ops => context.preview.showOps(ops), waitUntilReady: context.preview.waitUntilReady,
                    armCommit: context.preview.armCommit, finishCommit: context.preview.finishCommit, cancelCommit: context.preview.cancelCommit,
                    clear: () => context.preview.clear(), error: context.onError });
            }
        }
        return new CreationGesture(sample, modifiers, context);
    } };
}
