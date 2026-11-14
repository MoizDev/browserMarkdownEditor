import type { ByteLease, GfxDevice, TextureHandle } from '../../platform/render';
import type { MemoryAllocator } from '../../platform/render/memoryGovernor';

export interface PooledTexture {
    readonly device: GfxDevice;
    readonly handle: TextureHandle;
    readonly width: number;
    readonly height: number;
    readonly bytes: number;
}

/** Scratch textures retain their governor lease until reused or destroyed (design §6.1:592). */
export class PdfTexturePool {
    private readonly free: PooledTexture[] = [];
    private freeBytes = 0;

    constructor(private readonly allocator: MemoryAllocator) {}

    acquire(device: GfxDevice, width: number, height: number): PooledTexture | null {
        const index = this.free.findIndex(item => item.device === device && item.width === width && item.height === height);
        if (index >= 0) {
            const [item] = this.free.splice(index, 1);
            this.freeBytes -= item.bytes;
            return item;
        }
        const bytes = width * height * 4;
        const lease: ByteLease | null = this.allocator.reserve(bytes);
        if (!lease) return null;
        try {
            return { device, handle: device.createTexture(width, height, 'rgba8', ['sample', 'copy-dst'], lease),
                width, height, bytes };
        } catch (error) {
            this.allocator.release(lease);
            throw error;
        }
    }

    release(item: PooledTexture): void {
        if (this.free.length >= 16) { item.device.destroy(item.handle); return; }
        this.free.push(item);
        this.freeBytes += item.bytes;
    }

    memory(): number { return this.freeBytes; }

    clear(lost: boolean): void {
        const free = this.free.splice(0);
        this.freeBytes = 0;
        if (!lost) for (const item of free) item.device.destroy(item.handle);
    }
}
