import type { Affine } from '../../platform/types';
import { isLocked, selectedRoots } from '../change/commands';
import { worldPose, worldToLocal, type ChangeGeometry } from '../change/coordinates';
import type { EncoderContext } from '../format/encode';
import { compose } from '../geom/affine';
import { transformBox, validBox, type Box } from '../geom/bounds';
import { nextDown, nextUp } from '../geom/numeric';
import { polylinePath } from '../geom/polylines';
import { transformedPathBounds } from '../geom/providers';
import { createBoardDoc, type BoardDoc } from '../model/doc';
import type { NodeId, SheetId } from '../model/ids';
import type { MediaEntry, MediaId } from '../model/media';
import type { Node } from '../model/nodes';
import { extRawValues, nodeRawValues, scanRawMedia } from '../model/rawMedia';
import { measureBoardPaintBoundsNow } from '../render/worldBounds';
import type { BoardCopySnapshotOptions } from './runtimeSnapshot';
import { snapshotSelection, type ClipboardBounds, type ClipboardLease, type CopySnapshot, type CopySnapshotHost } from './snapshot';

export interface BoardCutReceipt {
    readonly doc: BoardDoc;
    readonly revision: number;
    readonly fontEpoch: number;
    readonly selection: readonly NodeId[];
    readonly geometry: ChangeGeometry;
    assertCurrent(): void;
}
export interface BoardCopySnapshotNowResult {
    readonly snapshot: CopySnapshot;
    readonly cutReceipt: BoardCutReceipt | null;
    readonly cutFailure?: unknown;
}

function union(a: Box | null, b: Box): Box {
    if (!validBox(b)) throw new Error('Invalid clipboard geometry');
    return a ? [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])] : b;
}
function transform(box: Box, matrix: Affine): Box {
    const out = new Float64Array(4); transformBox(out, 0, box, 0, matrix, 0);
    return [out[0], out[1], out[2], out[3]];
}
function matrix(doc: BoardDoc, id: NodeId): Affine {
    const pose = worldPose(doc, id), c = Math.cos(pose.rotation), s = Math.sin(pose.rotation);
    return [c, s, -s, c, pose.x, pose.y];
}
function boxFromRect(rect: { x: number; y: number; width: number; height: number }): Box {
    return [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height];
}
function releaseAll(leases: readonly ClipboardLease[]): void {
    let failure: unknown;
    for (let i = leases.length - 1; i >= 0; i--) try { leases[i].release(); } catch (error) { failure ??= error; }
    if (failure) throw failure;
}

