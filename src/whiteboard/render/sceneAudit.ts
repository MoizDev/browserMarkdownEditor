/** The board's presented scene for the fidelity kit (audit only, `bme.renderAudit=1`): the paint items of the last presented
 * frame, in paint order, with the view and the exact world-to-pane matrix they were drawn at. The kit rasterises the exact
 * coverage of this geometry as its reference (FAULT-GPU.md: the truth yardstick, not canvas2d), so it describes the item's own
 * geometry, never a backend's flattening: ink as its capsule hulls and discs, paths as their commands and stroke style.
 * Off, `presentedScene` returns a no-op and keeps nothing. On, a pane's last frame stays referenced until it presents again or
 * its registration is replaced; that is the price of measuring. */
import { auditScene, renderAuditEnabled } from '../../platform/render/renderAudit';
import type { Affine, ViewState } from '../../platform/types';
import { inkCoverageChunks, type PaintItem, type PaintSource } from './paintStream';

interface Presented { readonly frame: PaintSource; readonly view: ViewState; readonly paneTransform: Affine | null }

function describe(item: PaintItem): unknown {
    const base = { kind: item.kind, node: item.nodeId, m: item.localToWorld, clips: item.clips.length };
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
    return base;
}

/** Registers (once per surface) and updates the scene a surface last presented. Returns the registration's removal. */
export function presentedScene(surface: string): { update(frame: PaintSource, view: ViewState, paneTransform: Affine | null): void; dispose(): void } {
    if (!renderAuditEnabled()) return { update() {}, dispose() {} };
    let last: Presented | null = null;
    const dispose = auditScene(`board:${surface}`, () => {
        if (!last) return null;
        const { frame, view, paneTransform } = last;
        const items = frame.liveOnly ? null : [...frame.underlay, ...frame.content].map(describe);
        return { revision: frame.sceneRevision, theme: frame.theme ?? null, liveOnly: !!frame.liveOnly,
            camera: view.camera, viewport: view.viewport, paneTransform, items };
    });
    return { update(frame, view, paneTransform) { last = { frame, view, paneTransform }; }, dispose() { last = null; dispose(); } };
}
