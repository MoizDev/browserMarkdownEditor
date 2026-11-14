const MAX_LINE_BYTES = 64 * 1024 * 1024;

/** Read only the native envelope and its ordered host record; drawing records
 * remain opaque to the PDF stream. This binds the board to the PDF-owned id. */
export async function validateBoardWriteIdentity(blob: Blob, format: string, writeId: string,
    cooperate: () => Promise<void>): Promise<void> {
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
        if (found || !record.pdf || typeof record.pdf !== 'object' || (record.pdf as { writeId?: unknown }).writeId !== writeId) throw new Error('Board write identity does not match the PDF');
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
