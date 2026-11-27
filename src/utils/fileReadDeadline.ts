export const FILE_ANSWER_MS = 10_000;
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

export function byteReadMs(size: number): number {
    return FILE_ANSWER_MS + size / SLOWEST_BYTES_PER_MS;
}

export function withinFileDeadline<T>(work: Promise<T>, name: string, ms = FILE_ANSWER_MS): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
        work,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(fileReadTimeout(name)), ms); }),
    ]).finally(() => clearTimeout(timer));
}
