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
  /** Write out everything pending, as leaving the page does (useSaveFunnel). */
  checkpointNow: () => Promise<void>;
  notifyRef: React.MutableRefObject<(message: string) => void>;
}

/** How long a reload the app offers waits for pending saves before it refuses and says why. */
const SAVE_BEFORE_RELOAD_MS = 5000;

/**
 * A newer build was deployed: offer a reload, never one that drops work. The same "save, then reload" serves every
 * reload the app itself offers — the update notice, a pane whose code is gone from the server, the error screens —
 * and is registered for main.tsx's last-resort boundary (utils/crashCheckpoint.ts).
 */
export function useUpdateNotice(deps: UseUpdateNoticeDeps) {
  const { flushingRef, tabsRef, hasUnsaved, documentSessions, documentBuffers, checkpointNow, notifyRef } = deps;
  const [updateAvailable, setUpdateAvailable] = useState(false);
  useEffect(() => watchForNewVersion(() => setUpdateAvailable(true)), []);
  // A gesture whose code was replaced on the server by a newer version, and whose caller let the failure go: said here,
  // once for each such gesture. Measured: Export to PDF after a deploy did nothing but raise the update notice, the
  // export's own chunk having answered 404 (an unhandled ChunkLoadError) — and every gesture that loads its code on
  // first use (the Trash bin's, Recover's, the DiskBar's) can do the same.
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
  // Do not discard an in-flight save, a not-yet-committed text edit, or ink
  // still held by a canvas serializer. Conflicts remain for the reader to fix.
  // `dirty`, `disk` and the buffer's own revision are asked too: a document held in a disk conflict (its autosave is
  // skipped until the DiskBar is answered), one whose file is gone, and one whose last save failed have no timer, no
  // write in flight and no pending edit, so `hasUnsaved` alone called them saved and the reload dropped the only copy.
  const unsaved = useCallback(() => flushingRef.current.size > 0 || anyPending()
    || tabsRef.current.some(tab => hasUnsaved(tab) || documentSessions.hasPendingEdits(tab.id)
      || tab.dirty || !!tab.disk || documentBuffers.isDirty(tab.id)), [documentBuffers, documentSessions, flushingRef, hasUnsaved, tabsRef]);
  const saveAll = useCallback(async () => {
    if (!unsaved()) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        checkpointNow().catch(error => { console.error('Could not save before reloading:', error); }),
        new Promise<void>(resolve => { timer = setTimeout(resolve, SAVE_BEFORE_RELOAD_MS); }),
      ]);
    } finally { clearTimeout(timer); }
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
