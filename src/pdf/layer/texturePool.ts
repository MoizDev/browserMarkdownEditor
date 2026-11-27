import type { ByteLease, GfxDevice, TextureHandle } from '../../platform/render';
import type { MemoryAllocator, ReserveOptions } from '../../platform/render/memoryGovernor';

export interface PooledTexture {
    readonly device: GfxDevice;
    readonly handle: TextureHandle;
    readonly width: number;
    readonly height: number;
    readonly bytes: number;
}

const FREE_TEXTURE_LIMIT = 32;

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
        let lease: ByteLease | null = this.allocator.reserve(bytes);
        while (!lease && this.free.length) {
            const oldest = this.free.shift()!;
            this.freeBytes -= oldest.bytes;
            oldest.device.destroy(oldest.handle);
            lease = this.allocator.reserve(bytes);
        }
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
        if (this.free.length >= FREE_TEXTURE_LIMIT) { item.device.destroy(item.handle); return; }
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

export function createTileTexture(allocator: MemoryAllocator, device: GfxDevice, width: number, height: number, options?: ReserveOptions): PooledTexture | null {
    const bytes = width * height * 4;
    const lease = allocator.reserve(bytes, options);
    if (!lease) return null;
    try {
        return { device, handle: device.createTexture(width, height, 'rgba8', ['sample', 'copy-dst'], lease), width, height, bytes };
    } catch (error) {
        allocator.release(lease);
        throw error;
    }
}
