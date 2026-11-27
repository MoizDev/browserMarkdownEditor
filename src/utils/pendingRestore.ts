export interface PendingRestoreEntry {
  readonly origin: string;
  path: string;
  readonly help: boolean;
  content?: string;
  readError?: string;
  dropped: boolean;
}

export interface PendingRestore {
  readonly root: FileSystemDirectoryHandle;
  readonly entries: PendingRestoreEntry[];
  epoch: number;
}

function reachable(entry: PendingRestoreEntry): boolean {
  return !entry.dropped && !entry.help;
}

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

export function dropPending(pending: PendingRestore, doomed: (path: string) => boolean): void {
  let changed = false;
  for (const entry of pending.entries) {
    if (!reachable(entry) || !doomed(entry.path)) continue;
    entry.dropped = true;
    changed = true;
  }
  if (changed) pending.epoch++;
}
