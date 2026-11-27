import { useCallback, useEffect, useRef, useState } from 'react';
import { subscribeRenderStatus } from '../utils/renderStatus';
import { subscribeRestoreNotice, takeRestoreNotice } from '../utils/storage';

export function useStatusLine() {
  const [saveStatus, setSaveStatus] = useState<string>('');
  const saveStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showStatus = useCallback((message: string, ms: number) => {
    if (saveStatusTimerRef.current) clearTimeout(saveStatusTimerRef.current);
    setSaveStatus(message);
    saveStatusTimerRef.current = setTimeout(() => setSaveStatus(''), ms);
  }, []);
  const holdStatus = useCallback((message: string) => {
    if (saveStatusTimerRef.current) {
      clearTimeout(saveStatusTimerRef.current);
      saveStatusTimerRef.current = null;
    }
    setSaveStatus(message);
  }, []);
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
