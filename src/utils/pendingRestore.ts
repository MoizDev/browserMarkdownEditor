// The documents a vault's restore pass is still bringing back, reachable from
// the vault mutations while it does (issue #9).
//
// The restore pass reads its session's files before it opens any of them, and
// the file tree is on screen and usable throughout. Rename, move and trash are copy-then-
// delete, and the fix-ups that follow them walk the OPEN tabs — which the
// documents still being restored are not yet among. So a note renamed in that
// window came back at its old path, holding a handle to an entry that no longer
// existed: the tree showed `a2.md`, the tab said `a.md`, and every keystroke in
// it logged "Auto-save failed" and went nowhere. A note just trashed came back
// as an open tab.
//
// This registry is what those mutations update instead, synchronously and
// beside their own fix-ups, so a restored document FOLLOWS a rename the same way
// an open one does rather than merely being dropped at the end. Pure: no React,
// no filesystem — App owns the when, this owns the what.

export interface PendingRestoreEntry {
  /** The path the stored session names — restoreLayout's key space. Never changes. */
  readonly origin: string;
  /** Where the document is NOW; re-pointed by a rename/move of it or its folder. */
  path: string;
  /**
   * The Help guide's pseudo-entry. Never matched by a vault mutation: its path
   * is a bare name (`help-guide`), so a vault folder of that name would
   * otherwise re-point or drop it — handleTrash's reason for the same test.
   */
  readonly help: boolean;
  /** Set once read (a PDF's is '' without reading). undefined = not read, yet or ever. */
  content?: string;
  /** Trashed, displaced, overwritten, unreadable or gone — never merged. */
  dropped: boolean;
}

export interface PendingRestore {
  /** The vault this pass restores; a mutation in any other vault leaves it alone. */
  readonly root: FileSystemDirectoryHandle;
  /** In stored order, which restoreLayout's singletons follow. */
  readonly entries: PendingRestoreEntry[];
  /** Bumped by every mutation that changed anything, so the pass knows to re-validate. */
  epoch: number;
}

/** Still in play, and a document a vault mutation can reach. */
function reachable(entry: PendingRestoreEntry): boolean {
  return !entry.dropped && !entry.help;
}

/**
 * A rename or move of `fromPath` (a folder when `isFolder`) to `newPath`.
 *
 * `overwritten` is every destination the move lands on — renameFile/moveFile
 * deliberately overwrite a taken name, and a folder move is a merge — computed
 * exactly as App's retargetTabs computes them. A pending document sitting at one
 * of those is DROPPED first, and only then are the movers re-pointed: the other
 * order would drop the mover itself, and skipping the drop would leave two
 * entries answering to one path, which the restore's simultaneous relabel of the
 * layout (tabGroups' relabelPaths) requires never to happen.
 */
export function retargetPending(
  pending: PendingRestore,
  fromPath: string,
  isFolder: boolean,
  newPath: string,
  overwritten: readonly string[],
): void {
  if (newPath === fromPath) return;
  const prefix = `${fromPath}/`;
  const moves = (path: string) => (isFolder ? path.startsWith(prefix) : path === fromPath);
  const landing = new Set(overwritten);
  let changed = false;

  for (const entry of pending.entries) {
    if (!reachable(entry) || moves(entry.path) || !landing.has(entry.path)) continue;
    entry.dropped = true;
    changed = true;
  }
  for (const entry of pending.entries) {
    if (!reachable(entry) || !moves(entry.path)) continue;
    entry.path = isFolder ? newPath + entry.path.slice(fromPath.length) : newPath;
    changed = true;
  }
  if (changed) pending.epoch++;
}

/** A trash (or the bin's Replace displacing something): whatever `doomed` names is not coming back. */
export function dropPending(pending: PendingRestore, doomed: (path: string) => boolean): void {
  let changed = false;
  for (const entry of pending.entries) {
    if (!reachable(entry) || !doomed(entry.path)) continue;
    entry.dropped = true;
    changed = true;
  }
  if (changed) pending.epoch++;
}
