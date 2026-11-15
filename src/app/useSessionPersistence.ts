import { useEffect, useRef } from 'react';
import type { TabLayout } from '../types';
import { setRecordScope } from '../utils/storage';
import { focusedPath as focusedPathOf } from '../utils/tabPanes';
import { writeSession } from '../utils/tabSessions';

export interface UseSessionPersistenceDeps {
  rootHandle: FileSystemDirectoryHandle | null;
  currentVaultId: string | null;
  layout: TabLayout;
  indexRestoreSettled: () => void;
}

/**
 * Which vault the workspace on screen is the session of, and writing that
 * session out under the vault's id whenever the arrangement moves. The restore
 * (useSessionRestore) claims these refs; the vault switch (useVaultSwitch)
 * releases them.
 */
export function useSessionPersistence(deps: UseSessionPersistenceDeps) {
  const { rootHandle, currentVaultId, layout, indexRestoreSettled } = deps;
  /**
   * WHICH VAULT the workspace on screen is the session of — the handle and the
   * id together, because neither alone is enough.
   *
   * `openVaultHandle` commits rootHandle + fileTree in one batch and only then
   * awaits recordVault, so there is a commit where the tree is the NEW vault's
   * and `currentVaultId` is still the OLD one; restoring there would open the
   * old vault's paths out of the new vault's tree. And the persist effect is
   * declared before the switch effect, so on the switch commit it runs FIRST,
   * with the outgoing layout — and would file it under the incoming id.
   *
   * So both effects check both refs, and the restore pass writes them together
   * — and only once it has a real id to write, never against the `null` a vault
   * carries between its tree landing and recordVault answering (see there).
   * `undefined` is "nothing restored yet", which no vault id can collide with.
   */
  const sessionRootRef = useRef<FileSystemDirectoryHandle | null>(null);
  const sessionVaultIdRef = useRef<string | null | undefined>(undefined);
  /**
   * The restore pass still READING the claimed vault's files, if one is — and
   * while it is, nothing is persisted. Claiming the two refs above is what
   * un-gates persistence, and the claim comes before the reads, so a note opened
   * in that window was written out as the vault's whole session until the merge
   * wrote it back (measured: a tree click 100ms into a restore reading 600ms per
   * file held the stored session at that one tab for 2.4s, and a reload inside
   * the window came back with only it — all four saved documents, columns and
   * all, gone for good). A token rather than a flag, so a pass that outlives a
   * switch cannot release the gate a later pass holds.
   */
  const restoringRef = useRef<object | null>(null);
  useEffect(() => {
    if (!rootHandle) return;
    // A failed vault-id write can prevent any restore claim; do not leave that
    // vault without an index forever. A restore already reading owns its release.
    const timer = setTimeout(() => {
      if (sessionRootRef.current !== rootHandle && !restoringRef.current) indexRestoreSettled();
    }, 2000);
    return () => clearTimeout(timer);
  }, [rootHandle, indexRestoreSettled]);

  // Which vault the path-keyed records (fileScrollAnchors, pdfViewPositions,
  // collapsedHeadings) file their entries under. Declared BEFORE the restore
  // pass so no pane it opens can read a record under the outgoing vault's
  // scope — `Notes/index.md` names a different file in every vault, and with
  // per-vault sessions both of them are routinely open.
  //
  // That covers the panes THIS app opens, and not the one window it cannot:
  // `currentVaultId` lands recordVault's round trips after `rootHandle`+`fileTree`
  // on the switch paths, so the new vault's tree is clickable while the scope still
  // names the old one, and a file opened by hand right then reads the other
  // vault's offset for the same path. Deliberately not "fixed" by clearing the
  // scope on switch: pane unmounts run one commit AFTER the switch effect, so
  // their flush would then write the OUTGOING vault's offsets to bare paths —
  // trading a rare wrong offset for a routine one.
  useEffect(() => { setRecordScope(currentVaultId); }, [currentVaultId]);

  // Persist the open documents, how they are divided into columns, which tab
  // each column was left showing and how wide the columns were, UNDER THIS
  // VAULT'S ID — so a reload, and a switch away and back, both come back to the
  // same workspace. Keyed on `layout` (not `tabs`) so it does NOT run on every
  // keystroke — the layout's identity only moves when the arrangement does.
  //
  // GATED on the two session refs, which is the old `hasRestoredTabs` rule
  // generalized per vault. It has to cover two things:
  //   • mount, with zero tabs — writing that out would clobber the stored list
  //     moments before restore reads it, which is what once reduced every
  //     reload to "only the last-active file comes back";
  //   • the vault-switch commit, where this effect runs first (declaration
  //     order) with the OUTGOING layout, and a commit later with the empty one
  //     the switch installs — either of which would land under the INCOMING
  //     vault's id.
  // The HANDLE test is what actually closes that, under either ordering:
  // `sessionRootRef` holds the outgoing handle before the switch effect runs
  // and `null` after, and the switch effect only fires when the handle really
  // changed — so it can never equal the incoming `rootHandle`. Declaration
  // order is therefore not the guard; the `sessionRootRef.current = null`
  // there is (see it for what depends on it).
  // An empty layout is written happily once the refs match: "I closed
  // everything in this vault" is a session, and must survive a switch.
  useEffect(() => {
    if (!currentVaultId) return;                              // no id → nowhere to file it
    if (sessionRootRef.current !== rootHandle) return;        // the workspace is still the old vault's
    if (sessionVaultIdRef.current !== currentVaultId) return; // …or this vault's restore has not run yet
    if (restoringRef.current) return;                         // …or is still reading (see restoringRef)
    writeSession(currentVaultId, {
      // Stamped, because a record written before panes and tabs swapped axes
      // means the opposite by the same `groups` row — readSession migrates it
      // (see its v1 reader), and cannot tell the two apart without this.
      v: 2,
      paths: layout.panes.flatMap(p => p.paths),
      groups: layout.panes.map(p => p.paths),
      // Which tab each column was left showing: without it a column came back
      // on its leftmost tab, since `active` speaks for one column only.
      focus: layout.panes.map(p => p.activePath),
      // `null` while nobody has dragged a divider, which is most workspaces —
      // absence is how "equal columns" is encoded all the way down (see
      // tabPanes.ts). ONE row for the whole editor now, not one per tab.
      sizes: layout.sizes ?? null,
      active: focusedPathOf(layout),
    });
  }, [layout, currentVaultId, rootHandle]);
  return { sessionRootRef, sessionVaultIdRef, restoringRef };
}
