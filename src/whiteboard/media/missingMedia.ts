import { MEDIA_MIMES, type MediaEntry, type MediaId, type MediaMime } from '../model/media';
import { mediaExtension } from './ingest';

/**
 * A picture this board names but whose bytes it does not have: its file was not in `.Assets` when the board opened (moved
 * without that folder, a sync not finished, deleted by hand). The board stays whole around it: the view and every export
 * draw its placeholder, the reference is kept exactly as written, and the person is told in plain words which file to put
 * back. Anything else that fails to give a picture's bytes (a mismatch, a refusal) is not this and stays an error.
 */
export class MissingMediaError extends Error {
    override readonly name = 'MissingMediaError';
    constructor(readonly id: MediaId, message: string) { super(message); }
}

export function isMissingMedia(error: unknown): error is MissingMediaError {
    return error instanceof MissingMediaError;
}

/** The exact name the picture's file must have in `.Assets`: the one its record names, else the content name a save gives it. */
function expectedFile(entry: Pick<MediaEntry, 'id' | 'file' | 'mime'>): string | null {
    if (entry.file) return entry.file;
    return (MEDIA_MIMES as readonly string[]).includes(entry.mime) ? `${entry.id.slice(7)}.${mediaExtension(entry.mime as MediaMime)}` : null;
}

/**
 * The one sentence every missing-picture message is built on: what the picture was called when it was added, and the exact
 * file name it needs beside the board. Naming both as if they were files sent people looking for "logo.png" when the board
 * reads `84804cc2…3615.png`.
 */
export function missingPictureSentence(entry: Pick<MediaEntry, 'id' | 'name' | 'file' | 'mime'>, consequence?: string): string {
    const file = expectedFile(entry);
    return `${entry.name ? `The picture “${entry.name}”` : 'A picture on this board'} is missing${consequence ? `, so ${consequence}` : ''}. `
        + (file ? `To bring it back, put its file in the .Assets folder beside this board, named ${file}, and reopen the board.`
            : 'To bring it back, put its file in the .Assets folder beside this board and reopen the board.');
}

/** What an export says, once, when it draws a missing picture's placeholder. */
export function missingFromExport(entry: Pick<MediaEntry, 'id' | 'name' | 'file' | 'mime'>): MissingMediaError {
    return new MissingMediaError(entry.id, missingPictureSentence(entry, 'the export shows a grey box where it sits'));
}
