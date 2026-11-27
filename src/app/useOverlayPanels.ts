import { useCallback, useEffect, useState } from 'react';

export function useOverlayPanels(rootHandle: FileSystemDirectoryHandle | null) {
  const [showSettings, setShowSettings] = useState<boolean>(false);
  const [showTrash, setShowTrash] = useState<boolean>(false);

  useEffect(() => { setShowTrash(false); }, [rootHandle]);
  const openTrash = useCallback(() => setShowTrash(true), []);
  const openSettings = useCallback(() => setShowSettings(true), []);
  return { showSettings, setShowSettings, openSettings, showTrash, setShowTrash, openTrash };
}
