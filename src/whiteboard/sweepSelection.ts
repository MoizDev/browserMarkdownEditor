import { compose, singularValues, transformPoint } from './geom/affine';
import { nextDown, nextUp } from './geom/numeric';
import type { Vec2 } from './geom/path';
import { SpatialPickJob, sweptSelectionCursor } from './pick';
import type { SweepSelectionServices } from './sweepSelection.types';

// Each real segment gets the shared scene's conservative world-space AABB;
// shape coverage and every ancestor clip are resolved by the narrow-phase service.
export function beginSweptSelection(services: SweepSelectionServices, from: Vec2, to: Vec2, topOnly: boolean) {
    const state = services.selection.getSnapshot(), transform = services.worldToSurface;
    if (![from.x, from.y, to.x, to.y, services.radiusCss, ...transform].every(Number.isFinite) || services.radiusCss < 0) throw new RangeError('Invalid swept selection');
    const [maximumScale, minimumScale] = singularValues(transform);
    const lowerScale = nextDown(minimumScale - 64 * Number.EPSILON * maximumScale);
    if (!(lowerScale > 0)) throw new RangeError('Swept selection needs a well-conditioned presented camera');
    const radius = nextUp(services.radiusCss / lowerScale);
    const box = [nextDown(Math.min(from.x, to.x) - radius), nextDown(Math.min(from.y, to.y) - radius),
        nextUp(Math.max(from.x, to.x) + radius), nextUp(Math.max(from.y, to.y) + radius)] as const;
    if (!box.every(Number.isFinite)) throw new RangeError('Swept selection bounds overflow');
    const points = [transformPoint(transform, from), transformPoint(transform, to)];
    const cursor = services.scene.spatialCursor({ sheetId: state.sheet, request: { kind: 'box', box }, purpose: 'selectable' });
    const job = new SpatialPickJob(cursor, {
        isCurrent: () => services.isCurrent() && services.selection.getSnapshot().sheet === state.sheet && services.selection.getSnapshot().focus === state.focus,
        begin: ref => services.beginNarrow(ref, { kind: 'swept', points, radiusCss: services.radiusCss, localToSurface: compose(transform, ref.localToWorld) }),
        partPriority: part => services.partPriority(part),
    }, services.doc, state.sheet, state.focus);
    return sweptSelectionCursor(job, topOnly);
}
