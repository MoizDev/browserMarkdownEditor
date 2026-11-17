// One GPU texture per decoded picture (imageKey), leased from the governor and written only as it arrives, then only read.
// A picture that fits one chunk is written whole; anything larger arrives in row bands, each decoded and then claimed on its
// own claimUpload, so no single write is larger than a chunk. Design: PLAN §4 gpu-h7, §3.1.
import type { LayerHost } from '../../../platform/render/compositor.types';
import type { ByteLease, GfxDevice, TextureHandle } from '../../../platform/render/gfx/api';
import { auditCount } from '../../../platform/render/renderAudit';
import type { FrameBudget } from '../../../platform/render/types';
import type { Admission } from './contracts';

/** One upload chunk: the scheduler's progress grant is a tile (scheduler.ts progressUploadBytes, 516 × 516 × 4 = 1,064,256 B),
 * so a chunk of this size is claimable on an otherwise idle frame. Smaller chunks would mean a decode round trip per band:
 * a 4000-px-wide picture would take about 16 times as many frames to arrive. */
export const IMAGE_CHUNK_BYTES = 1024 * 1024;

/** Mip levels stay off. IMAGE_SAMPLING_PROFILE is bilinear without mip levels, canvas2d samples that way, and the
 * parity row (pictures within 3 levels of canvas2d) is measured against it; mips would smooth minified pictures away
 * from that reference. The path is real (h10's `createTexture(…, { mips })`, `generateMips`): turning this on is gpu's
 * call, and the sampler the route binds follows it through IMAGE_FILTER. */
const IMAGE_MIPS = false;
/** The filter every picture is sampled with: linear, with the mip chain when IMAGE_MIPS is on. */
export const IMAGE_FILTER: 'linear' | 'linear-mipmap' = IMAGE_MIPS ? 'linear-mipmap' : 'linear';

/** Bytes of a texture's whole chain: level 0 alone, or every level down to 1×1 when it is mipped. */
function textureBytes(width: number, height: number, mips: boolean = IMAGE_MIPS): number {
    let bytes = 0;
    for (let w = width, h = height; ; w = Math.max(1, w >> 1), h = Math.max(1, h >> 1)) {
        bytes += w * h * 4;
        if (!mips || (w === 1 && h === 1)) return bytes;
    }
}

/** A video node's current frame, as h12's videoFrames hands it over: one stable key per node, and a `version` that moves per
 * presented frame. The frame is closed once its pixels are copied into a bitmap, so the texture never keeps a frame alive. */
export type VideoFrameSource = ImageBitmapSource & { readonly width: number; readonly height: number; close(): void };

/** A picture's texture, the stable value every route draws from. `width`/`height` are its texels: the source's own, unless
 * the source is larger than the device's texture limit, which is the only case the texture is resampled (counted as image:resample). */
export interface ImageTexture {
    readonly key: string;
    readonly texture: TextureHandle;
    readonly sourceWidth: number;
    readonly sourceHeight: number;
    readonly width: number;
    readonly height: number;
}

export interface ImageTextures {
    /** `ready` holds the texture until `unhold` (a route pairs them per prepared run). `deferred` while staging or
     * uploading; `denied` when the GPU pool refuses the lease; `unsupported` for a source this path cannot draw. `image` is
     * null once the picture's bitmap was released: a ready texture still draws; anything else must wait for the bitmap. */
    acquire(key: string, image: CanvasImageSource | null, budget: FrameBudget): Admission<ImageTexture>;
    /** One texture per video node, rewritten in place when its version moves and never mipped. A version the texture already
     * holds costs no upload; a new one is decoded, then written whole once its claim is granted. Until then the texture keeps
     * the version it has, so a node is never drawn half-written. */
    acquireVideo(key: string, frame: VideoFrameSource, version: number, budget: FrameBudget): Admission<ImageTexture>;
    /** True when acquiring `key` needs its bitmap: no texture is ready for this device. */
    needsSource(key: string): boolean;
    unhold(key: string): void;
    /** Frees textures nobody holds and no frame used this frame, least recently used first. Returns the bytes freed. */
    evict(bytes: number, frameId: number): number;
    release(): void;
    memory(): { gpuBytes: number; cpuBytes: number };
}

