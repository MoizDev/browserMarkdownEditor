import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import type { FileSystemContextValue, OpenTab } from '../types';
import { setTerminalStartSource } from '../utils/terminalStart';
import { parentVaultPath } from '../utils/paths';

export interface UseVaultIdentityDeps {
  rootHandle: FileSystemDirectoryHandle | null;
  showSettings: boolean;
  ensureVaultId: FileSystemContextValue['ensureVaultId'];
  writeFileRef: React.MutableRefObject<FileSystemContextValue['writeFile']>;
  rootHandleRef: React.MutableRefObject<FileSystemDirectoryHandle | null>;
  activeTabPathRef: React.MutableRefObject<string | null>;
  tabsRef: React.MutableRefObject<OpenTab[]>;
}

export function useVaultIdentity(deps: UseVaultIdentityDeps) {
  const { rootHandle, showSettings, ensureVaultId, writeFileRef, rootHandleRef, activeTabPathRef, tabsRef } = deps;
  const vaultIdRef = useRef<{ root: FileSystemDirectoryHandle; id: string | null } | null>(null);
  const [settingsVaultId, setSettingsVaultId] = useState<string | null>(null);
  useEffect(() => {
    if (!showSettings || !rootHandle) return;
    let alive = true;
    void ensureVaultId(rootHandle, writeFileRef.current).then(id => { if (alive) setSettingsVaultId(id); });
    return () => { alive = false; };
  }, [showSettings, rootHandle, ensureVaultId, writeFileRef]);
  useEffect(() => {
    setTerminalStartSource(async () => {
      const root = rootHandleRef.current;
      if (!root) return { vaultId: null, dir: '' };
      if (vaultIdRef.current?.root !== root) {
        vaultIdRef.current = { root, id: await ensureVaultId(root, writeFileRef.current) };
      }
      const path = activeTabPathRef.current;
      const file = path ? tabsRef.current.find(t => t.file.path === path)?.file : null;
      const dir = file && !file.isHelp ? parentVaultPath(file.path) : '';
      return { vaultId: vaultIdRef.current.id, dir };
    });
  }, [ensureVaultId, activeTabPathRef, rootHandleRef, tabsRef, writeFileRef]);
  return { settingsVaultId };
}
