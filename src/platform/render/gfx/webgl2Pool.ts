import type { Handle, TargetHandle, TargetLease, TextureHandle } from './api';
import type { TargetRequest } from './webgl2Frame';
import { ArenaError } from '../resourceArena';

export interface PoolStorage {
    readonly texture: TextureHandle;
    readonly target: TargetHandle;
    readonly request: TargetRequest;
}
export interface PoolBackend {
    readonly generation: number;
    readonly maxSize: number;
    create(request: TargetRequest): PoolStorage;
    alias(storage: PoolStorage, request: TargetRequest): { texture: TextureHandle; target: TargetHandle };
    releaseAlias(lease: TargetLease): void;
    destroy(storage: PoolStorage): void;
    completed(serial: number): boolean;
}
interface Entry {
    readonly storage: PoolStorage;
    readonly key: string;
    readonly frames: Set<object>;
    held: Borrow | null;
    dependencies: number;
    serial: number;
}
interface Borrow {
    readonly lease: TargetLease;
    readonly entry: Entry;
    active: boolean;
}

/** Pool storage stays charged while idle (design:284). Every borrow has fresh public handles:
 * releasing a lease can never leave a stale public handle authorizing a later borrow's pixels.
 */
export class Webgl2TargetPool {
    readonly #backend: PoolBackend;
    readonly #entries = new Set<Entry>();
    readonly #leases = new WeakMap<TargetLease, Borrow>();
    readonly #handles = new WeakMap<Handle, Borrow>();
    readonly #frames = new Map<object, Set<Entry>>();

    constructor(backend: PoolBackend) { this.#backend = backend; }

    acquire(desc: TargetRequest): TargetLease | null {
        for (const dimension of [desc.width, desc.height]) {
            if (!Number.isSafeInteger(dimension) || dimension <= 0) throw new ArenaError('invalid-input');
        }
        if (desc.width > this.#backend.maxSize || desc.height > this.#backend.maxSize) throw new ArenaError('unsupported');
        if (![1, 4].includes(desc.samples) || typeof desc.stencil !== 'boolean' ||
            desc.format !== undefined && desc.format !== 'rgba8' && desc.format !== 'r8' ||
            !['mask', 'group', 'scene-cache', 'capture'].includes(desc.purpose)) throw new ArenaError('invalid-input');
        const request: TargetRequest = { ...desc, format: desc.format ?? 'rgba8',
            width: Math.min(this.#backend.maxSize, Math.ceil(desc.width / 64) * 64),
            height: Math.min(this.#backend.maxSize, Math.ceil(desc.height / 64) * 64) };
        const key = JSON.stringify([this.#backend.generation, request.width, request.height, request.format, request.samples, request.stencil]);
        let entry: Entry | undefined;
        for (const candidate of this.#entries) {
            if (candidate.key === key && this.#idle(candidate)) { entry = candidate; break; }
        }
        if (!entry) {
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    entry = { storage: this.#backend.create(request), key, frames: new Set(), held: null, dependencies: 0, serial: 0 };
                    this.#entries.add(entry);
                    break;
                } catch (error) {
                    if (!(error instanceof ArenaError) || error.code !== 'out-of-budget') throw error;
                    if (attempt === 1 || !this.trimIdle()) return null;
                }
            }
        }
        if (!entry) return null;
        let aliases: { texture: TextureHandle; target: TargetHandle };
        try { aliases = this.#backend.alias(entry.storage, desc); }
        catch (error) {
            if (error instanceof ArenaError && error.code === 'out-of-budget') return null;
            throw error;
        }
        const lease: TargetLease = Object.freeze({ ...aliases, width: request.width, height: request.height,
            format: request.format!, samples: request.samples, stencil: request.stencil });
        const borrow: Borrow = { lease, entry, active: true };
        entry.held = borrow;
        this.#leases.set(lease, borrow);
        this.#handles.set(lease.target, borrow);
        this.#handles.set(lease.texture, borrow);
        return lease;
    }

    release(lease: TargetLease): void {
        const borrow = this.#leases.get(lease);
        if (!borrow) throw new ArenaError('invalid-resource');
        if (!borrow.active) return;
        borrow.active = false;
        if (borrow.entry.held === borrow) borrow.entry.held = null;
        this.#backend.releaseAlias(lease);
    }

    releaseHandle(handle: Handle): boolean {
        const borrow = this.#handles.get(handle);
        if (!borrow) return false;
        this.release(borrow.lease);
        return true;
    }

    /** An independently owned target/clip can outlive the borrow that supplied its texture. */
    retainDependency(handle: TextureHandle): (() => void) | undefined {
        const borrow = this.#handles.get(handle);
        if (!borrow) return undefined;
        borrow.entry.dependencies++;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            borrow.entry.dependencies--;
        };
    }

    /** Pin accounting spans encode-before-submit as well as submitted fences (design:298). */
    touch(handle: Handle, frame: object): void {
        const borrow = this.#handles.get(handle);
        if (!borrow) return;
        let entries = this.#frames.get(frame);
        if (!entries) { entries = new Set(); this.#frames.set(frame, entries); }
        entries.add(borrow.entry);
        borrow.entry.frames.add(frame);
    }

    finish(frame: object, serial: number | null): void {
        const entries = this.#frames.get(frame);
        if (!entries) return;
        this.#frames.delete(frame);
        for (const entry of entries) {
            entry.frames.delete(frame);
            if (serial !== null) entry.serial = Math.max(entry.serial, serial);
        }
    }

    trimIdle(): number {
        let count = 0;
        for (const entry of this.#entries) {
            if (!this.#idle(entry)) continue;
            this.#backend.destroy(entry.storage);
            this.#entries.delete(entry);
            count++;
        }
        return count;
    }

    clear(): void {
        this.trimIdle(); // Pressure always relinquishes idle storage before a live working set.
        for (const entry of this.#entries) {
            if (entry.held) this.release(entry.held.lease);
            this.#backend.destroy(entry.storage);
        }
        this.#entries.clear();
        this.#frames.clear();
    }

    abandon(): void {
        for (const entry of this.#entries) {
            if (entry.held) entry.held.active = false;
            entry.held = null;
            entry.frames.clear();
        }
        this.#entries.clear();
        this.#frames.clear();
    }

    #idle(entry: Entry): boolean {
        return entry.held === null && entry.dependencies === 0 && entry.frames.size === 0 && this.#backend.completed(entry.serial);
    }
}
