import { useCallback, useEffect, useState } from 'react';

/** The two panels drawn over the workspace on request: Settings and the Trash bin. */
export function useOverlayPanels(rootHandle: FileSystemDirectoryHandle | null) {
  const [showSettings, setShowSettings] = useState<boolean>(false);
  /** Whether the Trash bin is on screen. Its rows hold handles crawled out of
   *  ONE vault, so the panel closes when the vault does (see the effect beside
   *  the context menu's) — a put-back clicked after a switch would otherwise
   *  write into the vault the reader has left. */
  const [showTrash, setShowTrash] = useState<boolean>(false);

  // Same hazard, one surface further out: every row in the Trash panel closes
  // over a handle from the vault it was crawled in, and nothing in those
  // handles goes stale when the vault does — a put-back clicked afterwards
  // would copy a file into a folder of the vault the reader just left.
  useEffect(() => { setShowTrash(false); }, [rootHandle]);
  const openTrash = useCallback(() => setShowTrash(true), []);
  const openSettings = useCallback(() => setShowSettings(true), []);
  return { showSettings, setShowSettings, openSettings, showTrash, setShowTrash, openTrash };
}
