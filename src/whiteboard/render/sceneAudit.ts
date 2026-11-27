import { auditScene, renderAuditEnabled } from '../../platform/render/renderAudit';
import type { Affine, ViewState } from '../../platform/types';
import { inkCoverageChunks, type PaintItem, type PaintSource } from './paintStream';

interface Presented { readonly frame: PaintSource; readonly view: ViewState; readonly paneTransform: Affine | null }

function describe(item: PaintItem): unknown {
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
    if (item.kind === 'text') {
        const { box, ink } = item.paint;
        const lines = item.paint.lines.filter(line => line.fragments.length).map(line => {
            let x0 = Infinity, x1 = -Infinity;
            for (const fragment of line.fragments) { x0 = Math.min(x0, fragment.x); x1 = Math.max(x1, fragment.x + fragment.width); }
            return { x0, x1, top: line.top, bottom: line.bottom };
        });
        return { ...base, box: { w: box.w, h: box.h }, ink: { x: ink.x, y: ink.y, width: ink.width, height: ink.height }, lines };
    }
    if (item.kind === 'image') return { ...base, rect: { x: item.rect.x, y: item.rect.y, width: item.rect.width, height: item.rect.height }, opacity: item.opacity };
    return base;
}

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