/** A decoded piece awaiting its upload, charged to the CPU pool while it exists. */
interface Staged { readonly bitmap: ImageBitmap; readonly lease: ByteLease; readonly row: number; readonly rows: number }

/** A decode in flight. Its CPU lease is returned by whichever comes first: its settlement, or the release of its slot. A
 * release returns the lease at once, so the governor sees the bytes freed synchronously; the bitmap is closed when it lands. */
interface Inflight { lease: ByteLease | null }

interface Slot {
    readonly device: GfxDevice;
    readonly view: ImageTexture;
    /** The texture's own GPU lease: its bytes are reserved before the texture exists and returned when it is destroyed. */
    readonly lease: ByteLease;
    readonly bytes: number;
    refs: number;
    usedFrame: number;
    ready: boolean;
    /** Rows of the texture already written, from the top, once the picture arrives in bands. */
    uploaded: number;
    /** The downscaled source, present only when the picture was larger than its texture. */
    scaled: Staged | null;
    /** A band decoded and waiting for its claimUpload. */
    band: Staged | null;
    /** The decode in flight (a resize or a band), when there is one. */
    inflight: Inflight | null;
    /** One asynchronous decode in flight; its settlement clears this. */
    busy: boolean;
    failed: boolean;
    dropped: boolean;
    /** Video only: the version the texture holds (-1 before its first write). */
    version: number;
    /** Video only: the newest frame decoded to a bitmap, waiting for its claimUpload, and the version it carries. */
    video: Staged | null;
    pendingVersion: number;
}

const UPLOAD_USES = ['sample', 'copy-dst'] as const;
const UPLOAD_SOURCE = { premultiplied: true, colorSpace: 'srgb', origin: 'top-left' } as const;

/** The texture a picture gets: its source size, fitted proportionally into the device's texture limit (`limits.maxTexture2D`,
 * the field gpu confirmed). A picture within the limit keeps its texels: the GPU scales it when it is drawn, not a CPU resample. */
function targetSize(device: GfxDevice, w: number, h: number): { width: number; height: number } {
    const max = device.limits.maxTexture2D;
    const scale = Math.min(1, max / w, max / h);
    return { width: Math.min(max, Math.max(1, Math.round(w * scale))), height: Math.min(max, Math.max(1, Math.round(h * scale))) };
}

