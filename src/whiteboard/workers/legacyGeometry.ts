import type { Affine } from '../../platform/types';
import type { RenderToken } from '../../platform/render/types';
import { worldPose } from '../change/coordinates';
import { compose, inverse } from '../geom/affine';
import { transformBox, validBox, type Box } from '../geom/bounds';
import { transformedPathBounds } from '../geom/providers';
import type { LegacyGeometry, LegacyTextLayout } from '../import/worldBounds';
import { SampleStore } from '../ink/samples';
import { MediaStore } from '../media/store';
import { UI_DEFAULTS, VIEW_DEFAULTS } from '../model/defaults';
import type { Sheet } from '../model/doc';
import { nodeId, sheetId, type NodeId, type ParentId, type SheetId } from '../model/ids';
import { createLoadedBoardDoc } from '../model/loadDocument';
import type { Node } from '../model/nodes';
import { createBoardRenderServices } from '../render/services';
import { BoardFonts } from '../text/fonts';

export interface LegacyGeometryOptions {
    readonly token: RenderToken;
    readonly fonts: BoardFonts;
    readonly samples: SampleStore;
    readonly media: MediaStore;
    readonly current: () => boolean;
    readonly cooperate?: () => Promise<void>;
}
interface RecordGeometry {
    readonly node: Readonly<Node>;
    readonly prepared: Awaited<ReturnType<ReturnType<typeof createBoardRenderServices>['prepareForPick']>>;
    readonly connectorToLocal?: Affine;
}
function union(a: Box | undefined, b: Box): Box {
    if (!validBox(b)) throw new Error('Invalid legacy geometry bounds');
    return a ? [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])] : b;
}
function transform(box: Box, matrix: Affine): Box {
    const value = new Float64Array(4); transformBox(value, 0, box, 0, matrix, 0);
    return [value[0], value[1], value[2], value[3]];
}
function rect(x: number, y: number, width: number, height: number): Box { return [x, y, x + width, y + height]; }
function poseMatrix(pose: ReturnType<typeof worldPose>): Affine {
    const c = Math.cos(pose.rotation), s = Math.sin(pose.rotation); return [c, s, -s, c, pose.x, pose.y];
}

/** Supplies import's synchronous bounds reader from a fully prepared worker renderer.
 * Ordered records remain distinct even when legacy IDs collide. */
