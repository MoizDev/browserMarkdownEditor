import type { BoardAssetAccess, FileSystemContextValue } from '../types';
import { hashBytes } from './diskVersion';

/** App-owned session identity: a rename, vault activation or closed/replaced
 * tab retires this bridge, rather than redirecting an in-flight write. */
export interface BoardMediaOwner {
    documentId: string;
    vaultActivation: number;
    root: FileSystemDirectoryHandle;
    parent: FileSystemDirectoryHandle;
    owner: FileSystemFileHandle;
    lifetime: AbortSignal;
    isCurrent: (documentId: string, vaultActivation: number) => boolean;
}

export interface BoardMediaDescriptor {
    id: string;
    mime: string;
    file: string | null;
}

export interface PdfMediaStaging {
    /** The session owns the immutable Blob and its document/history/job leases. */
    stage: (id: string, blob: Blob, signal: AbortSignal) => Promise<void>;
    read: (id: string, signal: AbortSignal) => Promise<Blob | null>;
}

const EXTENSIONS: Readonly<Record<string, string>> = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
    'image/avif': 'avif', 'image/svg+xml': 'svg', 'video/mp4': 'mp4',
    'video/webm': 'webm', 'video/quicktime': 'mov',
};

/** The host passes this to the media ingestor, retaining the same owner for
 * every asynchronous operation. PDF blobs stay in the session; only its
 * pinned save revision may turn them into attachments. */
export function createBoardMediaBridge(
    io: Pick<FileSystemContextValue, 'readBoardAsset' | 'putBoardAsset'>,
    owner: BoardMediaOwner,
    pdf?: PdfMediaStaging,
) {
    const isCurrent = () => !owner.lifetime.aborted && owner.isCurrent(owner.documentId, owner.vaultActivation);
    const request = (entry: BoardMediaDescriptor, signal: AbortSignal): BoardAssetAccess => {
        if (!/^sha256:[a-f0-9]{64}$/.test(entry.id) || !Object.hasOwn(EXTENSIONS, entry.mime)) {
            throw new Error('Invalid board media descriptor');
        }
        const combined = AbortSignal.any([owner.lifetime, signal]);
        combined.throwIfAborted();
        if (!isCurrent()) throw new DOMException('Board session ended', 'AbortError');
        return { root: owner.root, parent: owner.parent, owner: owner.owner, hash: entry.id.slice(7),
            preferredName: entry.file, signal: combined, isCurrent };
    };
    const assertCurrent = (signal: AbortSignal) => {
        signal.throwIfAborted();
        if (!isCurrent()) throw new DOMException('Board session ended', 'AbortError');
    };
    return {
        isCurrent,
        async storeMedia(entry: BoardMediaDescriptor, blob: Blob, signal: AbortSignal): Promise<string | null> {
            const access = request(entry, signal);
            if (!pdf) return io.putBoardAsset({ ...access, blob, extension: EXTENSIONS[entry.mime] });
            if (await hashBytes(await blob.arrayBuffer()) !== access.hash) throw new Error('Board media hash mismatch');
            assertCurrent(access.signal);
            await pdf.stage(entry.id, blob, access.signal);
            assertCurrent(access.signal);
            return null;
        },
        async readMedia(entry: BoardMediaDescriptor, signal: AbortSignal): Promise<Blob | null> {
            const access = request(entry, signal);
            const blob = pdf ? await pdf.read(entry.id, access.signal) : (await io.readBoardAsset(access))?.blob ?? null;
            assertCurrent(access.signal);
            if (blob && await hashBytes(await blob.arrayBuffer()) !== access.hash) throw new Error('Board media hash mismatch');
            assertCurrent(access.signal);
            return blob;
        },
    };
}
