import type { Affine, Rect } from '../../platform/types';
import type { ConnectorNode } from '../model/nodes';
import type { Arrowhead } from '../model/styles';
import { transformPoint } from './affine';
import { connectorBody } from './connectors';
import { bodyCrossingSteps, bodyLength, pointAtLength, tangentAtLength, trimBodyPath } from './connectorPath';
import type { AttachmentSurface, ConnectorBody, ConnectorGeometryRequest, ConnectorGeometryResult, ConnectorLabelPaint, ResolvedConnectorEnd } from './connectorTypes';
import { routeElbowSteps } from './elbow';
import { connectorSurfaceContains, connectorSurfaceIntervals } from './connectorContourProbe';
import { connectorHeadScale, headGeometry } from './heads';
import type { PathOp, Vec2 } from './path';
import { transformedPathBounds } from './providers';
import { styleGeometryMetrics } from './styleMetrics';

const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];
function aim(node: ConnectorNode, terminal: 'start' | 'end', matrix: Affine, surface: AttachmentSurface | undefined): Vec2 {
    const end = node[terminal], a = end.attach;
    if (!a || !surface) return transformPoint(matrix, end);
    const box = surface.logicalBox, precise = a.precise || a.exact;
    return transformPoint(surface.localToWorld, { x: box.x + box.width * (precise ? a.anchor.x : .5),
        y: box.y + box.height * (precise ? a.anchor.y : .5) });
}
function union(a: Rect | null, b: Rect): Rect {
    if (!a) return b;
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}
function closedHead(kind: Arrowhead): boolean { return !['none', 'arrow', 'pipe'].includes(kind); }

/** One independent provider for free/attached arcs and received rectilinear
 * routes. It returns an explicit refusal for a route without a valid candidate;
 * the load admission owner must preserve original bytes/read-only in that case. */
