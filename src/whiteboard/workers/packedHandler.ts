import type { WorkerContext } from '../../platform/workers';
import { validBox } from '../geom/bounds';
import { PackedBuildJob, type PackedSnapshot } from '../scene/packedBuild';
import { SECURITY_LIMITS } from '../security/limits';

/** The worker receives only owned numeric slabs; it never reads a live scene. */
export async function buildPacked(payload: unknown, context: WorkerContext): Promise<unknown> {
    if (!payload || typeof payload !== 'object') throw new TypeError('Invalid packed scene request');
    const input = payload as PackedSnapshot;
    if (!(input.slots instanceof Uint32Array) || !(input.generations instanceof Uint32Array)
        || !(input.versions instanceof Uint32Array) || !(input.bounds instanceof Float64Array)
        || input.slots.length > SECURITY_LIMITS.records || input.generations.length !== input.slots.length
        || input.versions.length !== input.slots.length || input.bounds.length !== input.slots.length * 4
        || !Number.isSafeInteger(input.revision) || input.revision < 0) throw new TypeError('Invalid packed scene slabs');
    let started = performance.now(), work = 0;
    for (let i = 0; i < input.slots.length; i++) {
        if (input.slots[i] >= SECURITY_LIMITS.records || !input.generations[i] || !input.versions[i] || !validBox(input.bounds, i * 4)) {
            throw new RangeError('Invalid packed scene entry');
        }
        if (++work >= 256 || performance.now() - started >= 3) {
            await context.slice(); work = 0; started = performance.now();
        }
    }
    context.signal.throwIfAborted();
    const job = new PackedBuildJob(input);
    try {
        for (;;) {
            started = performance.now(); work = 0;
            let status: 'pending' | 'complete' | 'cancelled' = 'pending';
            while (status === 'pending' && work++ < 256 && performance.now() - started < 3) status = job.step(1);
            if (status === 'complete') {
                const data = job.result;
                context.transfer(data.slots.buffer as ArrayBuffer, data.generations.buffer as ArrayBuffer, data.versions.buffer as ArrayBuffer,
                    data.bounds.buffer as ArrayBuffer, data.membership.buffer as ArrayBuffer, data.starts.buffer as ArrayBuffer, data.counts.buffer as ArrayBuffer);
                return data;
            }
            if (status === 'cancelled') throw new DOMException('Packed scene build cancelled', 'AbortError');
            await context.slice();
        }
    } finally { job.cancel(); }
}
