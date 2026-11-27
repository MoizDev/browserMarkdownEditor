import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import type { OpenTab } from '../types';
import type { DocumentBufferStore } from '../utils/documentBuffers';
import type { DocumentSessionStore } from '../utils/documentSessions';
import { watchForNewVersion } from '../utils/versionPoll';
import { anyPending } from '../utils/unloadCoordinator';
import { setCrashCheckpoint } from '../utils/crashCheckpoint';
import { isAppReplaced } from '../platform/chunkLoad';

export interface UseUpdateNoticeDeps {
  flushingRef: React.MutableRefObject<Map<string, number>>;
  tabsRef: React.MutableRefObject<OpenTab[]>;
  hasUnsaved: (tab: OpenTab) => boolean;
  documentSessions: DocumentSessionStore;
  documentBuffers: DocumentBufferStore;
  checkpointNow: () => Promise<void>;
  notifyRef: React.MutableRefObject<(message: string) => void>;
}

const SAVE_BEFORE_RELOAD_MS = 5000;
const SETTLE_MS = 1000;

export function useUpdateNotice(deps: UseUpdateNoticeDeps) {
  const { flushingRef, tabsRef, hasUnsaved, documentSessions, documentBuffers, checkpointNow, notifyRef } = deps;
  const [updateAvailable, setUpdateAvailable] = useState(false);
  useEffect(() => watchForNewVersion(() => setUpdateAvailable(true)), []);
  useEffect(() => {
    const unhandled = (event: PromiseRejectionEvent) => {
      if (!isAppReplaced(event.reason)) return;
      event.preventDefault();
      console.warn('A gesture needed a part of the app that a newer version replaced:', event.reason);
      notifyRef.current('That needs a part of the app that a newer version has replaced. Reload to use it.');
    };
    window.addEventListener('unhandledrejection', unhandled);
    return () => window.removeEventListener('unhandledrejection', unhandled);
  }, [notifyRef]);
  const unsaved = useCallback(() => flushingRef.current.size > 0 || anyPending()
    || tabsRef.current.some(tab => hasUnsaved(tab) || documentSessions.hasPendingEdits(tab.id)
      || (tab.dirty && tab.representation.loadedKind !== 'pdf') || !!tab.disk || documentBuffers.isDirty(tab.id)), [documentBuffers, documentSessions, flushingRef, hasUnsaved, tabsRef]);
  const saveAll = useCallback(async () => {
    if (!unsaved()) return true;
    const deadline = Date.now() + SAVE_BEFORE_RELOAD_MS;
    do {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          checkpointNow().catch(error => { console.error('Could not save before reloading:', error); }),
          new Promise<void>(resolve => { timer = setTimeout(resolve, Math.max(0, deadline - Date.now())); }),
        ]);
      } finally { clearTimeout(timer); }
      const settleUntil = Math.min(deadline, Date.now() + SETTLE_MS);
      while (unsaved() && Date.now() < settleUntil) await new Promise(resolve => setTimeout(resolve, 50));
    } while (unsaved() && Date.now() < deadline);
    return !unsaved();
  }, [checkpointNow, unsaved]);
  const saveAndReload = useCallback(async () => {
    if (!await saveAll()) {
      notifyRef.current('Finish saving your changes and resolve any disk conflicts before reloading.');
      return false;
    }
    window.location.reload();
    return true;
  }, [notifyRef, saveAll]);
  useEffect(() => { setCrashCheckpoint(saveAll); }, [saveAll]);
  const reloadUpdatedApp = useCallback(() => { void saveAndReload(); }, [saveAndReload]);
  const dismissUpdate = useCallback(() => setUpdateAvailable(false), []);
  return { updateAvailable, reloadUpdatedApp, saveAndReload, dismissUpdate };
}