export function createBoardCopySnapshotNow(options: BoardCopySnapshotOptions): BoardCopySnapshotNowResult {
    const { runtime } = options, session = runtime.session, live = session.doc, owner = session.owner;
    const state = runtime.selection.getSnapshot(), selection = [...new Set(options.selection ?? state.selected)], revision = live.rev;
    const signal = options.signal ?? new AbortController().signal, fontEpoch = runtime.render.text.fonts.epoch, paintBinding = runtime.paintBinding;
    const held: ClipboardLease[] = [];
    let output: CopySnapshot | undefined, transferred = false, released = false;
    const check = () => {
        signal.throwIfAborted();
        if (released || !options.current() || session.owner !== owner || session.doc !== live || live.rev !== revision
            || runtime.selection.getSnapshot() !== state || runtime.render.text.fonts.epoch !== fontEpoch)
            throw new DOMException('Clipboard source changed', 'AbortError');
    };
    const keep = <T extends ClipboardLease>(lease: T): T => { held.push(lease); return lease; };
    try {
        check();
        const metadata = live, sheet = metadata.sheets.get(state.sheet);
        if (!sheet) throw new Error('Clipboard source sheet is unavailable');
        const roots: NodeId[] = [], skipped: NodeId[] = [], copied = new Map<NodeId, Readonly<Node>>(), ordered = new Map<NodeId, NodeId[]>();
        for (const chosen of selectedRoots(live, selection)) {
            const root = live.nodes.get(chosen.id); if (!root) throw new Error('Clipboard root is unavailable');
            let parent = root.parent, inSheet = false;
            for (let depth = 0; depth < 64; depth++) {
                if (parent === state.sheet) { inSheet = true; break; }
                const ancestor = live.nodes.get(parent as NodeId); if (!ancestor) break; parent = ancestor.parent;
            }
            if (!inSheet) throw new Error('Clipboard selection spans another sheet');
            if (root.kind === 'opaque') { skipped.push(root.id); continue; }
            roots.push(root.id); const subtree: NodeId[] = []; ordered.set(root.id, subtree);
            const pending = [root.id];
            while (pending.length) {
                check(); const id = pending.pop()!, node = live.nodes.get(id);
                if (!node) throw new Error('Clipboard subtree is incomplete');
                if (node.kind === 'opaque') { skipped.push(id); continue; }
                if (copied.has(id)) throw new Error('Clipboard roots overlap');
                if (copied.size >= 100000) throw new RangeError('Too many selected nodes to copy');
                copied.set(id, node); subtree.push(id);
                const children = live.children.get(id) ?? [];
                for (let i = children.length - 1; i >= 0; i--) pending.push(children[i].id);
            }
        }
        if (!roots.length) throw new Error(`This version can't copy opaque content: ${skipped.join(', ')}`);
        for (const node of copied.values()) if (node.kind === 'group') {
            let count = 0; for (const child of live.children.get(node.id) ?? []) if (copied.has(child.id)) count++;
            if (count < 2) throw new Error(`Skipping opaque content would leave an invalid copied group: ${node.id}`);
        }
        const rootSet = new Set(roots), nodes: Node[] = [], mediaIds = new Set<MediaId>(), rawIds = new Set<MediaId>();
        const addRaw = (id: MediaId) => { rawIds.add(id); mediaIds.add(id); };
        for (const original of copied.values()) {
            check(); let node: Node = { ...original };
            if (node.kind === 'connector') {
                const connector = node;
                const end = (terminal: 'start' | 'end') => {
                    const value = connector[terminal]; if (!value.attach || copied.has(value.attach.target)) return value;
                    const geometry = runtime.render.prepareForPickNow(connector, signal, live).connector;
                    if (!geometry) throw new Error('Clipboard connector geometry is unavailable');
                    const point = worldToLocal(live, connector, geometry[terminal].tipWorld);
                    return { ...value, x: point.x, y: point.y, attach: null };
                };
                node = { ...connector, start: end('start'), end: end('end') };
            }
            if (rootSet.has(node.id)) {
                const pose = worldPose(live, node.id); let opacity = node.opacity, parent = original.parent;
                for (let depth = 0; parent !== state.sheet && depth < 64; depth++) {
                    const ancestor = live.nodes.get(parent as NodeId); if (!ancestor) throw new Error('Clipboard root ancestor is unavailable');
                    opacity *= ancestor.opacity; parent = ancestor.parent;
                }
                if (parent !== state.sheet) throw new Error('Clipboard root ancestry exceeds limit');
                node = { ...node, parent: state.sheet, page: -1, x: pose.x, y: pose.y, rotation: pose.rotation, opacity };
            }
            nodes.push(node);
            if ((node.kind === 'picture' || node.kind === 'clip') && node.media) mediaIds.add(node.media);
            if (node.kind === 'linkcard' && node.preview) { if (node.preview.image) mediaIds.add(node.preview.image); if (node.preview.favicon) mediaIds.add(node.preview.favicon); }
            for (const raw of nodeRawValues(node)) if (raw !== null) scanRawMedia(raw, addRaw);
        }
        const media: MediaEntry[] = [];
        for (const id of mediaIds) {
            const entry = metadata.media.get(id); if (!entry) throw new Error(`Clipboard media metadata is missing: ${id}`);
            keep(runtime.media.retain(id, 'snapshot')); media.push(entry);
            for (const raw of extRawValues(entry.ext)) scanRawMedia(raw, addRaw);
        }
        const preservedMediaRefs = new Map<MediaId, number>(); for (const id of rawIds) preservedMediaRefs.set(id, 1);
        const projection = createBoardDoc({ kind: 'whiteboard', sheets: [{ ...sheet, ext: null }], nodes, media,
            ui: metadata.ui, view: metadata.view, host: { kind: 'whiteboard' },
            preserved: { version: metadata.preserved.version, fields: new Map(), records: [], end: null }, preservedMediaRefs });
        const prepared = new Map<NodeId, ReturnType<typeof runtime.render.prepareForPickNow>>();
        for (const node of projection.nodes.values()) if (node.kind !== 'group') {
            check(); prepared.set(node.id, runtime.render.prepareForPickNow(node, signal, projection));
        }
        const inkWorld = new Map<NodeId, Box>();
        const ink = (node: Node): Box => {
            const cached = inkWorld.get(node.id); if (cached) return cached;
            let box: Box | null = null;
            if (node.kind === 'group') for (const child of projection.children.get(node.id) ?? []) box = union(box, ink(child));
            else { const value = prepared.get(node.id); if (!value) throw new Error('Clipboard ink geometry unavailable'); box = transform(value.bounds.ink, matrix(projection, node.id)); }
            if (!box) throw new Error('Clipboard group has no ink bounds'); inkWorld.set(node.id, box); return box;
        };
        const logical = (root: Node): Box => {
            let box: Box | null = null; const stack = [root];
            while (stack.length) {
                const node = stack.pop()!;
                if (node.kind === 'group' || (root.kind === 'group' && node.kind === 'frame')) {
                    for (const child of projection.children.get(node.id) ?? []) stack.push(child);
                    if (node.kind === 'group') continue;
                }
                const value = prepared.get(node.id); if (!value) throw new Error('Clipboard logical geometry unavailable');
                const m = matrix(projection, node.id); let b: Box | null = null;
                if (node.kind === 'connector') {
                    if (!value.connector) throw new Error('Clipboard connector geometry unavailable');
                    for (const path of [value.connector.body, ...value.connector.heads]) {
                        const rect = transformedPathBounds(path, [1, 0, 0, 1, 0, 0]);
                        if (rect) { const r = node.width / 2; b = union(b, [rect.x - r, rect.y - r, rect.x + rect.width + r, rect.y + rect.height + r]); }
                    }
                    if (value.connector.label) b = union(b, transform(boxFromRect(value.connector.label.paint.ink), value.connector.label.localToWorld));
                } else if (node.kind === 'stroke') {
                    if (!value.ink) throw new Error('Clipboard ink geometry unavailable');
                    const point = (x: number, y: number, radius: number) => {
                        const px = m[0] * x + m[2] * y + m[4], py = m[1] * x + m[3] * y + m[5];
                        const rx = radius * Math.hypot(m[0], m[2]), ry = radius * Math.hypot(m[1], m[3]);
                        b = union(b, [px - rx, py - ry, px + rx, py + ry]);
                    };
                    for (const part of value.ink) {
                        for (let i = 0; i < part.segments.length; i += 6) { point(part.segments[i], part.segments[i + 1], part.segments[i + 2]); point(part.segments[i + 3], part.segments[i + 4], part.segments[i + 5]); }
                        for (let i = 0; i < part.discs.length; i += 3) point(part.discs[i], part.discs[i + 1], part.discs[i + 2]);
                    }
                } else if (node.kind === 'polyline') {
                    const rect = transformedPathBounds(polylinePath(node), m); if (rect) b = boxFromRect(rect);
                } else {
                    if (!value.vector) throw new Error('Clipboard vector geometry unavailable');
                    b = transform(boxFromRect(value.vector.boxLocal), compose([1, 0, 0, 1, 0, 0], m));
                }
                if (!b) throw new Error(`Logical geometry is empty: ${node.id}`); box = union(box, b);
            }
            if (!box) throw new Error(`Empty group has no logical geometry: ${root.id}`); return box;
        };
        const rootBounds = new Map<NodeId, ClipboardBounds>();
        for (const id of roots) {
            check(); const paint = paintBinding.prepareOverlayNow(projection, { sheetId: state.sheet, theme: 'light' }, ordered.get(id)!, signal);
            const measured = measureBoardPaintBoundsNow(paint, { memory: options.memory, signal, toleranceWorld: options.toleranceWorld, includeInvisible: true });
            const b = measured.bounds; if (!b) throw new Error(`Clipboard root has no measurable paint: ${id}`);
            rootBounds.set(id, { x: b[0], y: b[1], w: b[2] - b[0], h: b[3] - b[1] });
        }
        const encoder: EncoderContext = { ...runtime.encoder, bounds(node) {
            if (projection.nodes.get(node.id) !== node) throw new Error('Clipboard encoder requires its projection record');
            const b = ink(node), x = nextDown(b[0]), y = nextDown(b[1]);
            return [x, y, nextUp(nextUp(b[2]) - x), nextUp(nextUp(b[3]) - y)];
        }, mediaRefs: projection.mediaRefs, preservedMediaRefs: projection.preservedMediaRefs };
        const host: CopySnapshotHost = { doc: projection, sheet: state.sheet, board: options.board ?? owner.documentId, encoder,
            bounds(node) { const root = rootBounds.get(node.id); if (root) return root;
                const b = logical(node); return { x: b[0], y: b[1], w: b[2] - b[0], h: b[3] - b[1] }; },
            detachRoot(node, sheetId: SheetId) { if (sheetId !== state.sheet || projection.nodes.get(node.id) !== node) throw new Error('Invalid clipboard root projection'); return node; },
            retainSample: node => runtime.samples.retain(node.samples), retainMedia: id => runtime.media.retain(id, 'snapshot') };
        output = snapshotSelection(host, roots); check();
        const snapshotValue = output;
        let cutReceipt: BoardCutReceipt | null = null, cutFailure: unknown;
        try {
            const affected = new Set<NodeId>(), removed = new Set<NodeId>(), groupQueue: NodeId[] = [];
            for (const root of selectedRoots(live, selection)) if (!isLocked(live, root)) {
                affected.add(root.id); const stack = [root];
                while (stack.length) { const node = stack.pop()!; if (node.locked) continue;
                    removed.add(node.id); if (live.nodes.get(node.parent as NodeId)?.kind === 'group') groupQueue.push(node.parent as NodeId);
                    for (const child of live.children.get(node.id) ?? []) stack.push(child);
                }
            }
            while (groupQueue.length) {
                const id = groupQueue.pop()!; if (removed.has(id)) continue;
                const group = live.nodes.get(id); if (!group || group.kind !== 'group') continue;
                const survivors = (live.children.get(id) ?? []).filter(child => !removed.has(child.id));
                if (survivors.length <= 2) { affected.add(id); if (survivors.length <= 1) { removed.add(id); groupQueue.push(group.parent as NodeId); } }
            }
            keep(runtime.render.pinChangeGeometryNow(affected, signal, live, () => { try { check(); return true; } catch { return false; } }));
            const assertCurrent = () => { check(); };
            const geometry: ChangeGeometry = {
                resolvedTip(doc, connector, terminal) { assertCurrent(); if (doc !== live) throw new Error('Cut geometry document mismatch'); return runtime.render.changeGeometry.resolvedTip(doc, connector, terminal); },
                worldBoundsCenter(doc, node) { assertCurrent(); if (doc !== live) throw new Error('Cut geometry document mismatch'); return runtime.render.changeGeometry.worldBoundsCenter(doc, node); },
            };
            cutReceipt = { doc: live, revision, fontEpoch, selection: [...selection], geometry, assertCurrent };
        } catch (error) { cutFailure = error; }
        check();
        const ownerLease: ClipboardLease = { release() { if (!released) { released = true;
            try { releaseAll(snapshotValue.leases); } finally { releaseAll(held); }
        } } };
        const snapshot: CopySnapshot = { ...snapshotValue, revision, selected: selection, skippedOpaque: skipped,
            payload: { ...snapshotValue.payload, from: { ...snapshotValue.payload.from, kind: metadata.kind } }, leases: [ownerLease] };
        transferred = true; return { snapshot, cutReceipt, ...(cutFailure !== undefined ? { cutFailure } : {}) };
    } catch (error) { if (output) try { releaseAll(output.leases); } catch { /* preserve primary failure */ } throw error;
    } finally { if (!transferred) try { releaseAll(held); } catch { /* preserve primary failure */ } }
}
