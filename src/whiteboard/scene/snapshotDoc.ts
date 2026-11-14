import type { Applied } from '../change/ops';
import type { BoardDoc, BoardKind, HostBlock, PreservedBlock, Sheet, ViewFlags } from '../model/doc';
import type { SheetId } from '../model/ids';
import type { MediaEntry, MediaId } from '../model/media';
import type { UiBlock } from '../model/styles';

// Provenance: board model ownership and scene snapshot contracts; independent
// persistent overlay implementation, no third-party source.
export interface SceneMetadata {
    readonly kind: BoardKind;
    readonly sheets: ReadonlyMap<SheetId, Sheet>;
    readonly sheetOrder: readonly Sheet[];
    readonly ui: UiBlock;
    readonly view: ViewFlags;
    readonly host: HostBlock;
    readonly preserved: PreservedBlock;
    readonly media: ReadonlyMap<MediaId, MediaEntry>;
    readonly preservedMediaRefs: ReadonlyMap<MediaId, number>;
}
type Step<K, V> = { readonly previous: Step<K, V> | null; readonly values: ReadonlyMap<K, V | undefined> };
class LayerMap<K, V> implements ReadonlyMap<K, V> {
    readonly [Symbol.toStringTag] = 'LayerMap';
    constructor(readonly head: Step<K, V>, readonly size: number) {}
    get(key: K): V | undefined {
        for (let layer: Step<K, V> | null = this.head; layer; layer = layer.previous) {
            if (layer.values.has(key)) return layer.values.get(key);
        }
        return undefined;
    }
    has(key: K): boolean { return this.get(key) !== undefined; }
    *entries(): MapIterator<[K, V]> {
        const seen = new Set<K>();
        for (let layer: Step<K, V> | null = this.head; layer; layer = layer.previous) {
            for (const [key, value] of layer.values) {
                if (seen.has(key)) continue;
                seen.add(key);
                if (value !== undefined) yield [key, value];
            }
        }
    }
    *keys(): MapIterator<K> { for (const [key] of this.entries()) yield key; }
    *values(): MapIterator<V> { for (const [, value] of this.entries()) yield value; }
    [Symbol.iterator](): MapIterator<[K, V]> { return this.entries(); }
    forEach(callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
        for (const [key, value] of this) callback.call(thisArg, value, key, this);
    }
    update(changes: Map<K, V | undefined>): LayerMap<K, V> {
        if (!changes.size) return this;
        let size = this.size;
        for (const [key, value] of changes) {
            const had = this.has(key);
            if (had && value === undefined) size--;
            else if (!had && value !== undefined) size++;
        }
        return new LayerMap({ previous: this.head, values: changes }, size);
    }
}
function abort(signal?: AbortSignal): void {
    if (signal?.aborted) throw new DOMException('Scene metadata capture cancelled', 'AbortError');
}
function ticker(cooperate?: () => Promise<void>, signal?: AbortSignal) {
    let steps = 0, start = performance.now();
    return async (force = false) => {
        abort(signal);
        if (force || ++steps >= 256 || performance.now() - start >= 3) {
            await (cooperate?.() ?? new Promise<void>(resolve => setTimeout(resolve, 0)));
            abort(signal); steps = 0; start = performance.now();
        }
    };
}
async function baseMap<K, V, U>(source: ReadonlyMap<K, V>, copy: (value: V) => U,
    tick: (force?: boolean) => Promise<void>): Promise<LayerMap<K, U>> {
    const values = new Map<K, U>();
    for (const [key, value] of source) { await tick(); values.set(key, copy(value)); }
    return new LayerMap({ previous: null, values }, values.size);
}
function small(doc: BoardDoc, host: HostBlock): Pick<SceneMetadata, 'kind' | 'ui' | 'view' | 'host' | 'preserved'> {
    return { kind: doc.kind, ui: { ...doc.ui, next: { ...doc.ui.next } }, view: { ...doc.view },
        host, preserved: { ...doc.preserved, version: [...doc.preserved.version] as [number, number] } };
}

