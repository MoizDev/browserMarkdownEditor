import { pageAt } from '../../platform/render/pageStack';
import { allocateOrderKeys, isLocked, reparentNode, selectedRoots, setIfChanged } from '../change/commands';
import { worldPose } from '../change/coordinates';
import { inverse } from '../geom/affine';
import { acquireBoardGeometryScope } from './geometryScope';
import type { CommandBuilder } from '../change/ops';
import type { BoardRuntime } from '../host/runtime';
import { childrenOf, hasOpaqueDescendant, isSheetParent, sheetOf, type BoardDoc } from '../model/doc';
import { inspectOpaqueSubtrees, prepareSelectionScope, selectionNodeIds } from './selectionScope';
import { prepareSelectionOrderPlan } from './selectionOrderPlan';
import { prepareContainerContents } from './containerContents';
import { newNodeId, type NodeId, type ParentId, type SheetId } from '../model/ids';
import { createFrame, createGroup, type Node } from '../model/nodes';
import { boardPageStack, pageOrigin } from '../model/pages';
import type { Box } from '../scene/bounds';

export interface BoardSelectionCommandOptions {
    readonly runtime: BoardRuntime;
    readonly current: () => boolean;
    /** Current presented zoom; frame selection padding is measured in CSS pixels. */
    readonly zoom: () => number;
    readonly cooperate?: () => Promise<void>;
}
export type SelectionOrder = 'front' | 'back' | 'forward' | 'backward';

/** The structural scope rule every restructuring command enforces before it prepares: same sheet, inside focus, unlocked, no opaque content below. */
export type SelectionBlock = 'no-selection' | 'not-groups' | 'other-sheet' | 'outside-focus' | 'locked' | 'opaque';
export function structuralRootsBlock(doc: BoardDoc, roots: readonly Node[], state: { readonly sheet: SheetId; readonly focus: ParentId }): SelectionBlock | undefined {
    if (!roots.length) return 'no-selection';
    for (const node of roots) {
        if (sheetOf(doc, node.id) !== state.sheet) return 'other-sheet';
        let parent: ParentId = node.parent, inFocus = node.id === state.focus || parent === state.focus;
        for (let depth = 0; !inFocus && !isSheetParent(doc, parent) && depth < 64; depth++) {
            const ancestor = doc.nodes.get(parent as NodeId); if (!ancestor) return 'outside-focus';
            parent = ancestor.parent; inFocus = parent === state.focus;
        }
        if (!inFocus) return 'outside-focus';
        if (isLocked(doc, node)) return 'locked';
        if (hasOpaqueDescendant(doc, node.id)) return 'opaque';
    }
    return undefined;
}

/** Why ungroup would refuse this selection; the same rules the ungroup command enforces before it prepares. */
export function ungroupEligibility(doc: BoardDoc, ids: Iterable<NodeId>, state: { readonly sheet: SheetId; readonly focus: ParentId }):
    { readonly enabled: boolean; readonly reason?: SelectionBlock } {
    let roots: Node[];
    try { roots = selectedRoots(doc, ids); } catch { return { enabled: false, reason: 'no-selection' }; }
    if (roots.some(node => node.kind !== 'group')) return { enabled: false, reason: roots.length ? 'not-groups' : 'no-selection' };
    const block = structuralRootsBlock(doc, roots, state);
    return block ? { enabled: false, reason: block } : { enabled: true };
}

/** One real session/builder is the sole mutation authority. Geometry preparation
 * completes before opening that builder, and its lease outlives commit/rollback. */
