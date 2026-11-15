import { surfaceToWorld, worldToSurface } from '../../platform/render/camera';
import type { ScheduledFrame } from '../../platform/render/scheduler';
import type { ViewState } from '../../platform/types';
import { worldPose } from '../change/coordinates';
import type { Vec2 } from '../geom/path';
import type { BoardRuntime } from '../host/runtime';
import { PresentedHistory } from '../input/presentedHistory';
import type { GestureOwner, RealSample } from '../input/tool';
import type { NodeId } from '../model/ids';
import type { EmbedNode, LinkcardNode } from '../model/nodes';

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
const SVG_NS = 'http://www.w3.org/2000/svg';

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
    const cardsOnSheet = (actions: BoardCardActions): CardNode[] => {
        const out: CardNode[] = [];
        for (const id of session.doc.bySheet.get(runtime.selection.getSnapshot().sheet) ?? []) {
            const node = session.doc.nodes.get(id);
            if (node?.kind === 'embed' || node?.kind === 'linkcard') out.push(node);
        }
        return out;
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
            for (const node of cardsOnSheet(actions)) {
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
            const cards = actions ? cardsOnSheet(actions) : [];
            if (!actions || !cards.length) { clear(); return; }
            presented.present(frame.timestamp, { ...frame.view.camera });
            if (!svg) {
                svg = document.createElementNS(SVG_NS, 'svg'); svg.setAttribute('aria-hidden', 'true');
                svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible';
                options.overlay.append(svg);
            }
            svg.replaceChildren();
            for (const node of cards) {
                for (const chip of layout(node, actions, frame.view.camera)) {
                    const group = document.createElementNS(SVG_NS, 'g');
                    group.setAttribute('opacity', chip.action === null ? '0.55' : '1');
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
                    group.append(rect, text); svg.append(group);
                }
            }
        },
        dispose() {
            if (disposed) return;
            disposed = true; stopSelection(); stopSession(); stopEmbeds(); clear();
        },
    };
}
