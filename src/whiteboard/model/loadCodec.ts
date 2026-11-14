import { SECURITY_LIMITS } from '../security/limits';
import type { JsonValue } from './json';

const MAP = '$boardMap';
type Container = Record<string, unknown> | unknown[] | Map<string, unknown>;
type Frame = { readonly source: object; readonly target: Container; readonly entries: Iterator<readonly [string | number, unknown]>; readonly depth: number };

function* properties(source: object): Generator<readonly [string, unknown]> {
    for (const key in source) {
        if (!Object.hasOwn(source, key)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(source, key);
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError('Load data contains an accessor');
        yield [key, descriptor.value];
    }
}
function* arrayEntries(source: readonly unknown[]): Generator<readonly [number, unknown]> {
    for (let i = 0; i < source.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(source, i);
        if (!descriptor || !('value' in descriptor)) throw new TypeError('Load arrays must be dense data');
        yield [i, descriptor.value];
    }
}
function* mapEntries(source: readonly unknown[]): Generator<readonly [string, unknown]> {
    for (const [, pair] of arrayEntries(source)) {
        if (!Array.isArray(pair) || pair.length !== 2) throw new TypeError('Invalid load map entry');
        const key = Object.getOwnPropertyDescriptor(pair, 0), value = Object.getOwnPropertyDescriptor(pair, 1);
        if (!key || !value || !('value' in key) || !('value' in value) || typeof key.value !== 'string') throw new TypeError('Invalid load map entry');
        yield [key.value, value.value];
    }
}

/** One wire dialect for native/import projections. Raw lexemes are strings; only
 * explicitly tagged maps become Maps. Traversal is iterative even within a huge
 * rich-text record, and never materializes all keys or invokes a source getter. */
export async function transformLoadData(value: unknown, direction: 'encode' | 'decode',
    cooperate?: () => Promise<void>, signal?: AbortSignal): Promise<unknown> {
    const ancestors = new WeakSet<object>(), stack: Frame[] = [];
    let steps = 0, characters = 0, started = performance.now();
    const create = (input: unknown, depth: number): unknown => {
        if (++steps > SECURITY_LIMITS.fileBytes || depth > SECURITY_LIMITS.jsonDepth) throw new RangeError('Load projection exceeds its structural budget');
        if (input === null || typeof input === 'boolean') return input;
        if (typeof input === 'string') {
            if (input.length > SECURITY_LIMITS.fileBytes - characters) throw new RangeError('Load projection exceeds its character budget');
            characters += input.length;
            return input;
        }
        if (typeof input === 'number' && Number.isFinite(input)) return input;
        if (!input || typeof input !== 'object' || ancestors.has(input)) throw new TypeError('Load data must be an acyclic inert value');
        const array = Array.isArray(input), map = input instanceof Map, prototype = Object.getPrototypeOf(input);
        if (map ? direction !== 'encode' : array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new TypeError('Unsupported load data object');
        let target: Container, entries: Iterator<readonly [string | number, unknown]>, result: unknown;
        if (map) {
            const pairs: unknown[] = [];
            target = pairs;
            entries = (function* () {
                let i = 0;
                for (const [key, child] of input as Map<unknown, unknown>) {
                    if (typeof key !== 'string') throw new TypeError('Model map key must be a string');
                    yield [i++, [key, child]] as const;
                }
            })();
            result = { [MAP]: pairs };
        } else if (array) {
            target = []; entries = arrayEntries(input); result = target;
        } else if (direction === 'decode' && Object.hasOwn(input, MAP)) {
            const descriptor = Object.getOwnPropertyDescriptor(input, MAP);
            if (!descriptor || !('value' in descriptor) || !Array.isArray(descriptor.value)) throw new TypeError('Invalid tagged load map');
            for (const [key] of properties(input)) if (key !== MAP) throw new TypeError('Invalid tagged load map');
            target = new Map(); entries = mapEntries(descriptor.value); result = target;
        } else {
            target = Object.create(null) as Record<string, unknown>;
            entries = properties(input); result = target;
        }
        ancestors.add(input);
        stack.push({ source: input, target, entries, depth });
        return result;
    };
    signal?.throwIfAborted();
    const root = create(value, 0);
    let advances = 0;
    while (stack.length) {
        if ((++advances & 255) === 0 && performance.now() - started >= 3) {
            signal?.throwIfAborted(); await cooperate?.(); signal?.throwIfAborted(); started = performance.now();
        }
        const frame = stack[stack.length - 1], next = frame.entries.next();
        if (next.done) { ancestors.delete(frame.source); stack.pop(); continue; }
        const [key, child] = next.value;
        if (child === undefined && !Array.isArray(frame.target) && !(frame.target instanceof Map)) continue;
        if (direction === 'encode' && !Array.isArray(frame.target) && !(frame.target instanceof Map) && key === MAP) throw new TypeError('Reserved projection key in model object');
        if (typeof key === 'string') {
            if (key.length > SECURITY_LIMITS.fileBytes - characters) throw new RangeError('Load projection exceeds its character budget');
            characters += key.length;
        }
        const decoded = create(child, frame.depth + 1);
        if (frame.target instanceof Map) {
            if (typeof key !== 'string' || frame.target.has(key)) throw new TypeError('Duplicate load map key');
            frame.target.set(key, decoded);
        } else if (Array.isArray(frame.target)) frame.target[Number(key)] = decoded;
        else frame.target[key] = decoded;
    }
    signal?.throwIfAborted();
    return root;
}

export async function encodeLoadData(value: unknown, cooperate?: () => Promise<void>, signal?: AbortSignal): Promise<JsonValue> {
    return await transformLoadData(value, 'encode', cooperate, signal) as JsonValue;
}
export async function decodeLoadData(value: JsonValue, cooperate?: () => Promise<void>, signal?: AbortSignal): Promise<unknown> {
    return transformLoadData(value, 'decode', cooperate, signal);
}
