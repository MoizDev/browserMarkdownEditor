import type { RectI, Samples, TextureFormat } from './gfx/api';
import type { IsolationReservation as DeviceReservation } from './gfx/webgl2Isolation.types';
import type { IsolationShortfall } from './gfx/webgl2Isolation';
import { ArenaError } from './resourceArena';

/** Local structural view until the shared LayerHost isolation declaration lands. */
export interface LayerIsolationDeclaration {
    readonly depth: number;
    readonly maskDepth: number;
    readonly bounds: Readonly<RectI>;
    readonly stencil?: boolean;
    readonly samples?: Samples;
    readonly format?: TextureFormat;
    readonly multiply?: boolean;
    readonly targets?: { readonly count: number; readonly bounds: Readonly<RectI>;
        readonly stencil?: boolean; readonly samples?: Samples; readonly format?: TextureFormat };
}
interface Entry {
    left: number; top: number; right: number; bottom: number; groups: number; external: number; shortfall: number;
    format: TextureFormat; samples: Samples; stencil: boolean;
}

/** One prep snapshot, bounded by physical surface extents. Target classes merge declaration
 * peaks rather than allocating once per layer, because layers are composed sequentially (C4.3).
 */
export class GpuIsolationPlan {
    readonly #entries = new Map<string, Entry>();
    readonly #width: number;
    readonly #height: number;
    #ownDepth = 0;
    #multiply = false;

    constructor(width: number, height: number) { this.#width = width; this.#height = height; }

    own(depth: number, multiply: boolean): void {
        this.#ownDepth = depth;
        this.#multiply ||= multiply;
        if (depth) this.#entry({ x: 0, y: 0, width: this.#width, height: this.#height }, 'rgba8', 1, false);
    }

    declare(value: LayerIsolationDeclaration): void {
        this.#count(value.depth); this.#count(value.maskDepth);
        const samples = value.samples ?? 1, format = value.format ?? 'rgba8', stencil = value.stencil ?? false;
        const entry = this.#entry(value.bounds, format, samples, stencil);
        entry.groups = Math.max(entry.groups, value.depth + value.maskDepth);
        this.#multiply ||= value.multiply === true;
        if (value.targets) {
            this.#count(value.targets.count);
            const target = this.#entry(value.targets.bounds, value.targets.format ?? 'rgba8', value.targets.samples ?? 1, value.targets.stencil ?? false);
            target.external = Math.max(target.external, value.targets.count);
        }
    }

    shortfall(value: IsolationShortfall): void {
        const { request, simultaneous } = value;
        this.#count(simultaneous);
        const entry = this.#entry({ x: 0, y: 0, width: request.width, height: request.height },
            request.format ?? 'rgba8', request.samples, request.stencil);
        entry.shortfall = Math.max(entry.shortfall, simultaneous);
    }

    finish(): DeviceReservation[] {
        if (this.#multiply) {
            // Every multiply reads a single-sampled backdrop in its own target's format.
            // Union all potentially active classes before adding those backdrop entries.
            const entries = [...this.#entries.values()];
            for (const entry of entries) {
                const backdrop = this.#entry({ x: entry.left, y: entry.top, width: entry.right - entry.left,
                    height: entry.bottom - entry.top }, entry.format, 1, false);
                backdrop.shortfall = Math.max(backdrop.shortfall, 1);
            }
        }
        return [...this.#entries.values()].map(entry => ({ width: entry.right - entry.left, height: entry.bottom - entry.top, format: entry.format,
            samples: entry.samples, stencil: entry.stencil,
            count: Math.max(entry.shortfall, entry.groups + entry.external +
                (entry.format === 'rgba8' && entry.samples === 1 && !entry.stencil ? this.#ownDepth : 0) +
                (this.#multiply && entry.samples === 1 && !entry.stencil ? 1 : 0)) }))
            .filter(entry => entry.count > 0 && entry.width > 0 && entry.height > 0);
    }

    #entry(bounds: Readonly<RectI>, format: TextureFormat, samples: Samples, stencil: boolean): Entry {
        if (![bounds.x, bounds.y, bounds.width, bounds.height].every(value => Number.isSafeInteger(value) && value >= 0) ||
            !Number.isSafeInteger(bounds.x + bounds.width) || !Number.isSafeInteger(bounds.y + bounds.height) ||
            !['rgba8', 'r8'].includes(format) || ![1, 4].includes(samples) || typeof stencil !== 'boolean') throw new ArenaError('invalid-input');
        const right = Math.min(this.#width, bounds.x + bounds.width), bottom = Math.min(this.#height, bounds.y + bounds.height);
        const left = Math.min(this.#width, bounds.x), top = Math.min(this.#height, bounds.y);
        const key = this.#key(format, samples, stencil);
        let entry = this.#entries.get(key);
        if (!entry) {
            entry = { left, top, right, bottom, groups: 0, external: 0, shortfall: 0, format, samples, stencil };
            this.#entries.set(key, entry);
        }
        entry.left = Math.min(entry.left, left); entry.top = Math.min(entry.top, top);
        entry.right = Math.max(entry.right, right); entry.bottom = Math.max(entry.bottom, bottom);
        return entry;
    }
    #key(format: TextureFormat, samples: Samples, stencil: boolean): string { return `${format}:${samples}:${stencil}`; }
    #count(count: number): void { if (!Number.isSafeInteger(count) || count < 0 || count > 64) throw new ArenaError('invalid-input'); }
}
