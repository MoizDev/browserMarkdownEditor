import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import { selectedRoots } from '../change/commands';
import { worldPose, worldToLocal } from '../change/coordinates';
import { acquireBoardGeometryScope } from '../commands/geometryScope';
import type { EncoderContext } from '../format/encode';
import { createBoardEncoderBounds } from '../host/encoderBounds';
import type { BoardRuntime } from '../host/runtime';
import type { NodeId, SheetId } from '../model/ids';
import { createLoadedBoardDoc } from '../model/loadDocument';
import type { MediaEntry, MediaId } from '../model/media';
import type { ConnectorNode, Node } from '../model/nodes';
import { extRawValues, nodeRawValues, scanRawMediaIncremental } from '../model/rawMedia';
import { measureBoardPaintBounds } from '../render/worldBounds';
import { snapshotSelectionAsync, type ClipboardBounds, type ClipboardLease, type CopySnapshot, type CopySnapshotHost } from './snapshot';

export interface BoardCopySnapshotOptions {
    readonly runtime: BoardRuntime;
    readonly memory: MemoryAllocator;
    readonly current: () => boolean;
    readonly selection?: readonly NodeId[];
    readonly board?: string;
    readonly signal?: AbortSignal;
    readonly cooperate?: () => Promise<void>;
    readonly toleranceWorld?: number;
}

