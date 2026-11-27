import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import type { ActiveFile, RecentVault } from '../types';
import { findLinkedVault, readLocation, vaultLinkName, writeLocation } from '../utils/appUrl';

export function useAppLink() {
  const [initialLocation] = useState(readLocation);
  const linkPendingRef = useRef(true);
  const [pendingLinkFile, setPendingLinkFile] = useState<string | null>(initialLocation.file ?? null);
  return { initialLocation, linkPendingRef, pendingLinkFile, setPendingLinkFile };
}

export interface UseUrlWriterDeps {
  rootHandle: FileSystemDirectoryHandle | null;
  currentVaultId: string | null;
  recentVaults: RecentVault[];
  activeFile: ActiveFile | null;
  pendingLinkFile: string | null;
  initialLocation: ReturnType<typeof readLocation>;
  linkPendingRef: React.MutableRefObject<boolean>;
}

/** Declared after the restore pass, whose effect must run first on a commit:
 *  it spends the link (linkPendingRef) the writer then reads. */
export function useUrlWriter(deps: UseUrlWriterDeps): void {
  const { rootHandle, currentVaultId, recentVaults, activeFile, pendingLinkFile, initialLocation, linkPendingRef } = deps;
  useEffect(() => {
    const vault = recentVaults.find(v => v.id === currentVaultId);
    if (!vault) {
      if (!rootHandle || currentVaultId || linkPendingRef.current) return;
      writeLocation({});
      return;
    }
    writeLocation({
      vault: vaultLinkName(vault, recentVaults),
      file: activeFile && !activeFile.isHelp
        ? activeFile.path
        : pendingLinkFile && findLinkedVault(initialLocation.vault, recentVaults)?.id === vault.id
          ? pendingLinkFile
          : undefined,
    });
  }, [rootHandle, currentVaultId, recentVaults, activeFile, pendingLinkFile, initialLocation, linkPendingRef]);
}
