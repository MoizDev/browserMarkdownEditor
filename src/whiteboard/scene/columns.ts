// Dense Float64 scene state; slot generation lives in HybridIndex, not in an object per node.
export class SceneColumns {
    capacity = 16;
    world = new Float64Array(16 * 6);
    ink = new Float64Array(16 * 4);
    hit = new Float64Array(16 * 4);
    parent = new Int32Array(16).fill(-1);
    sheet = new Int32Array(16).fill(-1);
    page = new Int32Array(16).fill(-1);
    clip = new Int32Array(16).fill(-1);
    opacity = new Float64Array(16);
    locked = new Uint8Array(16);
    quality = new Uint8Array(16);
    count = new Uint32Array(16);
    geometry = new Uint32Array(16);
    paint = new Uint32Array(16);
    nodeRevision = new Float64Array(16);
    reserve(required: number): void {
        if (!Number.isSafeInteger(required) || required < 0 || required > 0x7fffffff) throw new RangeError('Invalid dense scene capacity');
        if (required <= this.capacity) return;
        let capacity = this.capacity;
        while (capacity < required) capacity *= 2;
        const f64 = (old: Float64Array, stride = 1) => { const next = new Float64Array(capacity * stride); next.set(old); return next; };
        const i32 = (old: Int32Array) => { const next = new Int32Array(capacity).fill(-1); next.set(old); return next; };
        const u32 = (old: Uint32Array) => { const next = new Uint32Array(capacity); next.set(old); return next; };
        const u8 = (old: Uint8Array) => { const next = new Uint8Array(capacity); next.set(old); return next; };
        this.world = f64(this.world, 6); this.ink = f64(this.ink, 4); this.hit = f64(this.hit, 4);
        this.parent = i32(this.parent); this.sheet = i32(this.sheet); this.page = i32(this.page); this.clip = i32(this.clip);
        this.opacity = f64(this.opacity); this.nodeRevision = f64(this.nodeRevision);
        this.locked = u8(this.locked); this.quality = u8(this.quality);
        this.count = u32(this.count); this.geometry = u32(this.geometry); this.paint = u32(this.paint);
        this.capacity = capacity;
    }
    get byteLength(): number {
        return this.world.byteLength + this.ink.byteLength + this.hit.byteLength + this.parent.byteLength + this.sheet.byteLength
            + this.page.byteLength + this.clip.byteLength + this.opacity.byteLength + this.locked.byteLength + this.quality.byteLength
            + this.count.byteLength + this.geometry.byteLength + this.paint.byteLength + this.nodeRevision.byteLength;
    }
}
