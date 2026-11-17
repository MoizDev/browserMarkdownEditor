import type { ByteLease } from '../../platform/render/gfx/api';
import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { PaintImageItem, PaintSource } from '../render/paintStream';
import { paintItemsOf } from '../render/paintWindows';
import type { PaintFrameAssembler } from '../render/frameTypes';
import type { PaintImageLease } from '../render/resources';
import { isMediaTileKey } from './mips';

// Provenance: video playback presentation facts for paint leases; independent per-view
// registry of presented frames. A video node has one stable image key; each advance of its
// picture is a new version of that key, so the image route keeps one texture per node and
// re-uploads it in place when the version moves.

/** The image key of a video node: stable for the node's life. The frame it names is the node's latest one. */
export const VIDEO_FRAME_PREFIX = 'frame/';
export function videoFrameKey(node: string): string {
    return `${VIDEO_FRAME_PREFIX}${encodeURIComponent(node)}`;
}

/** What a presented frame is made of: the frame the element decoded (no copy), or an immutable bitmap (animated pictures). */
export type VideoFrameSource = ImageBitmap | VideoFrame;

/** A lease on a node's frame: the paint image lease, plus the frame's version within the node's stable key. */
export interface VideoFrameLease extends PaintImageLease {
    /** Counts the node's advances; the same key with a larger version is a new picture. */
    readonly version: number;
}

interface Frame {
    readonly key: string;
    readonly node: string;
    readonly version: number;
    readonly source: VideoFrameSource;
    readonly width: number;
    readonly height: number;
    readonly lease: ByteLease;
    refs: number;
    /** Superseded or stopped: no new lease may take it, and it closes when its last holder lets go. */
    retired: boolean;
    closed: boolean;
}

export interface VideoFrameRegistry {
    /** Charges bytes to this view's memory before anything allocates them; null when disposed or when memory is refused. */
    reserve(bytes: number): ByteLease | null;
    /** Gives back a charge that no frame or decoder took. */
    release(lease: ByteLease): void;
    /**
     * Charges a new presented frame. Null defers it: memory is refused, or this view already holds RETAINED_VERSIONS
     * superseded frames for paints still in flight. The caller asks again on its next advance, and drops nothing that is held.
     */
    admitFrame(bytes: number): ByteLease | null;
    /** Takes ownership of the frame's source and its charge. Refusal (disposed) closes the source, releases the charge and returns false. */
    present(node: string, source: VideoFrameSource, lease: ByteLease): boolean;
    /** Stops a node: its latest frame retires, and nothing new can be leased for it. */
    retire(node: string): void;
    /**
     * A lease on the node's latest frame, named by its stable key. A lease holds its frame's source for as long as it is held,
     * even after a newer frame supersedes it; a key taken after that resolves to the newer frame.
     */
    lease(key: string, signal: AbortSignal): Promise<VideoFrameLease>;
    /** Synchronous hold on a key that is still present. Release pairs with the holder's own release. */
    retainKey(key: string): () => void;
    /**
     * Holds every video image a decorated frame names, by its node's key, so each still resolves while the frame is retained.
     * Throws if one of them is already gone. The release is idempotent and must run after the holder's own physical work retires.
     */
    retainFrame(frame: PaintSource): () => void;
    /** Node → its stable key, for every node with a live frame. Identity changes exactly when `version` does. */
    readonly keys: ReadonlyMap<string, string>;
    readonly version: number;
    /** True once a drawn frame has shown this node's image (its poster or a presented frame). */
    drawn(node: string): boolean;
    /** Called with the frame that was actually drawn, so the row that starts playback appears only after an image was shown. */
    markDrawn(frame: PaintSource): void;
    dispose(): void;
}

/** The video image keys a frame names, in the order the frame draws them. */
function videoKeysOf(frame: PaintSource): string[] {
    const keys: string[] = [];
    for (const item of paintItemsOf(frame)) if (item.kind === 'image' && item.imageKey.startsWith(VIDEO_FRAME_PREFIX)) keys.push(item.imageKey);
    return keys;
}

/** The pixel size of a presented source. A VideoFrame's display size is the size the image draws at. */
function sizeOf(source: VideoFrameSource): { width: number; height: number } {
    if (source instanceof ImageBitmap) return { width: source.width, height: source.height };
    return { width: source.displayWidth, height: source.displayHeight };
}

/**
 * Superseded frames one view may keep alive for paints in flight. Each holds its source and charge until released, so a
 * slow paint must not let them pile up: beyond this count the next frame is deferred, never a held one closed.
 */
const RETAINED_VERSIONS = 2;

