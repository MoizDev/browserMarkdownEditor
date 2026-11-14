import { fenceBytes } from '../format/fence';
import { NATIVE_FORMAT_ID } from '../format/identity';
import { mediaExtension } from '../media/ingest';
import { hashMedia } from '../media/sha256';
import { MEDIA_MIMES, type MediaEntry, type MediaId, type MediaMime } from '../model/media';

export interface BoardPdfAttachment {
    readonly name: string;
    readonly role: 'editable' | 'fence' | 'media';
    readonly sha256: string;
    readonly format: typeof NATIVE_FORMAT_ID;
    readonly bytes: Blob;
}

/** Snapshot media must be pinned by the caller until the assembler finishes. */
export async function pdfBoardAttachments(
    board: Uint8Array, media: Iterable<MediaEntry>, read: (id: MediaId) => Blob | undefined, signal: AbortSignal,
): Promise<BoardPdfAttachment[]> {
    signal.throwIfAborted();
    const boardBlob = new Blob([Uint8Array.from(board)], { type: 'application/json' });
    const fenceBlob = new Blob([Uint8Array.from(fenceBytes())], { type: 'application/json' });
    const boardHash = await hashMedia(boardBlob, signal);
    const fenceHash = await hashMedia(fenceBlob, signal);
    const attachments: BoardPdfAttachment[] = [
        { name: 'board.json', role: 'editable', bytes: boardBlob, sha256: boardHash.slice(7), format: NATIVE_FORMAT_ID },
        { name: 'tldraw-snapshot.json', role: 'fence', bytes: fenceBlob, sha256: fenceHash.slice(7), format: NATIVE_FORMAT_ID },
    ];
    const seen = new Set<MediaId>();
    for (const entry of media) {
        signal.throwIfAborted();
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        if (!/^sha256:[0-9a-f]{64}$/.test(entry.id) || !(MEDIA_MIMES as readonly string[]).includes(entry.mime))
            throw new Error('Unsupported board media attachment');
        const blob = read(entry.id);
        if (!blob || blob.size !== entry.bytes || await hashMedia(blob, signal) !== entry.id)
            throw new Error('Board media is missing or has changed');
        attachments.push({ name: `board-media/${entry.id.slice(7)}.${mediaExtension(entry.mime as MediaMime)}`,
            role: 'media', bytes: blob, sha256: entry.id.slice(7), format: NATIVE_FORMAT_ID });
    }
    signal.throwIfAborted();
    return attachments;
}
