// The mark travels with the PDF: a second browser needs no local ledger.
// This module is pure bytes/WebCrypto, shared by worker inspection and writing.
import { hashBytes } from './diskVersion';

const encoder = new TextEncoder();
const namespace = encoder.encode('VaultWriteMark/');
const header = encoder.encode('VaultWriteMark/1 sha256=');
const headerV2 = encoder.encode('VaultWriteMark/2 sha256=');
const idHeader = encoder.encode(' writeId=');
const DIGEST_LENGTH = 64;
export const PDF_WRITE_MARK_PLACEHOLDER = 'VaultWriteMark/1 sha256=' + '0'.repeat(DIGEST_LENGTH);

/** A write id is generated once per frozen board revision and covered by the digest. */
export function pdfWriteMarkV2Placeholder(writeId: string): string {
    if (!/^[0-9a-f]{32}$/.test(writeId)) throw new Error('Invalid PDF write id');
    return 'VaultWriteMark/2 sha256=' + '0'.repeat(DIGEST_LENGTH) + ' writeId=' + writeId;
}

export type PdfWriteMarkCheck =
    | { kind: 'verified'; writeId?: string }
    | { kind: 'missing' }
    | { kind: 'foreign'; reason: 'mismatch' | 'unsupported' | 'malformed' };

function matches(bytes: Uint8Array, offset: number, expected: Uint8Array): boolean {
    if (offset < 0 || offset + expected.length > bytes.length) return false;
    for (let i = 0; i < expected.length; i++) if (bytes[offset + i] !== expected[i]) return false;
    return true;
}

function lastMark(bytes: Uint8Array): number {
    // Do not decode an entire textbook into a second enormous string. Earlier
    // literal marker text is ordinary content, covered by the LAST mark's hash.
    for (let i = bytes.length - namespace.length; i >= 0; i--) {
        if (bytes[i] === namespace[0] && matches(bytes, i, namespace)) return i;
    }
    return -1;
}

/** Exact-byte provenance only, never permission to skip a versioned write. */
export async function checkPdfWriteMark(bytes: Uint8Array): Promise<PdfWriteMarkCheck> {
    const mark = lastMark(bytes);
    if (mark < 0) return { kind: 'missing' };
    const version = matches(bytes, mark, header) ? 1 : matches(bytes, mark, headerV2) ? 2 : 0;
    if (!version) return { kind: 'foreign', reason: 'unsupported' };
    const start = mark + (version === 1 ? header.length : headerV2.length), end = start + DIGEST_LENGTH;
    if (end > bytes.length) return { kind: 'foreign', reason: 'malformed' };
    const expected = String.fromCharCode(...bytes.subarray(start, end));
    if (!/^[0-9a-fA-F]{64}$/.test(expected)) return { kind: 'foreign', reason: 'malformed' };
    let writeId: string | undefined;
    if (version === 2) {
        const idStart = end + idHeader.length, idEnd = idStart + 32;
        if (!matches(bytes, end, idHeader) || idEnd > bytes.length) return { kind: 'foreign', reason: 'malformed' };
        writeId = String.fromCharCode(...bytes.subarray(idStart, idEnd));
        // PDFium's public attachment API writes the mark as a literal string
        // in /Params, so ')' is also a valid terminator after the write id.
        if (!/^[0-9a-f]{32}$/.test(writeId) || (idEnd < bytes.length && ![0, 9, 10, 12, 13, 32, 41].includes(bytes[idEnd]))) return { kind: 'foreign', reason: 'malformed' };
    }
    const zeroed = bytes.slice();
    zeroed.fill(0x30, start, end);
    return await hashBytes(zeroed) === expected.toLowerCase()
        ? { kind: 'verified', ...(writeId ? { writeId } : {}) }
        : { kind: 'foreign', reason: 'mismatch' };
}

/** A board can only claim an outer PDF bearing its exact v2 write identity. */
export async function checkPdfWriteMarkForBoard(bytes: Uint8Array, writeId: string): Promise<PdfWriteMarkCheck> {
    if (!/^[0-9a-f]{32}$/.test(writeId)) return { kind: 'foreign', reason: 'malformed' };
    const check = await checkPdfWriteMark(bytes);
    if (check.kind !== 'verified') return check.kind === 'missing' ? { kind: 'foreign', reason: 'unsupported' } : check;
    return check.writeId === writeId ? check : { kind: 'foreign', reason: 'mismatch' };
}

/** Worker-owned serialized bytes, with the newest raw stream still zeroed. */
export async function sealPdfWriteMark(bytes: Uint8Array): Promise<Uint8Array> {
    const mark = lastMark(bytes);
    const prefix = matches(bytes, mark, header) ? header : matches(bytes, mark, headerV2) ? headerV2 : null;
    const start = mark + (prefix?.length ?? 0);
    if (mark < 0 || !prefix ||
        !matches(bytes, start, encoder.encode('0'.repeat(DIGEST_LENGTH)))) {
        throw new Error('The PDF write mark placeholder was not the last mark in the output. Nothing was saved.');
    }
    bytes.set(encoder.encode(await hashBytes(bytes)), start);
    // An output which cannot verify is a writer fault, never a successful file
    // that would ask its own author about a foreign edit on the next open.
    if (lastMark(bytes) !== mark || (await checkPdfWriteMark(bytes)).kind !== 'verified') {
        throw new Error('The PDF write mark could not be verified. Nothing was saved.');
    }
    return bytes;
}
