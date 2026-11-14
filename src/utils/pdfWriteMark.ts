// The mark travels with the PDF: a second browser needs no local ledger.
// This module is pure bytes/WebCrypto, shared by worker inspection and writing.
import { hashBytes } from './diskVersion';

const encoder = new TextEncoder();
const namespace = encoder.encode('VaultWriteMark/');
const header = encoder.encode('VaultWriteMark/1 sha256=');
const DIGEST_LENGTH = 64;
export const PDF_WRITE_MARK_PLACEHOLDER = 'VaultWriteMark/1 sha256=' + '0'.repeat(DIGEST_LENGTH);

export type PdfWriteMarkCheck =
    | { kind: 'verified' }
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
    if (!matches(bytes, mark, header)) return { kind: 'foreign', reason: 'unsupported' };
    const start = mark + header.length, end = start + DIGEST_LENGTH;
    if (end > bytes.length) return { kind: 'foreign', reason: 'malformed' };
    const expected = String.fromCharCode(...bytes.subarray(start, end));
    if (!/^[0-9a-fA-F]{64}$/.test(expected)) return { kind: 'foreign', reason: 'malformed' };
    const zeroed = bytes.slice();
    zeroed.fill(0x30, start, end);
    return await hashBytes(zeroed) === expected.toLowerCase()
        ? { kind: 'verified' }
        : { kind: 'foreign', reason: 'mismatch' };
}

/** Worker-owned serialized bytes, with the newest raw stream still zeroed. */
export async function sealPdfWriteMark(bytes: Uint8Array): Promise<Uint8Array> {
    const mark = lastMark(bytes), start = mark + header.length;
    if (mark < 0 || !matches(bytes, mark, header) ||
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
