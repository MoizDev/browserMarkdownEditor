import { Sha256 } from '../../utils/sha256';
import type { AttachmentInput } from './protocol';

const FENCE = '{"document":{"schema":{"schemaVersion":999},"store":{}},"fence":"compat-1: compatibility fence, holds no content, so that builds of this app from before the guard release refuse to edit this file"}';
const MAX_ATTACHMENTS = 100_000;
const HASH = /^[0-9a-f]{64}$/;

/** The PDF marker is a format declaration, not an AFRelationship value. */
export function attachmentMarker(role: Exclude<AttachmentInput['role'], 'unknown'>, format: string): string {
    if (!format || format.length > 128) throw new Error('Invalid attachment format identifier');
    let encoded: string;
    try { encoded = encodeURIComponent(format); } catch { throw new Error('Invalid attachment format identifier'); }
    const marker = `local-vault-pdf/v1;role=${role};format=${encoded}`;
    if (marker.length > 256) throw new RangeError('Attachment marker is too long');
    return marker;
}

async function blobHash(blob: Blob, cooperate: () => Promise<void>): Promise<string> {
    const hash = new Sha256(), reader = blob.stream().getReader();
    try {
        for (;;) {
            await cooperate();
            const next = await reader.read();
            if (next.done) break;
            hash.update(next.value);
        }
        return hash.digest();
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Checks a frozen input before native attachment mutation. Unknown files retain
 * their own metadata and are never assigned an app marker by this writer. */
export async function validateBoardAttachments(attachments: readonly AttachmentInput[], format: string,
    cooperate: () => Promise<void>): Promise<void> {
    if (!Array.isArray(attachments) || attachments.length > MAX_ATTACHMENTS || !format) throw new Error('Invalid board attachment set');
    const seen = new Set<string>();
    let board = 0, fence = 0;
    for (const entry of attachments) {
        if (!entry || typeof entry.name !== 'string' || !entry.name || entry.name.includes('\0') ||
            !(entry.bytes instanceof Blob) || !HASH.test(entry.sha256)) throw new Error('Invalid attachment');
        const identity = `${entry.name}\0${entry.sha256}`;
        if (seen.has(identity)) throw new Error('Duplicate attachment');
        seen.add(identity);
        if (entry.role !== 'unknown') {
            if (entry.format !== format) throw new Error('Attachment format does not match the board');
            attachmentMarker(entry.role, format);
        }
        switch (entry.role) {
            case 'editable': if (entry.name !== 'board.json' || ++board !== 1) throw new Error('Invalid editable board attachment'); break;
            case 'fence':
                if (entry.name !== 'tldraw-snapshot.json' || ++fence !== 1 || entry.bytes.size !== new TextEncoder().encode(FENCE).length || await entry.bytes.text() !== FENCE) throw new Error('Invalid compatibility fence');
                break;
            case 'media':
                if (!new RegExp(`^board-media/${entry.sha256}\\.[a-zA-Z0-9]{1,16}$`).test(entry.name)) throw new Error('Invalid board media name');
                break;
            case 'pristine': throw new Error('Pristine bytes are supplied by the writer source');
            case 'notebook-source': throw new Error('Notebook pointers do not belong to annotated boards');
            case 'write-mark': throw new Error('The write mark is owned by the PDF writer');
            case 'unknown': break;
            default: throw new Error('Unknown attachment role');
        }
        if (await blobHash(entry.bytes, cooperate) !== entry.sha256) throw new Error('Attachment bytes differ from their fingerprint');
    }
    if (board !== 1 || fence !== 1) throw new Error('Editable board and compatibility fence are required');
}
