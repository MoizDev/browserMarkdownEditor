import { surfaceToWorld, worldToSurface } from '../../platform/render/camera';
import type { ScheduledFrame } from '../../platform/render/scheduler';
import type { ViewState } from '../../platform/types';
import { worldPose } from '../change/coordinates';
import { forEachNodeInZOrder } from '../model/doc';
import type { Vec2 } from '../geom/path';
import type { BoardRuntime } from '../host/runtime';
import { PresentedHistory } from '../input/presentedHistory';
import type { GestureOwner, RealSample } from '../input/tool';
import type { NodeId } from '../model/ids';
import type { EmbedNode, LinkcardNode, Node } from '../model/nodes';

/** What a card's controls may do. Embed consent is session-only and never saved; opening and fetching are explicit gestures. */
export interface BoardCardActions {
    embedState(id: NodeId): 'inert' | 'loading' | 'loaded';
    loadEmbed(id: NodeId): Promise<unknown>;
    unloadEmbed(id: NodeId): Promise<void>;
    subscribeEmbeds(listener: () => void): () => void;
    openLink(url: string): void;
    fetchPreview(id: NodeId): Promise<void>;
}
export interface CardControlOptions {
    readonly runtime: BoardRuntime;
    readonly overlay: HTMLElement;
    readonly view: () => ViewState;
    readonly current: () => boolean;
    readonly invalidate: () => void;
    /** The mapping that presented a physical sample to the surface, shared with the other handles. */
    readonly sampleToSurface: (sample: RealSample) => Vec2;
    readonly actions: BoardCardActions | null;
    readonly error: (error: unknown) => void;
}
type CardNode = Readonly<EmbedNode | LinkcardNode>;
type Action = 'load' | 'unload' | 'fetch' | 'open';
interface Chip { readonly action: Action | null; readonly label: string }
interface PlacedChip extends Chip { readonly x: number; readonly y: number; readonly w: number; readonly h: number }

// Screen pixels, not world units: a card's chips keep their size at any zoom, and a chip is a touch target as well as a label.
const INSET = 12, HEIGHT = 26, GAP = 6, CHARACTER = 7.2, CHIP_PAD = 20;
/** Above any embed slot (stacked by node order, a small number) in the board overlay. */
const CHIP_LAYER = 2_147_483_000;
const SVG_NS = 'http://www.w3.org/2000/svg';
// A signal that is never aborted: the picking geometry is read as the current revision, not cancelled.
const NEVER = new AbortController().signal;
let maskSeq = 0;
/** A node's ink on the surface, as a box: the nearest thing the picking geometry offers to its outline. */
interface SurfaceBox { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }

function toWorld(runtime: BoardRuntime, node: Readonly<CardNode>, x: number, y: number): Vec2 {
    const pose = worldPose(runtime.session.doc, node.id), c = Math.cos(pose.rotation), s = Math.sin(pose.rotation);
    return { x: pose.x + c * x - s * y, y: pose.y + s * x + c * y };
}
function toLocal(runtime: BoardRuntime, node: Readonly<CardNode>, world: Vec2): Vec2 {
    const pose = worldPose(runtime.session.doc, node.id), c = Math.cos(pose.rotation), s = Math.sin(pose.rotation);
    const dx = world.x - pose.x, dy = world.y - pose.y;
    return { x: c * dx + s * dy, y: -s * dx + c * dy };
}

/**
 * The chips drawn on an embed or link card: Load, Stop or Loading for an embed; Fetch preview (until a preview is stored)
 * and Open link for a link card. They are a view of the card, never saved content, and they hit-test like the sticky handles:
 * the select tool asks `begin` before it selects, so a chip press never starts a move. A ⌘/Ctrl press on a link card's body
 * opens its address, which is the card's link area.
 */
