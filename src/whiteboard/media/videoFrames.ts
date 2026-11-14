import type { ByteLease } from '../../platform/render/gfx/api';
import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { PaintFrame, PaintItem } from '../render/paintStream';
import type { PaintFrameAssembler } from '../render/frameTypes';
import type { PaintImageLease } from '../render/resources';

// Provenance: video playback presentation facts for paint leases; independent per-view
// registry of immutable presented frames, with the frame key as the only paint identity.

/** A presented frame is named by its node and its per-node sequence, never by the mutable media. */
export const VIDEO_FRAME_PREFIX = 'frame/';
export function videoFrameKey(node: string, seq: number): string {
    return `${VIDEO_FRAME_PREFIX}${encodeURIComponent(node)}/${seq}`;
}

interface Frame {
    readonly key: string;
    readonly node: string;
    readonly bitmap: ImageBitmap;
    readonly lease: ByteLease;
    refs: number;
    /** Superseded or stopped: no new lease may take it, and it closes when its last holder lets go. */
    retired: boolean;
    closed: boolean;
}

export interface VideoFrameRegistry {
    /** Takes ownership of the bitmap. Refusal (disposed, or no memory) closes it and returns false. */
    present(node: string, bitmap: ImageBitmap): boolean;
    /** Stops a node: its latest frame retires, and nothing new can be leased for it. */
    retire(node: string): void;
    /** Only a live (not retired) frame can be leased; a superseded frame's paint re-prepares with the new key. */
    lease(key: string, signal: AbortSignal): Promise<PaintImageLease>;
    /** Node → key of its latest live frame. Identity changes exactly when `version` does. */
    readonly keys: ReadonlyMap<string, string>;
    readonly version: number;
    /** True once a drawn frame has shown this node's image (its poster or a presented frame). */
    drawn(node: string): boolean;
    /** Called with the frame that was actually drawn, so the row that starts playback appears only after an image was shown. */
    markDrawn(frame: PaintFrame): void;
    dispose(): void;
}

export function createVideoFrameRegistry(options: { readonly memory: MemoryAllocator; readonly invalidate: () => void }): VideoFrameRegistry {
    const { memory } = options;
    const frames = new Map<string, Frame>(), latest = new Map<string, Frame>(), sequence = new Map<string, number>(), shown = new Set<string>();
    let keys: ReadonlyMap<string, string> = new Map(), version = 0, disposed = false;
    const publish = () => { version++; keys = new Map([...latest].map(([node, frame]) => [node, frame.key])); options.invalidate(); };
    const drop = (frame: Frame) => {
        if (frame.closed) return;
        frame.closed = true;
        if (frames.get(frame.key) === frame) frames.delete(frame.key);
        if (latest.get(frame.node) === frame) latest.delete(frame.node);
        try { frame.bitmap.close(); } finally { memory.release(frame.lease); }
    };
    const retireFrame = (frame: Frame) => { frame.retired = true; if (frame.refs === 0) drop(frame); };
    const aborted = () => new DOMException('Video frame is no longer current', 'AbortError');
    return {
        present(node, bitmap) {
            if (disposed) { bitmap.close(); return false; }
            const lease = memory.reserve(bitmap.width * bitmap.height * 4);
            if (!lease) { bitmap.close(); return false; }
            const seq = (sequence.get(node) ?? 0) + 1;
            sequence.set(node, seq);
            const frame: Frame = { key: videoFrameKey(node, seq), node, bitmap, lease, refs: 0, retired: false, closed: false };
            frames.set(frame.key, frame);
            const previous = latest.get(node);
            latest.set(node, frame);
            if (previous) retireFrame(previous);
            publish();
            return true;
        },
        retire(node) {
            const frame = latest.get(node);
            if (!frame) return;
            latest.delete(node);
            retireFrame(frame);
            publish();
        },
        async lease(key, signal) {
            signal.throwIfAborted();
            const frame = frames.get(key);
            if (disposed || !frame || frame.retired || frame.closed) throw aborted();
            frame.refs++;
            let held = true;
            return {
                source: frame.bitmap, width: frame.bitmap.width, height: frame.bitmap.height, cpuBytes: 0,
                release() {
                    if (!held) return;
                    held = false; frame.refs--;
                    if (frame.refs === 0 && frame.retired) drop(frame);
                },
            };
        },
        get keys() { return keys; },
        get version() { return version; },
        drawn: node => shown.has(node),
        markDrawn(frame) {
            const visit = (items: readonly PaintItem[]) => { for (const item of items) if (item.kind === 'image') shown.add(item.nodeId); };
            visit(frame.underlay); visit(frame.content);
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            for (const frame of [...frames.values()]) retireFrame(frame);
            latest.clear(); keys = new Map(); version++; shown.clear();
        },
    };
}

/** The overlay the view's paint pipeline wraps around its frame assembler. */
export interface VideoFrameOverlay {
    wrap(frames: PaintFrameAssembler): PaintFrameAssembler;
    drawn(frame: PaintFrame): void;
}
export function videoFrameOverlay(registry: VideoFrameRegistry): VideoFrameOverlay {
    return { wrap: frames => liveVideoFrames(frames, registry), drawn: frame => registry.markDrawn(frame) };
}

/**
 * Serves each playing picture's latest presented frame from the frame's own image key. The assembler
 * keys its frames by identity, so a decorated frame is mapped back to the original it was made from for every call that
 * the assembler owns: presented, retain, isCurrent and retire. An original is retired only when no decorated
 * version of it is still held and it is no longer the newest one.
 */
export function liveVideoFrames(base: PaintFrameAssembler, registry: VideoFrameRegistry): PaintFrameAssembler {
    const originals = new WeakMap<PaintFrame, PaintFrame>();
    const versions = new Map<PaintFrame, Set<PaintFrame>>(), deferred = new Set<PaintFrame>();
    let newest: PaintFrame | null = null, lastOriginal: PaintFrame | null = null, lastVersion = -1, lastDecorated: PaintFrame | null = null;
    const original = (frame: PaintFrame) => originals.get(frame) ?? frame;
    const withKeys = (items: readonly PaintItem[], keys: ReadonlyMap<string, string>): readonly PaintItem[] => items.map(item => {
        if (item.kind !== 'image') return item;
        const key = keys.get(item.nodeId);
        return key === undefined ? item : { ...item, imageKey: key };
    });
    const decorate = (frame: PaintFrame): PaintFrame => {
        const keys = registry.keys;
        if (keys.size === 0) return frame;
        if (lastOriginal === frame && lastVersion === registry.version && lastDecorated) return lastDecorated;
        const decorated: PaintFrame = Object.freeze({ ...frame,
            underlay: Object.freeze(withKeys(frame.underlay, keys)), content: Object.freeze(withKeys(frame.content, keys)) });
        originals.set(decorated, frame);
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
        prepare: budget => base.prepare(budget),
        needsFrame: () => base.needsFrame(),
        readFrame() { const frame = base.readFrame(); newest = frame; return frame ? decorate(frame) : null; },
        isCurrent: frame => base.isCurrent(original(frame)),
        presented: frame => base.presented(original(frame)),
        retain: frame => base.retain(original(frame)),
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
        dispose: () => base.dispose(),
    };
}
