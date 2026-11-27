/*
 * Length-only LZ-String scan follows lz-string 1.5.0 libs/lz-string.js
 * _decompress, SHA-256 550034b821027008776cb9bcd1700bb5d31e8b3de224cb130fc966a75dab0e5e.
 * No tldraw-authored source was read or used.
 *
 * MIT License — Copyright (c) 2013 pieroxy
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { decompressFromBase64 } from 'lz-string';
import type { WorkerContext } from '../../platform/workers';
import { parseJsonIncremental, type JsonSpan } from '../format/jsonRead';
import { SECURITY_LIMITS } from '../security/limits';

export const LEGACY_CLIPBOARD_INPUT_LIMIT = 16_777_216;
export const LEGACY_CLIPBOARD_OUTPUT_LIMIT = 33_554_432;
const ENVELOPE_LIMIT = SECURITY_LIMITS.clipboardHtmlBytes;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

async function predictedLength(encoded: string, context: WorkerContext): Promise<number> {
    if (!encoded.length || encoded.length > LEGACY_CLIPBOARD_INPUT_LIMIT || encoded.length % 4 !== 0) throw new RangeError('Invalid legacy compressed length');
    let end = encoded.length;
    while (end && encoded.charCodeAt(end - 1) === 61) end--;
    if (!end || encoded.length - end > 3) throw new TypeError('Invalid legacy base64 padding');
    for (let i = 0; i < end; i++) {
        if (ALPHABET.indexOf(encoded[i]) < 0) throw new TypeError('Invalid legacy base64');
        if ((i & 4095) === 4095) { context.signal.throwIfAborted(); await context.slice(); }
    }
    let bitPosition = 0;
    const bits = (width: number): number => {
        if (width > 30 || bitPosition + width > end * 6) throw new TypeError('Truncated legacy compressed data');
        let value = 0, power = 1;
        for (let i = 0; i < width; i++) {
            const bit = bitPosition++, symbol = ALPHABET.indexOf(encoded[Math.floor(bit / 6)]);
            if (symbol & (32 >> (bit % 6))) value += power;
            power *= 2;
        }
        return value;
    };
    const first = bits(2);
    if (first === 2) {
        const remaining = end * 6 - bitPosition;
        if (remaining > 6 || (remaining && bits(remaining) !== 0)) throw new TypeError('Invalid legacy compressed trailing data');
        return 0;
    }
    if (first !== 0 && first !== 1) throw new TypeError('Invalid legacy first code');
    bits(first === 0 ? 8 : 16);
    const lengths = new Uint32Array(Math.min(2 * LEGACY_CLIPBOARD_OUTPUT_LIMIT + 4, 4 * end + 8));
    lengths[3] = 1;
    let dictionarySize = 4, bitsPerCode = 3, enlarge = 4, previous = 1, total = 1, work = 0;
    for (;;) {
        let code = bits(bitsPerCode);
        if (code === 2) break;
        if (code === 0 || code === 1) {
            bits(code === 0 ? 8 : 16);
            if (dictionarySize >= lengths.length) throw new RangeError('Legacy dictionary exceeds bounds');
            lengths[dictionarySize] = 1; code = dictionarySize++; enlarge--;
        }
        if (enlarge === 0) { enlarge = 2 ** bitsPerCode; bitsPerCode++; }
        const entry = code < dictionarySize ? lengths[code] : code === dictionarySize ? previous + 1 : 0;
        if (!entry) throw new TypeError('Invalid legacy dictionary code');
        if (entry > LEGACY_CLIPBOARD_OUTPUT_LIMIT - total) throw new RangeError('Legacy clipboard decompressed size exceeds limits');
        total += entry;
        if (dictionarySize >= lengths.length) throw new RangeError('Legacy dictionary exceeds bounds');
        lengths[dictionarySize++] = previous + 1; enlarge--;
        previous = entry;
        if (enlarge === 0) { enlarge = 2 ** bitsPerCode; bitsPerCode++; }
        if ((++work & 4095) === 0) { context.signal.throwIfAborted(); await context.slice(); }
    }
    const remaining = end * 6 - bitPosition;
    if (remaining > 6 || (remaining && bits(remaining) !== 0)) throw new TypeError('Invalid legacy compressed trailing data');
    return total;
}
async function fields(span: JsonSpan, allowed: readonly string[], context: WorkerContext): Promise<Map<string, JsonSpan>> {
    if (span.kind !== 'object') throw new TypeError('Legacy clipboard object required');
    const values = new Map<string, JsonSpan>();
    for await (const [key, value] of span.fieldsIncremental(context.slice)) {
        if (!allowed.includes(key) || values.has(key)) throw new TypeError('Unknown or duplicate legacy clipboard field');
        values.set(key, value);
    }
    return values;
}
async function arraySize(span: JsonSpan | undefined, context: WorkerContext, limit: number): Promise<number> {
    if (!span || span.kind !== 'array') throw new TypeError('Legacy clipboard array required');
    let count = 0;
    for await (const item of span.itemsIncremental(context.slice)) {
        if (item.kind !== 'object') throw new TypeError('Legacy clipboard record must be an object');
        if (++count > limit) throw new RangeError('Legacy clipboard record count exceeds limits');
        if ((count & 255) === 0) { context.signal.throwIfAborted(); await context.slice(); }
    }
    return count;
}
export type LegacyClipboardReply =
    | { readonly status: 'unsupported' }
    | { readonly status: 'decoded'; readonly content: Blob; readonly assets: Blob; readonly decodedUnits: number; readonly shapes: number; readonly bindings: number; readonly assetCount: number };
export async function legacyClipboard(payload: unknown, context: WorkerContext): Promise<LegacyClipboardReply> {
    if (!payload || typeof payload !== 'object') throw new TypeError('Invalid legacy clipboard request');
    const { envelope } = payload as { envelope?: unknown };
    if (!(envelope instanceof Blob) || (typeof File !== 'undefined' && envelope instanceof File) || envelope.size > ENVELOPE_LIMIT) throw new TypeError('Expected copied legacy clipboard bytes');
    const input = new TextDecoder('utf-8', { fatal: true }).decode(await envelope.arrayBuffer()); context.signal.throwIfAborted();
    const outer = await parseJsonIncremental(input, context.slice), outerFields = await fields(outer, ['type', 'kind', 'version', 'data'], context);
    const type = outerFields.get('type'), kind = outerFields.get('kind'), version = outerFields.get('version');
    if (!type || type.kind !== 'string' || await type.stringIncremental(128, context.slice) !== 'application/tldraw') throw new TypeError('Not a legacy clipboard envelope');
    if (!kind || kind.kind !== 'string' || await kind.stringIncremental(128, context.slice) !== 'content'
        || !version || version.kind !== 'number' || version.number() !== 3) return { status: 'unsupported' };
    const data = outerFields.get('data');
    if (!data || data.kind !== 'object') return { status: 'unsupported' };
    let dataFields: Map<string, JsonSpan>;
    try { dataFields = await fields(data, ['assets', 'otherCompressed'], context); }
    catch (error) { context.signal.throwIfAborted(); if (error instanceof TypeError) return { status: 'unsupported' }; throw error; }
    const compressed = dataFields.get('otherCompressed'), assets = dataFields.get('assets');
    if (!compressed || compressed.kind !== 'string' || !assets || assets.kind !== 'array') return { status: 'unsupported' };
    const assetCount = await arraySize(assets, context, SECURITY_LIMITS.clipboardRecords);
    const encoded = await compressed.stringIncremental(LEGACY_CLIPBOARD_INPUT_LIMIT, context.slice);
    const expected = await predictedLength(encoded, context);
    context.signal.throwIfAborted();
    const decoded = decompressFromBase64(encoded);
    context.signal.throwIfAborted();
    if (typeof decoded !== 'string' || decoded.length !== expected || decoded.length > LEGACY_CLIPBOARD_OUTPUT_LIMIT) throw new TypeError('Invalid legacy compressed data');
    const content = await parseJsonIncremental(decoded, context.slice);
    if (content.kind !== 'object') throw new TypeError('Legacy clipboard content must be an object');
    let shapes: JsonSpan | undefined, bindings: JsonSpan | undefined;
    const seen = new Set<string>();
    for await (const [key, value] of content.fieldsIncremental(context.slice)) {
        if (seen.has(key)) throw new TypeError('Duplicate legacy content field'); seen.add(key);
        if (key === 'shapes') shapes = value; else if (key === 'bindings') bindings = value;
    }
    const shapeCount = await arraySize(shapes, context, SECURITY_LIMITS.clipboardNodes);
    const bindingCount = bindings === undefined ? 0 : await arraySize(bindings, context, SECURITY_LIMITS.clipboardRecords);
    const assetsText = await assets.textIncremental(context.slice);
    let nextYield = 4096;
    for (let i = 0; i < decoded.length; i++) {
        const unit = decoded.charCodeAt(i);
        if (unit >= 0xd800 && unit <= 0xdbff) {
            const low = decoded.charCodeAt(++i); if (!(low >= 0xdc00 && low <= 0xdfff)) throw new TypeError('Legacy JSON has an unpaired surrogate');
        } else if (unit >= 0xdc00 && unit <= 0xdfff) throw new TypeError('Legacy JSON has an unpaired surrogate');
        if (i >= nextYield) { nextYield = i + 4096; context.signal.throwIfAborted(); await context.slice(); }
    }
    context.signal.throwIfAborted();
    return { status: 'decoded', content: new Blob([decoded], { type: 'application/json' }), assets: new Blob([assetsText], { type: 'application/json' }),
        decodedUnits: decoded.length, shapes: shapeCount, bindings: bindingCount, assetCount };
}
