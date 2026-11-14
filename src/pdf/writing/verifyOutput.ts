import { Sha256 } from '../../utils/sha256';
import { validateBoardWriteIdentity } from './boardIdentity';
import { attachmentMarker } from './attachments';
import { validNotebookSourcePath } from './notebookPointer';
import type { WriterOperations } from './protocol';

type VerifiedOperation = 'writer.finishAnnotated' | 'writer.buildNotebook';
const MARK = new TextEncoder().encode('VaultWriteMark/');
const V2 = new TextEncoder().encode('VaultWriteMark/2 sha256=');
const ID_HEADER = new TextEncoder().encode(' writeId=');
const ZERO_DIGEST = new Uint8Array(64).fill(0x30);
const CHUNK = 256 * 1024;
const HASH = /^[0-9a-f]{64}$/;
const ID = /^[0-9a-f]{32}$/;

function matches(bytes: Uint8Array, offset: number, expected: Uint8Array): boolean {
    if (offset < 0 || offset + expected.length > bytes.length) return false;
    for (let index = 0; index < expected.length; index++) if (bytes[offset + index] !== expected[index]) return false;
    return true;
}

/** Yield between bounded chunks so cancellation is observable without copying the output. */
async function cooperate(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await new Promise<void>(resolve => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
        channel.port2.postMessage(0);
    });
    signal?.throwIfAborted();
}

async function verifyMark(bytes: Uint8Array, writeId: string, signal?: AbortSignal): Promise<void> {
    let mark = -1;
    for (let end = bytes.length - MARK.length + 1; end > 0 && mark < 0;) {
        const start = Math.max(0, end - CHUNK);
        for (let index = end - 1; index >= start; index--) {
            if (bytes[index] === MARK[0] && matches(bytes, index, MARK)) { mark = index; break; }
        }
        end = start;
        await cooperate(signal);
    }
    if (mark < 0 || !matches(bytes, mark, V2)) throw new Error('PDF output has no supported final write mark');
    const start = mark + V2.length, end = start + ZERO_DIGEST.length;
    const idStart = end + ID_HEADER.length, idEnd = idStart + 32;
    if (idEnd > bytes.length || !matches(bytes, end, ID_HEADER)) throw new Error('PDF output write mark is malformed');
    const expected = String.fromCharCode(...bytes.subarray(start, end));
    const actualId = String.fromCharCode(...bytes.subarray(idStart, idEnd));
    if (!/^[0-9a-fA-F]{64}$/.test(expected) || actualId !== writeId ||
        (idEnd < bytes.length && ![0, 9, 10, 12, 13, 32, 41].includes(bytes[idEnd]))) {
        throw new Error('PDF output write identity does not match');
    }
    const hash = new Sha256();
    for (let offset = 0; offset < bytes.length; offset += CHUNK) {
        signal?.throwIfAborted();
        const limit = Math.min(bytes.length, offset + CHUNK);
        if (offset < end && limit > start) {
            const before = Math.max(offset, Math.min(start, limit)), after = Math.min(limit, Math.max(end, offset));
            hash.update(bytes.subarray(offset, before));
            hash.update(ZERO_DIGEST.subarray(Math.max(0, offset - start), Math.min(64, limit - start)));
            hash.update(bytes.subarray(after, limit));
        } else hash.update(bytes.subarray(offset, limit));
        await cooperate(signal);
    }
    if (hash.digest() !== expected.toLowerCase()) throw new Error('PDF output write mark hash does not match');
}

async function verifyBoard(args: WriterOperations['writer.finishAnnotated']['args'], signal?: AbortSignal): Promise<void> {
    if (!Array.isArray(args.attachments)) throw new Error('Invalid frozen PDF board attachments');
    const boards = args.attachments.filter(entry => entry?.name === 'board.json' || entry?.role === 'editable');
    if (boards.length !== 1) throw new Error('PDF output requires one frozen editable board');
    const board = boards[0], format = board.format;
    if (board.name !== 'board.json' || board.role !== 'editable' || !(board.bytes instanceof Blob) ||
        typeof format !== 'string' || !format || !HASH.test(board.sha256)) throw new Error('Invalid frozen PDF board');
    attachmentMarker('editable', format);
    await validateBoardWriteIdentity(board.bytes, format, args.writeId, () => cooperate(signal));
    const reader = board.bytes.stream().getReader(), hash = new Sha256();
    try {
        for (;;) {
            await cooperate(signal);
            const chunk = await reader.read();
            signal?.throwIfAborted();
            if (chunk.done) break;
            for (let offset = 0; offset < chunk.value.length; offset += CHUNK) {
                hash.update(chunk.value.subarray(offset, offset + CHUNK));
                await cooperate(signal);
            }
        }
        if (hash.digest() !== board.sha256) throw new Error('Frozen PDF board fingerprint does not match');
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Called by the privileged host after wire-shape checks and before any disk write.
 * The fresh-notebook route has no write mark: its native worker verifies the
 * pointer on reopen, so the host checks only identities and the byte envelope. */
export async function verifyPdfWriterOutput<K extends VerifiedOperation>(op: K, args: WriterOperations[K]['args'],
    result: WriterOperations[K]['result'], signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!args || !result || !Number.isSafeInteger(args.revision) || args.revision < 0 ||
        typeof args.writeId !== 'string' || !ID.test(args.writeId) || result.revision !== args.revision || result.writeId !== args.writeId ||
        !(result.bytes instanceof ArrayBuffer) || result.bytes.byteLength < 8 || result.bytes.byteLength >= 0x80000000) {
        throw new Error('Invalid PDF writer output identity');
    }
    const bytes = new Uint8Array(result.bytes);
    if (!matches(bytes, 0, new TextEncoder().encode('%PDF-'))) throw new Error('PDF writer returned invalid output bytes');
    if (op === 'writer.finishAnnotated') {
        await verifyBoard(args as WriterOperations['writer.finishAnnotated']['args'], signal);
        await verifyMark(bytes, args.writeId, signal);
    } else if (op === 'writer.buildNotebook') {
        const input = args as WriterOperations['writer.buildNotebook']['args'];
        if (input.displayListSchema !== 1 || !Array.isArray(input.pages) || !input.pages.length ||
            !input.notebookSource || !validNotebookSourcePath(input.notebookSource.path)) throw new Error('Invalid notebook export identity');
    } else throw new Error('Unsupported PDF writer output');
    signal?.throwIfAborted();
}
