// "Is this name taken?" for the writes that cannot go through
// FileSystemContext's freeEntryName. The OTHER copy of this rule is
// FileSystemContext.entryExists — independent code, kept identical; change both.

/**
 * Is `name` already used inside `dir`, by anything at all?
 *
 * BOTH KINDS of entry count as taken, whichever kind is about to be written: a
 * file and a folder cannot share a name, and asking only about files once
 * reported a name free while a folder of it sat there. That is the rule
 * `freeEntryName` already documents (FileSystemContext.tsx:21-25); this is the
 * same rule at the entry points that cannot go through it: App's create
 * handlers and the AI agent's (utils/agentHost.ts).
 *
 * It matters here because `createFile` OPENS-OR-TRUNCATES (:425-434). Without
 * this check a "New note" onto an existing name empties that file — no
 * warning, no undo, and the tree looks exactly as it did a moment before. The
 * guard is at this entry point rather than in the primitive deliberately:
 * routing `createFile` through `freeEntryName` would quietly create
 * "note (1).md" while the caller went on to open the name it asked for, and
 * the other caller (the annotated-PDF path) wants create-or-open.
 */
export async function nameTaken(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try { await dir.getFileHandle(name); return true; } catch { /* not a file */ }
  try { await dir.getDirectoryHandle(name); return true; } catch { /* nor a folder */ }
  return false;
}
