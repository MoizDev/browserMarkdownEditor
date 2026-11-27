import type { ByteLease } from '../../platform/render/gfx/api';
import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { PaintImageItem, PaintSource } from '../render/paintStream';
import { paintItemsOf } from '../render/paintWindows';
import type { PaintFrameAssembler } from '../render/frameTypes';
import type { PaintImageLease } from '../render/resources';
import { isMediaTileKey } from './mips';

export const VIDEO_FRAME_PREFIX = 'frame/';
export function videoFrameKey(node: string): string {
    return `${VIDEO_FRAME_PREFIX}${encodeURIComponent(node)}`;
}

export type VideoFrameSource = ImageBitmap | VideoFrame;

export interface VideoFrameLease extends PaintImageLease {
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
    retired: boolean;
    closed: boolean;
}

export interface VideoFrameRegistry {
    reserve(bytes: number): ByteLease | null;
    release(lease: ByteLease): void;
    onRoom(listener: () => void): () => void;
    admitFrame(bytes: number): ByteLease | null;
    present(node: string, source: VideoFrameSource, lease: ByteLease): boolean;
    retire(node: string): void;
    lease(key: string, signal: AbortSignal): Promise<VideoFrameLease>;
    retainKey(key: string): () => void;
    retainFrame(frame: PaintSource): () => void;
    readonly keys: ReadonlyMap<string, string>;
    readonly version: number;
    drawn(node: string): boolean;
    markDrawn(frame: PaintSource): void;
    dispose(): void;
}

function videoKeysOf(frame: PaintSource): string[] {
    const keys: string[] = [];
    for (const item of paintItemsOf(frame)) if (item.kind === 'image' && item.imageKey.startsWith(VIDEO_FRAME_PREFIX)) keys.push(item.imageKey);
    return keys;
}

function sizeOf(source: VideoFrameSource): { width: number; height: number } {
    if (source instanceof ImageBitmap) return { width: source.width, height: source.height };
    return { width: source.displayWidth, height: source.displayHeight };
}

const RETAINED_VERSIONS = 2;

export function createVideoFrameRegistry(options: { readonly memory: MemoryAllocator; readonly invalidate: () => void }): VideoFrameRegistry {
    const { memory } = options;
    const frames = new Set<Frame>(), latest = new Map<string, Frame>(), sequence = new Map<string, number>(), shown = new Set<string>();
    let keys: ReadonlyMap<string, string> = new Map(), version = 0, disposed = false;
    const publish = () => { version++; keys = new Map([...latest.values()].map(frame => [frame.node, frame.key])); options.invalidate(); };
    // Room listeners run in a microtask, never inside the call that freed the room: a drop inside `present` would otherwise re-enter it
    // while its own frame is being set as the latest one.
    const roomWaiters = new Set<() => void>();
    const roomOpened = () => {
        if (roomWaiters.size === 0) return;
        queueMicrotask(() => {
            const waiting = [...roomWaiters];
            roomWaiters.clear();
            for (const listener of waiting) listener();
        });
    };
    const drop = (frame: Frame) => {
        if (frame.closed) return;
        frame.closed = true;
        frames.delete(frame);
        if (latest.get(frame.key) === frame) latest.delete(frame.key);
        try { frame.source.close(); } finally { memory.release(frame.lease); roomOpened(); }
    };
    const retireFrame = (frame: Frame) => { frame.retired = true; if (frame.refs === 0) drop(frame); };
    const aborted = () => new DOMException('Video frame is no longer current', 'AbortError');
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
        release(lease) { memory.release(lease); roomOpened(); },
        onRoom(listener) {
            if (disposed) return () => {};
            roomWaiters.add(listener);
            return () => { roomWaiters.delete(listener); };
        },
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
            latest.clear(); keys = new Map(); version++; shown.clear(); roomWaiters.clear();
        },
    };
}

export interface VideoFrameOverlay {
    wrap(frames: PaintFrameAssembler): PaintFrameAssembler;
    drawn(frame: PaintSource): void;
}
function tileKeysOf(frame: PaintSource): Set<string> {
    const keys = new Set<string>();
    for (const item of paintItemsOf(frame)) if (item.kind === 'image' && isMediaTileKey(item.imageKey)) keys.add(item.imageKey);
    return keys;
}
export function videoFrameOverlay(registry: VideoFrameRegistry, afterDraw: () => void = () => {},
    demand: (keys: ReadonlySet<string>) => void = () => {}): VideoFrameOverlay {
    return { wrap: frames => liveVideoFrames(frames, registry),
        drawn: frame => { registry.markDrawn(frame); demand(tileKeysOf(frame)); afterDraw(); } };
}

const originalOfDecorated = new WeakMap<PaintSource, PaintSource>();
export function originalOf(frame: PaintSource): PaintSource { return originalOfDecorated.get(frame) ?? frame; }

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
