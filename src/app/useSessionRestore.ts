import type React from 'react';
import { useEffect, useRef } from 'react';
import type { ActiveFile, FileSystemContextValue, FileTreeFileNode, FileTreeNode, OpenTab, RecentVault, TabLayout } from '../types';
import type { DocumentBufferStore } from '../utils/documentBuffers';
import type { BoardSaveBaselines } from '../utils/assetRetirement';
import type { DiskVersion } from '../utils/diskVersion';
import type { PendingRestore, PendingRestoreEntry } from '../utils/pendingRestore';
import { findLinkedVault, type readLocation } from '../utils/appUrl';
import { collectFiles } from '../utils/tree';
import { classifyRequestedKind, opensInApp, representationFor } from '../utils/documentReading';
import { isEpubFile, isNativeDrawingFile, isPdfFile } from '../utils/fileTypes';
import { loadHelpDoc } from '../utils/helpDocLoader';
import { setBaseline } from '../utils/docBaselines';
import { pruneSessions, readSession } from '../utils/tabSessions';
import { mergeLayouts, relabelPaths, restoreLayout } from '../utils/tabPanes';
import { newTabId } from './documentIds';
import { describeReadError, isNotFound } from './readErrors';
import type { SetLayout, SetTabs } from './types';
import { isFileReadTimeout, withinFileDeadline } from '../utils/fileReadDeadline';

// Every read here has a deadline (utils/fileReadDeadline.ts; the reads themselves carry it, and the path lookups are
// given the same one below). Measured: one read that never settled (a cloud file not downloaded yet, a stalled
// volume) brought back no tab at all, kept the session's persistence shut and the index unstarted for the page.
/** The vault index starts after this however the restore is doing; it used to wait for the restore to settle. */
const INDEX_WAIT_MS = 8000;
/** How long the restore waits for the app's own moves to finish before it gives up (keeping the saved session). */
const MOVES_WAIT_MS = 15_000;

/** Wait for the app's in-flight moves to settle, or report false after MOVES_WAIT_MS. */
async function movesSettled(moves: Set<Promise<unknown>>): Promise<boolean> {
  const deadline = performance.now() + MOVES_WAIT_MS;
  while (moves.size) {
    const left = deadline - performance.now();
    if (left <= 0) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.allSettled([...moves]), new Promise(resolve => { timer = setTimeout(resolve, left); })]);
    clearTimeout(timer);
  }
  return true;
}

/** The restore could not finish; its claim keeps the vault's saved session from being written over. */
class RestoreIncomplete extends Error {}

export interface UseSessionRestoreDeps {
  fileTree: FileTreeNode[];
  rootHandle: FileSystemDirectoryHandle | null;
  currentVaultId: string | null;
  isLoading: boolean;
  recentVaults: RecentVault[];
  readFileVersioned: FileSystemContextValue['readFileVersioned'];
  resolveVaultFile: FileSystemContextValue['resolveVaultFile'];
  rememberAssetRefs: (file: ActiveFile, content: string) => void;
  seedPdfBaseline: (id: string, handle: FileSystemFileHandle) => void;
  seedDocumentBuffer: (id: string, path: string, content: string, readable: boolean) => void;
  documentBuffers: DocumentBufferStore;
  indexRestoreSettled: () => void;
  initialLocation: ReturnType<typeof readLocation>;
  linkPendingRef: React.MutableRefObject<boolean>;
  setPendingLinkFile: (file: string | null) => void;
  sessionRootRef: React.MutableRefObject<FileSystemDirectoryHandle | null>;
  sessionVaultIdRef: React.MutableRefObject<string | null | undefined>;
  restoringRef: React.MutableRefObject<object | null>;
  restorePendingRef: React.MutableRefObject<PendingRestore | null>;
  vaultMovesRef: React.MutableRefObject<Set<Promise<unknown>>>;
  rootHandleRef: React.MutableRefObject<FileSystemDirectoryHandle | null>;
  currentVaultIdRef: React.MutableRefObject<string | null>;
  layoutRef: React.MutableRefObject<TabLayout>;
  assetRefsRef: React.MutableRefObject<Map<string, { saved: Set<string>; references: Set<string> }>>;
  boardBaselinesRef: React.MutableRefObject<BoardSaveBaselines>;
  setTabs: SetTabs;
  setLayout: SetLayout;
}