export function createLegacyDraftGeometry(options: LegacyGeometryOptions): {
    readonly prepareGeometry: (nodes: readonly Node[], sheets: readonly Sheet[], signal?: AbortSignal) => Promise<void>;
    readonly geometry: LegacyGeometry;
    readonly textLayout: LegacyTextLayout;
    dispose(): void;
} {
    if (!(options.fonts instanceof BoardFonts) || !(options.samples instanceof SampleStore) || !(options.media instanceof MediaStore)
        || typeof options.current !== 'function') throw new TypeError('Legacy geometry needs the real worker font, sample and media owners');
    const lifetime = new AbortController(), cooperate = options.cooperate ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
    let disposed = false, busy = false, renderer: ReturnType<typeof createBoardRenderServices> | null = null;
    let scope: { release(): void } | null = null, records = new Map<Readonly<Node>, RecordGeometry>();
    const check = (signal?: AbortSignal) => {
        lifetime.signal.throwIfAborted(); signal?.throwIfAborted();
        if (disposed || !options.current()) throw new DOMException('Legacy geometry source ended', 'AbortError');
    };
    const requireRecord = (node: Readonly<Node>) => {
        check(); const value = records.get(node); if (!value) throw new Error(`Legacy geometry is not prepared for ${node.id}`); return value;
    };
    const geometry: LegacyGeometry = {
        worldBounds(node, target) {
            const { prepared, connectorToLocal } = requireRecord(node);
            let box: Box | undefined;
            if (node.kind === 'connector') {
                if (!prepared.connector || !connectorToLocal) throw new Error(`Legacy connector geometry is unavailable: ${node.id}`);
                const world = compose(target, connectorToLocal), rx = node.width / 2 * Math.hypot(world[0], world[2]), ry = node.width / 2 * Math.hypot(world[1], world[3]);
                for (const path of [prepared.connector.body, ...prepared.connector.heads]) {
                    const r = transformedPathBounds(path, world);
                    if (r) box = union(box, [r.x - rx, r.y - ry, r.x + r.width + rx, r.y + r.height + ry]);
                }
                if (prepared.connector.label) {
                    const label = prepared.connector.label, r = label.paint.ink;
                    box = union(box, transform(rect(r.x, r.y, r.width, r.height), compose(world, label.localToWorld)));
                }
            } else if (node.kind === 'stroke') {
                if (!prepared.ink) throw new Error(`Legacy stroke geometry is unavailable: ${node.id}`);
                const rx = Math.hypot(target[0], target[2]), ry = Math.hypot(target[1], target[3]);
                const point = (x: number, y: number, radius: number) => {
                    const px = target[0] * x + target[2] * y + target[4], py = target[1] * x + target[3] * y + target[5];
                    box = union(box, [px - radius * rx, py - radius * ry, px + radius * rx, py + radius * ry]);
                };
                for (const part of prepared.ink) {
                    for (let i = 0; i < part.segments.length; i += 6) {
                        point(part.segments[i], part.segments[i + 1], part.segments[i + 2]);
                        point(part.segments[i + 3], part.segments[i + 4], part.segments[i + 5]);
                    }
                    for (let i = 0; i < part.discs.length; i += 3) point(part.discs[i], part.discs[i + 1], part.discs[i + 2]);
                }
            } else if (node.kind !== 'group' && node.kind !== 'opaque') {
                const local = prepared.bounds;
                box = transform(union(local.ink, local.hit ?? local.ink), target);
            }
            if (!box && node.kind !== 'group') throw new Error(`Legacy node has no prepared geometry: ${node.id}`);
            return box;
        },
        worldBoundsError(node, target) {
            const { prepared, connectorToLocal } = requireRecord(node);
            const matrix = connectorToLocal ? compose(target, connectorToLocal) : target;
            const scale = Math.hypot(matrix[0], matrix[1], matrix[2], matrix[3]);
            if (!Number.isFinite(scale)) throw new RangeError('Legacy geometry transform overflows');
            if (node.kind === 'stroke') {
                let error = 0;
                for (const part of prepared.ink ?? []) error = Math.max(error, part.centreErrorWorld + part.radiusErrorWorld + part.dashPhaseErrorWorld);
                return error * scale;
            }
            // The canonical vector realization uses 0.01 path and length budgets;
            // connector routing uses 0.01 world units (vectorGeometry/services).
            return node.kind === 'connector' ? 0.01 * scale : node.kind === 'text' ? 0 : 0.02 * scale;
        },
    };
    const textLayout: LegacyTextLayout = {
        get engine() { if (!renderer) throw new Error('Legacy text geometry is not prepared'); return renderer.text.layout; },
        fontEpoch: () => { if (!renderer) throw new Error('Legacy text geometry is not prepared'); return renderer.text.fonts.epoch; },
    };
    async function prepareGeometry(nodes: readonly Node[], sheets: readonly Sheet[], requestedSignal?: AbortSignal): Promise<void> {
        check(requestedSignal); if (busy) throw new Error('Legacy geometry preparation is already running'); busy = true;
        const signal = requestedSignal ? AbortSignal.any([lifetime.signal, requestedSignal]) : lifetime.signal;
        let nextRenderer: ReturnType<typeof createBoardRenderServices> | null = null, nextScope: { release(): void } | null = null;
        let work = 0, started = performance.now();
        const tick = async () => { check(signal); await cooperate(); check(signal); work = 0; started = performance.now(); };
        const due = () => ++work >= 256 || performance.now() - started >= 3;
        try {
            const sheetAliases = new Map<SheetId, SheetId>(), uniqueSheets: Sheet[] = [];
            for (const sheet of sheets) {
                if (!sheetAliases.has(sheet.id)) {
                    const id = sheetId(`legacy-geometry-sheet-${sheetAliases.size}`); sheetAliases.set(sheet.id, id);
                    uniqueSheets.push({ ...sheet, id, ext: null });
                }
                if (due()) await tick();
            }
            if (!uniqueSheets.length) throw new Error('Legacy geometry has no sheet');
            const sheetSet = new Set(uniqueSheets.map(sheet => sheet.id));
            const aliases = new Map<Node, NodeId>(), first = new Map<NodeId, NodeId>(), originalById = new Map<NodeId, Node>();
            const duplicates = new Set<NodeId>();
            for (const node of nodes) {
                if (aliases.has(node)) throw new Error(`Legacy record object is repeated: ${node.id}`);
                if (sheetAliases.has(node.id as unknown as SheetId)) throw new Error(`Legacy node and sheet IDs collide: ${node.id}`);
                const id = nodeId(`legacy-geometry-node-${aliases.size}`); aliases.set(node, id);
                if (!first.has(node.id)) { first.set(node.id, id); originalById.set(node.id, node); } else duplicates.add(node.id);
                if (due()) await tick();
            }
            for (const node of nodes) {
                const parent = originalById.get(node.parent as NodeId);
                if (parent && duplicates.has(parent.id) && (parent.kind === 'group' || parent.kind === 'frame')) {
                    throw new Error(`Ambiguous duplicate legacy container: ${parent.id}`);
                }
                if (due()) await tick();
            }
            const aliasNodes: Node[] = [], aliasMap = new Map<NodeId, Node>();
            for (const node of nodes) {
                if (node.kind === 'opaque') throw new Error(`Opaque legacy geometry is unavailable: ${node.id}`);
                const sheet = sheetAliases.get(node.parent as SheetId), parentNode = originalById.get(node.parent as NodeId);
                if (!sheet && (!parentNode || (parentNode.kind !== 'group' && parentNode.kind !== 'frame'))) throw new Error(`Invalid legacy parent: ${node.id}`);
                const parent: ParentId = sheet ?? first.get(node.parent as NodeId)!;
                let value: Node = { ...node, id: aliases.get(node)!, parent, page: -1 };
                if (value.kind === 'connector') {
                    const end = (value: typeof node & { kind: 'connector' }, terminal: 'start' | 'end') => {
                        const source = value[terminal]; if (!source.attach) return source;
                        const target = first.get(source.attach.target);
                        if (!target) throw new Error(`Legacy connector target is unavailable: ${node.id}`);
                        return { ...source, attach: { ...source.attach, target } };
                    };
                    const original = node as Extract<Node, { kind: 'connector' }>;
                    value = { ...value, start: end(original, 'start'), end: end(original, 'end') };
                }
                aliasNodes.push(value); aliasMap.set(value.id, value); if (due()) await tick();
            }
            for (const node of aliasNodes) {
                const path = new Set<NodeId>(); let parent: ParentId = node.id;
                for (let depth = 0; depth <= 64; depth++) {
                    if (sheetSet.has(parent as SheetId)) break;
                    if (depth === 64 || path.has(parent as NodeId)) throw new Error(`Invalid legacy ancestry: ${node.id}`);
                    path.add(parent as NodeId); const current = aliasMap.get(parent as NodeId);
                    if (!current) throw new Error(`Missing legacy ancestor: ${node.id}`);
                    parent = current.parent;
                }
                if (due()) await tick();
            }
            const doc = await createLoadedBoardDoc({ kind: 'whiteboard', sheets: uniqueSheets, nodes: aliasNodes,
                ui: UI_DEFAULTS, view: VIEW_DEFAULTS, host: { kind: 'whiteboard' }, media: [],
                preserved: { version: [1, 0], fields: new Map(), records: [], end: null }, preservedMediaRefs: new Map() }, tick, signal);
            check(signal);
            nextRenderer = createBoardRenderServices({ doc, samples: options.samples, media: options.media,
                token: options.token, fonts: options.fonts, cooperate });
            nextScope = await nextRenderer.pinChangeGeometry(aliasNodes.map(node => node.id), signal, doc, options.current); check(signal);
            const fontEpoch = nextRenderer.text.fonts.epoch, prepared = new Map<Readonly<Node>, RecordGeometry>();
            for (let i = 0; i < nodes.length; i++) {
                const original = nodes[i], alias = doc.nodes.get(aliases.get(original)!)!;
                if (alias.kind === 'group') continue;
                // Non-connectors use the original ID: draw-style geometry is seeded
                // by that ID, while the projection IDs only disambiguate ownership.
                const node = alias.kind === 'connector' ? alias : original;
                const result = await nextRenderer.prepareForPick(node, signal, doc); check(signal);
                if (nextRenderer.text.fonts.epoch !== fontEpoch) throw new DOMException('Legacy font geometry changed', 'AbortError');
                let connectorToLocal: Affine | undefined;
                if (alias.kind === 'connector') {
                    connectorToLocal = inverse(poseMatrix(worldPose(doc, alias.id)), 1e12) ?? undefined;
                    if (!connectorToLocal) throw new Error(`Legacy connector transform is unavailable: ${original.id}`);
                }
                prepared.set(original, { node: original, prepared: result, connectorToLocal });
                if (due()) await tick();
            }
            check(signal);
            const previousScope = scope, previousRenderer = renderer;
            scope = nextScope; renderer = nextRenderer; records = prepared; nextScope = null; nextRenderer = null;
            try { previousScope?.release(); } finally { previousRenderer?.dispose(); }
        } finally {
            try { nextScope?.release(); } finally { nextRenderer?.dispose(); busy = false; }
        }
    }
    return { prepareGeometry, geometry, textLayout,
        dispose() { if (disposed) return; disposed = true; lifetime.abort(); records.clear();
            try { scope?.release(); } finally { scope = null; renderer?.dispose(); renderer = null; } } };
}
