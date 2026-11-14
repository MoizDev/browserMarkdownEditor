import { fenceBytes } from '../format/fence';
import { mediaExtension } from '../media/ingest';
import { hashMedia } from '../media/sha256';
import { MEDIA_MIMES, type MediaEntry, type MediaId, type MediaMime } from '../model/media';

export interface BoardPdfAttachment {
    readonly name: string;
    readonly role: 'editable' | 'fence' | 'media';
    readonly bytes: Uint8Array | Blob;
}

/** Snapshot media must be pinned by the caller until the assembler finishes. */
export async function pdfBoardAttachments(
    board: Uint8Array, media: Iterable<MediaEntry>, read: (id: MediaId) => Blob | undefined, signal: AbortSignal,
): Promise<BoardPdfAttachment[]> {
    signal.throwIfAborted();
    const attachments: BoardPdfAttachment[] = [
        { name: 'board.json', role: 'editable', bytes: board.slice() },
        { name: 'tldraw-snapshot.json', role: 'fence', bytes: fenceBytes() },
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
        attachments.push({ name: `board-media/${entry.id.slice(7)}.${mediaExtension(entry.mime as MediaMime)}`, role: 'media', bytes: blob });
    }
    signal.throwIfAborted();
    return attachments;
}
