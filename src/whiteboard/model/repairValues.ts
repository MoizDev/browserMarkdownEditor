import { NODE_FILE_FIELDS } from './fileFields';
import type { RawJson } from './json';
import type { LoadRepairNotice } from './loadTypes';
import type { MediaEntry, MediaId } from './media';
import type { ConnectorEnd, NodeRecord, Point } from './nodes';
import { MAX_COORDINATE } from './validate';

// Provenance: document-model §9.2, model validate/nodes/defaults; independent
// load-only repair, no third-party or tldraw source.
type NumericKey = 'x' | 'y' | 'rotation' | 'opacity' | 'w' | 'h' | 'width' | 'sx' | 'sy'
    | 'growY' | 'time' | 'scale' | 'labelScale' | 'fit' | 'bend' | 'elbowMid' | 'labelAt'
    | 'geomVersion' | 'fairTol';
const TAU = Math.PI * 2;
const clamp = (value: number, min: number, max: number, fallback: number): number =>
    Number.isNaN(value) ? fallback : Math.max(min, Math.min(max, value));

export async function repairNodeValues(nodes: readonly NodeRecord[], media: readonly MediaEntry[], options: {
    cooperate?: () => Promise<void>; signal?: AbortSignal;
}): Promise<{ nodes: readonly NodeRecord[]; changedOrdinals: ReadonlySet<number>; notices: readonly LoadRepairNotice[]; readOnlyReason: string | null }> {
    const result: NodeRecord[] = [], changed = new Set<number>(), messages = new Map<string, string[]>();
    const mediaIds = new Set<MediaId>();
    let steps = 0;
    const tick = async () => {
        if (options.signal?.aborted) throw new DOMException('Board admission cancelled', 'AbortError');
        await options.cooperate?.();
        if (options.signal?.aborted) throw new DOMException('Board admission cancelled', 'AbortError');
    };
    await tick();
    for (const entry of media) {
        if ((steps++ & 255) === 0) await tick();
        mediaIds.add(entry.id);
    }
    const notice = (code: string, id: string) => {
        const ids = messages.get(code);
        if (ids) ids.push(id); else messages.set(code, [id]);
    };
    let refusal: string | null = null;
    for (let i = 0; i < nodes.length; i++) {
        if ((steps++ & 255) === 0) await tick();
        const original = nodes[i];
        if (original.kind === 'opaque') { result.push(original); continue; }
        let node = original;
        let numericChanged = false, mediaChanged = false;
        const set = (key: keyof typeof NODE_FILE_FIELDS, value: unknown) => {
            if (Object.is(Reflect.get(node, key), value)) return;
            if (NODE_FILE_FIELDS[key].some(token => node.ext?.raw.has(token))) {
                refusal = `Repair would override preserved ${key} on node ${node.id}`; return;
            }
            node = { ...node, [key]: value } as Exclude<NodeRecord, { kind: 'opaque' }>;
            numericChanged = true;
        };
        const range = (key: NumericKey, min: number, max: number, fallback: number) => {
            const value = Reflect.get(node, key) as number;
            set(key, clamp(value, min, max, fallback));
        };
        for (const key of ['x', 'y'] as const) {
            const value = node[key];
            set(key, Number.isFinite(value) ? clamp(value, -MAX_COORDINATE, MAX_COORDINATE, 0) : 0);
        }
        let rotation = !Number.isFinite(node.rotation) ? 0 : node.rotation >= 0 && node.rotation < TAU
            ? node.rotation : node.rotation % TAU;
        if (rotation < 0) rotation += TAU;
        if (rotation >= TAU) rotation = 0;
        set('rotation', rotation);
        range('opacity', 0, 1, 1);
        if ('w' in node) range('w', 1, 1_000_000, 1);
        if ('h' in node) range('h', 1, 1_000_000, 1);
        if ('width' in node) range('width', 0.05, 500, 0.05);
        if ('growY' in node) range('growY', 0, Number.MAX_VALUE, 0);
        if ('scale' in node) range('scale', 0.01, 100, 1);
        if ('labelScale' in node) range('labelScale', 0.01, 100, 1);
        if (node.kind === 'stroke') {
            for (const key of ['sx', 'sy'] as const) {
                const value = clamp(node[key], -1_000_000, 1_000_000, 1);
                set(key, value === 0 ? 1 : value);
            }
            range('fairTol', 0, 1, 0);
            set('geomVersion', Math.round(clamp(node.geomVersion, 1, 65535, 1)));
            if (node.kind === 'stroke' && node.widthModel.id === 'pressure-linear-v1') {
                const rMin = clamp(node.widthModel.rMin, 0, Number.MAX_VALUE, 0);
                const rMax = clamp(node.widthModel.rMax, rMin, Number.MAX_VALUE, rMin);
                if (rMin !== node.widthModel.rMin || rMax !== node.widthModel.rMax) set('widthModel', { ...node.widthModel, rMin, rMax });
            }
        }
        if (node.kind === 'sticky' && node.fit !== null) range('fit', Number.MIN_VALUE, 100, 1);
        if (node.kind === 'clip') range('time', 0, Number.MAX_VALUE, 0);
        if (node.kind === 'connector') {
            range('bend', -1_000_000, 1_000_000, 0);
            range('elbowMid', 0, 1, 0.5); range('labelAt', 0, 1, 0.5);
            const repairEnd = (end: ConnectorEnd): ConnectorEnd => {
                const x = clamp(end.x, -MAX_COORDINATE, MAX_COORDINATE, 0), y = clamp(end.y, -MAX_COORDINATE, MAX_COORDINATE, 0);
                const a = end.attach;
                const ax = a ? clamp(a.anchor.x, 0, 1, 0.5) : 0, ay = a ? clamp(a.anchor.y, 0, 1, 0.5) : 0;
                if (x === end.x && y === end.y && (!a || (ax === a.anchor.x && ay === a.anchor.y))) return end;
                return { ...end, x, y, attach: a ? { ...a, anchor: { x: ax, y: ay } } : null };
            };
            const start = repairEnd(node.start), end = repairEnd(node.end);
            if (start !== node.start) set('start', start);
            if (end !== node.end) set('end', end);
        }
        if (node.kind === 'polyline') {
            const points: Point[] = [];
            let modified = false;
            for (const point of node.points) {
                if ((steps++ & 255) === 0) await tick();
                const x = clamp(point.x, -MAX_COORDINATE, MAX_COORDINATE, 0), y = clamp(point.y, -MAX_COORDINATE, MAX_COORDINATE, 0);
                if (x !== point.x || y !== point.y) { points.push({ x, y }); modified = true; } else points.push(point);
            }
            if (modified) set('points', points);
        }
        if (node.kind === 'picture' && node.crop) {
            const crop = node.crop;
            let x0 = clamp(crop.x0, 0, 1, 0), x1 = clamp(crop.x1, 0, 1, 1);
            let y0 = clamp(crop.y0, 0, 1, 0), y1 = clamp(crop.y1, 0, 1, 1);
            if (x0 > x1) [x0, x1] = [x1, x0];
            if (y0 > y1) [y0, y1] = [y1, y0];
            if (x0 === x1) { x0 = 0; x1 = 1; }
            if (y0 === y1) { y0 = 0; y1 = 1; }
            if (x0 !== crop.x0 || x1 !== crop.x1 || y0 !== crop.y0 || y1 !== crop.y1) set('crop', { ...crop, x0, x1, y0, y1 });
        }
        if ((node.kind === 'picture' || node.kind === 'clip') && node.media !== null && !mediaIds.has(node.media)) {
            const raw = new Map(node.ext?.raw);
            if (raw.has('media')) refusal = `Repair would override preserved media on node ${node.id}`;
            else {
                // This token is generated from the already decoded, typed media id.
                raw.set('media', JSON.stringify(node.media) as RawJson);
                node = { ...node, media: null, ext: { fields: node.ext?.fields ?? new Map(), raw } };
                mediaChanged = true;
            }
        }
        result.push(node);
        if (numericChanged || mediaChanged) changed.add(i);
        if (numericChanged) notice('numeric', node.id);
        if (mediaChanged) notice('missing-media', node.id);
        if (refusal) break;
    }
    return { nodes: refusal ? nodes : result, changedOrdinals: changed,
        notices: [...messages].map(([code, nodeIds]) => ({ code, count: nodeIds.length, nodeIds })), readOnlyReason: refusal };
}