export function createBoardSelectionCommands(options: BoardSelectionCommandOptions) {
    const { runtime } = options, session = runtime.session, doc = session.doc;
    const cooperate = options.cooperate ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
    type Capture = { revision: number; sheet: SheetId; focus: ParentId; owner: typeof session.owner; font: number };
    const capture = (): Capture => {
        if (!options.current() || session.isReadOnly || session.isGestureActive) throw new Error('Selection command is not currently editable');
        const selection = runtime.selection.getSnapshot();
        return { revision: doc.rev, sheet: selection.sheet, focus: selection.focus, owner: session.owner, font: runtime.render.text.fonts.epoch };
    };
    const check = (state: Capture, signal: AbortSignal) => {
        signal.throwIfAborted();
        const selection = runtime.selection.getSnapshot();
        if (!options.current() || session.isReadOnly || session.isGestureActive || session.doc !== doc || session.owner !== state.owner
            || doc.rev !== state.revision || selection.sheet !== state.sheet || selection.focus !== state.focus
            || runtime.render.text.fonts.epoch !== state.font) throw new DOMException('Selection command became stale', 'AbortError');
    };
    const rootsFor = (ids: readonly NodeId[], state: Capture, structural: boolean, signal: AbortSignal, preserveNested = false): Promise<Node[]> =>
        prepareSelectionScope({ doc, ids, sheet: state.sheet, focus: state.focus, structural, preserveNested, signal, cooperate,
            current: () => { try { check(state, signal); return true; } catch { return false; } } });
    const ancestors = (parent: ParentId): ParentId[] => {
        const result: ParentId[] = [];
        for (let depth = 0; depth <= 64; depth++) {
            result.push(parent); if (isSheetParent(doc, parent)) return result;
            const node = doc.nodes.get(parent as NodeId); if (!node) throw new Error('Missing selection ancestor');
            parent = node.parent;
        }
        throw new Error('Selection ancestry is too deep');
    };
    const lca = async (roots: readonly Node[], state: Capture, signal: AbortSignal): Promise<ParentId> => {
        let candidates = roots.length ? ancestors(roots[0].parent) : [], work = 0, started = performance.now();
        for (let i = 1; i < roots.length && candidates.length; i++) {
            const chain = new Set(ancestors(roots[i].parent)); candidates = candidates.filter(id => chain.has(id));
            if (++work >= 256 || performance.now() - started >= 3) { await cooperate(); check(state, signal); work = 0; started = performance.now(); }
        }
        const parent = candidates[0];
        if (!parent || !ancestors(parent).includes(state.focus)) throw new Error('Selection has no common parent inside focus');
        check(state, signal); return parent;
    };
    const branch = (node: Node, parent: ParentId): Node => {
        let current = node;
        for (let depth = 0; depth <= 64; depth++) {
            if (current.parent === parent) return current;
            const next = doc.nodes.get(current.parent as NodeId); if (!next) throw new Error('Selection has no common branch');
            current = next;
        }
        throw new Error('Selection ancestry is too deep');
    };
    const local = (parent: ParentId, world: { x: number; y: number }) => {
        if (isSheetParent(doc, parent)) {
            const stack = boardPageStack(doc.host), page = stack ? pageAt(stack, world.y) : -1;
            const origin = stack && page >= 0 ? pageOrigin(stack, page) : undefined;
            if (stack && !origin) throw new Error('Page origin is unavailable');
            return { x: world.x - (origin?.x ?? 0), y: world.y - (origin?.y ?? 0), page };
        }
        const pose = worldPose(doc, parent), c = Math.cos(pose.rotation), s = Math.sin(pose.rotation), dx = world.x - pose.x, dy = world.y - pose.y;
        return { x: c * dx + s * dy, y: -s * dx + c * dy, page: -1 };
    };
    const inherited = (node: Node, parent: ParentId): number => {
        let opacity = 1, next = node.parent;
        for (let depth = 0; next !== parent && depth < 64; depth++) {
            const ancestor = doc.nodes.get(next as NodeId);
            if (!ancestor) throw new Error('Selection ancestor is missing');
            if (ancestor.kind === 'frame') throw new Error('Cannot move a selection across an ancestor frame clip');
            opacity *= ancestor.opacity; next = ancestor.parent;
        }
        if (next !== parent) throw new Error('Selection ancestry is too deep');
        return opacity;
    };
    const bounds = async (roots: readonly Node[], parent: ParentId, state: Capture, signal: AbortSignal): Promise<Box> => {
        const current = () => { try { check(state, signal); return true; } catch { return false; } };
        const ids = await selectionNodeIds(doc, roots, { signal, current, cooperate });
        const lease = await acquireBoardGeometryScope(runtime, ids, { signal, cooperate, current });
        try {
            check(state, signal);
            const pose = isSheetParent(doc, parent) ? null : worldPose(doc, parent);
            const c = Math.cos(pose?.rotation ?? 0), s = Math.sin(pose?.rotation ?? 0);
            const target = inverse([c, s, -s, c, pose?.x ?? 0, pose?.y ?? 0], 1e12);
            if (!target) throw new Error('Frame selection parent is not invertible');
            let box: Box | null = null;
            for (const node of roots) {
                const next = await lease.boundsInSpace(node.id, target); check(state, signal);
                box = box ? [Math.min(box[0], next[0]), Math.min(box[1], next[1]), Math.max(box[2], next[2]), Math.max(box[3], next[3])] : next;
            }
            if (!box) throw new Error('Selection is empty');
            return box;
        } finally { lease.release(); }
    };
    const commit = <T>(state: Capture, signal: AbortSignal, label: string, run: (builder: CommandBuilder) => T,
        select?: (result: T) => readonly NodeId[]): T => {
        check(state, signal); session.history.open(label);
        let builder: ReturnType<typeof session.begin> | undefined, open = true;
        try {
            builder = session.begin('tool', label);
            const result = run(builder), applied = builder.commit(); builder = undefined;
            try { if (select) runtime.selection.replace(select(result)); } finally { applied.release(); }
            session.history.close(); open = false; return result;
        } catch (error) {
            try { builder?.abort(); } finally { if (open) session.history.cancel(); }
            throw error;
        }
    };
    const guarded = async <T>(ids: readonly NodeId[], label: string, signal: AbortSignal | undefined,
        prepare: (roots: Node[], state: Capture, signal: AbortSignal) => Promise<(builder: CommandBuilder) => T>,
        select?: (result: T) => readonly NodeId[]): Promise<T> => {
        const activeSignal = signal ?? new AbortController().signal, state = capture(); check(state, activeSignal);
        const roots = await rootsFor(ids, state, true, activeSignal); check(state, activeSignal);
        const action = await prepare(roots, state, activeSignal); check(state, activeSignal);
        const current = () => { try { check(state, activeSignal); return true; } catch { return false; } };
        const rootIds = await selectionNodeIds(doc, roots, { signal: activeSignal, current, cooperate });
        const lease = await runtime.render.pinChangeGeometry(rootIds, activeSignal, doc, current);
        try { check(state, activeSignal); return commit(state, activeSignal, label, action, select); }
        finally { lease.release(); }
    };
    const createContainer = async (ids: readonly NodeId[], kind: 'group' | 'frame', name: string, signal?: AbortSignal) =>
        guarded(ids, kind === 'group' ? 'Group' : 'Frame selection', signal, async (roots, state, activeSignal) => {
            if (roots.length < (kind === 'group' ? 2 : 1)) throw new Error('Not enough selected roots');
            const parent = await lca(roots, state, activeSignal), inheritedOpacity: number[] = [];
            const removed = new Map<ParentId, number>(); let work = 0, started = performance.now();
            for (const root of roots) {
                inheritedOpacity.push(inherited(root, parent)); removed.set(root.parent, (removed.get(root.parent) ?? 0) + 1);
                if (++work >= 256 || performance.now() - started >= 3) { await cooperate(); check(state, activeSignal); work = 0; started = performance.now(); }
            }
            const sourceGroups: NodeId[] = [];
            for (const source of removed.keys()) {
                const group = doc.nodes.get(source as NodeId); if (group?.kind === 'group') sourceGroups.push(group.id);
                if (++work >= 256 || performance.now() - started >= 3) { await cooperate(); check(state, activeSignal); work = 0; started = performance.now(); }
            }
            const opaque = await inspectOpaqueSubtrees(doc, sourceGroups, { signal: activeSignal, cooperate,
                current: () => { try { check(state, activeSignal); return true; } catch { return false; } } });
            check(state, activeSignal);
            for (const [source, count] of removed) {
                const group = doc.nodes.get(source as NodeId);
                if (group?.kind === 'group' && !opaque.get(group.id)
                    && childrenOf(doc, source).length - count + Number(source === parent) < 2) {
                    throw new Error('Grouping would implicitly dissolve an existing group');
                }
                if (++work >= 256 || performance.now() - started >= 3) { await cooperate(); check(state, activeSignal); work = 0; started = performance.now(); }
            }
            let world = worldPose(doc, roots[0].id), width = 0, height = 0;
            const zoom = kind === 'frame' ? options.zoom() : 1;
            if (!Number.isFinite(zoom) || zoom <= 0) throw new RangeError('Frame selection needs a valid presented zoom');
            if (kind === 'frame') {
                const box = await bounds(roots, parent, state, activeSignal), padding = 25 / zoom;
                const left = box[0] - padding, top = box[1] - padding;
                const right = box[2] + padding, bottom = box[3] + padding;
                width = right - left; height = bottom - top;
                if (!isSheetParent(doc, parent)) {
                    const pose = worldPose(doc, parent), c = Math.cos(pose.rotation), s = Math.sin(pose.rotation);
                    world = { x: pose.x + c * left - s * top, y: pose.y + s * left + c * top, rotation: pose.rotation };
                } else {
                    // The frame uses one physical page origin, not one per corner.
                    world = { x: box[0] - padding, y: box[1] - padding, rotation: 0 };
                    width = box[2] - box[0] + 2 * padding; height = box[3] - box[1] + 2 * padding;
                }
            }
            const siblings = childrenOf(doc, parent), lastBranch = branch(roots[roots.length - 1], parent);
            let insertion = -1;
            for (let i = 0; i < siblings.length; i++) {
                if (siblings[i].id === lastBranch.id) { insertion = i; break; }
                if (++work >= 256 || performance.now() - started >= 3) { await cooperate(); check(state, activeSignal); work = 0; started = performance.now(); }
            }
            if (insertion < 0) throw new Error('Selection insertion point disappeared');
            const nextSibling = siblings[insertion + 1]?.id ?? null;
            return builder => {
                if (kind === 'frame' && options.zoom() !== zoom) throw new DOMException('Frame selection view changed', 'AbortError');
                const order = allocateOrderKeys(doc, builder, parent, lastBranch.id, nextSibling, 1)[0];
                const place = local(parent, world), id = newNodeId(doc);
                const base = { id, parent, order, page: place.page, x: place.x, y: place.y, ext: null };
                const container = kind === 'group' ? createGroup(base) : createFrame({ ...base, w: width, h: height, name, color: null });
                builder.push({ t: 'create', node: container });
                const keys = allocateOrderKeys(doc, builder, id, null, null, roots.length);
                for (let i = 0; i < roots.length; i++) {
                    const node = doc.nodes.get(roots[i].id); if (!node) throw new Error('Selected node disappeared');
                    reparentNode(doc, builder, node, id, runtime.render.changeGeometry, keys[i]);
                    const moved = doc.nodes.get(node.id)!;
                    setIfChanged(builder, moved, 'opacity', node.opacity * inheritedOpacity[i]);
                }
                return id;
            };
        }, id => [id]);
    return {
        group: (ids: readonly NodeId[], signal?: AbortSignal) => createContainer(ids, 'group', '', signal),
        frameSelection: (ids: readonly NodeId[], name = 'Frame', signal?: AbortSignal) => createContainer(ids, 'frame', name, signal),
        ungroup(ids: readonly NodeId[], signal?: AbortSignal) {
            return guarded(ids, 'Ungroup', signal, async (roots, state, activeSignal) => {
                if (!roots.length || roots.some(node => node.kind !== 'group')) throw new Error('Ungroup requires groups');
                const children = await prepareContainerContents(doc, roots, { signal: activeSignal, cooperate,
                    current: () => { try { check(state, activeSignal); return true; } catch { return false; } } });
                check(state, activeSignal);
                return builder => {
                    const moved: NodeId[] = [];
                    for (const root of roots) {
                        const live = doc.nodes.get(root.id); if (!live || live.kind !== 'group') throw new Error('Group disappeared');
                        const siblings = childrenOf(doc, live.parent), index = siblings.findIndex(node => node.id === live.id);
                        const direct = children.get(root.id)!;
                        const keys = allocateOrderKeys(doc, builder, live.parent, index > 0 ? siblings[index - 1].id : null,
                            siblings[index + 1]?.id ?? null, direct.length);
                        for (let i = 0; i < direct.length; i++) {
                            const child = doc.nodes.get(direct[i].id); if (!child) throw new Error('Group child disappeared');
                            const opacity = child.opacity * live.opacity;
                            reparentNode(doc, builder, child, live.parent, runtime.render.changeGeometry, keys[i]);
                            setIfChanged(builder, doc.nodes.get(child.id)!, 'opacity', opacity); moved.push(child.id);
                        }
                        builder.push({ t: 'delete', id: live.id });
                    }
                    return moved;
                };
            }, moved => moved);
        },
        removeFrames(ids: readonly NodeId[], signal?: AbortSignal) {
            return guarded(ids, 'Remove frame', signal, async (roots, state, activeSignal) => {
                if (!roots.length || roots.some(node => node.kind !== 'frame')) throw new Error('Remove frame requires frames');
                const contents = await prepareContainerContents(doc, roots, { signal: activeSignal, cooperate,
                    current: () => { try { check(state, activeSignal); return true; } catch { return false; } } });
                check(state, activeSignal);
                return builder => {
                    const moved: NodeId[] = [];
                    for (const original of roots) {
                        const frame = doc.nodes.get(original.id);
                        if (!frame || frame.kind !== 'frame') throw new Error('Frame disappeared');
                        const siblings = childrenOf(doc, frame.parent), index = siblings.findIndex(node => node.id === frame.id);
                        if (index < 0) throw new Error('Frame order changed');
                        const direct = contents.get(frame.id)!;
                        const keys = direct.length ? allocateOrderKeys(doc, builder, frame.parent, index > 0 ? siblings[index - 1].id : null,
                            index + 1 < siblings.length ? siblings[index + 1].id : null, direct.length) : [];
                        for (let i = 0; i < direct.length; i++) {
                            const child = doc.nodes.get(direct[i].id); if (!child) throw new Error('Frame child disappeared');
                            const opacity = child.opacity * frame.opacity;
                            reparentNode(doc, builder, child, frame.parent, runtime.render.changeGeometry, keys[i]);
                            setIfChanged(builder, doc.nodes.get(child.id)!, 'opacity', opacity); moved.push(child.id);
                        }
                        builder.push({ t: 'delete', id: frame.id });
                    }
                    return moved;
                };
            }, moved => moved);
        },
        async reorderSelection(ids: readonly NodeId[], direction: SelectionOrder, signal?: AbortSignal): Promise<void> {
            if (!['front', 'back', 'forward', 'backward'].includes(direction)) throw new RangeError('Invalid selection order');
            const activeSignal = signal ?? new AbortController().signal, state = capture(); check(state, activeSignal);
            const roots = await rootsFor(ids, state, true, activeSignal); check(state, activeSignal);
            const plan = await prepareSelectionOrderPlan(doc, roots, direction, { signal: activeSignal, cooperate,
                current: () => { try { check(state, activeSignal); return true; } catch { return false; } } });
            check(state, activeSignal); if (!plan.length) return;
            const current = () => { try { check(state, activeSignal); return true; } catch { return false; } };
            const rootIds = await selectionNodeIds(doc, roots, { signal: activeSignal, current, cooperate });
            const lease = await runtime.render.pinChangeGeometry(rootIds, activeSignal, doc, current);
            try {
                commit(state, activeSignal, 'Reorder', builder => {
                    for (const run of plan) {
                        const keys = allocateOrderKeys(doc, builder, run.parent, run.before, run.after, run.ids.length);
                        for (let i = 0; i < run.ids.length; i++) {
                            const node = doc.nodes.get(run.ids[i]); if (!node) throw new Error('Reordered node disappeared');
                            setIfChanged(builder, node, 'order', keys[i]);
                        }
                    }
                });
            } finally { lease.release(); }
        },
        async toggleLocked(ids: readonly NodeId[], signal?: AbortSignal): Promise<void> {
            const token = signal ?? new AbortController().signal, state = capture();
            const roots = await rootsFor(ids, state, false, token, true); check(state, token);
            if (!roots.length) return;
            for (const node of roots) if (node.kind === 'opaque') throw new Error('Opaque nodes cannot be unlocked');
            const label = roots.every(node => node.locked) ? 'Unlock' : roots.every(node => !node.locked) ? 'Lock' : 'Toggle lock';
            commit(state, token, label, builder => { for (const node of roots) setIfChanged(builder, node, 'locked', !node.locked); });
        },
        async unlockAll(signal?: AbortSignal): Promise<void> {
            const token = signal ?? new AbortController().signal, state = capture(), ids: NodeId[] = [];
            let count = 0, started = performance.now();
            for (const node of doc.nodes.values()) {
                check(state, token);
                if (node.locked && node.kind !== 'opaque') ids.push(node.id);
                if (++count >= 256 || performance.now() - started >= 3) { await cooperate(); check(state, token); count = 0; started = performance.now(); }
            }
            if (!ids.length) return;
            commit(state, token, 'Unlock all', builder => { for (const id of ids) { const node = doc.nodes.get(id); if (node) setIfChanged(builder, node, 'locked', false); } });
        },
    };
}
