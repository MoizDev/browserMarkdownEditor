import type { NativeCanvasHost, NativeCanvasIdentity } from '../../types/nativeCanvas';
import type { Op } from '../change/ops';
import type { MediaLocationWriter } from '../media/ingest';
import type { MediaStore } from '../media/store';
import { isSafeMediaFile } from '../model/media';
import type { BoardSession } from '../session/BoardSession';
import { createNativeMediaPorts } from './mediaPorts';
import { createMediaRestorePin } from './pinMediaRestore';

/** Bind restore work to the live board; the filesystem host retains write authority. */
export function createNativeMediaRestore(
    store: MediaStore, host: NativeCanvasHost, identity: NativeCanvasIdentity,
    currentBoard: () => BoardSession | undefined, locations: MediaLocationWriter,
) {
    const media = createNativeMediaPorts(host, identity);
    // Admission captures R0 while sealed read-only. Pin identity/revision here;
    // only restore and location edits require the separate live write permission.
    const current = (revision: number): BoardSession | undefined => {
        const live = host.identity(identity.documentId), board = currentBoard();
        if (!host.isCurrent(identity) || !live || live.session !== identity.session
            || live.vaultActivation !== identity.vaultActivation || live.bytesGeneration !== identity.bytesGeneration
            || live.kind !== identity.kind || !board
            || board.owner.documentId !== identity.documentId || board.owner.session !== identity.session) return undefined;
        // Non-dirtying commits (tool and UI state) advance doc.rev without changing the saved content, so the fence is content.
        return board.contentRevision === revision ? board : undefined;
    };
    return createMediaRestorePin(store, {
        referenced() {
            const board = currentBoard();
            if (!board) return [];
            return [...board.doc.media.values()].filter(entry => !!board.doc.mediaRefs.get(entry.id)?.size
                || (board.doc.preservedMediaRefs.get(entry.id) ?? 0) > 0);
        },
        isCurrent: revision => !!current(revision),
        async restore(entry, blob, signal) {
            signal.throwIfAborted();
            const board = currentBoard();
            if (!board || board.isReadOnly || !host.isCurrent(identity)) throw new DOMException('Board session ended', 'AbortError');
            const name = await media.restore(entry, blob, signal);
            signal.throwIfAborted();
            if (currentBoard() !== board || board.isReadOnly || !host.isCurrent(identity)) throw new DOMException('Board session ended', 'AbortError');
            return name;
        },
        updateFiles(changes, revision) {
            const board = current(revision);
            if (!board || board.isReadOnly || !host.canWrite(identity)
                || changes.some(change => !isSafeMediaFile(change.next) || board.doc.media.get(change.id)?.file !== change.expected)) return false;
            const ops: Op[] = changes.map(change => ({ t: 'media', op: 'set-file', id: change.id, file: change.next }));
            const applied = board.apply({ origin: 'host', label: 'Restore media', ops });
            applied.release();
            for (const change of changes) locations.setFile(change.id, change.next);
            return true;
        },
    });
}
