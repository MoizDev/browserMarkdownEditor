import type { WorkerContext } from '../../platform/workers';
import { readNative } from '../format/read';
import type { BoardDocInput } from '../model/doc';
import type { JsonObject, JsonValue } from '../model/json';
import type { LoadSampleWire } from '../model/loadTypes';
import type { ParseNativeReply, ParseNativeRequest, ParsedNativeDraft } from './nativeParseTypes';

type Frame = {
    readonly source: object;
    readonly output: Record<string, JsonValue> | JsonValue[];
    readonly iterator: Iterator<readonly [string | number, unknown]>;
    readonly map: boolean;
};

/** Projection is deliberately not admission: C5 revalidates and repairs these ordered records. */
async function project(value: unknown, context: WorkerContext): Promise<JsonValue> {
    const ancestors = new WeakSet<object>();
    const stack: Frame[] = [];
    function create(input: unknown): JsonValue {
        if (input === null || typeof input === 'string' || typeof input === 'boolean') return input;
        if (typeof input === 'number' && Number.isFinite(input)) return input;
        if (!input || typeof input !== 'object' || ancestors.has(input)) throw new TypeError('Invalid cyclic or non-data native draft');
        const array = Array.isArray(input), map = input instanceof Map;
        const prototype = Object.getPrototypeOf(input);
        if (!array && !map && prototype !== Object.prototype && prototype !== null) throw new TypeError('Unsupported native draft object');
        const output: Record<string, JsonValue> | JsonValue[] = array || map ? [] : Object.create(null) as Record<string, JsonValue>;
        let iterator: Iterator<readonly [string | number, unknown]>;
        if (array) iterator = input.entries();
        else if (map) iterator = input.entries() as Iterator<readonly [string, unknown]>;
        else {
            const keys = Object.keys(input);
            let index = 0;
            iterator = {
                next() {
                    if (index === keys.length) return { done: true, value: undefined };
                    const key = keys[index++], descriptor = Object.getOwnPropertyDescriptor(input, key);
                    if (!descriptor || !('value' in descriptor)) throw new TypeError('Native draft contains an accessor');
                    return { done: false, value: [key, descriptor.value] as const };
                },
            };
        }
        ancestors.add(input);
        stack.push({ source: input, output, iterator, map });
        return output;
    }
    const root = create(value);
    let started = performance.now(), steps = 0;
    while (stack.length) {
        const frame = stack[stack.length - 1], next = frame.iterator.next();
        if (next.done) { ancestors.delete(frame.source); stack.pop(); continue; }
        const [key, child] = next.value;
        if (frame.map) {
            if (typeof key !== 'string') throw new TypeError('Native draft map key is not a string');
            (frame.output as JsonValue[]).push([key, create(child)]);
        } else if (Array.isArray(frame.output)) {
            frame.output.push(create(child));
        } else if (child !== undefined) {
            frame.output[String(key)] = create(child);
        }
        if ((++steps & 255) === 0 && performance.now() - started >= 3) {
            await context.slice();
            started = performance.now();
        }
    }
    return root;
}
async function* blobBytes(blob: Blob): AsyncIterable<Uint8Array> {
    const reader = blob.stream().getReader();
    try {
        for (;;) { const next = await reader.read(); if (next.done) return; yield next.value; }
    } finally { reader.releaseLock(); }
}
function ordered(input: BoardDocInput): { sheets: unknown[]; nodes: unknown[]; media: unknown[] } {
    if (!Array.isArray(input.sheets) || (input.nodes !== undefined && !Array.isArray(input.nodes))
        || (input.media !== undefined && !Array.isArray(input.media))) throw new TypeError('Native parser returned an unordered draft');
    return { sheets: input.sheets, nodes: input.nodes ?? [], media: input.media ?? [] };
}
export async function parseNative(payload: unknown, context: WorkerContext): Promise<ParseNativeReply> {
    if (!payload || typeof payload !== 'object') throw new TypeError('Invalid native parse request');
    const request = payload as ParseNativeRequest;
    if (!(request.bytes instanceof Blob) || (typeof File !== 'undefined' && request.bytes instanceof File)) {
        throw new TypeError('Native parsing requires the opened bytes as a Blob, not a File');
    }
    const samples: LoadSampleWire[] = [];
    const result = await readNative(blobBytes(request.bytes), {
        byteLength: request.bytes.size, expectedKind: request.expectedKind, pdfPages: request.pdfPages,
        signal: context.signal, cooperate: () => context.slice(),
        admitEncoded(pts, header) {
            const workerRef = samples.length + 1;
            samples.push({ workerRef, pts, header });
            return workerRef;
        },
    });
    context.signal.throwIfAborted();
    if (!result.draft) return { ...result, draft: null };
    const draft = result.draft, input = draft.input, records = ordered(input);
    const wire: ParsedNativeDraft = {
        kind: input.kind,
        sheets: await project(records.sheets, context) as JsonObject[],
        nodes: await project(records.nodes, context) as JsonObject[],
        media: await project(records.media, context) as JsonObject[],
        ui: await project(input.ui, context) as JsonObject,
        view: await project(input.view, context) as JsonObject,
        host: await project(input.host, context) as JsonObject,
        preserved: await project(input.preserved, context) as JsonObject,
        preservedMediaRefs: await project(input.preservedMediaRefs, context) as unknown as readonly (readonly [string, number])[],
        samples,
        sources: draft.sources,
        unmapped: draft.unmapped,
        coldBounds: await project(draft.coldBounds, context) as unknown as ParsedNativeDraft['coldBounds'],
        ...(draft.savedView ? { savedView: draft.savedView } : {}),
    };
    return { ...result, draft: wire };
}
