import type { PaintInkItem } from '../paintStream';
import { analyticCapsule } from '../analyticInk';
import type { InkRouteFor } from './contracts';

/** The only place an ink route is chosen; wet and committed ink both call it, so a stroke cannot change route between
 * its last wet frame and its first committed one. Analytic only for what the analytic route already draws today: one
 * capsule or disc, source-over. Everything else (multiply, clips, several primitives, curves, pressure) is the exact
 * union of its outline. The choice depends on the item alone, never on the view: a view can still refuse analytic
 * packing, and that refusal is reported, not re-routed. */
export const inkRouteFor: InkRouteFor = (item: PaintInkItem) => analyticCapsule(item) ? 'ink-analytic' : 'ink-union';