/** A copy owns its original Scene and resource pins until its snapshot leases retire. */
export async function createBoardCopySnapshot(options: BoardCopySnapshotOptions): Promise<CopySnapshot> {
    const { runtime } = options, session = runtime.session, live = session.doc, owner = session.owner;
    const state = runtime.selection.getSnapshot(), selection = [...new Set(options.selection ?? state.selected)], revision = live.rev;
    // Captured before the first await: this copy's paint uses its own start binding, never a later rebind.
    const signal = options.signal ?? new AbortController().signal, scene = runtime.scene, paintBinding = runtime.paintBinding;
    const cooperate = options.cooperate ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
    if (!scene || !scene.ready || scene.revision !== revision) throw new Error('Clipboard scene is not ready');
    const pin = scene.pin(), held: ClipboardLease[] = [pin];
    let output: CopySnapshot | undefined, transferred = false;
    const check = () => {
        signal.throwIfAborted();
        if (!options.current() || session.owner !== owner || session.doc !== live || live.rev !== revision
            || runtime.selection.getSnapshot() !== state || pin.revision !== revision) throw new DOMException('Clipboard source changed', 'AbortError');
    };
    let work = 0, started = performance.now();
    const tick = async () => { check(); await cooperate(); check(); work = 0; started = performance.now(); };
    const due = () => ++work >= 256 || performance.now() - started >= 3;
    const keep = <T extends ClipboardLease>(lease: T): T => { held.push(lease); return lease; };
    const release = (leases: readonly ClipboardLease[]) => {
        let first: unknown;
        for (let i = leases.length - 1; i >= 0; i--) try { leases[i].release(); } catch (error) { first ??= error; }
        if (first) throw first;
    };
    try {
        check();
        const source = await pin.readDocument(signal); check();
        const sheet = source.sheets.get(state.sheet); if (!sheet) throw new Error('Clipboard source sheet is unavailable');
        const chosen = selectedRoots(source, selection);
        const roots: NodeId[] = [], skipped: NodeId[] = [], ordered = new Map<NodeId, NodeId[]>(), copied = new Map<NodeId, Readonly<Node>>();
        for (const root of chosen) {
            let parent = root.parent, inSheet = false;
            for (let depth = 0; depth < 64; depth++) {
                if (parent === state.sheet) { inSheet = true; break; }
                const ancestor = source.nodes.get(parent as NodeId); if (!ancestor) break; parent = ancestor.parent;
            }
            if (!inSheet) throw new Error('Clipboard selection spans another sheet');
            if (root.kind === 'opaque') { skipped.push(root.id); continue; }
            roots.push(root.id); const subtree: NodeId[] = []; ordered.set(root.id, subtree);
            const pending: NodeId[] = [root.id];
            while (pending.length) {
                const id = pending.pop()!, node = source.nodes.get(id); if (!node) throw new Error('Clipboard subtree is incomplete');
                if (node.kind === 'opaque') { skipped.push(id); continue; }
                if (copied.has(id)) throw new Error('Clipboard roots overlap');
                if (copied.size >= 100000) throw new RangeError('Too many selected nodes to copy');
                copied.set(id, node); subtree.push(id);
                const children = source.children.get(id) ?? [];
                for (let i = children.length - 1; i >= 0; i--) { pending.push(children[i].id); if (due()) await tick(); }
                if (due()) await tick();
            }
        }
        if (!roots.length) throw new Error(`This version can't copy opaque content: ${skipped.join(', ')}`);
        // Skipping opaque records must not create a clipboard group that the
        // native model would immediately dissolve on admission.
        for (const node of copied.values()) if (node.kind === 'group') {
            let count = 0; for (const child of source.children.get(node.id) ?? []) { if (copied.has(child.id)) count++; if (due()) await tick(); }
            if (count < 2) throw new Error(`Skipping opaque content would leave an invalid copied group: ${node.id}`);
        }
        check();
        keep(await runtime.render.pinChangeGeometry(roots, signal, source, () => {
            try { check(); return true; } catch { return false; }
        }));
        check();
        const rootSet = new Set(roots), nodes: Node[] = [], mediaIds = new Set<MediaId>(), rawIds = new Set<MediaId>();
        const addRaw = (id: MediaId) => { rawIds.add(id); mediaIds.add(id); };
        for (const original of copied.values()) {
            let node: Node = { ...original };
            if (node.kind === 'connector') {
                const connector = node as ConnectorNode;
                const end = (terminal: 'start' | 'end') => {
                    const value = connector[terminal];
                    if (!value.attach || copied.has(value.attach.target)) return value;
                    const point = runtime.render.changeGeometry.resolvedTip(source, connector, terminal);
                    const local = worldToLocal(source, connector, point);
                    return { ...value, x: local.x, y: local.y, attach: null };
                };
                node = { ...connector, start: end('start'), end: end('end') };
            }
            if (rootSet.has(node.id)) {
                const pose = worldPose(source, node.id); let opacity = node.opacity, parent = original.parent;
                for (let depth = 0; parent !== state.sheet && depth < 64; depth++) {
                    const ancestor = source.nodes.get(parent as NodeId); if (!ancestor) throw new Error('Clipboard root ancestor is unavailable');
                    opacity *= ancestor.opacity; parent = ancestor.parent;
                }
                if (parent !== state.sheet) throw new Error('Clipboard root ancestry exceeds limit');
                node = { ...node, parent: state.sheet, page: -1, x: pose.x, y: pose.y, rotation: pose.rotation, opacity };
            }
            nodes.push(node);
            if ((node.kind === 'picture' || node.kind === 'clip') && node.media) mediaIds.add(node.media);
            if (node.kind === 'linkcard' && node.preview) { if (node.preview.image) mediaIds.add(node.preview.image); if (node.preview.favicon) mediaIds.add(node.preview.favicon); }
            for (const raw of nodeRawValues(node)) {
                if (raw !== null) { await scanRawMediaIncremental(raw, addRaw, tick); check(); }
                if (due()) await tick();
            }
            if (due()) await tick();
        }
        const media: MediaEntry[] = [];
        for (const id of mediaIds) {
            const entry = source.media.get(id); if (!entry) throw new Error(`Clipboard media metadata is missing: ${id}`);
            keep(runtime.media.retain(id, 'snapshot')); media.push(entry);
            for (const raw of extRawValues(entry.ext)) { await scanRawMediaIncremental(raw, addRaw, tick); check(); }
            if (due()) await tick();
        }
        const preservedMediaRefs = new Map<MediaId, number>();
        for (const id of rawIds) { preservedMediaRefs.set(id, 1); if (due()) await tick(); }
        const projection = await createLoadedBoardDoc({ kind: 'whiteboard', sheets: [{ ...sheet, ext: null }], nodes, media,
            ui: source.ui, view: source.view, host: { kind: 'whiteboard' },
            preserved: { version: source.preserved.version, fields: new Map(), records: [], end: null }, preservedMediaRefs }, tick, signal);
        check();
        const allIds = nodes.map(node => node.id);
        const geometry = keep(await acquireBoardGeometryScope(runtime, allIds, { doc: projection, signal, cooperate, current: () => {
            try { check(); return true; } catch { return false; }
        } }));
        check();
        const encoderBounds = await createBoardEncoderBounds({ doc: projection, sources: [], local: () => undefined,
            realize: async (node, requestSignal) => (await runtime.render.prepareForPick(node, requestSignal, projection)).bounds,
            cooperate: tick, geometryEpoch: () => runtime.render.text.fonts.epoch });
        check(); await encoderBounds.prepare(allIds, signal); check();
        const rootBounds = new Map<NodeId, ClipboardBounds>();
        for (const id of roots) {
            const paint = await paintBinding.prepareOverlay(projection, { sheetId: state.sheet, theme: 'light' }, ordered.get(id)!, signal);
            check();
            const measured = await measureBoardPaintBounds(paint, { memory: options.memory, signal, cooperate: tick,
                toleranceWorld: options.toleranceWorld, includeInvisible: true }); check();
            const b = measured.bounds; if (!b) throw new Error(`Clipboard root has no measurable paint: ${id}`);
            rootBounds.set(id, { x: b[0], y: b[1], w: b[2] - b[0], h: b[3] - b[1] });
        }
        const encoder: EncoderContext = { ...runtime.encoder, bounds: encoderBounds.bounds,
            mediaRefs: projection.mediaRefs, preservedMediaRefs: projection.preservedMediaRefs };
        const board = options.board ?? owner.documentId;
        const host: CopySnapshotHost = { doc: projection, sheet: state.sheet, board, encoder,
            bounds(node) {
                const root = rootBounds.get(node.id); if (root) return root;
                const b = geometry.logicalBounds(node.id); return { x: b.x, y: b.y, w: b.width, h: b.height };
            },
            detachRoot(node, sheetId: SheetId) {
                if (sheetId !== state.sheet || projection.nodes.get(node.id) !== node) throw new Error('Invalid clipboard root projection');
                return node;
            },
            retainSample: node => runtime.samples.retain(node.samples),
            retainMedia: id => runtime.media.retain(id, 'snapshot'),
        };
        output = await snapshotSelectionAsync(host, roots, { signal, cooperate: tick }); check();
        const snapshot = output;
        let released = false;
        const ownerLease: ClipboardLease = { release() { if (!released) { released = true;
            try { release(snapshot.leases); } finally { release(held); }
        } } };
        // Source and projection keep the original resources alive even after the view closes.
        const result: CopySnapshot = { ...snapshot, revision, selected: selection, skippedOpaque: skipped,
            payload: { ...snapshot.payload, from: { ...snapshot.payload.from, kind: source.kind } }, leases: [ownerLease] };
        transferred = true; return result;
    } catch (error) {
        if (output) try { release(output.leases); } catch { /* preserve the primary failure */ }
        throw error;
    } finally {
        if (!transferred) try { release(held); } catch { /* preserve the primary failure */ }
    }
}
