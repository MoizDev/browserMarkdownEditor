// One GPU texture per decoded picture (imageKey), leased from the governor, written once and then only read.
// A picture is written whole when the frame's upload allowance takes it, else in row chunks that each pass their own
// claimUpload, so a picture bigger than one frame's allowance still arrives. Design: PLAN §4 gpu-h7, §3.1.
import type { LayerHost } from '../../../platform/render/compositor.types';
import type { ByteLease, GfxDevice, TextureHandle } from '../../../platform/render/gfx/api';
import { auditCount } from '../../../platform/render/renderAudit';
import type { FrameBudget } from '../../../platform/render/types';
import type { Admission } from './contracts';

/** One upload chunk, one tile's worth: the scheduler's progress grant is a tile (scheduler.ts progressUploadBytes,
 * 516 × 516 × 4 = 1,064,256 B), so a chunk of this size is always claimable on an otherwise idle frame. */
export const IMAGE_CHUNK_BYTES = 1024 * 1024;

/** Mip levels stay off. IMAGE_SAMPLING_PROFILE is bilinear without mip levels, canvas2d samples that way, and the
 * parity row (pictures within 3 levels of canvas2d) is measured against it; mips would smooth minified pictures away
 * from that reference. The path is real (h10's `createTexture(…, { mips })`, `generateMips`): turning this on is gpu's
 * call, and the sampler the route binds follows it through IMAGE_FILTER. */
const IMAGE_MIPS = false;
/** The filter every picture is sampled with: linear, with the mip chain when IMAGE_MIPS is on. */
export const IMAGE_FILTER: 'linear' | 'linear-mipmap' = IMAGE_MIPS ? 'linear-mipmap' : 'linear';

/** Bytes of a texture's whole chain: level 0 alone, or every level down to 1×1 when mips are on. */
function textureBytes(width: number, height: number): number {
    let bytes = 0;
    for (let w = width, h = height; ; w = Math.max(1, w >> 1), h = Math.max(1, h >> 1)) {
        bytes += w * h * 4;
        if (!IMAGE_MIPS || (w === 1 && h === 1)) return bytes;
    }
}

/** A picture's texture, the stable value every route draws from. `width`/`height` are its texels: smaller than the
 * source only when the source is larger than the device's texture limit and was downscaled at decode. */
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
     * uploading; `denied` when the GPU pool refuses the lease; `unsupported` for a source this path cannot draw. */
    acquire(key: string, image: CanvasImageSource, budget: FrameBudget): Admission<ImageTexture>;
    unhold(key: string): void;
    /** Frees textures nobody holds and no frame used this frame, least recently used first. Returns the bytes freed. */
    evict(bytes: number, frameId: number): number;
    release(): void;
    memory(): { gpuBytes: number; cpuBytes: number };
}

/** A decoded piece awaiting its upload, charged to the CPU pool while it exists. */
interface Staged { readonly bitmap: ImageBitmap; readonly lease: ByteLease; readonly row: number; readonly rows: number }

interface Slot {
    readonly device: GfxDevice;
    readonly view: ImageTexture;
    /** The texture's own GPU lease: its bytes are reserved before the texture exists and returned when it is destroyed. */
    readonly lease: ByteLease;
    readonly bytes: number;
    refs: number;
    usedFrame: number;
    ready: boolean;
    /** Whole-picture upload refused by the allowance: the picture now arrives in chunks. */
    chunked: boolean;
    /** Rows of the texture already written, from the top, in chunked mode. */
    uploaded: number;
    /** The downscaled source, present only when the picture was larger than the device limit. */
    scaled: Staged | null;
    /** A chunk decoded and waiting for its claimUpload. */
    band: Staged | null;
    /** One asynchronous decode in flight (a resize or a chunk); its settlement clears this. */
    busy: boolean;
    failed: boolean;
    dropped: boolean;
}

/** The largest texture side the device takes: `limits.maxTexture2D`, the field gpu confirmed (PLAN §3.4's
 * `maxTextureSize` is superseded). */
const maxTextureSide = (device: GfxDevice): number => device.limits.maxTexture2D;

