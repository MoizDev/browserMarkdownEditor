import { parseJson } from '../../whiteboard/format/jsonRead';
import type { JsonSpan } from '../../whiteboard/format/jsonRead';

const MAX_LINE_BYTES = 64 * 1024 * 1024;

function sameJson(a: JsonSpan, b: JsonSpan): boolean {
    if (a.kind !== b.kind) return false;
    if (a.kind === 'object') {
        const left = a.fieldMap(), right = b.fieldMap();
        return left.size === right.size && [...left].every(([key, value]) => {
            const other = right.get(key); return !!other && sameJson(value, other);
        });
    }
    if (a.kind === 'array') {
        const left = [...a.items()], right = [...b.items()];
        return left.length === right.length && left.every((value, index) => sameJson(value, right[index]));
    }
    return Object.is(a.value(), b.value());
}

export async function validateBoardWriteIdentity(blob: Blob, format: string, writeId: string,
    cooperate: () => Promise<void>, expectedHostLine?: string): Promise<void> {
    const reader = blob.stream().getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
    let parts: Uint8Array[] = [], size = 0, first = true, found = false;
    const accept = (line: string): boolean => {
        if (first) {
            first = false;
            if (!line.endsWith('[')) throw new Error('Invalid native board envelope');
            const header: unknown = JSON.parse(line + ']}');
            if (!header || typeof header !== 'object' || (header as { format?: unknown }).format !== format ||
                (header as { kind?: unknown }).kind !== 'pdf-ink' || !Array.isArray((header as { version?: unknown }).version) ||
                ((header as { version: unknown[] }).version)[0] !== 1) throw new Error('Unsupported PDF board format');
            return false;
        }
        const text = line.trim();
        if (text === ']}') return true;
        const value: unknown = JSON.parse(text.endsWith(',') ? text.slice(0, -1) : text);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid native board record');
        const record = value as { type?: unknown; pdf?: unknown };
        if (record.type !== 'host') return false;
        if (found || !record.pdf || typeof record.pdf !== 'object' || (record.pdf as { writeId?: unknown }).writeId !== writeId ||
            (expectedHostLine !== undefined && !sameJson(parseJson(text.endsWith(',') ? text.slice(0, -1) : text), parseJson(expectedHostLine)))) {
            throw new Error('Board host identity does not match the PDF');
        }
        found = true;
        return true;
    };
    try {
        for (;;) {
            await cooperate();
            const chunk = await reader.read();
            if (chunk.done) break;
            let start = 0;
            for (let i = 0; i < chunk.value.length; i++) {
                if (chunk.value[i] !== 10) continue;
                const part = chunk.value.subarray(start, i);
                size += part.length;
                if (size > MAX_LINE_BYTES) throw new RangeError('Native board record is too large');
                parts.push(part);
                const line = new Uint8Array(size);
                let offset = 0;
                for (const piece of parts) { line.set(piece, offset); offset += piece.length; }
                parts = []; size = 0; start = i + 1;
                if (accept(decoder.decode(line))) {
                    if (!found) throw new Error('Native board has no PDF host identity');
                    return;
                }
            }
            const tail = chunk.value.subarray(start);
            size += tail.length;
            if (size > MAX_LINE_BYTES) throw new RangeError('Native board record is too large');
            if (tail.length) parts.push(tail);
        }
        throw new Error('Native board has no PDF host identity');
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function validateConvertedBoardHostIdentity(blob: Blob, format: string, writeId: string, encodedHost: string,
    cooperate: () => Promise<void>): Promise<void> {
    if (!encodedHost || encodedHost.length > MAX_LINE_BYTES) throw new Error('Invalid converted PDF host');
    await validateBoardWriteIdentity(blob, format, writeId, cooperate, encodedHost);
}
