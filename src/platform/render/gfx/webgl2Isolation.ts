import type { Samples, TargetLease, TextureFormat } from './api';
import type { TargetRequest } from './webgl2Frame';
import { ArenaError } from '../resourceArena';

/** An admitted storage class; its dimensions are the union of the declared device bounds. */
export interface IsolationReservation {
    readonly width: number;
    readonly height: number;
    readonly format: TextureFormat;
    readonly samples: Samples;
    readonly stencil: boolean;
    readonly count: number;
}

interface Slot {
    readonly lease: TargetLease;
    readonly width: number;
    readonly height: number;
    serial: number;
    frame: object | null;
    inUse: boolean;
}

/** A missing declaration is a runnable deferral, not a native allocation during draw. */
export class IsolationShortfall extends ArenaError {
    constructor(readonly request: TargetRequest, readonly simultaneous: number) { super('out-of-budget'); }
}

/** Keep charged physical targets and their aliases until pressure/hide. Within one recorded
 * command stream a target can be recycled after the matching pop; across submitted frames its
 * serial must complete first. No target or alias is created in the encoding pass (C4.3).
 */
export class Webgl2IsolationPool {
    readonly #slots: Slot[] = [];
    readonly #frames = new Map<object, Set<Slot>>();
    constructor(private readonly acquire: (request: TargetRequest) => TargetLease | null,
        private readonly release: (lease: TargetLease) => void,
        private readonly completed: (serial: number) => boolean) {}

    admit(plan: readonly IsolationReservation[]): boolean {
        const added: Slot[] = [];
        const claimed = new Set<Slot>();
        try {
            for (const request of [...plan].sort((a, b) => b.width * b.height - a.width * a.height)) {
                if (![request.width, request.height, request.count].every(value => Number.isSafeInteger(value) && value >= 0)) {
                    throw new ArenaError('invalid-input');
                }
                if (!request.width || !request.height || !request.count) continue;
                for (let index = 0; index < request.count; index++) {
                    let slot = this.#slots.find(candidate => !claimed.has(candidate) && !candidate.frame &&
                        this.#compatible(candidate, request) && this.completed(candidate.serial));
                    if (!slot) {
                        const lease = this.acquire({ width: request.width, height: request.height, format: request.format,
                            samples: request.samples, stencil: request.stencil, purpose: 'group' });
                        if (!lease) { for (const item of added) { this.release(item.lease); this.#remove(item); } return false; }
                        slot = { lease, width: request.width, height: request.height, serial: 0, frame: null, inUse: false };
                        this.#slots.push(slot);
                        added.push(slot);
                    }
                    claimed.add(slot);
                }
            }
            return true;
        } catch (error) {
            for (const item of added) { this.release(item.lease); this.#remove(item); }
            throw error;
        }
    }

    begin(frame: object): void {
        if (this.#frames.has(frame)) throw new ArenaError('invalid-input');
        this.#frames.set(frame, new Set());
    }

    borrow(frame: object, request: TargetRequest): TargetLease {
        const used = this.#frames.get(frame);
        if (!used) throw new ArenaError('aborted');
        const requestFormat = request.format ?? 'rgba8';
        let compatibleInUse = 0;
        for (const slot of this.#slots) {
            if (!this.#compatible(slot, { ...request, format: requestFormat })) continue;
            if (slot.frame === frame && slot.inUse) { compatibleInUse++; continue; }
            if (slot.frame !== null && slot.frame !== frame) continue;
            if (slot.frame === null && !this.completed(slot.serial)) continue;
            slot.frame = frame;
            slot.inUse = true;
            used.add(slot);
            return slot.lease;
        }
        throw new IsolationShortfall(request, compatibleInUse + 1);
    }

    put(frame: object, lease: TargetLease): void {
        const slot = [...(this.#frames.get(frame) ?? [])].find(item => item.lease === lease);
        if (!slot || !slot.inUse) throw new ArenaError('invalid-resource');
        slot.inUse = false;
    }

    finish(frame: object, serial: number | null): void {
        const used = this.#frames.get(frame);
        if (!used) return;
        this.#frames.delete(frame);
        for (const slot of used) {
            slot.frame = null;
            slot.inUse = false;
            if (serial !== null) slot.serial = Math.max(slot.serial, serial);
        }
    }

    clear(): void {
        for (const slot of this.#slots) this.release(slot.lease);
        this.#slots.length = 0;
        this.#frames.clear();
    }

    abandon(): void { this.#slots.length = 0; this.#frames.clear(); }

    #compatible(slot: Slot, request: Pick<IsolationReservation, 'width' | 'height' | 'format' | 'samples' | 'stencil'>): boolean {
        return slot.width >= request.width && slot.height >= request.height && slot.lease.format === request.format &&
            slot.lease.samples === request.samples && slot.lease.stencil === request.stencil;
    }
    #remove(slot: Slot): void { const index = this.#slots.indexOf(slot); if (index >= 0) this.#slots.splice(index, 1); }
}