const UPLOAD_USES = ['sample', 'copy-dst'] as const;
const UPLOAD_SOURCE = { premultiplied: true, colorSpace: 'srgb', origin: 'top-left' } as const;

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

    // In-flight decodes are not cancelled: their settlement sees `dropped`, closes what it made and returns its lease.
    const drop = (slot: Slot): void => {
        slot.dropped = true;
        if (slots.get(slot.view.key) === slot) slots.delete(slot.view.key);
        if (slot.scaled) { closeStaged(slot.scaled); slot.scaled = null; }
        if (slot.band) { closeStaged(slot.band); slot.band = null; }
        slot.device.destroy(slot.view.texture);
        host.allocator.gpu.release(slot.lease);
        gpuBytes -= slot.bytes;
    };

    // Decodes the picture down to the texture size. Settlement is an invalidate, so the next prepare finds it.
    const startResize = (slot: Slot, image: ImageBitmap): void => {
        const { width, height } = slot.view;
        const lease = reserveCpu(width * height * 4);
        if (!lease) { awaitCapacity(); return; }
        slot.busy = true;
        createImageBitmap(image, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' }).then(bitmap => {
            slot.busy = false;
            if (slot.dropped) { bitmap.close(); releaseCpu(lease); return; }
            slot.scaled = { bitmap, lease, row: 0, rows: height };
            host.invalidate('image-texture-staged');
        }, () => {
            slot.busy = false; releaseCpu(lease);
            if (slot.dropped) return;
            slot.failed = true; host.invalidate('image-texture-failed');
        });
    };

    // Decodes rows [row, row + rows) of the texture-sized source into a bitmap of exactly that band.
    const startBand = (slot: Slot, source: ImageBitmap, row: number, rows: number): void => {
        const lease = reserveCpu(slot.view.width * rows * 4);
        if (!lease) { awaitCapacity(); return; }
        slot.busy = true;
        createImageBitmap(source, 0, row, slot.view.width, rows).then(bitmap => {
            slot.busy = false;
            if (slot.dropped) { bitmap.close(); releaseCpu(lease); return; }
            slot.band = { bitmap, lease, row, rows };
            host.invalidate('image-texture-band');
        }, () => {
            slot.busy = false; releaseCpu(lease);
            if (slot.dropped) return;
            slot.failed = true; host.invalidate('image-texture-failed');
        });
    };

    const writeRows = (slot: Slot, device: GfxDevice, rect: { x: number; y: number; width: number; height: number },
        source: ImageBitmap): void => {
        device.writeTexture(slot.view.texture, rect, { source, ...UPLOAD_SOURCE });
        auditCount(audit, 'upload:image', 1, { bytes: rect.width * rect.height * 4 });
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
        if (!slot.chunked) {
            const bytes = width * height * 4;
            if (budget.claimUpload(bytes)) {
                writeRows(slot, device, { x: 0, y: 0, width, height }, source);
                finish(slot, device);
                return true;
            }
            if (bytes <= IMAGE_CHUNK_BYTES) { host.invalidate('image-texture-upload'); return false; }
            slot.chunked = true;
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
            if (typeof ImageBitmap === 'undefined' || !(image instanceof ImageBitmap)) return { status: 'unsupported', why: 'not-bitmap' };
            const w = image.width, h = image.height;
            if (!(w > 0 && h > 0)) return { status: 'empty' };
            let slot = slots.get(key);
            if (slot?.failed) { drop(slot); return { status: 'unsupported', why: 'upload-failed' }; }
            if (slot && (slot.device !== device || slot.view.sourceWidth !== w || slot.view.sourceHeight !== h)) { drop(slot); slot = undefined; }
            if (!slot) {
                const max = maxTextureSide(device);
                const scale = Math.min(1, max / w, max / h);
                const width = Math.min(max, Math.max(1, Math.round(w * scale))), height = Math.min(max, Math.max(1, Math.round(h * scale)));
                const bytes = textureBytes(width, height);
                const lease = host.allocator.gpu.reserve(bytes);
                if (!lease) { awaitCapacity(); return { status: 'denied', pool: 'gpu', bytes }; }
                let texture: TextureHandle;
                try { texture = device.createTexture(width, height, 'rgba8', UPLOAD_USES, lease, { mips: IMAGE_MIPS }); }
                catch (error) { host.allocator.gpu.release(lease); throw error; }
                const view: ImageTexture = Object.freeze({ key, texture, sourceWidth: w, sourceHeight: h, width, height });
                slot = { device, view, lease, bytes, refs: 0, usedFrame: budget.frameId, ready: false, chunked: false, uploaded: 0,
                    scaled: null, band: null, busy: false, failed: false, dropped: false };
                slots.set(key, slot); gpuBytes += bytes;
            }
            slot.usedFrame = budget.frameId;
            if (!slot.ready && !advance(slot, device, image, budget)) return { status: 'deferred' };
            slot.refs++;
            return { status: 'ready', value: slot.view };
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
