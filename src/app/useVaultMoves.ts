import { useCallback, useRef } from 'react';
import type { PendingRestore } from '../utils/pendingRestore';

/**
 * What keeps the vault's long-running mutations from interleaving — with each
 * other and with the session restore: the moves in flight, the restore's own
 * registry of documents it is still bringing back, and the one lock every
 * copy-then-delete over the vault takes (trash, the bin, a conversion restore,
 * a notebook export, a PDF's kept original).
 */
export function useVaultMoves() {
  /**
   * The documents that restore pass is bringing back, while it is (see
   * utils/pendingRestore). They are not in `tabsRef` until the merge, so
   * without this a rename, move or trash in the window never reached them:
   * the note came back under its old path with a dead handle, or came back out
   * of the Trash (issue #9). `retargetTabs`, `handleTrash` and the bin's
   * Replace update it synchronously beside their own tab fix-ups.
   */
  const restorePendingRef = useRef<PendingRestore | null>(null);
  /**
   * Every rename, move, trash and bin Replace still RUNNING, from its first
   * filesystem call to the end of its tab fix-up. Each is copy → removeEntry →
   * a full refreshTree walk → only then the fix-up, so for that whole span the
   * old entry is gone and nothing has re-pointed anything yet. The restore pass
   * waits for this to empty before its last re-validation and its merge.
   */
  const vaultMovesRef = useRef<Set<Promise<unknown>>>(new Set());
  const trackVaultMove = useCallback(<T,>(work: () => Promise<T>): Promise<T> => {
    const p = work();
    vaultMovesRef.current.add(p);
    // Removed on rejection too: a span left registered would hold the restore
    // (and its persistence gate) open for the rest of the session.
    const done = () => { vaultMovesRef.current.delete(p); };
    p.then(done, done);
    return p;
  }, []);
  /** The in-flight restore's registry — only when it is restoring THIS vault,
   *  so a pass outliving a switch is never edited by the next vault's moves. */
  const pendingFor = useCallback((root: FileSystemDirectoryHandle | null): PendingRestore | null => {
    const pending = restorePendingRef.current;
    return pending && root && pending.root === root ? pending : null;
  }, []);
  /** Held for the whole of any copy-then-delete over the vault — and over the
   *  question in front of it, because only one dialog fits on screen. */
  const trashInFlightRef = useRef<boolean>(false);
  return { restorePendingRef, vaultMovesRef, trackVaultMove, pendingFor, trashInFlightRef };
}
