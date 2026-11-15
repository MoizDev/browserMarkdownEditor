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

/** The vault's stable id (`.VaultAgent`), minted only when something needs it:
 *  the first terminal in a vault, or Settings showing it. */
export function useVaultIdentity(deps: UseVaultIdentityDeps) {
  const { rootHandle, showSettings, ensureVaultId, writeFileRef, rootHandleRef, activeTabPathRef, tabsRef } = deps;
  // ── Where a new terminal starts ────────────────────────────────────────
  // The folder of the file in front of the user, as the helper can resolve it:
  // a vault-relative directory plus the vault's id, since the browser can never
  // know this vault as `/Users/…` (utils/terminalStart.ts). Registered once,
  // reading refs, because it is asked at the moment a shell is spawned — which
  // is long after this ran.
  const vaultIdRef = useRef<{ root: FileSystemDirectoryHandle; id: string | null } | null>(null);
  /** The same id, for Settings — resolved when that panel opens, so a reader who
   *  never opens Settings or a terminal never gets a .VaultAgent folder. */
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
      // Minted on the first terminal in a vault, not on every vault open: a
      // reader who never opens one never gets a .VaultAgent folder from this.
      if (vaultIdRef.current?.root !== root) {
        vaultIdRef.current = { root, id: await ensureVaultId(root, writeFileRef.current) };
      }
      const path = activeTabPathRef.current;
      const file = path ? tabsRef.current.find(t => t.file.path === path)?.file : null;
      // The Help guide and an unsaved pseudo-file have no folder in the vault.
      const dir = file && !file.isHelp ? parentVaultPath(file.path) : '';
      return { vaultId: vaultIdRef.current.id, dir };
    });
  }, [ensureVaultId, activeTabPathRef, rootHandleRef, tabsRef, writeFileRef]);
  return { settingsVaultId };
}
