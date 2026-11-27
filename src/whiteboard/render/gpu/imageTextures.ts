import type { LayerHost } from '../../../platform/render/compositor.types';
import type { ByteLease, DrawableImage, GfxDevice, TextureHandle } from '../../../platform/render/gfx/api';
import { auditCount } from '../../../platform/render/renderAudit';
import type { FrameBudget } from '../../../platform/render/types';
import type { Admission } from './contracts';

export const IMAGE_CHUNK_BYTES = 1024 * 1024;
const FIRST_PAINT_FRAME_BYTES = 16 * 1024 * 1024;

const IMAGE_MIPS = false;
export const IMAGE_FILTER: 'linear' | 'linear-mipmap' = IMAGE_MIPS ? 'linear-mipmap' : 'linear';

function textureBytes(width: number, height: number, mips: boolean = IMAGE_MIPS): number {
    let bytes = 0;
    for (let w = width, h = height; ; w = Math.max(1, w >> 1), h = Math.max(1, h >> 1)) {
        bytes += w * h * 4;
        if (!mips || (w === 1 && h === 1)) return bytes;
    }
}

export interface VideoFrameInput {
    readonly version: number;
    readonly source: DrawableImage;
    readonly width: number;
    readonly height: number;
}

export interface ImageTexture {
    readonly key: string;
    readonly texture: TextureHandle;
    readonly sourceWidth: number;
    readonly sourceHeight: number;
    readonly width: number;
    readonly height: number;
}

export interface ImageTextures {
    acquire(key: string, image: CanvasImageSource | null, budget: FrameBudget, firstPaint?: boolean): Admission<ImageTexture>;
    acquireVideo(key: string, frame: VideoFrameInput, budget: FrameBudget): Admission<ImageTexture>;
    needsSource(key: string): boolean;
    unhold(key: string): void;
    evict(bytes: number, frameId: number): number;
    release(): void;
    memory(): { gpuBytes: number; cpuBytes: number };
}

interface Staged { readonly bitmap: ImageBitmap; readonly lease: ByteLease; readonly row: number; readonly rows: number }

interface Inflight { lease: ByteLease | null }

interface Slot {
    readonly device: GfxDevice;
    readonly view: ImageTexture;
    readonly lease: ByteLease;
    readonly bytes: number;
    refs: number;
    usedFrame: number;
    ready: boolean;
    uploaded: number;
    scaled: Staged | null;
    band: Staged | null;
    inflight: Inflight | null;
    busy: boolean;
    failed: boolean;
    dropped: boolean;
    version: number;
}

const UPLOAD_USES = ['sample', 'copy-dst'] as const;
const UPLOAD_SOURCE = { premultiplied: true, colorSpace: 'srgb', origin: 'top-left' } as const;

function targetSize(device: GfxDevice, w: number, h: number): { width: number; height: number } {
    const max = device.limits.maxTexture2D;
    const scale = Math.min(1, max / w, max / h);
    return { width: Math.min(max, Math.max(1, Math.round(w * scale))), height: Math.min(max, Math.max(1, Math.round(h * scale))) };
}

