import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import type { ActiveFile, RecentVault } from '../types';
import { findLinkedVault, readLocation, vaultLinkName, writeLocation } from '../utils/appUrl';

/**
 * The link the page was opened with (`#vault=…&file=…`): what it asked for,
 * and whether the restore pass has dealt with it yet. The URL hash names a
 * stored vault and is read ONCE; its `file` is opened only by the session
 * restore (useSessionRestore), in the vault it names.
 */
export function useAppLink() {
  /**
   * The address bar AS THE PAGE LOADED, captured once.
   *
   * Not re-read later: the URL writer further down rewrites the hash as the
   * app settles, and one render where a vault is open but the labelled list has
   * not caught up used to clear it — wiping the link before its note had been
   * opened. Reading a link that is being kept up to date is the mistake; the
   * instruction is what arrived, once. Declared here because its readers are
   * the restore pass below and the URL writer after it.
   */
  const [initialLocation] = useState(readLocation);
  /** Spent by the first restore of a vault the link names, or by the first
   *  restore of any vault when it names no vault or no note — a vault the app
   *  fell back to leaves it waiting (see the restore pass). Until it is spent
   *  the URL writer never blanks the hash. */
  const linkPendingRef = useRef(true);
  /**
   * The link's note until the restore pass has dealt with it, so the URL
   * writer keeps naming it. Without this the writer wrote the vault ALONE from
   * the moment recordVault listed it — before the tree walk, let alone the
   * reads — until the merge made the note active; a reload or a copied address
   * in that window lost a note only the link had named, since the session never
   * held it either (restoringRef holds its write back until the merge). State,
   * not a ref: when the link opens nothing in its own vault (a missing or
   * non-document file, every read failing) no tab changes, and the writer
   * still has to re-run to drop `file`.
   */
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
  /**
   * Keep the address bar describing what is open, so it can be copied at any
   * moment as a link back here.
   *
   * The vault is named rather than identified wherever it can be — a link is
   * something a person reads and types — and only carries an id suffix when two
   * known vaults share a folder name. See utils/appUrl.ts for why a link cannot
   * carry a path on disk, which is the thing it would obviously want to.
   *
   * With no vault document active yet (the help guide has no link, so it does
   * not count), the link's note stays named until the restore pass has
   * consumed it (see pendingLinkFile) — but only in the vault the link resolves
   * to, the restore pass's own test, so a link that fell back to another vault
   * never pins its `file` there. An open document outranks it: the bar
   * describes what is open.
   */
  useEffect(() => {
    const vault = recentVaults.find(v => v.id === currentVaultId);
    if (!vault) {
      // Three reasons there may be no vault to name, and none is a reason to
      // clear the hash. Before a vault is open, the link is what the "Open 'X'"
      // button is about to act on. And "an id but no entry in the list" is not
      // a vault without a name: recordVault now sets the two in one batch, but
      // it once set the id first, and clearing in that transient render wiped
      // the link mid-open — the file it named never got opened. Kept for any
      // list write that could still land apart from the id (a forget racing an
      // open), where the right move is again to wait for the next commit. And
      // the mount path commits `rootHandle` a render BEFORE recordVault's id:
      // "a handle but no id" while the link is still unclaimed blanked the
      // whole hash for that await (measured: ~30ms into 5 of 6 slowed reloads,
      // so a reload there lost the link outright).
      if (!rootHandle || currentVaultId || linkPendingRef.current) return;
      writeLocation({});
      return;
    }
    writeLocation({
      vault: vaultLinkName(vault, recentVaults),
      // The help guide is not a file in the vault, so it has no link.
      file: activeFile && !activeFile.isHelp
        ? activeFile.path
        : pendingLinkFile && findLinkedVault(initialLocation.vault, recentVaults)?.id === vault.id
          ? pendingLinkFile
          : undefined,
    });
  }, [rootHandle, currentVaultId, recentVaults, activeFile, pendingLinkFile, initialLocation, linkPendingRef]);
}