export function createVideoFrameRegistry(options: { readonly memory: MemoryAllocator; readonly invalidate: () => void }): VideoFrameRegistry {
    const { memory } = options;
    // Every frame not yet closed: each node's latest, plus the superseded ones a paint still holds. `latest` maps a node's
    // stable key to its latest frame, and `sequence` counts each node's presented frames, which are its versions.
    const frames = new Set<Frame>(), latest = new Map<string, Frame>(), sequence = new Map<string, number>(), shown = new Set<string>();
    let keys: ReadonlyMap<string, string> = new Map(), version = 0, disposed = false;
    const publish = () => { version++; keys = new Map([...latest.values()].map(frame => [frame.node, frame.key])); options.invalidate(); };
    const drop = (frame: Frame) => {
        if (frame.closed) return;
        frame.closed = true;
        frames.delete(frame);
        if (latest.get(frame.key) === frame) latest.delete(frame.key);
        try { frame.source.close(); } finally { memory.release(frame.lease); }
    };
    const retireFrame = (frame: Frame) => { frame.retired = true; if (frame.refs === 0) drop(frame); };
    const aborted = () => new DOMException('Video frame is no longer current', 'AbortError');
    // A retired frame still held is one a paint holds, so this is the held-version count the cap reads.
    const heldVersions = () => { let held = 0; for (const frame of frames) if (frame.retired) held++; return held; };
    const hold = (key: string): (() => void) => {
        const frame = latest.get(key);
        if (disposed || !frame || frame.closed) throw new Error('Cannot retain a video frame that is no longer held');
        frame.refs++;
        let held = true;
        return () => {
            if (!held) return;
            held = false; frame.refs--;
            if (frame.refs === 0 && frame.retired) drop(frame);
        };
    };
    return {
        reserve(bytes) { return disposed ? null : memory.reserve(bytes); },
        release(lease) { memory.release(lease); },
        admitFrame(bytes) {
            if (disposed || heldVersions() >= RETAINED_VERSIONS) return null;
            return memory.reserve(bytes);
        },
        present(node, source, lease) {
            if (disposed) { source.close(); memory.release(lease); return false; }
            const seq = (sequence.get(node) ?? 0) + 1;
            sequence.set(node, seq);
            const size = sizeOf(source);
            const key = videoFrameKey(node);
            const frame: Frame = { key, node, version: seq, source, width: size.width, height: size.height, lease, refs: 0, retired: false, closed: false };
            frames.add(frame);
            const previous = latest.get(key);
            latest.set(key, frame);
            if (previous) retireFrame(previous);
            publish();
            return true;
        },
        retire(node) {
            const key = videoFrameKey(node);
            const frame = latest.get(key);
            if (!frame) return;
            latest.delete(key);
            retireFrame(frame);
            publish();
        },
        async lease(key, signal) {
            signal.throwIfAborted();
            const frame = latest.get(key);
            if (disposed || !frame || frame.closed) throw aborted();
            frame.refs++;
            let held = true;
            return {
                source: frame.source, width: frame.width, height: frame.height, cpuBytes: 0, version: frame.version,
                release() {
                    if (!held) return;
                    held = false; frame.refs--;
                    if (frame.refs === 0 && frame.retired) drop(frame);
                },
            };
        },
        retainKey: hold,
        retainFrame(frame) {
            const releases: Array<() => void> = [];
            try { for (const key of videoKeysOf(frame)) releases.push(hold(key)); }
            catch (error) { for (const done of releases) done(); throw error; }
            let released = false;
            return () => { if (released) return; released = true; for (const done of releases) done(); };
        },
        get keys() { return keys; },
        get version() { return version; },
        drawn: node => shown.has(node),
        markDrawn(frame) {
            for (const item of paintItemsOf(frame)) if (item.kind === 'image') shown.add(item.nodeId);
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            for (const frame of [...frames]) retireFrame(frame);
            latest.clear(); keys = new Map(); version++; shown.clear();
        },
    };
}

/** The overlay the view's paint pipeline wraps around its frame assembler. */
export interface VideoFrameOverlay {
    wrap(frames: PaintFrameAssembler): PaintFrameAssembler;
    drawn(frame: PaintSource): void;
}
/** The tile keys a drawn frame names, so the view can release the rasters it no longer shows. */
function tileKeysOf(frame: PaintSource): Set<string> {
    const keys = new Set<string>();
    for (const item of paintItemsOf(frame)) if (item.kind === 'image' && isMediaTileKey(item.imageKey)) keys.add(item.imageKey);
    return keys;
}
/**
 * `afterDraw` runs once per drawn frame, so the view's animation clock sees each frame the view showed. `demand` receives the
 * tile keys that frame drew: the view's picture rasters outside them are released.
 */
export function videoFrameOverlay(registry: VideoFrameRegistry, afterDraw: () => void = () => {},
    demand: (keys: ReadonlySet<string>) => void = () => {}): VideoFrameOverlay {
    return { wrap: frames => liveVideoFrames(frames, registry),
        drawn: frame => { registry.markDrawn(frame); demand(tileKeysOf(frame)); afterDraw(); } };
}

/**
 * Serves each playing picture's latest presented frame from the node's stable image key. The assembler
 * keys its frames by identity, so a decorated frame is mapped back to the original it was made from for every call that
 * the assembler owns: presented, retain, isCurrent and retire. An original is retired only when no decorated
 * version of it is still held and it is no longer the newest one.
 */
/** A decorated frame's original, by identity: every frame the assembler hands out is either an original or one of these. */
const originalOfDecorated = new WeakMap<PaintSource, PaintSource>();
export function originalOf(frame: PaintSource): PaintSource { return originalOfDecorated.get(frame) ?? frame; }

