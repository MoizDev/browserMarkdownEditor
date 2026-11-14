import type { NodeId } from '../model/ids';
import { createNode, type Node } from '../model/nodes';

export interface SceneRecordPin {
    get(id: NodeId): Node | undefined;
    values(): Iterable<Node>;
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
interface Link { readonly value: Value; readonly left: Link | null; readonly right: Link | null; readonly height: number; refs: number }
const height = (node: Link | null) => node?.height ?? 0;

/** A path-copied AVL owns its links and values independently of the live mutable model. */
export async function createSceneRecordStore(initial: Iterable<Node>, retain: Retain,
    cooperate?: () => Promise<void>, signal?: AbortSignal): Promise<SceneRecordStore> {
    let root: Link | null = null, disposed = false, scheduled = false, failure: unknown;
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
        return { value, left, right, height: 1 + Math.max(height(left), height(right)), refs: 1 };
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
    const insert = (link: Link | null, value: Value): Link => {
        if (!link) return make(value, null, null);
        const id = value.node.id, current = link.value.node.id;
        if (id === current) return make(value, link.left, link.right);
        if (id < current) {
            const next = insert(link.left, value);
            try { return balance(link.value, next, link.right); } finally { releaseLink(next); }
        }
        const next = insert(link.right, value);
        try { return balance(link.value, link.left, next); } finally { releaseLink(next); }
    };
    const remove = (link: Link | null, id: NodeId): Link | null => {
        if (!link) return null;
        const current = link.value.node.id;
        if (id < current) {
            const next = remove(link.left, id);
            try { return balance(link.value, next, link.right); } finally { releaseLink(next); }
        }
        if (id > current) {
            const next = remove(link.right, id);
            try { return balance(link.value, link.left, next); } finally { releaseLink(next); }
        }
        if (!link.left) return keep(link.right);
        if (!link.right) return keep(link.left);
        let successor = link.right;
        while (successor.left) successor = successor.left;
        const next = remove(link.right, successor.value.node.id);
        try { return balance(successor.value, link.left, next); } finally { releaseLink(next); }
    };
    const stageRecord = (base: Link | null, record: Node): Link => {
        const node = Object.freeze(createNode(record)), lease = retain(node), value: Value = { node, lease, refs: 1 };
        try { return insert(base, value); } finally { releaseValue(value); }
    };
    const update = (records: Iterable<Node>, removed: Iterable<NodeId>) => {
        if (disposed) throw new Error('Scene record store is disposed');
        let staged = keep(root);
        try {
            for (const id of removed) {
                const next = remove(staged, id);
                releaseLink(staged); staged = next;
            }
            for (const record of records) {
                const next = stageRecord(staged, record);
                releaseLink(staged); staged = next;
            }
        } catch (error) { releaseLink(staged); throw error; }
        const previous = root; root = staged; releaseLink(previous);
    };
    const pin = (): SceneRecordPin => {
        if (disposed) throw new Error('Scene record store is disposed');
        let held = keep(root), released = false;
        const guard = () => { if (released) throw new Error('Scene record pin is released'); };
        return {
            get(id) {
                guard();
                let cursor = held;
                while (cursor) {
                    const key = cursor.value.node.id;
                    if (id === key) return cursor.value.node;
                    cursor = id < key ? cursor.left : cursor.right;
                }
                return undefined;
            },
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
            release() { if (!released) { released = true; releaseLink(held); held = null; } },
        };
    };
    const dispose = () => { if (!disposed) { disposed = true; releaseLink(root); root = null; } };
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
            const next = stageRecord(root, node);
            releaseLink(root); root = next; count++;
        }
        signal?.throwIfAborted();
        return { update, pin, dispose, drain };
    } catch (error) {
        dispose();
        try { await drain(); } catch { /* preserve the admission failure */ }
        throw error;
    }
}