/** Async because initial media and preserved-reference tables can be document-sized. */
export async function captureSceneMetadata(doc: BoardDoc, cooperate?: () => Promise<void>, signal?: AbortSignal): Promise<SceneMetadata> {
    return (await SceneMetadataStore.create(doc, cooperate, signal)).pin();
}
export class SceneMetadataStore {
    private constructor(private current: SceneMetadata) {}
    static async create(doc: BoardDoc, cooperate?: () => Promise<void>, signal?: AbortSignal): Promise<SceneMetadataStore> {
        const revision = doc.rev, advance = ticker(cooperate, signal);
        const tick = async (force = false) => {
            if (doc.rev !== revision) throw new Error('Board changed during scene metadata capture');
            await advance(force);
            if (doc.rev !== revision) throw new Error('Board changed during scene metadata capture');
        };
        await tick(true);
        const sheets = await baseMap(doc.sheets, sheet => ({ ...sheet }), tick);
        const media = await baseMap(doc.media, entry => ({ ...entry }), tick);
        const refs = await baseMap(doc.preservedMediaRefs, value => value, tick);
        const sheetOrder: Sheet[] = [];
        for (const sheet of doc.sheetOrder) { await tick(); const copy = sheets.get(sheet.id); if (!copy) throw new Error('Missing ordered sheet'); sheetOrder.push(copy); }
        const originalHost = doc.host;
        let host: HostBlock;
        if (originalHost.kind === 'pdf-ink') {
            const pages: (readonly [number, number])[] = [];
            for (const page of originalHost.pages) { await tick(); pages.push([page[0], page[1]]); }
            host = { ...originalHost, pages };
        } else host = originalHost.kind === 'notebook' ? { ...originalHost, paper: { ...originalHost.paper } } : { ...originalHost };
        abort(signal);
        return new SceneMetadataStore({ ...small(doc, host), sheets, media, preservedMediaRefs: refs, sheetOrder });
    }
    update(applied: Applied, doc: BoardDoc): void {
        const old = this.current;
        const sheets = old.sheets as LayerMap<SheetId, Sheet>, media = old.media as LayerMap<MediaId, MediaEntry>;
        const refs = old.preservedMediaRefs as LayerMap<MediaId, number>;
        const sheetChanges = new Map<SheetId, Sheet | undefined>(), mediaChanges = new Map<MediaId, MediaEntry | undefined>();
        const refChanges = new Map<MediaId, number | undefined>();
        for (const id of applied.touched.sheets) { const sheet = doc.sheets.get(id); sheetChanges.set(id, sheet && { ...sheet }); }
        for (const id of applied.touched.media) {
            const entry = doc.media.get(id); mediaChanges.set(id, entry && { ...entry }); refChanges.set(id, doc.preservedMediaRefs.get(id));
        }
        const nextSheets = sheets.update(sheetChanges);
        const sheetOrder = sheetChanges.size ? doc.sheetOrder.map(sheet => {
            const copy = nextSheets.get(sheet.id); if (!copy) throw new Error('Missing ordered sheet'); return copy;
        }) : old.sheetOrder;
        let host = old.host;
        if (doc.host.kind === 'notebook' && old.host.kind === 'notebook' && applied.touched.board.has('host.paper')) host = { ...doc.host, paper: { ...doc.host.paper } };
        else if (doc.host.kind === 'pdf-ink' && old.host.kind === 'pdf-ink' && applied.touched.board.has('host.pdf')) host = { ...doc.host, pages: old.host.pages };
        this.current = { ...small(doc, host), sheets: nextSheets, sheetOrder, media: media.update(mediaChanges), preservedMediaRefs: refs.update(refChanges) };
    }
    pin(): SceneMetadata { return this.current; }
    /** Compaction publishes new layers only if no update raced it; existing pins retain their layers. */
    async materialize(signal?: AbortSignal, cooperate?: () => Promise<void>): Promise<SceneMetadata> {
        const pinned = this.current, tick = ticker(cooperate, signal);
        const flatten = async <K, V>(map: ReadonlyMap<K, V>): Promise<LayerMap<K, V>> => {
            const source = map as LayerMap<K, V>, values = new Map<K, V>(), seen = new Set<K>();
            for (let layer: Step<K, V> | null = source.head; layer; layer = layer.previous) {
                for (const [key, value] of layer.values) {
                    await tick();
                    if (seen.has(key)) continue;
                    seen.add(key); if (value !== undefined) values.set(key, value);
                }
            }
            return new LayerMap({ previous: null, values }, values.size);
        };
        await tick(true);
        const sheets = await flatten(pinned.sheets), media = await flatten(pinned.media), refs = await flatten(pinned.preservedMediaRefs);
        abort(signal);
        const result: SceneMetadata = { ...pinned, sheets, media, preservedMediaRefs: refs };
        if (this.current === pinned) this.current = result;
        return result;
    }
}
