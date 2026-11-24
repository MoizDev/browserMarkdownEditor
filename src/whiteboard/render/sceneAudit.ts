/** The board's presented scene for the fidelity kit (audit only, `bme.renderAudit=1`): the paint items of the last presented
 * frame, in paint order, with the view and the exact world-to-pane matrix they were drawn at (text items with their boxes). The kit rasterises the exact
 * coverage of this geometry as its reference (FAULT-GPU.md: the truth yardstick, not canvas2d), so it describes the item's own
 * geometry, never a backend's flattening: ink as its capsule hulls and discs, paths as their commands and stroke style.
 * Off, `presentedScene` returns a no-op and keeps nothing. On, a pane's last frame stays referenced until it presents again, is
 * hidden (`forget`) or its registration is replaced; that is the price of measuring. Kept through a hide, it held a hidden
 * 10,060-stroke drawing's whole paint, so every memory kit run with the audit on read a hidden board as still holding it. */
import { auditScene, renderAuditEnabled } from '../../platform/render/renderAudit';
import type { Affine, ViewState } from '../../platform/types';
import { inkCoverageChunks, type PaintItem, type PaintSource } from './paintStream';

interface Presented { readonly frame: PaintSource; readonly view: ViewState; readonly paneTransform: Affine | null }

function describe(item: PaintItem): unknown {
    // `clips` stays the count (judges read it as a flag); each clip's own geometry is in `clipPaths`, outermost first, so the truth
    // can intersect a clipped item (a frame's child) instead of leaving it to canvas2d's weaker bar.
    const base = { kind: item.kind, node: item.nodeId, m: item.localToWorld, clips: item.clips.length,
        ...(item.clips.length ? { clipPaths: item.clips.map(clip => ({ d: clip.d, fillRule: clip.fillRule, m: clip.localToWorld })) } : {}) };
    if (item.kind === 'path') {
        const { fill, stroke, blend } = item.material;
        return { ...base, d: item.d, fillRule: item.fillRule, fill: fill ?? null, blend,
            stroke: stroke ? { color: stroke.color, width: stroke.width, cap: stroke.cap, join: stroke.join, miterLimit: stroke.miterLimit,
                dash: stroke.dash ? { array: [...stroke.dash.array], phase: stroke.dash.phase } : null } : null };
    }
    if (item.kind === 'ink') {
        const segments: number[] = [], discs: number[] = [];
        for (const chunk of inkCoverageChunks(item.coverage)) {
            for (const v of chunk.segments) segments.push(v);
            for (const v of chunk.discs) discs.push(v);
        }
        return { ...base, color: item.material.color, blend: item.material.blend, segments, discs };
    }
    // A text item's layout box, conservative ink bounds and each line's glyph extent (its fragments' span, top to bottom), in its own
    // units (`m` maps them to world): the kinds judge holds its canvas2d rule for text to the lines, so a body fault both backends
    // share is not taken for text. A sticky's box is the whole note; its lines are where the glyphs are.
    if (item.kind === 'text') {
        const { box, ink } = item.paint;
        const lines = item.paint.lines.filter(line => line.fragments.length).map(line => {
            let x0 = Infinity, x1 = -Infinity;
            for (const fragment of line.fragments) { x0 = Math.min(x0, fragment.x); x1 = Math.max(x1, fragment.x + fragment.width); }
            return { x0, x1, top: line.top, bottom: line.bottom };
        });
        return { ...base, box: { w: box.w, h: box.h }, ink: { x: ink.x, y: ink.y, width: ink.width, height: ink.height }, lines };
    }
    return base;
}

/** Registers (once per surface) and updates the scene a surface last presented. Returns the registration's removal. */
export function presentedScene(surface: string): { update(frame: PaintSource, view: ViewState, paneTransform: Affine | null): void; forget(): void; dispose(): void } {
    if (!renderAuditEnabled()) return { update() {}, forget() {}, dispose() {} };
    let last: Presented | null = null;
    const dispose = auditScene(`board:${surface}`, () => {
        if (!last) return null;
        const { frame, view, paneTransform } = last;
        const items = frame.liveOnly ? null : [...frame.underlay, ...frame.content].map(describe);
        return { revision: frame.sceneRevision, theme: frame.theme ?? null, liveOnly: !!frame.liveOnly,
            camera: view.camera, viewport: view.viewport, paneTransform, items };
    });
    return { update(frame, view, paneTransform) { last = { frame, view, paneTransform }; }, forget() { last = null; }, dispose() { last = null; dispose(); } };
}