type LabelWork = { readonly kind: 'label'; readonly position: Vec2; readonly length: number };
function* connectorSteps(request: ConnectorGeometryRequest, resolveLabel: boolean):
    Generator<void | LabelWork, ConnectorGeometryResult, ConnectorLabelPaint | null> {
    const { node, toleranceWorld: error, maxPieces } = request;
    if (!Number.isFinite(error) || error <= 0 || !Number.isSafeInteger(maxPieces) || maxPieces < 1
        || !request.localToWorld.every(Number.isFinite)) throw new RangeError('Invalid connector geometry budget');
    const startTarget = node.start.attach ? request.resolveTarget(node.start.attach.target) : undefined;
    const endTarget = node.end.attach ? request.resolveTarget(node.end.attach.target) : undefined;
    if ((node.start.attach && !startTarget) || (node.end.attach && !endTarget)) return { status: 'pending', reason: 'target' };
    const a = aim(node, 'start', request.localToWorld, startTarget), b = aim(node, 'end', request.localToWorld, endTarget);
    let route: readonly Vec2[] | undefined;
    if (node.route === 'elbow') {
        const gap = Math.max(12, node.width * 6);
        let escape: Rect = { x: Math.min(a.x, b.x) - gap, y: Math.min(a.y, b.y) - gap,
            width: Math.abs(a.x - b.x) + gap * 2, height: Math.abs(a.y - b.y) + gap * 2 };
        for (const target of [startTarget, endTarget]) if (target) {
            const box = target.logicalBox;
            const corners = [{ x: box.x, y: box.y }, { x: box.x + box.width, y: box.y },
                { x: box.x, y: box.y + box.height }, { x: box.x + box.width, y: box.y + box.height }].map(p => transformPoint(target.localToWorld, p));
            const x = Math.min(...corners.map(p => p.x)) - gap, y = Math.min(...corners.map(p => p.y)) - gap;
            escape = union(escape, { x, y, width: Math.max(...corners.map(p => p.x)) + gap - x, height: Math.max(...corners.map(p => p.y)) + gap - y });
        }
        const selected = yield* routeElbowSteps({ start: a, end: b, mid: node.elbowMid, escape,
            *validPort(points, terminal) {
                const target = terminal === 'start' ? startTarget : endTarget, end = node[terminal];
                if (!target || end.attach?.exact) return true;
                return yield* connectorSurfaceContains(target, terminal === 'start' ? points[0] : points[points.length - 1], maxPieces);
            },
            *crossesForbidden(points) {
                for (const [target, terminal] of [[startTarget, 'start'], [endTarget, 'end']] as const) {
                    if (!target || node[terminal].attach?.exact) continue;
                    const value = yield* connectorSurfaceIntervals(target, points, error, maxPieces);
                    if (value.parts.length > 1) return true;
                    if (value.parts.length && (terminal === 'start' ? value.parts[0].from > error : value.length - value.parts[0].to > error)) return true;
                }
                return false;
            } });
        if (selected.status === 'unroutable') return { status: 'unroutable', connector: node.id, reason: 'Every received elbow candidate crosses a target or leaves an invalid port' };
        route = selected.points;
    }
    // Only the observed default threshold bracket is available; v1 chooses its
    // lower straight endpoint (6 at width2), without rewriting stored bend.
    const metric = styleGeometryMetrics.bendThreshold(node.size, node.width);
    const threshold = metric.status === 'bracket' ? metric.min : metric.status === 'provisional' ? metric.value : node.width * 3;
    const bodies: ConnectorBody[] = route && route.length > 1 ? route.slice(1).map((point, i) => connectorBody(route![i], point, 0, error))
        : [connectorBody(a, b, Math.abs(node.bend) <= threshold ? 0 : node.bend, error)];
    const offsets = [0];
    for (const body of bodies) offsets.push(offsets[offsets.length - 1] + bodyLength(body));
    const total = offsets[offsets.length - 1];
    const locate = (distance: number) => {
        const value = Math.max(0, Math.min(total, distance));
        let i = 0; while (i + 1 < bodies.length && offsets[i + 1] < value) i++;
        return { body: bodies[i], distance: value - offsets[i] };
    };
    const point = (distance: number) => { const value = locate(distance); return pointAtLength(value.body, value.distance); };
    const tangent = (distance: number, direction: 1 | -1) => { const value = locate(distance); return tangentAtLength(value.body, value.distance, direction); };
    const crossings = function* (target: AttachmentSurface): Generator<void, { distance: number; entering: boolean }[]> {
        const result: { distance: number; entering: boolean }[] = [];
        for (let i = 0; i < bodies.length; i++) {
            for (const hit of yield* bodyCrossingSteps(bodies[i], target, error, maxPieces)) result.push({ distance: offsets[i] + hit.distance, entering: hit.entering });
            yield;
        }
        return result;
    };
    let startBoundary = 0, endBoundary = total, startConnected = false, endConnected = false;
    if (startTarget && !node.start.attach!.exact) {
        const values = yield* crossings(startTarget), first = values[0];
        startConnected = yield* connectorSurfaceContains(startTarget, a, maxPieces);
        // Only the component connected to the terminal may be removed.
        if (first && !first.entering) { startBoundary = first.distance; startConnected = true; }
        else if (!values.length && total > 0 && startConnected && (yield* connectorSurfaceContains(startTarget, point(total / 2), maxPieces))) {
            startBoundary = total; startConnected = true;
        }
    }
    if (endTarget && !node.end.attach!.exact) {
        const values = yield* crossings(endTarget), last = values[values.length - 1];
        endConnected = yield* connectorSurfaceContains(endTarget, b, maxPieces);
        if (last?.entering) { endBoundary = last.distance; endConnected = true; }
        else if (!values.length && total > 0 && endConnected && (yield* connectorSurfaceContains(endTarget, point(total / 2), maxPieces))) {
            endBoundary = 0; endConnected = true;
        }
    }
    const span = Math.max(0, endBoundary - startBoundary);
    // v1 uses the recorded default rectangular gap, scaled only by actual width.
    let startGap = startConnected ? 6 * node.width : 0;
    let endGap = endConnected ? 6 * node.width : 0;
    const gapScale = startGap + endGap > span ? span / (startGap + endGap) : 1;
    startGap *= gapScale; endGap *= gapScale;
    const from = Math.min(total, startBoundary + startGap), to = Math.max(from, endBoundary - endGap);
    const startTip = point(from), endTip = point(to), startTangent = tangent(from, -1), endTangent = tangent(to, 1);
    const head = (kind: Arrowhead, tip: Vec2, vector: Vec2, scale: number) => headGeometry({ kind, tip, tangent: vector,
        width: node.width, scale, tolerance: error, maxPieces });
    const fullStart = head(node.headStart, startTip, startTangent.vector, 1), fullEnd = head(node.headEnd, endTip, endTangent.vector, 1);
    const scale = connectorHeadScale(fullStart.reserve, fullEnd.reserve, to - from);
    const hs = head(node.headStart, startTip, startTangent.vector, scale), he = head(node.headEnd, endTip, endTangent.vector, scale);
    const bodyFrom = Math.min(to, from + (closedHead(node.headStart) ? hs.reserve : 0));
    const bodyTo = Math.max(bodyFrom, to - (closedHead(node.headEnd) ? he.reserve : 0));
    const body: PathOp[] = [];
    for (let i = 0; i < bodies.length; i++) {
        if (offsets[i + 1] < bodyFrom || offsets[i] > bodyTo) continue;
        body.push(...trimBodyPath(bodies[i], Math.max(0, bodyFrom - offsets[i]), Math.min(bodyLength(bodies[i]), bodyTo - offsets[i]), error, maxPieces));
        if (body.length > maxPieces) throw new RangeError('Connector path budget exceeded');
    }
    const label = resolveLabel ? yield { kind: 'label', position: point(from + (to - from) * node.labelAt), length: to - from } : request.label;
    const exclusions: { outline: readonly PathOp[]; localToWorld: Affine }[] = [];
    if (label) {
        const { w, h } = label.paint.box;
        // The plan leaves halo calibration open; v1 pads each label by four units.
        exclusions.push({ outline: [{ op: 'M', p: { x: -4, y: -4 } }, { op: 'L', p: { x: w + 4, y: -4 } },
            { op: 'L', p: { x: w + 4, y: h + 4 } }, { op: 'L', p: { x: -4, y: h + 4 } }, { op: 'Z' }], localToWorld: label.localToWorld });
    }
    const heads = [...hs.paths, ...he.paths];
    let bounds: Rect | null = null;
    for (const path of [body, ...heads]) { const box = transformedPathBounds(path, IDENTITY); if (box) bounds = union(bounds, box); }
    bounds ??= { x: startTip.x, y: startTip.y, width: 0, height: 0 };
    bounds = { x: bounds.x - node.width / 2, y: bounds.y - node.width / 2, width: bounds.width + node.width, height: bounds.height + node.width };
    if (label) {
        const box = label.paint.ink;
        const outline: PathOp[] = [{ op: 'M', p: { x: box.x, y: box.y } }, { op: 'L', p: { x: box.x + box.width, y: box.y } },
            { op: 'L', p: { x: box.x + box.width, y: box.y + box.height } }, { op: 'L', p: { x: box.x, y: box.y + box.height } }, { op: 'Z' }];
        const labelBounds = transformedPathBounds(outline, label.localToWorld); if (labelBounds) bounds = union(bounds, labelBounds);
    }
    const resolved = (terminal: 'start' | 'end', distance: number, tip: Vec2, direction: typeof startTangent): ResolvedConnectorEnd => ({
        aimWorld: terminal === 'start' ? a : b, boundaryWorld: point(distance), tipWorld: tip, tangentWorld: direction.vector,
        degenerate: direction.degenerate, target: node[terminal].attach?.target ?? null });
    return { status: 'ready', geometry: { key: request.key, start: resolved('start', startBoundary, startTip, startTangent),
        end: resolved('end', endBoundary, endTip, endTangent), body, heads, label,
        editMetrics: { anchorWorld: point(from + (to - from) * node.labelAt), bodyLength: to - from },
        bodyExclusions: exclusions, inkBoundsWorld: bounds } };
}