export function createCardControls(options: CardControlOptions) {
    const { runtime } = options, session = runtime.session;
    let svg: SVGSVGElement | undefined, disposed = false;
    const presented = new PresentedHistory<ViewState['camera']>();
    const current = () => !disposed && options.current();
    const report = (error: unknown) => { if (!(error instanceof DOMException && error.name === 'AbortError')) options.error(error); };
    /** The sheet's nodes in paint order (the last is the topmost); groups have no ink of their own, and their children are listed. */
    const sheetNodes = (): Node[] => {
        const out: Node[] = [];
        forEachNodeInZOrder(session.doc, runtime.selection.getSnapshot().sheet, node => { if (node.kind !== 'group') out.push(node); });
        return out;
    };
    /** A node's ink box on the surface; null for a kind this does not box (a connector's line and label, an opaque record). */
    const surfaceBox = (node: Readonly<Node>, camera: ViewState['camera']): SurfaceBox | null => {
        if (node.kind === 'connector' || node.kind === 'opaque') return null;
        let ink: readonly number[];
        try { ink = runtime.render.prepareForPickNow(node, NEVER, session.doc).bounds.ink; } catch { return null; }
        const [lx0, ly0, lx1, ly1] = ink;
        if (![lx0, ly0, lx1, ly1].every(Number.isFinite) || lx1 < lx0 || ly1 < ly0) return null;
        const pose = worldPose(session.doc, node.id), c = Math.cos(pose.rotation), s = Math.sin(pose.rotation);
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const [px, py] of [[lx0, ly0], [lx1, ly0], [lx1, ly1], [lx0, ly1]] as const) {
            const p = worldToSurface({ x: pose.x + c * px - s * py, y: pose.y + s * px + c * py }, camera);
            x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
        }
        return { x0, y0, x1, y1 };
    };
    /** Whether a node above `from` in paint order covers the surface point: such a node is what a press there reaches. */
    const coveredAbove = (boxes: readonly (SurfaceBox | null)[], from: number, p: Vec2): boolean => {
        for (let j = from; j < boxes.length; j++) {
            const b = boxes[j];
            if (b && p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1) return true;
        }
        return false;
    };
    const chipsFor = (node: Readonly<CardNode>, actions: BoardCardActions): Chip[] => {
        if (node.kind === 'embed') {
            const state = actions.embedState(node.id);
            return state === 'loaded' ? [{ action: 'unload', label: 'Stop' }]
                : state === 'loading' ? [{ action: null, label: 'Loading…' }] : [{ action: 'load', label: 'Load' }];
        }
        const chips: Chip[] = [];
        if (!node.preview && !session.isReadOnly) chips.push({ action: 'fetch', label: 'Fetch preview' });
        chips.push({ action: 'open', label: 'Open link' });
        return chips;
    };
    /** Chips laid from the card's top-left corner in surface pixels; none is drawn when the card is too small to hold them. */
    const layout = (node: Readonly<CardNode>, actions: BoardCardActions, camera: ViewState['camera']): PlacedChip[] => {
        const chips = chipsFor(node, actions);
        const widths = chips.map(chip => Math.round(chip.label.length * CHARACTER + CHIP_PAD));
        const total = widths.reduce((sum, w) => sum + w, 0) + GAP * Math.max(0, chips.length - 1);
        if (node.w * camera.z < total + 2 * INSET) return [];
        const corner = worldToSurface(toWorld(runtime, node, 0, 0), camera);
        let x = corner.x + INSET;
        const y = corner.y + INSET;
        return chips.map((chip, i) => { const placed = { ...chip, x, y, w: widths[i], h: HEIGHT }; x += widths[i] + GAP; return placed; });
    };
    const actionFor = (node: Readonly<CardNode>, action: Action, actions: BoardCardActions): () => void => {
        switch (action) {
            case 'load': return () => { void actions.loadEmbed(node.id).catch(report); };
            case 'unload': return () => { void actions.unloadEmbed(node.id).catch(report); };
            case 'fetch': return () => {
                if (session.isReadOnly || node.kind !== 'linkcard') return;
                void actions.fetchPreview(node.id).catch(report);
            };
            case 'open': return () => {
                try { actions.openLink(node.url); } catch (error) { report(error); }
            };
        }
    };
    const clear = () => { svg?.remove(); svg = undefined; presented.clear(); };
    const invalidate = () => { if (current()) options.invalidate(); else clear(); };
    const stopSelection = runtime.selection.subscribe(invalidate), stopSession = session.subscribe(invalidate);
    const stopEmbeds = options.actions?.subscribeEmbeds(invalidate) ?? (() => {});
    /** A press that stays put completes its action on release; a drag past the slop turns into nothing. */
    const gesture = (sample: RealSample, down: Vec2, action: () => void): GestureOwner => {
        const pointerIds = new Set([sample.pointerId]);
        let ended = false;
        return { kind: 'node-edit', pointerIds,
            update(samples) {
                for (const next of samples) {
                    if (!pointerIds.has(next.pointerId) || ended) continue;
                    const point = options.sampleToSurface(next);
                    if (Math.hypot(point.x - down.x, point.y - down.y) >= 4) ended = true;
                }
            },
            finish(reason) { if (ended) return; ended = true; if (reason === 'up') action(); },
            cancel() { ended = true; },
        };
    };
    return {
        /** The gesture for a press on a card's chip, or on a link card's body with ⌘/Ctrl; null leaves the press to the select tool. */
        begin(surface: Vec2, sample: RealSample, accel: boolean): GestureOwner | null {
            const actions = options.actions, camera = presented.at(sample.time);
            if (!actions || !camera || !current() || ![surface.x, surface.y].every(Number.isFinite)) return null;
            const nodes = sheetNodes(), boxes = nodes.map(node => surfaceBox(node, camera));
            for (let k = nodes.length - 1; k >= 0; k--) {
                const node = nodes[k];
                if ((node.kind !== 'embed' && node.kind !== 'linkcard') || coveredAbove(boxes, k + 1, surface)) continue;
                for (const chip of layout(node, actions, camera)) {
                    if (chip.action === null || surface.x < chip.x || surface.x > chip.x + chip.w || surface.y < chip.y || surface.y > chip.y + chip.h) continue;
                    return gesture(sample, surface, actionFor(node, chip.action, actions));
                }
                if (accel && node.kind === 'linkcard') {
                    const local = toLocal(runtime, node, surfaceToWorld(surface, camera));
                    if (local.x >= 0 && local.x <= node.w && local.y >= 0 && local.y <= node.h) {
                        return gesture(sample, surface, actionFor(node, 'open', actions));
                    }
                }
            }
            return null;
        },
        write(frame: ScheduledFrame) {
            const actions = options.actions;
            const nodes = actions ? sheetNodes() : [];
            if (!actions || !nodes.some(node => node.kind === 'embed' || node.kind === 'linkcard')) { clear(); return; }
            presented.present(frame.timestamp, { ...frame.view.camera });
            if (!svg) {
                svg = document.createElementNS(SVG_NS, 'svg'); svg.setAttribute('aria-hidden', 'true');
                // Above the live embed frames (embedPresentation stacks each by its node order): under them, a loaded embed's frame
                // covered its own Stop chip and took the press, so a person could stop it only from the context menu.
                svg.style.cssText = `position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible;z-index:${CHIP_LAYER}`;
                options.overlay.append(svg);
            }
            svg.replaceChildren();
            const boxes = nodes.map(node => surfaceBox(node, frame.view.camera));
            for (let k = 0; k < nodes.length; k++) {
                const node = nodes[k];
                if (node.kind !== 'embed' && node.kind !== 'linkcard') continue;
                // A chip is clipped by whatever is above its card, so the card's chips never show through a node drawn over them.
                let host: SVGElement = svg;
                const above = boxes.slice(k + 1).filter((b): b is SurfaceBox => b !== null);
                if (above.length) {
                    const id = `bme-card-chips-${++maskSeq}`, mask = document.createElementNS(SVG_NS, 'mask');
                    mask.setAttribute('id', id); mask.setAttribute('maskUnits', 'userSpaceOnUse');
                    mask.setAttribute('x', '-100000'); mask.setAttribute('y', '-100000'); mask.setAttribute('width', '200000'); mask.setAttribute('height', '200000');
                    const visible = document.createElementNS(SVG_NS, 'rect');
                    visible.setAttribute('x', '-100000'); visible.setAttribute('y', '-100000'); visible.setAttribute('width', '200000'); visible.setAttribute('height', '200000');
                    visible.setAttribute('fill', '#ffffff'); mask.append(visible);
                    for (const b of above) {
                        const hidden = document.createElementNS(SVG_NS, 'rect');
                        hidden.setAttribute('x', String(b.x0)); hidden.setAttribute('y', String(b.y0));
                        hidden.setAttribute('width', String(b.x1 - b.x0)); hidden.setAttribute('height', String(b.y1 - b.y0));
                        hidden.setAttribute('fill', '#000000'); mask.append(hidden);
                    }
                    const layer = document.createElementNS(SVG_NS, 'g');
                    layer.setAttribute('mask', `url(#${id})`);
                    svg.append(mask, layer); host = layer;
                }
                for (const chip of layout(node, actions, frame.view.camera)) {
                    const group = document.createElementNS(SVG_NS, 'g');
                    group.setAttribute('opacity', chip.action === null ? '0.55' : '1');
                    // A chip nothing covers takes its own press, so a live frame beneath cannot: the press bubbles to the board's input
                    // root, whose select tool asks `begin` as for any chip press. A masked chip (a node above its card) stays see-through.
                    if (host === svg && chip.action !== null) group.style.pointerEvents = 'auto';
                    const rect = document.createElementNS(SVG_NS, 'rect');
                    rect.setAttribute('x', String(chip.x)); rect.setAttribute('y', String(chip.y));
                    rect.setAttribute('width', String(chip.w)); rect.setAttribute('height', String(chip.h));
                    rect.setAttribute('rx', String(chip.h / 2)); rect.setAttribute('fill', '#ffffff');
                    rect.setAttribute('stroke', '#6b7280'); rect.setAttribute('stroke-width', '1');
                    const text = document.createElementNS(SVG_NS, 'text');
                    text.setAttribute('x', String(chip.x + chip.w / 2)); text.setAttribute('y', String(chip.y + chip.h / 2));
                    text.setAttribute('text-anchor', 'middle'); text.setAttribute('dominant-baseline', 'central');
                    text.setAttribute('font-family', 'system-ui, sans-serif'); text.setAttribute('font-size', '12');
                    text.setAttribute('font-weight', '600'); text.setAttribute('fill', '#1f2328');
                    text.textContent = chip.label;
                    group.append(rect, text); host.append(group);
                }
            }
        },
        dispose() {
            if (disposed) return;
            disposed = true; stopSelection(); stopSession(); stopEmbeds(); clear();
        },
    };
}
