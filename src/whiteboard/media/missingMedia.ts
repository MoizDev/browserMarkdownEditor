import type { MediaEntry, MediaId } from '../model/media';

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

/** What an export says, once, when it draws a missing picture's placeholder. */
export function missingFromExport(entry: Pick<MediaEntry, 'id' | 'name' | 'file'>): MissingMediaError {
    return new MissingMediaError(entry.id, `${entry.name ? `“${entry.name}”` : 'A picture'} is not in the .Assets folder beside this board, `
        + `so the export shows a grey box where it sits${entry.file ? ` (its file is ${entry.file})` : ''}.`);
}
