import type { Affine, ViewState } from '../../../platform/types';
import type { LayerHost } from '../../../platform/render/compositor.types';
import type { GpuPass } from '../../../platform/render/gfx/api';
import type { FrameBudget } from '../../../platform/render/types';
import { createPathCoverageKit, type PathCoverageAdmission, type PreparedPathCoverage } from '../../../platform/render/pathCoverage';
import { auditCount } from '../../../platform/render/renderAudit';
import type { PaintInkItem, PaintItem } from '../paintStream';
import { analyticCapsule } from '../analyticInk';
import { AnalyticInkRun, createAnalyticInkRuns } from '../analyticInkBatch';
import { inkStrokeTriangles, inkToleranceBand } from '../inkGeometry';
import type { Admission, Blend, CreateInkRoutes, InkRouteFor, ItemRoute, PreparedRun } from './contracts';

/** The only place an ink route is chosen; wet and committed ink both call it, so a stroke cannot change route between
 * its last wet frame and its first committed one. Analytic only for what the analytic route already draws today: one
 * capsule or disc, source-over. Everything else (multiply, clips, several primitives, curves, pressure) is the exact
 * union of its outline. The choice depends on the item alone, never on the view: a view can still refuse analytic
 * packing, and that refusal is reported, not re-routed. */
export const inkRouteFor: InkRouteFor = (item: PaintInkItem) => analyticCapsule(item) ? 'ink-analytic' : 'ink-union';

const NO_TRIANGLES = new Float64Array(0);

/** A union run: one stencil cover per stroke, so a translucent stroke is never blended with itself. */
class UnionInkRun implements PreparedRun {
    readonly route = 'ink-union' as const;
    constructor(readonly blend: Blend, readonly strokes: readonly PreparedPathCoverage[]) {}
}

function pixels(view: ViewState): { width: number; height: number } {
    return { width: Math.round(view.viewport.width * view.viewport.dpr), height: Math.round(view.viewport.height * view.viewport.dpr) };
}
/** Origin-relative local to device affine: the item's transform and the view applied once, with the origin folded in. */
function affineAt(localToWorld: Affine, origin: Readonly<{ x: number; y: number }>, view: ViewState): Affine {
    const [a, b, c, d, e, f] = localToWorld;
    const s = view.camera.z * view.viewport.dpr;
    return [s * a, s * b, s * c, s * d, s * (a * origin.x + c * origin.y + e - view.camera.x), s * (b * origin.x + d * origin.y + f - view.camera.y)];
}

/** Ink factories: one analytic route and one exact-union route, both sharing the device's pipelines and memory accounting.
 * The audit surface is the adapter's name, so counts land beside the counts they replace. */
export const createInkRoutes: CreateInkRoutes = (host: LayerHost, audit: string) => {
    const runs = createAnalyticInkRuns(host, audit);
    const kit = createPathCoverageKit(host, () => auditCount(audit, 'error:coverage-kit'));

    const analytic: ItemRoute<PaintInkItem> = {
        id: 'ink-analytic',
        accepts: (item: PaintItem): item is PaintInkItem => item.kind === 'ink' && inkRouteFor(item) === 'ink-analytic',
        admit(items, view, blend, budget) {
            if (blend !== 'over') return { status: 'unsupported', why: 'analytic-multiply' };
            return runs.admit(items, view, budget);
        },
        draw(pass: GpuPass, run: PreparedRun): void {
            if (!(run instanceof AnalyticInkRun)) throw new Error('Not an analytic ink run');
            runs.draw(pass, run);
        },
        retire(run: PreparedRun): void { if (run instanceof AnalyticInkRun) runs.retire(run); },
        release(): void { runs.release(); },
        memory: () => runs.memory(),
    };

    const union: ItemRoute<PaintInkItem> = {
        id: 'ink-union',
        accepts: (item: PaintItem): item is PaintInkItem => item.kind === 'ink' && inkRouteFor(item) === 'ink-union',
        admit(items, view, blend, budget): Admission<PreparedRun> {
            // TODO(gpu-h5): 'modulate' needs h4's kit cover variant (step 4) and h10's device blend; until both land a
            // multiply slice is refused, so it is counted by the composer rather than drawn with the wrong blend.
            if (blend === 'modulate') return { status: 'unsupported', why: 'modulate-cover-pending' };
            const admitted: PreparedPathCoverage[] = [];
            const retireAll = (): void => { for (const stroke of admitted) kit.retire(stroke); };
            for (const item of items) {
                if (item.material.blend !== 'normal') { retireAll(); return { status: 'unsupported', why: 'blend-mismatch' }; }
                const [a, b, c, d] = item.localToWorld;
                const deviceScale = view.camera.z * view.viewport.dpr * Math.hypot(a, b, c, d);
                if (!(deviceScale > 0) || !Number.isFinite(deviceScale)) { retireAll(); return { status: 'unsupported', why: 'scale' }; }
                const stroke = inkStrokeTriangles(item, inkToleranceBand(deviceScale), audit);
                if (!stroke) { retireAll(); return { status: 'unsupported', why: 'outline-refused' }; }
                const result: PathCoverageAdmission = kit.admit({
                    shapes: { positive: stroke.triangles, negative: NO_TRIANGLES, edges: stroke.edges, bounds: stroke.bounds },
                    rule: 'union', affine: affineAt(item.localToWorld, stroke.origin, view), viewport: pixels(view),
                    colour: item.material.color, output: { kind: 'composite', blend: 'normal' }, supersample: true,
                }, budget);
                if (result.status === 'ready') admitted.push(result.value);
                else if (result.status !== 'empty') {
                    retireAll();
                    // The kit's own upload: two doubles per vertex are eight bytes, so a double is four bytes.
                    if (result.status === 'denied') return { status: 'denied', pool: 'gpu', bytes: stroke.triangles.length * 4 };
                    if (result.status === 'deferred') return { status: 'deferred' };
                    return { status: 'unsupported', why: 'coverage-kit' };
                }
            }
            if (!admitted.length) return { status: 'empty' };
            return { status: 'ready', value: new UnionInkRun(blend, admitted) };
        },
        draw(pass: GpuPass, run: PreparedRun): void {
            if (!(run instanceof UnionInkRun)) throw new Error('Not a union ink run');
            // TODO(gpu-h5): draw under each item's clips through withClips (G/routePath.ts, h4) once it lands. Until then
            // clipped ink draws unclipped, which is wrong for it; the switch that routes clipped ink here waits for that.
            for (const stroke of run.strokes) kit.draw(pass, stroke);
        },
        retire(run: PreparedRun): void {
            if (run instanceof UnionInkRun) for (const stroke of run.strokes) kit.retire(stroke);
        },
        release(): void { kit.release(); },
        memory: () => kit.memory(),
    };

    return { analytic, union };
};
