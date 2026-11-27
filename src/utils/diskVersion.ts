export interface DiskStat {
    lastModified: number;
    size: number;
}

export interface DiskVersion extends DiskStat {
    hash: string;
}

export async function hashBytes(bytes: ArrayBuffer | Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
    const view = new Uint8Array(digest);
    let hex = '';
    for (let i = 0; i < view.length; i++) hex += view[i].toString(16).padStart(2, '0');
    return hex;
}

export function sameStat(a: DiskStat | null | undefined, b: DiskStat | null | undefined): boolean {
    return !!a && !!b && a.lastModified === b.lastModified && a.size === b.size;
}

export function decodeDocumentText(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    if ((bytes[0]===0x50 && bytes[1]===0x4b && [3,5,7].includes(bytes[2])) ||
        (bytes[0]===0x25 && bytes[1]===0x50 && bytes[2]===0x44 && bytes[3]===0x46) || bytes.includes(0)) {
        throw new Error('This file contains binary data. Open it with its original document extension.');
    }
    try { return new TextDecoder('utf-8', {fatal:true}).decode(buffer); }
    catch { throw new Error('This file is not valid UTF-8 text. Its source has not been changed.'); }
}
