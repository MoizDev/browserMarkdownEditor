const COPY_CHUNK_BYTES = 4 * 1024 * 1024;

function aborted(): DOMException { return new DOMException('PDF acquisition cancelled', 'AbortError'); }

export async function stablePdfBlob(file: Blob, signal?: AbortSignal): Promise<Blob> {
    if (signal?.aborted) throw aborted();
    let result = new Blob([], { type: 'application/pdf' });
    for (let offset = 0; offset < file.size; offset += COPY_CHUNK_BYTES) {
        const end = Math.min(file.size, offset + COPY_CHUNK_BYTES);
        const bytes = await file.slice(offset, end).arrayBuffer();
        if (signal?.aborted) throw aborted();
        if (bytes.byteLength !== end - offset) throw new Error('The PDF snapshot could not be read completely.');
        result = new Blob([result, bytes], { type: 'application/pdf' });
    }
    return result;
}
