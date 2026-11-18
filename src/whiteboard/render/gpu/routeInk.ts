import type { Affine, ViewState } from '../../../platform/types';
import type { LayerHost } from '../../../platform/render/compositor.types';
import type { GpuPass } from '../../../platform/render/gfx/api';
import type { FrameBudget } from '../../../platform/render/types';
import { createPathCoverageKit, type PathCoverageAdmission, type PreparedPathCoverage } from '../../../platform/render/pathCoverage';
import { auditCount, renderAuditEnabled } from '../../../platform/render/renderAudit';
import type { PaintInkItem, PaintItem } from '../paintStream';
import type { Rgba } from '../../../platform/types';
import { analyticCapsule } from '../analyticInk';
import { AnalyticInkRun, createAnalyticInkRuns } from '../analyticInkBatch';
import { createInkGeometry, inkToleranceBand } from '../inkGeometry';
import type { Admission, Blend, CreateInkRoutes, InkRouteFor, ItemRoute, PreparedRun } from './contracts';

/** The only place an ink route is chosen; wet and committed ink both call it, so a stroke cannot change route between
 * its last wet frame and its first committed one. Analytic only for what the analytic route already draws today: one
 * capsule or disc, source-over. Everything else (multiply, clips, several primitives, curves, pressure) is the exact
 * union of its outline. The choice depends on the item alone, never on the view: a view can still refuse analytic
 * packing, and that refusal is reported, not re-routed. */
export const inkRouteFor: InkRouteFor = (item: PaintInkItem) => analyticCapsule(item) ? 'ink-analytic' : 'ink-union';

/** A union run: one stencil cover per stroke, so a translucent stroke is never blended with itself. Colour is not in the
 * admission: each stroke's paint is read from its item at draw, so a palette change re-admits nothing. By reading, the item's
 * chunks are one kit admission (admitSets), so the stroke's cover is one cover however many chunks it has. Across tiles, each
 * tile's admission covers only its own viewport, so a stroke spanning two tiles blends each pixel once. This route admits an
 * item the same way wet or committed; the hand-over between the two is the pane's logic, not checked here. */
class UnionInkRun implements PreparedRun {
    readonly route = 'ink-union' as const;
    constructor(readonly blend: Blend, readonly strokes: readonly PreparedPathCoverage[], readonly items: readonly PaintInkItem[],
        /** One paint per stroke, reused across draws: a draw assigns the colour, it never allocates. */
        readonly paints: readonly { colour: Rgba }[]) {}
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
    // The chunk triangles this route holds are leased from the CPU pool, the same pool its analytic staging uses.
    const geometry = createInkGeometry(host.allocator.cpu, audit);

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
            // Both blends sample the measured 4x4 grid (the proxy's sample positions). A multiply slice is laid by the kit's
            // modulate cover: each stroke multiplies k = C·c + 1 − α·c into the white slice, once per sample.
            const modulate = blend === 'modulate';
            const admitted: PreparedPathCoverage[] = [], admittedItems: PaintInkItem[] = [];
            const retireAll = (): void => { for (const stroke of admitted) kit.retire(stroke); };
            for (const item of items) {
                if (item.material.blend !== (modulate ? 'multiply' : 'normal')) { retireAll(); return { status: 'unsupported', why: 'blend-mismatch' }; }
                const [a, b, c, d] = item.localToWorld;
                const deviceScale = view.camera.z * view.viewport.dpr * Math.hypot(a, b, c, d);
                if (!(deviceScale > 0) || !Number.isFinite(deviceScale)) { retireAll(); return { status: 'unsupported', why: 'scale' }; }
                // One set per chunk, all under one affine and one stencil cover: a publication uploads only the chunks it adds.
                // Timed under the audit (gpu-h4's split of a zoom frame): the tessellation and placement of the item's chunks, in hundredths of a ms.
                const timed = renderAuditEnabled() ? performance.now() : 0;
                const stroke = geometry.strokeSets(item, inkToleranceBand(deviceScale));
                if (timed) { auditCount(audit, 'ink:strokesets-calls'); auditCount(audit, 'ink:strokesets-hundredths-ms', Math.round((performance.now() - timed) * 100)); }
                if (stroke && 'denied' in stroke) { retireAll(); return { status: 'denied', pool: 'cpu', bytes: stroke.denied }; }
                if (!stroke) { retireAll(); return { status: 'unsupported', why: 'outline-refused' }; }
                const result: PathCoverageAdmission = kit.admitSets({
                    sets: stroke.shapes, rule: 'union', affine: affineAt(item.localToWorld, stroke.origin, view), viewport: pixels(view),
                    colour: item.material.color, output: { kind: 'composite', blend: modulate ? 'modulate' : 'normal' },
                    sampling: 'grid4',
                }, budget);
                if (result.status === 'ready') { admitted.push(result.value); admittedItems.push(item); }
                else if (result.status !== 'empty') {
                    retireAll();
                    // The kit's own upload: two doubles per vertex are eight bytes, so a double is four bytes.
                    if (result.status === 'denied') {
                        let bytes = 0;
                        for (const set of stroke.sets) bytes += set.triangles.length * 4;
                        return { status: 'denied', pool: 'gpu', bytes };
                    }
                    if (result.status === 'deferred') return { status: 'deferred' };
                    return { status: 'unsupported', why: 'coverage-kit' };
                }
            }
            if (!admitted.length) return { status: 'empty' };
            const paints = admittedItems.map(item => ({ colour: item.material.color }));
            return { status: 'ready', value: new UnionInkRun(blend, admitted, admittedItems, paints) };
        },
        draw(pass: GpuPass, run: PreparedRun): void {
            if (!(run instanceof UnionInkRun)) throw new Error('Not a union ink run');
            // Routes never clip: the caller applies item clips (withClips / withPreparedClips), so this draw is unclipped.
            // The colour is the item's current colour, read here: the kit's paint argument overrides the admission's colour.
            for (let i = 0; i < run.strokes.length; i++) {
                const paint = run.paints[i];
                paint.colour = run.items[i].material.color;
                kit.draw(pass, run.strokes[i], paint);
            }
        },
        retire(run: PreparedRun): void {
            if (run instanceof UnionInkRun) for (const stroke of run.strokes) kit.retire(stroke);
        },
        release(): void { kit.release(); geometry.release(); },
        memory: () => {
            const kitBytes = kit.memory();
            return { gpuBytes: kitBytes.gpuBytes, cpuBytes: geometry.memory().cpuBytes + kitBytes.cpuBytes };
        },
    };

    return { analytic, union, evictCpu: (bytes, keep) => geometry.evictIdle(bytes, keep) };
};
