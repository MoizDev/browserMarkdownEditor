import type { NodeId, ParentId } from '../model/ids';
import { createNode, type Node } from '../model/nodes';
import { compareOrder } from '../model/orderKey';

export interface SceneRecordPin {
    readonly nodeCount: number;
    get(id: NodeId): Node | undefined;
    values(): Iterable<Node>;
    children(parent: ParentId): Iterable<Node>;
    childCount(parent: ParentId): number;
    childAt(parent: ParentId, index: number): Node | undefined;
    release(): void;
}
export interface SceneRecordStore {
    update(records: Iterable<Node>, removed: Iterable<NodeId>): void;
    pin(): SceneRecordPin;
    dispose(): void;
    drain(): Promise<void>;
}
type Lease = { release(): void };
type Retain = (node: Node) => Lease;
interface Value { readonly node: Node; readonly lease: Lease; refs: number }
interface Link { readonly value: Value; readonly left: Link | null; readonly right: Link | null; readonly height: number; readonly count: number; refs: number }
type Compare = (a: Node, b: Node) => number;
const height = (node: Link | null) => node?.height ?? 0;
const countLinks = (node: Link | null) => node?.count ?? 0;
const idCompare: Compare = (a, b) => a.id === b.id ? 0 : a.id < b.id ? -1 : 1;
const parentCompare: Compare = (a, b) => a.parent === b.parent ? compareOrder(a, b) : a.parent < b.parent ? -1 : 1;