export function resolveConnectorGeometryNow(request: ConnectorGeometryRequest, options: {
    label?: (position: Vec2, bodyLength: number) => ConnectorLabelPaint | null;
} = {}): ConnectorGeometryResult {
    const steps = connectorSteps(request, !!options.label);
    let input: ConnectorLabelPaint | null = null;
    for (;;) {
        const next = steps.next(input);
        if (next.done) return next.value;
        input = next.value?.kind === 'label' ? options.label!(next.value.position, next.value.length) : null;
    }
}

export async function resolveConnectorGeometry(request: ConnectorGeometryRequest, options: {
    signal: AbortSignal;
    cooperate?: () => Promise<void>;
    label?: (position: Vec2, bodyLength: number, signal: AbortSignal) => Promise<ConnectorLabelPaint | null>;
}): Promise<ConnectorGeometryResult> {
    const steps = connectorSteps(request, !!options.label), signal = options.signal;
    let input: ConnectorLabelPaint | null = null, count = 0, started = performance.now();
    signal.throwIfAborted();
    for (;;) {
        const next = steps.next(input); input = null;
        if (next.done) { signal.throwIfAborted(); return next.value; }
        if (next.value?.kind === 'label') {
            input = await options.label!(next.value.position, next.value.length, signal);
            signal.throwIfAborted();
        } else if (++count >= 256 || performance.now() - started >= 3) {
            signal.throwIfAborted();
            await (options.cooperate?.() ?? new Promise<void>(resolve => setTimeout(resolve, 0)));
            signal.throwIfAborted(); count = 0; started = performance.now();
        }
    }
}
