// What the app last knew a document's file to be on disk — the baseline every
// document write is checked against (FileSystemContext.writeFileVersioned) and
// every outside-change check compares with (App.checkOpenDocs).
//
// The stat (lastModified, size) is the cheap first look; the hash of the raw
// bytes is the truth. A `touch`, or a `git checkout` writing identical bytes,
// moves the stat but not the hash, and must never raise a conflict. Hashing the
// RAW bytes (not the CRLF-normalized text) treats text and PDFs alike.

export interface DiskStat {
    lastModified: number;
    size: number;
}

export interface DiskVersion extends DiskStat {
    /** SHA-256 of the file's raw bytes, lowercase hex. */
    hash: string;
}

/** SHA-256 hex of raw bytes (crypto.subtle: off the main thread's JS, and a
 *  100 MB PDF hashes in well under a second). */
export async function hashBytes(bytes: ArrayBuffer | Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
    const view = new Uint8Array(digest);
    let hex = '';
    for (let i = 0; i < view.length; i++) hex += view[i].toString(16).padStart(2, '0');
    return hex;
}

/** Whether a fresh stat is the one recorded — the echo of the app's own write,
 *  or nothing happened. A different stat is only a reason to hash. */
export function sameStat(a: DiskStat | null | undefined, b: DiskStat | null | undefined): boolean {
    return !!a && !!b && a.lastModified === b.lastModified && a.size === b.size;
}
