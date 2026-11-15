import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import type { OpenTab } from '../types';
import { watchForNewVersion } from '../utils/versionPoll';
import { anyPending } from '../utils/unloadCoordinator';

export interface UseUpdateNoticeDeps {
  flushingRef: React.MutableRefObject<Map<string, number>>;
  tabsRef: React.MutableRefObject<OpenTab[]>;
  hasUnsaved: (tab: OpenTab) => boolean;
  notifyRef: React.MutableRefObject<(message: string) => void>;
}

/** A newer build was deployed: offer a reload, never one that drops work. */
export function useUpdateNotice(deps: UseUpdateNoticeDeps) {
  const { flushingRef, tabsRef, hasUnsaved, notifyRef } = deps;
  const [updateAvailable, setUpdateAvailable] = useState(false);
  useEffect(() => watchForNewVersion(() => setUpdateAvailable(true)), []);
  const reloadUpdatedApp = useCallback(() => {
    // Do not discard an in-flight save, a not-yet-committed text edit, or ink
    // still held by a canvas serializer. Conflicts remain for the reader to fix.
    if (flushingRef.current.size || anyPending() || tabsRef.current.some(hasUnsaved)) {
      notifyRef.current('Finish saving your changes and resolve any disk conflicts before reloading.');
      return;
    }
    window.location.reload();
  }, [hasUnsaved, flushingRef, notifyRef, tabsRef]);
  const dismissUpdate = useCallback(() => setUpdateAvailable(false), []);
  return { updateAvailable, reloadUpdatedApp, dismissUpdate };
}
