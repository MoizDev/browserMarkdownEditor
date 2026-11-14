import type { ByteLease, TargetLease } from './api';
import type { TargetRequest } from './webgl2Frame';
import type { IsolationReservation } from './webgl2Isolation.types';
import { ArenaError } from '../resourceArena';

interface Slot {
    readonly lease: TargetLease;
    readonly metadata: ByteLease;
    readonly width: number;
    readonly height: number;
    inUse: boolean;
}
interface FrameSlots {
    readonly slots: Slot[];
    readonly external: Map<TargetLease, Slot>;
}

/** An undeclared target is a runnable deferral, not a native allocation during draw. */
export class IsolationShortfall extends ArenaError {
    constructor(readonly request: TargetRequest, readonly simultaneous: number, readonly external: boolean) { super('out-of-budget'); }
}

/** The target pool owns physical storage; a frame owns its private aliases and a prepaid
 * zero-byte metadata lease for fresh public aliases. Internal aliases can be recycled after a
 * matching pop within the same recorded stream; every alias is revoked at frame end. Underlying
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
            for (const request of plan) {
                if (![request.width, request.height, request.count].every(value => Number.isSafeInteger(value) && value >= 0)) {
                    throw new ArenaError('invalid-input');
                }
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
        this.#frames.set(frame, { slots: this.#prepared, external: new Map() });
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
            if (!external) return slot.lease;
            try {
                const handle = this.alias(slot.lease, request, slot.metadata);
                state.external.set(handle, slot);
                return handle;
            } catch (error) { slot.inUse = false; throw error; }
        }
        throw new IsolationShortfall(request, simultaneous + 1, external);
    }

    put(frame: object, lease: TargetLease, external: boolean): void {
        const state = this.#frames.get(frame);
        if (!state) throw new ArenaError('aborted');
        const slot = external ? state.external.get(lease) : state.slots.find(item => item.lease === lease);
        if (!slot || !slot.inUse) throw new ArenaError('invalid-resource');
        if (external) { state.external.delete(lease); this.revoke(lease); }
        slot.inUse = false;
    }

    finish(frame: object): void {
        const state = this.#frames.get(frame);
        if (!state) return;
        this.#frames.delete(frame);
        for (const lease of state.external.keys()) this.revoke(lease);
        this.#release(state.slots);
    }

    clear(): void {
        this.#release(this.#prepared);
        this.#prepared = [];
        for (const state of this.#frames.values()) {
            for (const lease of state.external.keys()) this.revoke(lease);
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
