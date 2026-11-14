import type { ReadPosition, ReadSourceRecord, UnmappedRecord } from '../format/readTypes';
import { FORMAT_LIMITS, RECORD_ORDER } from '../format/schema';

// Provenance: native read position and bounds contracts, FORMAT_LIMITS, and the
// serializer's original-byte authority. Independent admission checks, no third-party source.
function fields(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string' || (!required.includes(key) && !optional.includes(key))) return false;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !('value' in descriptor)) return false;
    }
    return required.every(key => Object.hasOwn(value, key));
}
function boundedString(value: unknown, max: number): value is string {
    return typeof value === 'string' && value.length <= max;
}
function position(value: unknown, size: number): value is ReadPosition {
    if (!fields(value, ['ordinal', 'line', 'byteOffset', 'byteLength'])) return false;
    const { ordinal, line, byteOffset, byteLength } = value;
    return typeof ordinal === 'number' && Number.isSafeInteger(ordinal) && ordinal >= 0
        && typeof line === 'number' && Number.isSafeInteger(line) && line >= 1
        && typeof byteOffset === 'number' && Number.isSafeInteger(byteOffset) && byteOffset >= 0 && byteOffset <= size
        && typeof byteLength === 'number' && Number.isSafeInteger(byteLength) && byteLength >= 0
        && byteLength <= FORMAT_LIMITS.recordBytes && byteLength <= size - byteOffset;
}
function source(value: unknown, size: number): value is ReadSourceRecord {
    if (!fields(value, ['category', 'type', 'position', 'reencode'], ['id', 'nodeBounds'])
        || typeof value.category !== 'string' || !RECORD_ORDER.includes(value.category as ReadSourceRecord['category'])
        || !boundedString(value.type, FORMAT_LIMITS.idChars) || (Object.hasOwn(value, 'id') && !boundedString(value.id, FORMAT_LIMITS.idChars))
        || !position(value.position, size) || typeof value.reencode !== 'boolean') return false;
    if (Object.hasOwn(value, 'nodeBounds')) {
        const b = value.nodeBounds;
        if (value.category !== 'node' || !Array.isArray(b) || b.length !== 4) return false;
        for (let i = 0; i < 4; i++) {
            if (typeof b[i] !== 'number' || !Number.isFinite(b[i]) || Math.abs(b[i]) > FORMAT_LIMITS.world) return false;
        }
        if (b[2] < 0 || b[3] < 0) return false;
    }
    return true;
}

export async function validateLoadSources(sources: readonly ReadSourceRecord[], removedSources: readonly ReadSourceRecord[],
    unmapped: readonly UnmappedRecord[], baseline: Blob, cooperate?: () => Promise<void>, signal?: AbortSignal): Promise<void> {
    const check = () => { if (signal?.aborted) throw new DOMException('Board admission cancelled', 'AbortError'); };
    if (!(baseline instanceof Blob) || (typeof File !== 'undefined' && baseline instanceof File)
        || baseline.size > FORMAT_LIMITS.fileBytes || !Array.isArray(sources) || !Array.isArray(removedSources)
        || !Array.isArray(unmapped)) throw new TypeError('Invalid source validation input');
    let steps = 0, started = performance.now();
    const tick = async () => { check(); await cooperate?.(); check(); started = performance.now(); steps = 0; };
    const ordinals = new Set<number>();
    let end = 0;
    check();
    for (const entry of sources) {
        if (++steps >= 256 || performance.now() - started >= 3) await tick();
        if (!source(entry, baseline.size) || ordinals.has(entry.position.ordinal) || entry.position.byteOffset < end) throw new TypeError('Invalid live source metadata');
        ordinals.add(entry.position.ordinal);
        end = entry.position.byteOffset + entry.position.byteLength;
    }
    for (const entry of removedSources) {
        if (++steps >= 256 || performance.now() - started >= 3) await tick();
        if (!source(entry, baseline.size)) throw new TypeError('Invalid removed source metadata');
    }
    for (const entry of unmapped) {
        if (++steps >= 256 || performance.now() - started >= 3) await tick();
        if (!fields(entry, ['raw', 'position', 'reason']) || !boundedString(entry.raw, FORMAT_LIMITS.recordBytes)
            || !position(entry.position, baseline.size) || !boundedString(entry.reason, 10_000)) throw new TypeError('Invalid unmapped source metadata');
    }
    check();
}
