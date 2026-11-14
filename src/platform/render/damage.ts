import type { Rect } from '../types';

/** Metadata for selective preparation; presentation still redraws the complete framebuffer. */
export interface DamageRecord {
    readonly reasonBits: number;
    readonly worldBounds: readonly Readonly<Rect>[];
    readonly full: boolean;
    readonly contentRevision: string;
    readonly cameraEpoch: number;
}

export interface DamageTags {
    readonly reasonBits: number;
    readonly contentRevision: string;
    readonly cameraEpoch: number;
}

const maxBounds = 32;
const maxRevisionLength = 4096;

function validateTags(tags: DamageTags): void {
    if (!Number.isSafeInteger(tags.reasonBits) || tags.reasonBits < 0 || tags.reasonBits > 0xffffffff ||
        !Number.isSafeInteger(tags.cameraEpoch) || tags.cameraEpoch < 0 ||
        typeof tags.contentRevision !== 'string' || tags.contentRevision.length > maxRevisionLength) {
        throw new RangeError('Invalid damage tags');
    }
}

function validateBounds(rect: Readonly<Rect>): void {
    const { x, y, width, height } = rect;
    if (![x, y, width, height, x + width, y + height].every(Number.isFinite) || width < 0 || height < 0 ||
        (width > 0 && x + width <= x) || (height > 0 && y + height <= y)) {
        throw new RangeError('Invalid damage bounds');
    }
}

/** One pending batch per pane; callers explicitly mark camera/size/DPR/theme/context changes full. */
export class DamageAccumulator {
    private bits = 0;
    private revision = '';
    private epoch = 0;
    private pending = false;
    private full = false;
    private bounds: Rect[] = [];

    mark(bounds: Readonly<Rect>, tags: DamageTags): void {
        validateTags(tags);
        validateBounds(bounds);
        this.update(tags);
        if (this.full || !bounds.width || !bounds.height) return;
        let merged = { ...bounds };
        // Repeat after every merge: a union can bridge two formerly disjoint regions.
        for (let i = 0; i < this.bounds.length;) {
            const other = this.bounds[i];
            const right = merged.x + merged.width, bottom = merged.y + merged.height;
            const otherRight = other.x + other.width, otherBottom = other.y + other.height;
            if (merged.x > otherRight || other.x > right || merged.y > otherBottom || other.y > bottom) { i++; continue; }
            const x = Math.min(merged.x, other.x), y = Math.min(merged.y, other.y);
            const width = Math.max(right, otherRight) - x, height = Math.max(bottom, otherBottom) - y;
            if (!Number.isFinite(width) || !Number.isFinite(height)) { this.promote(); return; }
            merged = { x, y, width, height };
            this.bounds.splice(i, 1);
            i = 0;
        }
        if (this.bounds.length === maxBounds) { this.promote(); return; }
        this.bounds.push(merged);
    }

    markFull(tags: DamageTags): void {
        validateTags(tags);
        this.update(tags);
        this.promote();
    }

    /** Immutable copy, unaffected by subsequent marks or consumption. */
    freeze(): DamageRecord | null {
        if (!this.pending) return null;
        const worldBounds = Object.freeze(this.bounds.map(rect => Object.freeze({ ...rect })));
        return Object.freeze({ reasonBits: this.bits, worldBounds, full: this.full,
            contentRevision: this.revision, cameraEpoch: this.epoch });
    }

    consume(): DamageRecord | null {
        const snapshot = this.freeze();
        this.pending = false;
        this.bits = 0;
        this.full = false;
        this.bounds = [];
        return snapshot;
    }

    private update(tags: DamageTags): void {
        if (this.pending && this.epoch !== tags.cameraEpoch) this.promote();
        this.pending = true;
        this.bits = (this.bits | tags.reasonBits) >>> 0;
        this.revision = tags.contentRevision;
        this.epoch = tags.cameraEpoch;
    }

    private promote(): void { this.full = true; this.bounds = []; }
}