/**
 * Bring a vault's workspace back when its tree lands — the ONLY thing that
 * opens documents when a vault loads, the link's note folded in — and forget
 * the stored sessions of vaults taken off the recent list.
 */
export function useSessionRestore(deps: UseSessionRestoreDeps): void {
  const {
    fileTree, rootHandle, currentVaultId, isLoading, recentVaults, readFileVersioned, resolveVaultFile,
    rememberAssetRefs, seedPdfBaseline, seedDocumentBuffer, documentBuffers, indexRestoreSettled,
    initialLocation, linkPendingRef, setPendingLinkFile, sessionRootRef, sessionVaultIdRef, restoringRef,
    restorePendingRef, vaultMovesRef, rootHandleRef, currentVaultIdRef, layoutRef, assetRefsRef,
    boardBaselinesRef, setTabs, setLayout,
  } = deps;
  // Auto-restore THIS VAULT'S tabs once its file tree has loaded — on a cold
  // start and on every switch back to it. The ONLY thing that opens documents
  // when a vault loads: the note a link names is folded in rather than opened
  // beside it, which raced this pass and cost the vault its tabs (see below).
  useEffect(() => {
    // Nothing to restore against yet — and NOTE that this return is above the
    // claim below, so a vault can set `currentVaultId` and never claim (an
    // empty folder walks to an empty tree, which is indistinguishable from one
    // that has not landed). That is why the switch effect re-points the id ref
    // at the vault being LEFT rather than leaving it on the last claim; see
    // there for what went wrong when it did not.
    if (!fileTree || fileTree.length === 0) {
      if (rootHandle && !isLoading) indexRestoreSettled();
      return;
    }
    // Both halves must have moved on: see sessionRootRef's note above. Equal on
    // either one means this commit is mid-switch (openVaultHandle commits the
    // tree before recordVault sets the id) or this vault has already been
    // restored — and restoring against the wrong pairing opens whichever of the
    // other vault's files happen to sit at these paths. That is the same hazard
    // the vault-switch effect exists to prevent, arriving by another road.
    if (sessionRootRef.current === rootHandle) return;
    if (sessionVaultIdRef.current === currentVaultId) return;
    // WAIT for the id rather than claim against its absence. Two paths —
    // openVaultHandle (and openRecentVault, only a wrapper over it) and
    // pickDirectory — commit the tree and only THEN await recordVault, while
    // the mount path and restoreVault record FIRST and walk after (which is why
    // an ordinary reload always looked fine). So the first vault of a page load
    // opened through the picker or the vault menu arrives
    // with `currentVaultId` still at its initial null; claiming here would mark
    // the workspace as that vault's and make the very next commit, the one
    // carrying the real id, fail the `sessionRootRef.current === rootHandle`
    // test above — the vault's session silently never restored. A vault whose
    // recordVault genuinely FAILED gets no session either way, which is the
    // intent: on the first vault of a load it keeps the null id and stops here;
    // on a later switch `currentVaultId` is left naming the OUTGOING vault, and
    // the id test above stops it instead. Persistence is not left un-gated by
    // the wait, because its own first line is the same check.
    if (!currentVaultId) return;
    // Claimed before every remaining early return — and before any await, since
    // StrictMode runs this effect twice — because persistence stays gated until
    // this pass has run, and a vault with nothing stored must still un-gate it.
    // The old `hasRestoredTabs` rule, per vault. (The `fileTree` return at the
    // top is the one that precedes it, deliberately: see there.)
    sessionRootRef.current = rootHandle;
    sessionVaultIdRef.current = currentVaultId;
    // Every claim starts with persistence open: a pass still reading an earlier
    // vault's files must not hold this one's gate — a vault with nothing to
    // read would otherwise persist nothing until that pass finished.
    restoringRef.current = null;
    const vaultFiles = collectFiles(fileTree);

    // The note the address bar names, when it belongs HERE. Resolved through
    // the same findLinkedVault FileSystemContext picked the vault with, so the
    // two agree: an unknown name that fell back to the last-used vault, another
    // vault chosen from the "Open 'X'" screen, or a hash naming no vault at all
    // opens that vault as it was left — the old opener instead opened the
    // link's path out of whichever vault loaded, if a file happened to sit
    // there. (The one blur: two known vaults sharing the link's name, with no
    // id suffix to part them — the link names both, and which it resolves to
    // here follows the list's order at this claim.) Text and PDF only,
    // handleFileClick's own test for "opens as a tab": anything else would be
    // a window.open on page load.
    //
    // Spent at the first claim of a vault it NAMES, so it never applies again
    // on a later switch back — even when that vault turned out not to hold
    // the note. Until then it waits: a vault the app fell back to (or one the
    // user picked instead) does not spend it, so opening the named folder
    // later in this page load — typically the first time this browser sees it
    // — still brings the note up. Spending it at the first claim of ANY vault
    // lost it to the fallback (issue #6). A link naming no vault or no note can
    // never apply, so it is spent at once. The list it is resolved against
    // always holds the vault being claimed: recordVault sets the id and the
    // list in one batch. With the id first, a folder opened for the first time
    // was missing from the list at this render and the note was dropped.
    const link = linkPendingRef.current ? initialLocation : null;
    const linkHere = !!link?.file && findLinkedVault(link.vault, recentVaults)?.id === currentVaultId;
    if (!link?.file || !link.vault || linkHere) linkPendingRef.current = false;
    const linkedNode = link?.file && linkHere
      ? vaultFiles.find(f => f.path === link.file && opensInApp(f.name))
      : undefined;
    // Spent with nothing to open for it, so nothing must keep it in the address
    // bar. A link still waiting for the vault it names keeps it: the writer only
    // shows it in that vault, and opening the named folder later must not leave
    // the bar without the note while its reads run.
    if (link && !linkPendingRef.current && !linkedNode) setPendingLinkFile(null);

    // Read the session WHOLE and synchronously, before the file reads below
    // yield: the refs just claimed are what the persist effect checks, so a
    // value read after the awaits could already have been rewritten — and the
    // columns would come back silently flattened. restoringRef now also shuts
    // persistence for the reads, but deciding the whole restore from one
    // snapshot is what makes that unreachable rather than merely unreached.
    const stored = readSession(currentVaultId);
    // A linked note the session does not hold joins it at the end, like any
    // newly opened note — restoreLayout makes a path no stored column accounts
    // for a tab of the last one. An empty `paths` is a real session ("I closed
    // everything here"); there is simply nothing of its own to open for it. A
    // Set, because a path listed twice (a hand-edited record) would mint two
    // tabs for one document — restoreLayout dedupes the layout, not the tabs.
    const paths = stored ? [...new Set(stored.paths)] : [];
    if (linkedNode && !paths.includes(linkedNode.path)) paths.push(linkedNode.path);
    if (paths.length === 0) { indexRestoreSettled(); return; }

    // Persistence stays shut from here until the merge is dispatched — see
    // restoringRef. Released in `finally` too, so no exit leaves it shut.
    const token = {};
    restoringRef.current = token;
    const release = () => { if (restoringRef.current === token) restoringRef.current = null; };
    // Published BEFORE the first await, so a rename, move or trash landing
    // anywhere in the reads below reaches these documents (see
    // restorePendingRef). A path the tree no longer holds is dropped here —
    // deleted or moved outside the app since the session was written.
    const root = rootHandle!;
    const pending: PendingRestore = {
      root,
      epoch: 0,
      entries: paths.map(p => {
        const help = p === 'help-guide';
        return {
          origin: p,
          path: p,
          help,
          // The guide's own text is fetched where it is used, below: it is a
          // chunk of its own now, and `entry.help` short-circuits every reader
          // of this field anyway.
          content: undefined,
          dropped: !help && !vaultFiles.some(f => f.path === p),
        };
      }),
    };
    restorePendingRef.current = pending;
    // The index waits for the restore so a restored pane paints first — but never for longer than this.
    const indexTimer = setTimeout(indexRestoreSettled, INDEX_WAIT_MS);
    // Set when this pass cannot finish: it then keeps `restoringRef` (persistence stays shut for the vault) instead
    // of releasing it, because the first layout change after an unfinished restore was written as the vault's WHOLE
    // session — measured: a help-guide chunk that failed to load restored nothing, and the next note opened
    // replaced four saved tabs for good.
    let incomplete = false;
    (async () => {
      try {
        // Read concurrently, not one after another: the workspace (the link's
        // note included) stayed empty for the SUM of the reads (measured, issue
        // #7: 600ms per read, four saved notes and the link's, ~3.05s from tree
        // to tabs) and now waits on the slowest one (same setup: ~0.62s). Each
        // entry is read and retried on its own, and everything after walks
        // `pending.entries` in stored order however the reads finish, so the
        // single merge and restoreLayout see exactly what they did.
        const readVersions = new Map<PendingRestoreEntry, DiskVersion>();
        await Promise.all(pending.entries.map(async entry => {
          if (entry.help) {
            // The guide is a chunk of its own: one that fails to load comes back as a tab saying so (Try again
            // loads it again), never as a reason to restore nothing.
            try { entry.content = await loadHelpDoc(); }
            catch (err) { entry.content = ''; entry.readError = describeReadError(err); }
            return;
          }
          if (entry.dropped) return;
          for (;;) {
            // Resolved by the entry's CURRENT path from the vault root, not
            // through the claim-time tree's handle: a rename that already ran
            // re-pointed the entry, and the old node's handle names an entry
            // that no longer exists.
            const path = entry.path;
            // Mirror handleFileClick: a PDF's bytes are read by its own pane —
            // decoding a PDF as UTF-8 would fill the buffer with garbage.
            if (isPdfFile(path) || isEpubFile(path) || isNativeDrawingFile(path)) {
              entry.content = '';
              break;
            }
            try {
              const { handle } = await withinFileDeadline(resolveVaultFile(root, path), path);
              const { text, version } = await readFileVersioned(handle);
              // Read at the old path and renamed since is still right: a rename
              // or move is a byte-for-byte copy.
              if (!entry.dropped) {
                entry.content = text;
                entry.readError = undefined;
                // The disk baseline of exactly these bytes, handed to the tab
                // at the merge (a copy's mtime differs; the hash will not).
                readVersions.set(entry, version);
              }
            } catch (err) {
              // A read racing a rename fails on the entry the copy just removed.
              // Once the move's fix-up has run the entry names where the note
              // went — read it there, rather than leave out a note the reader
              // only renamed. The path is compared even with no move left in
              // flight: one can have finished while the failed read settled.
              if (vaultMovesRef.current.size && !await movesSettled(vaultMovesRef.current)) throw new RestoreIncomplete('moves did not settle');
              if (!entry.dropped && entry.path !== path) continue;
              if (entry.dropped) break;
              // GONE and UNREADABLE are different answers, and only the first
              // may drop the path. This used to drop both alike, and whatever
              // is dropped here leaves the vault's saved tabs for good: the
              // layout is rebuilt from what came back, and the persist effect
              // then files that as the whole session — so one momentary failure
              // (a sync client or another editor mid-write, a cloud file not
              // downloaded, a lock) lost the tab and its place in the
              // arrangement on every later reload (issue #8). Anything but
              // NotFoundError gets one immediate second read — a fresh
              // getFile() is exactly what cures Chromium's "file changed after
              // getFile" NotReadableError — and then comes back as a tab that
              // says it could not be read, holding no text (OpenTab.readError).
              if (isNotFound(err)) {
                entry.dropped = true;
              } else if (isFileReadTimeout(err)) {
                // Not read again at once: a read that did not answer in ten seconds is not cured by a second one,
                // and the pane's Try again is right there.
                console.warn('A restored tab did not answer; keeping it:', path, err);
                entry.readError = describeReadError(err);
              } else if (entry.readError === undefined) {
                entry.readError = describeReadError(err);
                continue;
              } else {
                console.warn('Could not read a restored tab; keeping it:', path, err);
                entry.readError = describeReadError(err);
              }
            }
            break;
          }
        }));

        // SETTLE, then re-validate every survivor against the vault as it is
        // NOW, and repeat until nothing moved underneath. The reads above held
        // the session for as long as they took, and the tree stayed usable
        // throughout (issue #9: a note renamed after its read came back at the
        // old path — tree showing `a2.md`, tab saying `a.md`, "Auto-save
        // failed" on every keystroke). Waiting for no move in flight covers the
        // span where the old entry is gone and the registry not yet re-pointed;
        // re-resolving from the root hands each document a handle that exists
        // (and drops one deleted outside the app); the epoch catches a move
        // that started and finished inside these awaits.
        const live = new Map<PendingRestoreEntry, FileTreeFileNode>();
        for (;;) {
          if (!await movesSettled(vaultMovesRef.current)) throw new RestoreIncomplete('moves did not settle');
          const seen = pending.epoch;
          live.clear();
          for (const entry of pending.entries) {
            if (entry.help || entry.dropped || (entry.content === undefined && entry.readError === undefined)) continue;
            try {
              const { handle, parentHandle } = await withinFileDeadline(resolveVaultFile(root, entry.path), entry.path);
              if (classifyRequestedKind(entry.origin) !== classifyRequestedKind(handle.name) || isNativeDrawingFile(entry.origin) !== isNativeDrawingFile(handle.name)) {
                if (isEpubFile(handle.name) || isPdfFile(handle.name) || isNativeDrawingFile(handle.name)) { entry.content=''; entry.readError=undefined; readVersions.delete(entry); }
                else try { const read=await readFileVersioned(handle); entry.content=read.text; entry.readError=undefined; readVersions.set(entry,read.version); }
                catch(error){entry.content='';entry.readError=describeReadError(error);}
              }
              live.set(entry, { name: handle.name, kind: 'file', path: entry.path, handle, parentHandle });
            } catch (error) {
              // A path that did not ANSWER is not a path that is gone: keep the tab (as unreadable) on the
              // tree's node for it, or the session written after the merge would no longer hold it.
              const node = isFileReadTimeout(error) ? vaultFiles.find(f => f.path === entry.path) : undefined;
              if (node) {
                entry.content = '';
                entry.readError = describeReadError(error);
                readVersions.delete(entry);
                live.set(entry, node);
              }
              // Otherwise gone (or a folder now) — left out, like a note deleted
              // since the session was written.
            }
          }
          if (pending.epoch === seen && vaultMovesRef.current.size === 0) break;
        }
        // ── NO AWAIT from here to the merge's dispatch. ──
        // The loop above just proved the vault quiet; JS being single-threaded
        // is what keeps it so until the merge is queued. An await anywhere
        // below reopens issue #9. (One window stays, accepted: a move that
        // STARTS after this dispatch but runs its fix-up before React commits
        // the merge and tabsRef catches up. Every such move is several FS
        // round-trips plus a full refreshTree walk, against a commit already
        // queued — not reachable in practice.)

        if (rootHandleRef.current !== rootHandle || currentVaultIdRef.current !== currentVaultId || restorePendingRef.current !== pending) return;
        const restored: OpenTab[] = [];
        const origins: string[] = [];
        const relabel = new Map<string, string>();
        // One document per path, whatever the registry missed: a move's
        // overwritten set comes from the tree as last walked, and a stale one
        // could leave two entries at one path — two tabs for one document, and
        // a relabel that is no longer injective.
        const claimed = new Set<string>();
        for (const entry of pending.entries) {
          if (claimed.has(entry.path)) continue;
          if (entry.help) {
            const id = newTabId();
            seedDocumentBuffer(id, entry.path, entry.content!, entry.readError === undefined);
            restored.push(entry.readError !== undefined
              ? { id, file: { name: 'Help Guide', isHelp: true, path: entry.path }, mode: 'read', dirty: false, readError: entry.readError, representation: representationFor('Help Guide', true, 0, true) }
              : { id, file: { name: 'Help Guide', isHelp: true, path: entry.path }, mode: 'read', dirty: false, representation: representationFor('Help Guide', true) });
          } else {
            const node = live.get(entry);
            if (!node) continue;
            const id = newTabId();
            if (entry.readError === undefined) {
              const version = readVersions.get(entry);
              if (version) setBaseline(id, version);
              else if (isPdfFile(node.name) || isNativeDrawingFile(node.name)) seedPdfBaseline(id, node.handle);
            }
            seedDocumentBuffer(id, node.path, entry.readError !== undefined ? '' : entry.content!,
              entry.readError === undefined && representationFor(node.name).bufferKind === 'text');
            restored.push(entry.readError !== undefined
              ? { id, file: node, mode: 'read', dirty: false, readError: entry.readError, representation: representationFor(node.name, false, 0, true) }
              : { id, file: node, mode: 'read', dirty: false, representation: representationFor(node.name) });
            if (entry.path !== entry.origin) relabel.set(entry.origin, entry.path);
          }
          claimed.add(entry.path);
          origins.push(entry.origin);
        }
        // Nothing of the session came back (every note in it gone since — an
        // unreadable one still comes back, as a tab saying so) and nothing was
        // opened meanwhile: the stored session is left as it was. Something
        // that WAS opened still goes through the merge, with nothing to lay it
        // over — the gate held its write back, and the merge's new layout is
        // the only thing that will write it now.
        if (restored.length === 0 && layoutRef.current.panes.length === 0) return;
        // The awaits above yield to the event loop: the vault may have been
        // switched in the meantime, and the switch effect empties the tab set,
        // so the merge below would drop the OLD vault's notes (handles and all)
        // into the new vault's workspace. The HANDLE is checked as well as the
        // id, and it is the half that catches it: `currentVaultId` lags
        // `rootHandle` by a commit, so a switch whose reads land in that window
        // passes an id test comparing the outgoing id with itself (measured:
        // with a 600ms-per-file read, switching away mid-restore put vault A's
        // three tabs on screen over vault B's tree, autosaving through A's
        // handles). After the LAST await, which is now the re-validation.
        if (rootHandleRef.current !== rootHandle) return;
        if (currentVaultIdRef.current !== currentVaultId) return;
        // A later pass took the registry over (a switch away and back while
        // this one read): it restores the same session with a registry the
        // mutations still update, while this one's has gone deaf to them.
        if (restorePendingRef.current !== pending) return;
        // From here these are about to be ordinary tabs; the mutations go back
        // to finding them through tabsRef.
        restorePendingRef.current = null;
        // Asset baselines (see handleFileClick) only now that the workspace is
        // known to still be this vault's: seeded during the reads, a switch
        // mid-restore left the old vault's in the map the switch had just
        // cleared. A document already open keeps the baseline its own open took
        // — asked of the map itself, which every open of an asset-tracking
        // document seeds before its setTabs and every close clears, not of
        // tabsRef, which only catches up once a commit's effects have run.
        // An unreadable tab takes none: '' as a baseline would have its first
        // save after a retry diff every embed as removed. The retry seeds it.
        for (const tab of restored) {
          if (tab.readError) continue;
          const data = documentBuffers.snapshotForDocument(tab.id)?.data;
          if (typeof data === 'string' && !assetRefsRef.current.has(tab.file.path) && !boardBaselinesRef.current.capture(tab.file.path)) rememberAssetRefs(tab.file, data);
        }
        // Which of these shared a column, and which tab each column showed. A
        // session written before the editor had columns has no record of it,
        // and restoreLayout puts everything no stored row accounts for in the
        // last column as ordinary tabs — never dropping one, since the persist
        // effect files whatever comes out of here as the vault's WHOLE session
        // (issue #8). The link is an instruction and the session only a
        // default, so the link's note is what comes to the front — when it
        // actually came back. Built out here, not in an updater, because
        // StrictMode runs updaters twice.
        // Built in the STORED paths' space, which is the only one the stored
        // columns, focus and widths speak, then relabelled all at once to where
        // each document is now — so an arrangement whose note was renamed
        // mid-restore keeps its columns, its per-column focus and its widths
        // (see relabelPaths for why not renamePath one at a time).
        const restoredLayout = relabelPaths(restoreLayout(
          origins,
          stored?.groups,
          stored?.focus,
          stored?.sizes,
          linkedNode && origins.includes(linkedNode.path) ? linkedNode.path : stored?.active ?? null,
        ), relabel);
        // Anything opened while the reads were in flight — a click in the file
        // tree — is MERGED, never deferred to. Deferring is what turned
        // 5de752e's separate link opener into data loss: it opened the linked
        // note a moment before these reads finished, this pass saw a tab and
        // gave up, and since the refs were already claimed the persist effect
        // filed that one tab as the vault's whole session (measured under the
        // pre-transposition model, and the arithmetic is unchanged by it: four
        // documents in three tabs, one a 65/35 split, came back from a reload as
        // the one tab the address bar named, with the stored `paths` rewritten
        // from four to that one — so every reload after it restored nothing more
        // either). The saved arrangement comes back as it was left; what was
        // opened meanwhile follows as TABS of its focused column (mergeLayouts —
        // one or two clicked notes are not an arrangement the reader asked for,
        // and appending columns could breach MAX_PANES), keeping the focus; and
        // a document open on both sides keeps its in-memory tab, which may hold
        // edits. The gate opens BEFORE the merge is dispatched, so the commit
        // carrying it writes the session. One ordering still writes a lone tab
        // first: a click that committed just before this line, its effects not
        // yet run, has them flushed ahead of the merge's render — one tab
        // stored for the task or two until the merge's own write. flushSync is
        // not used to close it: only a reload landing in that gap could cost
        // anything.
        release();
        setTabs(prev => {
          const open = new Set(prev.map(t => t.file.path));
          return [...restored.filter(t => !open.has(t.file.path)), ...prev];
        });
        setLayout(prev => mergeLayouts(restoredLayout, prev));
      } catch (err) {
        incomplete = true;
        console.error('The saved tabs could not be restored; the saved session is kept as it was:', err);
      } finally {
        if (!incomplete) release();
        clearTimeout(indexTimer);
        if (restorePendingRef.current === pending) restorePendingRef.current = null;
        // The link has been dealt with, whichever way this ended. On success
        // this lands in the merge's batch, so the writer sees the note active
        // and nothing pending in one commit — no flash of the bare vault.
        if (linkedNode) setPendingLinkFile(null);
        indexRestoreSettled();
      }
    })();
  }, [fileTree, rootHandle, currentVaultId, readFileVersioned, rememberAssetRefs, seedPdfBaseline, recentVaults, initialLocation, resolveVaultFile, isLoading, indexRestoreSettled, seedDocumentBuffer, documentBuffers, assetRefsRef, boardBaselinesRef, currentVaultIdRef, layoutRef, linkPendingRef, restorePendingRef, restoringRef, rootHandleRef, sessionRootRef, sessionVaultIdRef, setLayout, setPendingLinkFile, setTabs, vaultMovesRef]);

  // A vault taken off the recent list (the minus in the vault menu) mints a new
  // id if it is ever opened again, so its stored session would be unreachable
  // weight. Nothing prunes by staleness — a vault returned to a year later
  // still opens where it was left, the same call fileScrollAnchors makes.
  // "Has the list ever loaded" rather than "is it empty now", because those are
  // not the same question and an emptiness test answers the wrong one: forgetting
  // the LAST row is a real transition to zero, and skipping it left that vault's
  // session behind forever — the one case where the help doc's "taking a vault
  // off that list forgets its tabs" was false. (Reachable because the open
  // vault's row has no minus, so a single removable row means the open vault is
  // absent from the list, which is what a failed `recordVault` leaves behind.)
  const sawVaultList = useRef<boolean>(false);
  useEffect(() => {
    if (recentVaults.length > 0) sawVaultList.current = true;
    if (!sawVaultList.current) return;   // the list has not loaded yet
    pruneSessions(recentVaults.map(v => v.id));
  }, [recentVaults]);
}
