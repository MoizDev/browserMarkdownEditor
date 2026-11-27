import { MEDIA_MIMES, type MediaEntry, type MediaId, type MediaMime } from '../model/media';
import { mediaExtension } from './ingest';

export class MissingMediaError extends Error {
    override readonly name = 'MissingMediaError';
    constructor(readonly id: MediaId, message: string) { super(message); }
}

export function isMissingMedia(error: unknown): error is MissingMediaError {
    return error instanceof MissingMediaError;
}

function expectedFile(entry: Pick<MediaEntry, 'id' | 'file' | 'mime'>): string | null {
    if (entry.file) return entry.file;
    return (MEDIA_MIMES as readonly string[]).includes(entry.mime) ? `${entry.id.slice(7)}.${mediaExtension(entry.mime as MediaMime)}` : null;
}

export function missingPictureSentence(entry: Pick<MediaEntry, 'id' | 'name' | 'file' | 'mime'>, consequence?: string): string {
    const file = expectedFile(entry);
    return `${entry.name ? `The picture “${entry.name}”` : 'A picture on this board'} is missing${consequence ? `, so ${consequence}` : ''}. `
        + (file ? `To bring it back, put its file in the .Assets folder beside this board, named ${file}, and reopen the board.`
            : 'To bring it back, put its file in the .Assets folder beside this board and reopen the board.');
}

export function missingFromExport(entry: Pick<MediaEntry, 'id' | 'name' | 'file' | 'mime'>): MissingMediaError {
    return new MissingMediaError(entry.id, missingPictureSentence(entry, 'the export shows a grey box where it sits'));
}
