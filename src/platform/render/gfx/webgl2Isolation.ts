import type { ByteLease, TargetLease } from './api';
import type { TargetRequest } from './webgl2Frame';
import type { IsolationReservation } from './webgl2Isolation.types';
import { ArenaError } from '../resourceArena';
import { RENDER_CONSTANTS as POLICY } from '../constants';

interface Slot {
    readonly lease: TargetLease;
    readonly metadata: ByteLease;
    readonly width: number;
    readonly height: number;
    inUse: boolean;
}
interface FrameSlots {
    readonly slots: Slot[];
    readonly borrowed: Map<TargetLease, { slot: Slot; external: boolean }>;
}

/** An undeclared target is a runnable deferral, not a native allocation during draw. */
export class IsolationShortfall extends ArenaError {
    constructor(readonly request: TargetRequest, readonly simultaneous: number, readonly external: boolean) { super('out-of-budget'); }
}

/** The target pool owns physical storage; a frame owns its private aliases and a prepaid
 * zero-byte metadata lease for aliases with each borrow's used rectangle. Aliases are revoked at
 * matching pop or frame end; encoded commands retain their pinned resources. Underlying
 * storage remains charged and cannot be reused before its submitted fence (C4.3).
 */
export class Webgl2IsolationPool {
    #prepared: Slot[] = [];
    readonly #frames = new Map<object, FrameSlots>();
    constructor(private readonly acquire: (request: TargetRequest) => TargetLease | null,
        private readonly release: (lease: TargetLease) => void,
        private readonly reserveMetadata: () => ByteLease,
        private readonly closeMetadata: (lease: ByteLease) => void,
        private readonly alias: (base: TargetLease, request: TargetRequest, metadata: ByteLease) => TargetLease,
        private readonly revoke: (lease: TargetLease) => void) {}

    admit(plan: readonly IsolationReservation[]): boolean {
        this.#release(this.#prepared);
        this.#prepared = [];
        const added: Slot[] = [];
        try {
            let bytes = 0, count = 0;
            for (const request of plan) {
                if (![request.width, request.height, request.count].every(value => Number.isSafeInteger(value) && value >= 0) ||
                    !['rgba8', 'r8'].includes(request.format) || ![1, 4].includes(request.samples) || typeof request.stencil !== 'boolean') {
                    throw new ArenaError('invalid-input');
                }
                if (!request.width || !request.height || !request.count) continue;
                const pixelBytes = (request.format === 'r8' ? 1 : 4) * (request.samples === 4 ? 5 : 1) +
                    (request.stencil ? request.samples * 8 : 0);
                count += request.count;
                bytes += request.width * request.height * pixelBytes * request.count;
                // No grant can exceed this governor ceiling; reject impossible inventories before
                // issuing any per-target reservations, which still decide the actual available budget.
                if (!Number.isSafeInteger(count) || !Number.isSafeInteger(bytes) || bytes > POLICY.memoryCeilings.high.gpuBytes) {
                    throw new ArenaError('out-of-budget');
                }
            }
            for (const request of plan) {
                if (!request.width || !request.height) continue;
                for (let index = 0; index < request.count; index++) {
                    const lease = this.acquire({ width: request.width, height: request.height, format: request.format,
                        samples: request.samples, stencil: request.stencil, purpose: 'group' });
                    if (!lease) throw new ArenaError('out-of-budget');
                    try {
                        added.push({ lease, metadata: this.reserveMetadata(), width: request.width, height: request.height, inUse: false });
                    } catch (error) { this.release(lease); throw error; }
                }
            }
            this.#prepared = added;
            return true;
        } catch (error) {
            this.#release(added);
            if (error instanceof ArenaError && error.code === 'out-of-budget') return false;
            throw error;
        }
    }

    begin(frame: object): void {
        if (this.#frames.has(frame)) throw new ArenaError('invalid-input');
        this.#frames.set(frame, { slots: this.#prepared, borrowed: new Map() });
        this.#prepared = [];
    }

    borrow(frame: object, request: TargetRequest, external: boolean): TargetLease {
        const state = this.#frames.get(frame);
        if (!state) throw new ArenaError('aborted');
        if (![request.width, request.height].every(value => Number.isSafeInteger(value) && value > 0) ||
            ![1, 4].includes(request.samples) || !['rgba8', 'r8'].includes(request.format ?? 'rgba8') ||
            typeof request.stencil !== 'boolean' || !['mask', 'group', 'scene-cache', 'capture'].includes(request.purpose)) {
            throw new ArenaError('invalid-input');
        }
        let simultaneous = 0;
        for (const slot of state.slots) {
            if (!this.#sameClass(slot, request)) continue;
            if (slot.inUse) { simultaneous++; continue; }
            if (slot.width < request.width || slot.height < request.height) continue;
            slot.inUse = true;
            try {
                const handle = this.alias(slot.lease, request, slot.metadata);
                state.borrowed.set(handle, { slot, external });
                return handle;
            } catch (error) { slot.inUse = false; throw error; }
        }
        throw new IsolationShortfall(request, simultaneous + 1, external);
    }

    put(frame: object, lease: TargetLease, external: boolean): void {
        const state = this.#frames.get(frame);
        if (!state) throw new ArenaError('aborted');
        const borrowed = state.borrowed.get(lease);
        if (!borrowed || borrowed.external !== external || !borrowed.slot.inUse) throw new ArenaError('invalid-resource');
        state.borrowed.delete(lease); this.revoke(lease);
        borrowed.slot.inUse = false;
    }

    finish(frame: object): void {
        const state = this.#frames.get(frame);
        if (!state) return;
        this.#frames.delete(frame);
        for (const lease of state.borrowed.keys()) this.revoke(lease);
        this.#release(state.slots);
    }

    clear(): void {
        this.#release(this.#prepared);
        this.#prepared = [];
        for (const state of this.#frames.values()) {
            for (const lease of state.borrowed.keys()) this.revoke(lease);
            this.#release(state.slots);
        }
        this.#frames.clear();
    }

    abandon(): void {
        const slots = [...this.#prepared, ...[...this.#frames.values()].flatMap(state => state.slots)];
        this.#prepared = [];
        this.#frames.clear();
        for (const slot of slots) this.closeMetadata(slot.metadata);
    }

    #sameClass(slot: Slot, request: TargetRequest): boolean {
        return slot.lease.format === (request.format ?? 'rgba8') && slot.lease.samples === request.samples && slot.lease.stencil === request.stencil;
    }
    #release(slots: readonly Slot[]): void {
        const failures: unknown[] = [];
        for (const slot of slots) {
            try { this.release(slot.lease); } catch (error) { failures.push(error); }
            try { this.closeMetadata(slot.metadata); } catch (error) { failures.push(error); }
        }
        if (failures.length) throw failures[0];
    }
}