export function createImageTextures(host: LayerHost, audit: string): ImageTextures {
    const slots = new Map<string, Slot>();
    let gpuBytes = 0, cpuBytes = 0;
    const wake = () => host.invalidate('image-texture-capacity');
    // A refused reservation does not poll (needsFrame() is false while denied): it waits for a real capacity change.
    const awaitCapacity = (): void => { host.allocator.gpu.whenAvailable?.(wake); host.allocator.cpu.whenAvailable?.(wake); };
    const reserveCpu = (bytes: number): ByteLease | null => {
        const lease = host.allocator.cpu.reserve(bytes);
        if (lease) cpuBytes += lease.bytes;
        return lease;
    };
    const releaseCpu = (lease: ByteLease): void => { host.allocator.cpu.release(lease); cpuBytes -= lease.bytes; };
    const closeStaged = (staged: Staged): void => { staged.bitmap.close(); releaseCpu(staged.lease); };

    // Synchronous: every byte this slot holds is returned by the time it returns (its decode's bitmap closes when it lands).
    const drop = (slot: Slot): void => {
        slot.dropped = true;
        if (slots.get(slot.view.key) === slot) slots.delete(slot.view.key);
        if (slot.scaled) { closeStaged(slot.scaled); slot.scaled = null; }
        if (slot.band) { closeStaged(slot.band); slot.band = null; }
        if (slot.inflight?.lease) { releaseCpu(slot.inflight.lease); slot.inflight.lease = null; }
        if (slot.video) { closeStaged(slot.video); slot.video = null; }
        slot.device.destroy(slot.view.texture);
        host.allocator.gpu.release(slot.lease);
        gpuBytes -= slot.bytes;
    };

    // One decode in flight for a slot: its lease is held in `inflight` until the decode lands or the slot is dropped.
    // `fatal`: a failure marks the slot failed (an image's texture cannot be made); otherwise it is counted and the slot waits.
    const decode = (slot: Slot, lease: ByteLease, make: () => Promise<ImageBitmap>, onStaged: (bitmap: ImageBitmap, held: ByteLease) => void,
        fatal = true): void => {
        const inflight: Inflight = { lease };
        slot.inflight = inflight; slot.busy = true;
        make().then(bitmap => {
            slot.busy = false; slot.inflight = null;
            const held = inflight.lease; inflight.lease = null;
            if (!held || slot.dropped) { bitmap.close(); if (held) releaseCpu(held); return; }
            onStaged(bitmap, held);
        }, () => {
            slot.busy = false; slot.inflight = null;
            const held = inflight.lease; inflight.lease = null;
            if (held) releaseCpu(held);
            if (slot.dropped) return;
            if (!fatal) { auditCount(audit, 'video:decode-failed', 1); return; }
            slot.failed = true; host.invalidate('image-texture-failed');
        });
    };

    // Decodes the picture down to the texture size. Settlement is an invalidate, so the next prepare finds it.
    // Only a picture beyond the device's texture limit is resampled, on the browser side (off the main thread); a picture within
    // the limit is uploaded at its own size and the GPU scales it when drawn.
    const startResize = (slot: Slot, image: ImageBitmap): void => {
        const { width, height } = slot.view;
        const lease = reserveCpu(width * height * 4);
        if (!lease) { awaitCapacity(); return; }
        auditCount(audit, 'image:resample', 1, { px: width * height });
        decode(slot, lease, () => createImageBitmap(image, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' }),
            (bitmap, held) => { slot.scaled = { bitmap, lease: held, row: 0, rows: height }; host.invalidate('image-texture-staged'); });
    };

    // Decodes rows [row, row + rows) of the texture-sized source into a bitmap of exactly that band.
    const startBand = (slot: Slot, source: ImageBitmap, row: number, rows: number): void => {
        const lease = reserveCpu(slot.view.width * rows * 4);
        if (!lease) { awaitCapacity(); return; }
        decode(slot, lease, () => createImageBitmap(source, 0, row, slot.view.width, rows),
            (bitmap, held) => { slot.band = { bitmap, lease: held, row, rows }; host.invalidate('image-texture-band'); });
    };

    const writeRows = (slot: Slot, device: GfxDevice, rect: { x: number; y: number; width: number; height: number },
        source: ImageBitmap, counter = 'upload:image'): void => {
        device.writeTexture(slot.view.texture, rect, { source, ...UPLOAD_SOURCE });
        auditCount(audit, counter, 1, { bytes: rect.width * rect.height * 4 });
    };

    // A video frame decoded to its own bitmap (a copy: the frame closes as soon as the copy lands). A failed decode drops that
    // frame only: the texture keeps its version, and the next frame decodes.
    const startVideo = (slot: Slot, frame: VideoFrameSource, lease: ByteLease, version: number): void => {
        const { width, height } = slot.view;
        slot.pendingVersion = version;
        auditCount(audit, 'video:decode', 1, { px: width * height });
        decode(slot, lease, () => createImageBitmap(frame).then(bitmap => { frame.close(); return bitmap; },
            error => { frame.close(); throw error; }),
            (bitmap, held) => { slot.video = { bitmap, lease: held, row: 0, rows: height }; host.invalidate('video-texture-staged'); },
            false);
    };

    const finish = (slot: Slot, device: GfxDevice): void => {
        if (slot.scaled) { closeStaged(slot.scaled); slot.scaled = null; }
        if (IMAGE_MIPS) device.generateMips(slot.view.texture);
        slot.ready = true;
    };

    // One step toward `ready`. Returns true when the texture is complete this call.
    const advance = (slot: Slot, device: GfxDevice, image: ImageBitmap, budget: FrameBudget): boolean => {
        const { width, height, sourceWidth, sourceHeight } = slot.view;
        if (!slot.scaled && (width !== sourceWidth || height !== sourceHeight)) {
            if (!slot.busy) startResize(slot, image);
            return false;
        }
        const source = slot.scaled ? slot.scaled.bitmap : image;
        // A picture that fits one chunk is written whole, from its own bitmap, once its claim is granted.
        if (slot.uploaded === 0 && !slot.band && width * height * 4 <= IMAGE_CHUNK_BYTES) {
            if (budget.claimUpload(width * height * 4)) {
                writeRows(slot, device, { x: 0, y: 0, width, height }, source);
                finish(slot, device);
                return true;
            }
            host.invalidate('image-texture-upload'); return false;
        }
        if (slot.band) {
            const band = slot.band;
            if (!budget.claimUpload(width * band.rows * 4)) { host.invalidate('image-texture-upload'); return false; }
            writeRows(slot, device, { x: 0, y: band.row, width, height: band.rows }, band.bitmap);
            closeStaged(band); slot.band = null;
            slot.uploaded = band.row + band.rows;
            if (slot.uploaded >= height) { finish(slot, device); return true; }
        }
        if (!slot.busy) startBand(slot, source, slot.uploaded, Math.min(height - slot.uploaded, Math.max(1, Math.floor(IMAGE_CHUNK_BYTES / (width * 4)))));
        return false;
    };

    return {
        acquire(key, image, budget) {
            const device = host.device();
            if (!device) return { status: 'unsupported', why: 'no-device' };
            if (device.generation !== budget.token.deviceGeneration || host.generation !== budget.token.deviceGeneration) return { status: 'deferred' };
            let slot = slots.get(key);
            if (slot?.failed) { drop(slot); return { status: 'unsupported', why: 'upload-failed' }; }
            if (!image) {
                // Without its bitmap only a ready texture of this device draws; a route asks for the bitmap first otherwise.
                if (!slot || !slot.ready || slot.device !== device) return { status: 'deferred' };
                slot.usedFrame = budget.frameId;
                slot.refs++;
                return { status: 'ready', value: slot.view };
            }
            if (typeof ImageBitmap === 'undefined' || !(image instanceof ImageBitmap)) return { status: 'unsupported', why: 'not-bitmap' };
            const w = image.width, h = image.height;
            if (!(w > 0 && h > 0)) return { status: 'empty' };
            // A picture's size is its source's, so a texture never needs to grow after its first draw: the same key always
            // resolves to the same texture size (the source's own, or the device's fit).
            if (slot && (slot.device !== device || slot.view.sourceWidth !== w || slot.view.sourceHeight !== h)) { drop(slot); slot = undefined; }
            if (!slot) {
                const target = targetSize(device, w, h);
                const bytes = textureBytes(target.width, target.height);
                const lease = host.allocator.gpu.reserve(bytes);
                if (!lease) { awaitCapacity(); return { status: 'denied', pool: 'gpu', bytes }; }
                let texture: TextureHandle;
                try { texture = device.createTexture(target.width, target.height, 'rgba8', UPLOAD_USES, lease, { mips: IMAGE_MIPS }); }
                catch (error) { host.allocator.gpu.release(lease); throw error; }
                const view: ImageTexture = Object.freeze({ key, texture, sourceWidth: w, sourceHeight: h, width: target.width, height: target.height });
                slot = { device, view, lease, bytes, refs: 0, usedFrame: budget.frameId, ready: false, uploaded: 0,
                    scaled: null, band: null, inflight: null, busy: false, failed: false, dropped: false,
                    version: -1, video: null, pendingVersion: -1 };
                slots.set(key, slot); gpuBytes += bytes;
            }
            slot.usedFrame = budget.frameId;
            if (!slot.ready && !advance(slot, device, image, budget)) return { status: 'deferred' };
            slot.refs++;
            return { status: 'ready', value: slot.view };
        },
        acquireVideo(key, frame, version, budget) {
            const device = host.device();
            if (!device) return { status: 'unsupported', why: 'no-device' };
            if (device.generation !== budget.token.deviceGeneration || host.generation !== budget.token.deviceGeneration) return { status: 'deferred' };
            const w = frame.width, h = frame.height;
            if (!(w > 0 && h > 0)) return { status: 'empty' };
            let slot = slots.get(key);
            // A node's size is its video's: a change re-creates the texture, but never while a run still draws the old one.
            if (slot && (slot.device !== device || slot.view.sourceWidth !== w || slot.view.sourceHeight !== h)) {
                if (slot.refs > 0) return { status: 'deferred' };
                drop(slot); slot = undefined;
            }
            if (!slot) {
                const bytes = textureBytes(w, h, false);
                const lease = host.allocator.gpu.reserve(bytes);
                if (!lease) { awaitCapacity(); return { status: 'denied', pool: 'gpu', bytes }; }
                let texture: TextureHandle;
                try { texture = device.createTexture(w, h, 'rgba8', UPLOAD_USES, lease, { mips: false }); }
                catch (error) { host.allocator.gpu.release(lease); throw error; }
                const view: ImageTexture = Object.freeze({ key, texture, sourceWidth: w, sourceHeight: h, width: w, height: h });
                slot = { device, view, lease, bytes, refs: 0, usedFrame: budget.frameId, ready: false, uploaded: 0,
                    scaled: null, band: null, inflight: null, busy: false, failed: false, dropped: false,
                    version: -1, video: null, pendingVersion: -1 };
                slots.set(key, slot); gpuBytes += bytes;
            }
            slot.usedFrame = budget.frameId;
            // The version the texture holds costs nothing: no upload, no new texture.
            if (slot.ready && slot.version === version) { slot.refs++; return { status: 'ready', value: slot.view }; }
            // The newest decoded frame is written whole once its claim is granted. A claim refused waits; the texture keeps its version.
            if (slot.video) {
                if (budget.claimUpload(w * h * 4)) {
                    const staged = slot.video;
                    writeRows(slot, device, { x: 0, y: 0, width: w, height: h }, staged.bitmap, 'upload:video');
                    closeStaged(staged); slot.video = null;
                    slot.version = slot.pendingVersion; slot.ready = true;
                } else host.invalidate('video-texture-upload');
            }
            if (slot.ready && slot.version === version) { slot.refs++; return { status: 'ready', value: slot.view }; }
            // Decode this frame unless one is already in flight or staged.
            if (!slot.busy && !slot.video) {
                const lease = reserveCpu(w * h * 4);
                if (!lease) awaitCapacity();
                else startVideo(slot, frame, lease, version);
            }
            if (slot.ready) { slot.refs++; return { status: 'ready', value: slot.view }; }
            return { status: 'deferred' };
        },
        needsSource(key) {
            const slot = slots.get(key);
            return !slot || !slot.ready || slot.device !== host.device();
        },
        unhold(key) {
            const slot = slots.get(key);
            if (slot && slot.refs > 0) slot.refs--;
        },
        evict(bytes, frameId) {
            const candidates = [...slots.values()]
                .filter(slot => slot.refs === 0 && slot.usedFrame < frameId && !slot.busy)
                .sort((a, b) => a.usedFrame - b.usedFrame);
            let freed = 0;
            for (const slot of candidates) {
                if (freed >= bytes) break;
                freed += slot.bytes;
                drop(slot);
            }
            return freed;
        },
        release() {
            for (const slot of [...slots.values()]) drop(slot);
            slots.clear();
        },
        memory: () => ({ gpuBytes, cpuBytes }),
    };
}
