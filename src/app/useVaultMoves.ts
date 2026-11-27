import { useCallback, useRef } from 'react';
import type { PendingRestore } from '../utils/pendingRestore';

export function useVaultMoves() {
  const restorePendingRef = useRef<PendingRestore | null>(null);
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
  const pendingFor = useCallback((root: FileSystemDirectoryHandle | null): PendingRestore | null => {
    const pending = restorePendingRef.current;
    return pending && root && pending.root === root ? pending : null;
  }, []);
  const trashInFlightRef = useRef<boolean>(false);
  return { restorePendingRef, vaultMovesRef, trackVaultMove, pendingFor, trashInFlightRef };
}
