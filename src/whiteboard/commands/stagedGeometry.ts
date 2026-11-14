import type { Affine } from '../../platform/types';
import type { ChangeGeometry, WorldPose } from '../change/coordinates';
import { worldPose } from '../change/coordinates';
import { inverse } from '../geom/affine';
import type { BoardRuntime } from '../host/runtime';
import type { BoardDoc } from '../model/doc';
import type { NodeId } from '../model/ids';
import type { ConnectorNode, Node, Point } from '../model/nodes';
import { IDENTITY, logicalAggregateBox, matrix, type LogicalSource } from './logicalGeometry';

export interface StagedBox { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
/** Synchronous, view-independent logical geometry of the STAGED document. An open builder
 * changes nodes without changing doc.rev, so nothing here is cached by revision. */
export interface StagedGeometryReader {
    /** Logical bounds in the page-less world space, the same box the async scope reports. */
    worldBox(node: Readonly<Node>): StagedBox;
    /** Exact unrotated box in the node's own frame. */
    localBox(node: Readonly<Node>): StagedBox;
    resolvedTip: ChangeGeometry['resolvedTip'];
}

function settle<T>(work: Generator<void, T, void>): T {
    // `due` is always false here, so the generator never asks to yield; the loop only documents that.
    for (;;) { const step = work.next(); if (step.done) return step.value; }
}
/** Mirrors the async reader: a group with no leaf has no ink, so its origin is a zero-extent point. */
function hasLeaf(doc: BoardDoc, root: Readonly<Node>): boolean {
    const pending: Readonly<Node>[] = [root];
    while (pending.length) {
        const value = pending.pop()!;
        if (value.kind !== 'group') return true;
        for (const child of doc.children.get(value.id) ?? []) pending.push(child);
    }
    return false;
}

/** The same logical formula as the async scope; resource pins live for one synchronous read. */
export function createStagedGeometryReader(render: BoardRuntime['render'], doc: BoardDoc, signal: AbortSignal): StagedGeometryReader {
    const pose = (id: NodeId): WorldPose => worldPose(doc, id);
    const ZERO: StagedBox = { x: 0, y: 0, w: 0, h: 0 };
    // `targetFromWorld` is the rigid space of the answer: identity for the world, the inverse pose for the node's own frame.
    const measure = (id: NodeId, targetFromWorld: Affine, empty: StagedBox): StagedBox => {
        const root = doc.nodes.get(id);
        if (!root) throw new Error(`Node is not in the staged document: ${id}`);
        if (root.kind === 'group' && !hasLeaf(doc, root)) return empty;
        const lease = render.pinChangeGeometryNow([root.id], signal, doc);
        try {
            const source: LogicalSource = {
                prepared: leaf => {
                    const value = doc.nodes.get(leaf);
                    return value && value.kind !== 'group' ? render.prepareForPickNow(value, signal, doc) : undefined;
                },
                // Attached ends need cooperative crossings, which a synchronous writer cannot wait for. They are
                // refused (never estimated) by the logical formula; unattached polylines are exact here.
                polylinePoints: () => undefined,
                children: parent => doc.children.get(parent) ?? [],
                pose,
                check: () => signal.throwIfAborted(),
            };
            const box = settle(logicalAggregateBox(source, root, targetFromWorld, () => false));
            return { x: box[0], y: box[1], w: box[2] - box[0], h: box[3] - box[1] };
        } finally { lease.release(); }
    };
    return {
        worldBox(node) {
            const origin = pose(node.id);
            return measure(node.id, IDENTITY, { x: origin.x, y: origin.y, w: 0, h: 0 });
        },
        localBox(node) {
            const back = inverse(matrix(pose(node.id)), 1e12);
            if (!back) throw new Error(`Geometry transform is not invertible: ${node.id}`);
            return measure(node.id, back, ZERO);
        },
        resolvedTip: (candidate, connector: ConnectorNode, terminal: 'start' | 'end'): Point => render.changeGeometry.resolvedTip(candidate, connector, terminal),
    };
}
