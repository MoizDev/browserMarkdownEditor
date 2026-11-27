import { MAX_TEXT_LENGTH } from '../model/textLimits';

const MAX_BYTES = MAX_TEXT_LENGTH * 4;
const MAX_DEPTH = 128;
const MAX_VALUES = 1_000_000;

export function* encodeOpaqueJsonSteps(value: unknown): Generator<void, string> {
    const active = new Set<object>(), pieces: string[] = [];
    let batch: string[] = [], length = 0, work = 0;
    const emit = (part: string) => {
        length += part.length;
        if (length > MAX_BYTES) throw new RangeError('Unsupported rich data exceeds preservation limit');
        batch.push(part);
        if (batch.length >= 512) { pieces.push(batch.join('')); batch = []; }
    };
    const string = function* (text: string): Generator<void, void> {
        emit('"');
        for (let index = 0; index < text.length;) {
            let end = Math.min(text.length, index + 4096);
            if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff
                && text.charCodeAt(end) >= 0xdc00 && text.charCodeAt(end) <= 0xdfff) end--;
            const encoded = JSON.stringify(text.slice(index, end));
            emit(encoded.slice(1, -1)); index = end;
            yield;
        }
        emit('"');
    };
    const visit = function* (item: unknown, depth: number): Generator<void, void> {
        if (++work > MAX_VALUES || depth > MAX_DEPTH) throw new RangeError('Unsupported rich data exceeds structural limits');
        if ((work & 255) === 0) yield;
        if (item === null) { emit('null'); return; }
        if (typeof item === 'boolean') { emit(item ? 'true' : 'false'); return; }
        if (typeof item === 'number') {
            if (!Number.isFinite(item)) throw new RangeError('Unsupported rich data contains a non-finite number');
            emit(JSON.stringify(item)); return;
        }
        if (typeof item === 'string') { yield* string(item); return; }
        if (typeof item !== 'object') throw new TypeError('Unsupported rich data is not JSON');
        if (active.has(item)) throw new TypeError('Unsupported rich data is cyclic');
        active.add(item);
        try {
            if (Array.isArray(item)) {
                for (const key in item) {
                    if (!Object.hasOwn(item, key)) throw new TypeError('Unsupported rich array has inherited data');
                    const index = Number(key);
                    if (!Number.isSafeInteger(index) || index < 0 || String(index) !== key || index >= item.length)
                        throw new TypeError('Unsupported rich array has extra fields');
                    if ((++work & 255) === 0) yield;
                    if (work > MAX_VALUES) throw new RangeError('Unsupported rich data exceeds structural limits');
                }
                emit('[');
                for (let index = 0; index < item.length; index++) {
                    const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
                    if (!descriptor || !('value' in descriptor)) throw new TypeError('Unsupported rich array contains a hole or accessor');
                    if (index) emit(',');
                    yield* visit(descriptor.value, depth + 1);
                }
                emit(']'); return;
            }
            const prototype = Object.getPrototypeOf(item);
            if (prototype !== Object.prototype && prototype !== null) throw new TypeError('Unsupported rich data is not a plain object');
            emit('{');
            let first = true;
            for (const key in item) {
                if (!Object.hasOwn(item, key)) throw new TypeError('Unsupported rich object has inherited data');
                const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
                if (!('value' in descriptor)) throw new TypeError('Unsupported rich object contains an accessor');
                if (!first) emit(','); first = false;
                yield* string(key); emit(':'); yield* visit(descriptor.value, depth + 1);
            }
            emit('}');
        } finally { active.delete(item); }
    };
    yield* visit(value, 0);
    if (batch.length) pieces.push(batch.join(''));
    return pieces.join('');
}
