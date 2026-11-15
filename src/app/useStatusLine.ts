import { useCallback, useEffect, useRef, useState } from 'react';
import { subscribeRenderStatus } from '../utils/renderStatus';
import { subscribeRestoreNotice, takeRestoreNotice } from '../utils/storage';

/**
 * The editor's one-line status ("Saved", "Moving … to Trash…", a resolved
 * conflict) — the quiet voice beside `notify`'s modal one.
 *
 * ONE timer for the whole line, re-armed rather than stacked: rapid saves used
 * to leave a handful of live timers all racing to clear the same message.
 */
export function useStatusLine() {
  const [saveStatus, setSaveStatus] = useState<string>('');
  const saveStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Show `message`, cleared after `ms` — re-armed over whatever was showing. */
  const showStatus = useCallback((message: string, ms: number) => {
    if (saveStatusTimerRef.current) clearTimeout(saveStatusTimerRef.current);
    setSaveStatus(message);
    saveStatusTimerRef.current = setTimeout(() => setSaveStatus(''), ms);
  }, []);
  /** Show `message` until something replaces it — a pending timer must not
   *  clear it midway (a folder's trash copy runs for seconds). */
  const holdStatus = useCallback((message: string) => {
    if (saveStatusTimerRef.current) {
      clearTimeout(saveStatusTimerRef.current);
      saveStatusTimerRef.current = null;
    }
    setSaveStatus(message);
  }, []);
  /** Say something that went RIGHT, in the status line — no dialog to dismiss.
   *  `notify` is the app's "Could not continue" modal: a resolved conflict
   *  reported through it blocked the window and read as a failure. */
  const announce = useCallback((message: string) => showStatus(message, 5000), [showStatus]);
  useEffect(() => subscribeRenderStatus(announce), [announce]);
  useEffect(() => {
    const showRestoreNotice = () => {
      const notice = takeRestoreNotice();
      if (notice) announce(notice);
    };
    const unsubscribe = subscribeRestoreNotice(showRestoreNotice);
    showRestoreNotice();
    return unsubscribe;
  }, [announce]);
  return { saveStatus, setSaveStatus, showStatus, holdStatus, announce };
}
