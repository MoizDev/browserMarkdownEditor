import type { MediaStore } from '../media/store';
import type { ExtBag, RawJson } from '../model/json';
import type { MediaId } from '../model/media';
import type { Node } from '../model/nodes';
import { nodeRawValues, scanRawMedia, scanRawMediaIncremental } from '../model/rawMedia';
import type { SampleStoreReader } from '../model/samples';
import type { RichText } from '../text/richText';
import { yieldToHost } from '../../platform/yieldToHost';

const LIMIT = 256;
type Ids = readonly MediaId[];
type Lease = { release(): void };
type Signature = { readonly kind: Node['kind']; readonly ext: ExtBag | null; readonly rich: RichText | null; readonly raw: RawJson | null };
type NodeEntry = Signature & { readonly ids: Ids };

class WeakFifo<T extends object, V> {
    private readonly values = new WeakMap<T, V>();
    private readonly order: WeakRef<T>[] = [];
    get(key: T): V | undefined { return this.values.get(key); }
    set(key: T, value: V): void {
        if (!this.values.has(key)) {
            if (this.order.length === LIMIT) { const old = this.order.shift()!.deref(); if (old) this.values.delete(old); }
            this.order.push(new WeakRef(key));
        }
        this.values.set(key, value);
    }
}
const rawCache = new Map<RawJson, Ids>();
const carrierCache = new WeakFifo<object, Ids>();
const nodeCache = new WeakFifo<object, NodeEntry>();
function remembered(raw: RawJson): Ids | undefined {
    const value = rawCache.get(raw);
    if (value !== undefined) { rawCache.delete(raw); rawCache.set(raw, value); }
    return value;
}
function remember(raw: RawJson, ids: Ids): void {
    rawCache.delete(raw); rawCache.set(raw, ids);
    if (rawCache.size > LIMIT) rawCache.delete(rawCache.keys().next().value!);
}
function signature(node: Readonly<Node>): Signature {
    return { kind: node.kind, ext: node.ext,
        rich: node.kind === 'text' || node.kind === 'sticky' ? node.text : node.kind === 'figure' || node.kind === 'connector' ? node.label : null,
        raw: node.kind === 'opaque' ? node.raw : null };
}
function same(a: Signature, b: Signature): boolean {
    return a.kind === b.kind && a.ext === b.ext && a.rich === b.rich && a.raw === b.raw;
}
function* extValues(ext: ExtBag): Iterable<RawJson | null> {
    yield* nodeRawValues({ kind: 'group', ext });
}
function* richValues(rich: RichText): Iterable<RawJson | null> {
    yield* nodeRawValues({ kind: 'text', ext: null, text: rich });
}
function rawIds(raw: RawJson): Ids {
    const hit = remembered(raw);
    if (hit) return hit;
    const ids = new Set<MediaId>();
    scanRawMedia(raw, id => ids.add(id));
    const result = Object.freeze([...ids]); remember(raw, result); return result;
}
function carrierIds(key: object, values: Iterable<RawJson | null>): Ids {
    const hit = carrierCache.get(key);
    if (hit) return hit;
    const ids = new Set<MediaId>();
    for (const raw of values) if (raw !== null) for (const id of rawIds(raw)) ids.add(id);
    const result = Object.freeze([...ids]); carrierCache.set(key, result); return result;
}
function extraIds(node: Readonly<Node>): Ids {
    const current = signature(node), hit = nodeCache.get(node);
    if (hit && same(hit, current)) return hit.ids;
    const ids = new Set<MediaId>();
    if (current.ext) for (const id of carrierIds(current.ext, extValues(current.ext))) ids.add(id);
    if (current.rich) for (const id of carrierIds(current.rich, richValues(current.rich))) ids.add(id);
    if (current.raw !== null) for (const id of rawIds(current.raw)) ids.add(id);
    const result = Object.freeze([...ids]); nodeCache.set(node, { ...current, ids: result }); return result;
}

export async function prewarmPaintNodeResources(nodes: Iterable<Readonly<Node>>, cooperate?: () => Promise<void>, signal?: AbortSignal): Promise<void> {
    let work = 0, started = performance.now();
    const tick = async () => {
        signal?.throwIfAborted();
        await (cooperate?.() ?? yieldToHost());
        signal?.throwIfAborted(); work = 0; started = performance.now();
    };
    const due = () => ++work >= 256 || performance.now() - started >= 3;
    const asyncRaw = async (raw: RawJson): Promise<Ids> => {
        const hit = remembered(raw);
        if (hit) return hit;
        const ids = new Set<MediaId>();
        await scanRawMediaIncremental(raw, id => ids.add(id), tick);
        signal?.throwIfAborted();
        const result = Object.freeze([...ids]); remember(raw, result); return result;
    };
    const asyncCarrier = async (key: object, values: Iterable<RawJson | null>): Promise<Ids> => {
        const hit = carrierCache.get(key);
        if (hit) return hit;
        const ids = new Set<MediaId>();
        for (const raw of values) {
            if (due()) await tick();
            if (raw !== null) for (const id of await asyncRaw(raw)) ids.add(id);
        }
        const result = Object.freeze([...ids]); carrierCache.set(key, result); return result;
    };
    signal?.throwIfAborted();
    for (const node of nodes) {
        if (due()) await tick();
        const current = signature(node), hit = nodeCache.get(node);
        if (hit && same(hit, current)) continue;
        const ids = new Set<MediaId>();
        if (current.ext) for (const id of await asyncCarrier(current.ext, extValues(current.ext))) ids.add(id);
        if (current.rich) for (const id of await asyncCarrier(current.rich, richValues(current.rich))) ids.add(id);
        if (current.raw !== null) for (const id of await asyncRaw(current.raw)) ids.add(id);
        signal?.throwIfAborted();
        if (same(current, signature(node))) nodeCache.set(node, { ...current, ids: Object.freeze([...ids]) });
    }
    signal?.throwIfAborted();
}

function releaseAll(leases: readonly Lease[]): void {
    let first: unknown, failed = false;
    for (let i = leases.length - 1; i >= 0; i--) {
        try { leases[i].release(); } catch (error) { if (!failed) { first = error; failed = true; } }
    }
    if (failed) throw first;
}

export function retainPaintNodeResources(node: Readonly<Node>, samples: SampleStoreReader, media: MediaStore): { release(): void } {
    const ids = new Set<MediaId>(extraIds(node));
    if ((node.kind === 'picture' || node.kind === 'clip') && node.media) ids.add(node.media);
    if (node.kind === 'linkcard' && node.preview) {
        if (node.preview.image) ids.add(node.preview.image);
        if (node.preview.favicon) ids.add(node.preview.favicon);
    }
    const leases: Lease[] = [];
    try {
        if (node.kind === 'stroke') leases.push(samples.retain(node.samples));
        for (const id of ids) leases.push(media.retain(id, 'snapshot'));
    } catch (error) {
        try { releaseAll(leases); } catch { /* retain failure is the primary error */ }
        throw error;
    }
    let released = false;
    return { release() { if (!released) { released = true; releaseAll(leases); } } };
}