export function createImageTextures(host: LayerHost, audit: string): ImageTextures {
    const slots = new Map<string, Slot>();
    let gpuBytes = 0, cpuBytes = 0;
    const wake = () => host.invalidate('image-texture-capacity');
    const awaitCapacity = (): void => { host.allocator.gpu.whenAvailable?.(wake); host.allocator.cpu.whenAvailable?.(wake); };
    const reserveCpu = (bytes: number): ByteLease | null => {
        const lease = host.allocator.cpu.reserve(bytes);
        if (lease) cpuBytes += lease.bytes;
        return lease;
    };
    const releaseCpu = (lease: ByteLease): void => { host.allocator.cpu.release(lease); cpuBytes -= lease.bytes; };
    const closeStaged = (staged: Staged): void => { staged.bitmap.close(); releaseCpu(staged.lease); };

    const drop = (slot: Slot): void => {
        slot.dropped = true;
        if (slots.get(slot.view.key) === slot) slots.delete(slot.view.key);
        if (slot.scaled) { closeStaged(slot.scaled); slot.scaled = null; }
        if (slot.band) { closeStaged(slot.band); slot.band = null; }
        if (slot.inflight?.lease) { releaseCpu(slot.inflight.lease); slot.inflight.lease = null; }
        slot.device.destroy(slot.view.texture);
        host.allocator.gpu.release(slot.lease);
        gpuBytes -= slot.bytes;
    };

    const decode = (slot: Slot, lease: ByteLease, make: () => Promise<ImageBitmap>, onStaged: (bitmap: ImageBitmap, held: ByteLease) => void): void => {
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
            slot.failed = true; host.invalidate('image-texture-failed');
        });
    };

    const startResize = (slot: Slot, image: ImageBitmap): void => {
        const { width, height } = slot.view;
        const lease = reserveCpu(width * height * 4);
        if (!lease) { awaitCapacity(); return; }
        auditCount(audit, 'image:resample', 1, { px: width * height });
        decode(slot, lease, () => createImageBitmap(image, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' }),
            (bitmap, held) => { slot.scaled = { bitmap, lease: held, row: 0, rows: height }; host.invalidate('image-texture-staged'); });
    };

    const startBand = (slot: Slot, source: ImageBitmap, row: number, rows: number): void => {
        const lease = reserveCpu(slot.view.width * rows * 4);
        if (!lease) { awaitCapacity(); return; }
        decode(slot, lease, () => createImageBitmap(source, 0, row, slot.view.width, rows),
            (bitmap, held) => { slot.band = { bitmap, lease: held, row, rows }; host.invalidate('image-texture-band'); });
    };

    const writeRows = (slot: Slot, device: GfxDevice, rect: { x: number; y: number; width: number; height: number },
        source: DrawableImage, counter = 'upload:image'): void => {
        device.writeTexture(slot.view.texture, rect, { source, ...UPLOAD_SOURCE });
        auditCount(audit, counter, 1, { bytes: rect.width * rect.height * 4 });
    };

    const finish = (slot: Slot, device: GfxDevice): void => {
        if (slot.scaled) { closeStaged(slot.scaled); slot.scaled = null; }
        if (IMAGE_MIPS) device.generateMips(slot.view.texture);
        slot.ready = true;
    };

    let firstPaintFrame = -1, firstPaintLeft = 0;
    const advance = (slot: Slot, device: GfxDevice, image: ImageBitmap, budget: FrameBudget, firstPaint: boolean): boolean => {
        const { width, height, sourceWidth, sourceHeight } = slot.view;
        if (!slot.scaled && (width !== sourceWidth || height !== sourceHeight)) {
            if (!slot.busy) startResize(slot, image);
            return false;
        }
        const source = slot.scaled ? slot.scaled.bitmap : image;
        if (firstPaint && slot.uploaded === 0 && !slot.band && !slot.busy) {
            if (budget.frameId !== firstPaintFrame) { firstPaintFrame = budget.frameId; firstPaintLeft = FIRST_PAINT_FRAME_BYTES; }
            const bytes = width * height * 4;
            if (bytes <= firstPaintLeft) {
                firstPaintLeft -= bytes;
                writeRows(slot, device, { x: 0, y: 0, width, height }, source);
                finish(slot, device);
                auditCount(audit, 'upload:image:first-paint', 1, { bytes });
                return true;
            }
        }
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
        acquire(key, image, budget, firstPaint = false) {
            const device = host.device();
            if (!device) return { status: 'unsupported', why: 'no-device' };
            if (device.generation !== budget.token.deviceGeneration || host.generation !== budget.token.deviceGeneration) return { status: 'deferred' };
            let slot = slots.get(key);
            if (slot?.failed) { drop(slot); return { status: 'unsupported', why: 'upload-failed' }; }
            if (!image) {
                if (!slot || !slot.ready || slot.device !== device) return { status: 'deferred' };
                slot.usedFrame = budget.frameId;
                slot.refs++;
                return { status: 'ready', value: slot.view };
            }
            if (typeof ImageBitmap === 'undefined' || !(image instanceof ImageBitmap)) return { status: 'unsupported', why: 'not-bitmap' };
            const w = image.width, h = image.height;
            if (!(w > 0 && h > 0)) return { status: 'empty' };
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
                    version: -1 };
                slots.set(key, slot); gpuBytes += bytes;
            }
            slot.usedFrame = budget.frameId;
            if (!slot.ready && !advance(slot, device, image, budget, firstPaint)) return { status: 'deferred' };
            slot.refs++;
            return { status: 'ready', value: slot.view };
        },
        acquireVideo(key, frame, budget) {
            const device = host.device();
            if (!device) return { status: 'unsupported', why: 'no-device' };
            if (device.generation !== budget.token.deviceGeneration || host.generation !== budget.token.deviceGeneration) return { status: 'deferred' };
            const { width: w, height: h, version } = frame;
            if (!(w > 0 && h > 0)) return { status: 'empty' };
            if (w > device.limits.maxTexture2D || h > device.limits.maxTexture2D) return { status: 'unsupported', why: 'video-size' };
            let slot = slots.get(key);
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
                    scaled: null, band: null, inflight: null, busy: false, failed: false, dropped: false, version: -1 };
                slots.set(key, slot); gpuBytes += bytes;
            }
            slot.usedFrame = budget.frameId;
            if (slot.ready && slot.version === version) { slot.refs++; return { status: 'ready', value: slot.view }; }
            if (!budget.claimUpload(w * h * 4, 'media')) {
                host.invalidate('video-texture-upload');
                if (!slot.ready) return { status: 'deferred' };
                slot.refs++;
                return { status: 'ready', value: slot.view };
            }
            writeRows(slot, device, { x: 0, y: 0, width: w, height: h }, frame.source, 'upload:video');
            slot.version = version; slot.ready = true;
            // The frame is the registry's: it stays open, since a 2D fallback may still draw this lease. The version recorded above
            // makes the next call for this node a no-op, so a node uploads at most once per presented frame.
            slot.refs++;
            return { status: 'ready', value: slot.view };
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