/** A path-copied AVL owns its links and values independently of the live mutable model. */
export async function createSceneRecordStore(initial: Iterable<Node>, retain: Retain,
    cooperate?: () => Promise<void>, signal?: AbortSignal): Promise<SceneRecordStore> {
    let root: Link | null = null, parentRoot: Link | null = null, disposed = false, scheduled = false, failure: unknown;
    const pending: Link[] = [];
    let waiters: { resolve(): void; reject(error: unknown): void }[] = [];
    const schedule = () => {
        if (!scheduled && pending.length) { scheduled = true; setTimeout(sweep, 0); }
    };
    const releaseValue = (value: Value) => {
        if (--value.refs === 0) {
            try { value.lease.release(); } catch (error) { failure ??= error; }
        }
    };
    const releaseLink = (link: Link | null) => {
        if (link && --link.refs === 0) { pending.push(link); schedule(); }
    };
    function sweep(): void {
        scheduled = false;
        const started = performance.now();
        let count = 0;
        while (pending.length && count++ < 256 && performance.now() - started < 3) {
            const link = pending.pop()!;
            releaseLink(link.left); releaseLink(link.right); releaseValue(link.value);
        }
        if (pending.length) schedule();
        else {
            const done = waiters; waiters = [];
            for (const waiter of done) { if (failure !== undefined) waiter.reject(failure); else waiter.resolve(); }
        }
    }
    const drain = (): Promise<void> => {
        if (!pending.length) return failure === undefined ? Promise.resolve() : Promise.reject(failure);
        schedule();
        return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    };
    const keep = (link: Link | null): Link | null => { if (link) link.refs++; return link; };
    const make = (value: Value, left: Link | null, right: Link | null): Link => {
        value.refs++; keep(left); keep(right);
        return { value, left, right, height: 1 + Math.max(height(left), height(right)), count: 1 + countLinks(left) + countLinks(right), refs: 1 };
    };
    // Arguments are borrowed; the returned root owns one reference. Rotations
    // allocate only the affected path and share every untouched subtree/value.
    const balance = (value: Value, left: Link | null, right: Link | null): Link => {
        if (height(left) - height(right) > 1) {
            const l = left!;
            if (height(l.left) >= height(l.right)) {
                const nextRight = make(value, l.right, right);
                try { return make(l.value, l.left, nextRight); } finally { releaseLink(nextRight); }
            }
            const middle = l.right!;
            const nextLeft = make(l.value, l.left, middle.left);
            try {
                const nextRight = make(value, middle.right, right);
                try { return make(middle.value, nextLeft, nextRight); } finally { releaseLink(nextRight); }
            } finally { releaseLink(nextLeft); }
        }
        if (height(right) - height(left) > 1) {
            const r = right!;
            if (height(r.right) >= height(r.left)) {
                const nextLeft = make(value, left, r.left);
                try { return make(r.value, nextLeft, r.right); } finally { releaseLink(nextLeft); }
            }
            const middle = r.left!;
            const nextLeft = make(value, left, middle.left);
            try {
                const nextRight = make(r.value, middle.right, r.right);
                try { return make(middle.value, nextLeft, nextRight); } finally { releaseLink(nextRight); }
            } finally { releaseLink(nextLeft); }
        }
        return make(value, left, right);
    };
    const insert = (link: Link | null, value: Value, compare: Compare): Link => {
        if (!link) return make(value, null, null);
        const order = compare(value.node, link.value.node);
        if (!order) return make(value, link.left, link.right);
        if (order < 0) {
            const next = insert(link.left, value, compare);
            try { return balance(link.value, next, link.right); } finally { releaseLink(next); }
        }
        const next = insert(link.right, value, compare);
        try { return balance(link.value, link.left, next); } finally { releaseLink(next); }
    };
    const remove = (link: Link | null, node: Node, compare: Compare): Link | null => {
        if (!link) return null;
        const order = compare(node, link.value.node);
        if (order < 0) {
            const next = remove(link.left, node, compare);
            try { return balance(link.value, next, link.right); } finally { releaseLink(next); }
        }
        if (order > 0) {
            const next = remove(link.right, node, compare);
            try { return balance(link.value, link.left, next); } finally { releaseLink(next); }
        }
        if (!link.left) return keep(link.right);
        if (!link.right) return keep(link.left);
        let successor = link.right;
        while (successor.left) successor = successor.left;
        const next = remove(link.right, successor.value.node, compare);
        try { return balance(successor.value, link.left, next); } finally { releaseLink(next); }
    };
    const find = (base: Link | null, id: NodeId): Value | undefined => {
        let cursor = base;
        while (cursor) {
            const key = cursor.value.node.id;
            if (id === key) return cursor.value;
            cursor = id < key ? cursor.left : cursor.right;
        }
        return undefined;
    };
    const update = (records: Iterable<Node>, removed: Iterable<NodeId>) => {
        if (disposed) throw new Error('Scene record store is disposed');
        let staged = keep(root), stagedParents = keep(parentRoot);
        try {
            for (const id of removed) {
                const old = find(staged, id);
                if (!old) continue;
                const next = remove(staged, old.node, idCompare);
                releaseLink(staged); staged = next;
                const nextParents = remove(stagedParents, old.node, parentCompare);
                releaseLink(stagedParents); stagedParents = nextParents;
            }
            for (const record of records) {
                const node = Object.freeze(createNode(record)), lease = retain(node), value: Value = { node, lease, refs: 1 };
                try {
                    const old = find(staged, node.id);
                    if (old) {
                        const nextParents = remove(stagedParents, old.node, parentCompare);
                        releaseLink(stagedParents); stagedParents = nextParents;
                    }
                    const next = insert(staged, value, idCompare);
                    releaseLink(staged); staged = next;
                    const nextParents = insert(stagedParents, value, parentCompare);
                    releaseLink(stagedParents); stagedParents = nextParents;
                } finally { releaseValue(value); }
            }
        } catch (error) { releaseLink(staged); releaseLink(stagedParents); throw error; }
        const previous = root, previousParents = parentRoot;
        root = staged; parentRoot = stagedParents; releaseLink(previous); releaseLink(previousParents);
    };
    const parentRank = (base: Link | null, parent: ParentId, upper: boolean): number => {
        let cursor = base, rank = 0;
        while (cursor) {
            const key = cursor.value.node.parent;
            if (key < parent || (upper && key === parent)) {
                rank += countLinks(cursor.left) + 1; cursor = cursor.right;
            } else cursor = cursor.left;
        }
        return rank;
    };
    const select = (base: Link | null, rank: number): Node | undefined => {
        let cursor = base;
        while (cursor) {
            const left = countLinks(cursor.left);
            if (rank === left) return cursor.value.node;
            if (rank < left) cursor = cursor.left;
            else { rank -= left + 1; cursor = cursor.right; }
        }
        return undefined;
    };
    const pin = (): SceneRecordPin => {
        if (disposed) throw new Error('Scene record store is disposed');
        let held = keep(root), heldParents = keep(parentRoot), released = false;
        const guard = () => { if (released) throw new Error('Scene record pin is released'); };
        return {
            get nodeCount() { guard(); return countLinks(held); },
            get(id) { guard(); return find(held, id)?.node; },
            *values() {
                guard();
                const stack: Link[] = []; let cursor = held;
                while (cursor || stack.length) {
                    guard();
                    while (cursor) { stack.push(cursor); cursor = cursor.left; }
                    const next = stack.pop()!;
                    yield next.value.node;
                    cursor = next.right;
                }
            },
            childCount(parent) {
                guard();
                return parentRank(heldParents, parent, true) - parentRank(heldParents, parent, false);
            },
            childAt(parent, index) {
                guard();
                if (!Number.isSafeInteger(index) || index < 0) throw new RangeError('Invalid child index');
                const first = parentRank(heldParents, parent, false), end = parentRank(heldParents, parent, true);
                return index < end - first ? select(heldParents, first + index) : undefined;
            },
            *children(parent) {
                guard();
                const stack: Link[] = []; let cursor = heldParents;
                while (cursor || stack.length) {
                    guard();
                    while (cursor) {
                        if (cursor.value.node.parent < parent) cursor = cursor.right;
                        else { stack.push(cursor); cursor = cursor.left; }
                    }
                    if (!stack.length) break;
                    const next = stack.pop()!, node = next.value.node;
                    if (node.parent !== parent) break;
                    yield node; cursor = next.right;
                }
            },
            release() {
                if (!released) { released = true; releaseLink(held); releaseLink(heldParents); held = heldParents = null; }
            },
        };
    };
    const dispose = () => { if (!disposed) { disposed = true; releaseLink(root); releaseLink(parentRoot); root = parentRoot = null; } };
    let count = 0, started = performance.now();
    try {
        signal?.throwIfAborted();
        for (const node of initial) {
            if (count >= 256 || performance.now() - started >= 3) {
                signal?.throwIfAborted(); await cooperate?.(); signal?.throwIfAborted();
                // Initial path copies become unreachable immediately; let their
                // deferred releases catch up before accepting another batch.
                await drain();
                count = 0; started = performance.now();
            }
            update([node], []); count++;
        }
        signal?.throwIfAborted();
        return { update, pin, dispose, drain };
    } catch (error) {
        dispose();
        try { await drain(); } catch { /* preserve the admission failure */ }
        throw error;
    }
}
