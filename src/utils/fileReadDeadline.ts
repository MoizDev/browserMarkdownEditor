// A read of one of the vault's files that does not answer is reported as such, instead of being waited on forever.
//
// `getFile()` and the byte read behind it have no deadline of their own, and on a file a cloud client has not
// downloaded yet (iCloud "Optimise storage", OneDrive/Dropbox on-demand), a network share or a sleeping disk they can
// simply never settle. Measured with an injected never-settling `getFile()`: one such note on reload brought back no
// tab at all, one such board sat on "Preparing canvas…" for good, and clicking one in the tree did nothing. The read
// functions in FileSystemContext reject with this instead, and every reader — the opener, the session restore, a
// canvas acquisition — gets the same distinct, retryable outcome (`isFileReadTimeout`). The read itself is left to
// finish or not: the platform offers no way to cancel it.

/** How long the file has to start answering (`getFile()`), and the floor for reading its bytes. */
export const FILE_ANSWER_MS = 10_000;
/** The byte read's allowance grows with the file at this slowest acceptable rate (bytes per ms ≈ 1 MB/s). */
const SLOWEST_BYTES_PER_MS = 1000;

export function fileReadTimeout(name: string): DOMException {
    return new DOMException(
        `“${name}” did not answer within ${FILE_ANSWER_MS / 1000} seconds. It may still be downloading from a cloud folder, or be on a disk or network share that is not available right now.`,
        'TimeoutError',
    );
}

export function isFileReadTimeout(error: unknown): boolean {
    return error instanceof DOMException && error.name === 'TimeoutError';
}

/** The deadline for reading `size` bytes once the file has answered. */
export function byteReadMs(size: number): number {
    return FILE_ANSWER_MS + size / SLOWEST_BYTES_PER_MS;
}

/** `work`, or a `fileReadTimeout(name)` rejection after `ms`. */
export function withinFileDeadline<T>(work: Promise<T>, name: string, ms = FILE_ANSWER_MS): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
        work,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(fileReadTimeout(name)), ms); }),
    ]).finally(() => clearTimeout(timer));
}