/** One image item of an original frame, and the list it sits in. Found once per original frame, so a decorate reads only these. */
interface ImageSlot { readonly list: readonly unknown[]; readonly at: number; readonly item: PaintImageItem }
const imageSlots = new WeakMap<PaintSource, readonly ImageSlot[]>();
function slotsOf(frame: PaintSource): readonly ImageSlot[] {
    const known = imageSlots.get(frame);
    if (known) return known;
    const slots: ImageSlot[] = [];
    const scan = (items: readonly { readonly kind: string }[]): void => {
        for (let at = 0; at < items.length; at++) {
            const item = items[at];
            if (item.kind === 'image') slots.push({ list: items, at, item: item as PaintImageItem });
        }
    };
    if (frame.liveOnly) for (const window of frame.windows) scan(window.items);
    else { scan(frame.underlay); scan(frame.content); }
    imageSlots.set(frame, slots);
    return slots;
}

/**
 * The frame the assembler serves for a playing picture: a new object per registry advance (the canvas2d reference's snapshot
 * restarts on object identity, and that restart is what takes the new picture's lease: canvasPaintAdapter.ts:250-252).
 * Everything else is shared with the original: only the video image items are replaced, and only the arrays that hold them are copied.
 */
function decorateFrame(frame: PaintSource, keys: ReadonlyMap<string, string>): PaintSource {
    const copies = new Map<readonly unknown[], unknown[]>();
    for (const slot of slotsOf(frame)) {
        const key = keys.get(slot.item.nodeId);
        if (key === undefined || slot.item.imageKey === key) continue;
        let copy = copies.get(slot.list);
        if (!copy) copies.set(slot.list, copy = slot.list.slice());
        copy[slot.at] = { ...slot.item, imageKey: key };
    }
    for (const copy of copies.values()) Object.freeze(copy);
    const replaced = <T>(list: readonly T[]): readonly T[] => (copies.get(list) as readonly T[] | undefined) ?? list;
    const decorated: PaintSource = frame.liveOnly
        ? Object.freeze({ ...frame, windows: Object.freeze(frame.windows.map(window => {
            const items = replaced(window.items);
            return items === window.items ? window : Object.freeze({ band: window.band, items });
        })) })
        : Object.freeze({ ...frame, underlay: replaced(frame.underlay), content: replaced(frame.content) });
    return decorated;
}

export function liveVideoFrames(base: PaintFrameAssembler, registry: VideoFrameRegistry): PaintFrameAssembler {
    const versions = new Map<PaintSource, Set<PaintSource>>(), deferred = new Set<PaintSource>();
    let newest: PaintSource | null = null, lastOriginal: PaintSource | null = null, lastVersion = -1, lastDecorated: PaintSource | null = null;
    const original = (frame: PaintSource) => originalOf(frame);
    const decorate = (frame: PaintSource): PaintSource => {
        const keys = registry.keys;
        if (keys.size === 0) return frame;
        if (lastOriginal === frame && lastVersion === registry.version && lastDecorated) return lastDecorated;
        const decorated = decorateFrame(frame, keys);
        originalOfDecorated.set(decorated, frame);
        let held = versions.get(frame);
        if (!held) versions.set(frame, held = new Set());
        held.add(decorated);
        lastOriginal = frame; lastVersion = registry.version; lastDecorated = decorated;
        return decorated;
    };
    return {
        bindMemory: base.bindMemory?.bind(base),
        cpuWorkingSet: base.cpuWorkingSet?.bind(base),
        memoryBytes: base.memoryBytes?.bind(base),
        request: source => base.request(source),
        requestStream: pin => base.requestStream(pin),
        prepare: budget => base.prepare(budget),
        needsFrame: () => base.needsFrame(),
        blocked: () => base.blocked?.() ?? false,
        readFrame() { const frame = base.readFrame(); newest = frame; return frame ? decorate(frame) : null; },
        isCurrent: frame => base.isCurrent(original(frame)),
        presented: frame => base.presented(original(frame)),
        retain(frame) {
            // Synchronous, and composed: the source the assembler pins for the original, and the video images this exact
            // decorated frame names. Both release together, once, after the holder's physical work has retired.
            const pinnedImages = registry.retainFrame(frame);
            try {
                const releaseSource = base.retain(original(frame));
                let released = false;
                return () => { if (released) return; released = true; try { releaseSource(); } finally { pinnedImages(); } };
            } catch (error) {
                pinnedImages();
                throw error;
            }
        },
        retire(frame) {
            const source = original(frame), held = versions.get(source);
            if (frame === source) {
                if (held && held.size) { deferred.add(source); return; }
                base.retire(source); return;
            }
            held?.delete(frame);
            if (held && held.size === 0) {
                versions.delete(source);
                if (deferred.has(source) || source !== newest) { deferred.delete(source); base.retire(source); }
            }
        },
        clear: () => base.clear(),
        whenRetired: () => base.whenRetired(),
        dispose: () => base.dispose(),
    };
}
