---
name: vault-filesystem
description: How this app reads and writes the user's real files — the File System Access layer, create/rename/move/trash, the overwrite rules, per-folder .Assets/.Garbage, asset retirement, and the recent-vaults list. Load before changing anything that touches the user's disk, adds a caller of createFile, or moves/renames/deletes anything.
---

# The vault: reading and writing the user's real files

`context/FileSystemContext.tsx` is the **only** thing that touches the File System Access API.
Everything else goes through `useFileSystem()`: `readFile`/`writeFile`, binary
`readFileBytes`/`writeFileBytes`, `createFile`/`createFolder`, `moveFile`/`renameFile`/`moveToTrash`,
`importFiles`, `getAssetUrl`/`saveAsset`/`retireAsset`/`restoreAsset`,
`pickDirectory`/`restoreVault`/`openRecentVault`/`openFolderAsVault`.

There is no backend and no undo stack behind these calls — a mistake here destroys the user's notes.

## Load-bearing FS facts

- The root directory handle is persisted in **IndexedDB** (`idb-keyval`, key
  `vault-directory-handle`). On mount, `queryPermission` (no user gesture needed) silently restores
  a `granted` vault; a `prompt` vault instead surfaces a "Restore Previous Vault" button
  (`requestPermission` *does* need a gesture).
- **`readFile` normalizes `\r\n → \n`.** Not cosmetic: CodeMirror normalizes the same way, so tab
  buffers, saved output and vault-search match offsets all stay in agreement. The vault-search cache
  normalizes identically.
- `writeFileBytes` hands the *view*, not `.buffer`, so a subarray does not write the whole buffer.

## There is no native move

`moveFile`/`renameFile`/`moveToTrash` are **copy-then-delete**; folders recurse via
`copyDirRecursive`. `moveToTrash` takes a **folder** the same way it takes a file — into the
`.Garbage` beside it, so `math/units` lands in `math/.Garbage/units` — carrying everything under it,
its own `.Assets` and `.Garbage` included, which is what makes the trashed copy as self-contained as
the folder was. `.Garbage`/`.Assets` themselves are refused: neither is in the file tree, so nothing
can ask, but copying one into itself is unbounded recursion.

**Trashing a folder is the app's only unbounded-duration operation**, and the four rules below all
follow from that one fact. Every one was measured to be reachable by an ordinary gesture before it
existed.

1. **It is all-or-nothing.** The original is removed only once the copy completes
   (`{ recursive: true }`), and anything that throws takes the copy back out again before returning
   false — so a failure really does mean the item is still where it was. Without the rollback the
   *realistic* failure (the copy succeeds, `removeEntry` is refused because a file inside is still
   being written) left a **complete** second copy in `.Garbage`, and each retry added another
   numbered one — in Finder, indistinguishable from a good backup. Removing it is safe only because
   it is ours: `freeEntryName` certified the name free moments earlier and nothing else may be
   trashing concurrently. It is not a licence to prune `.Garbage`, which nothing does — though
   `restoreAsset` does legitimately *take a file back out* of `.Garbage/.Assets`.
2. **`App.handleTrash` serializes it** (`trashInFlightRef`, the shape of `pickDirectory`'s
   `pickerOpenRef`). The folder's row stays on screen for the whole copy, so "nothing happened, click
   again" is the natural response; unguarded, two copies ran at once, one was abandoned half-written
   when the source vanished under it, and the loser's `alert` told the user a deletion that had
   **succeeded** had failed. The status line says `Moving "…" to Trash…` for the duration, because a
   copy with no outward sign is what invites the second click. Because `ConfirmDialog` does not
   freeze the page the way `confirm()` did, that guard must cover the **question** as well as the copy.
3. **Pending saves are flushed BEFORE the copy, and the reconcile queue drained.** Those tabs stay
   live and editable throughout, with their timers armed, so a debounced write would land on an
   original the copy had already read and `removeEntry` was about to destroy — the edit surviving or
   not came down to where the note fell in an arbitrary `entries()` order. Flushed rather than
   cancelled, so the trashed copy carries the reader's last words. Draining `reconcileQueueRef` next
   stops a `retireAsset` moving a picture between `.Assets` and `.Garbage/.Assets` while
   `copyDirRecursive` walks one of them.
4. **`handleTrash` then closes every open tab the deletion took** — for a folder, every document
   under its path. The match is a `path/` prefix and, for a folder, **nothing else**: a sibling
   `units2` is not caught, and the equality branch is gated to files because the Help guide's
   pseudo-path is a bare name, so a vault folder called `help-guide` closed the Help tab. Left open,
   those tabs draw notes that no longer exist, hold handles that resolve to nothing, and are written
   straight back into the stored session.

## Nothing overwrites an existing file by accident

Every write that could land on a taken name goes through `freeEntryName` (" (1)", " (2)", …) —
imports and the trash. It counts **both kinds** of entry as taken, whatever kind is being written (a
file and a folder cannot share a name, and asking only about files reported a name free while a
folder of it sat there — reachable as soon as folders can be trashed), and numbers a folder's whole
name rather than treating its last dot as an extension. Deleting the same name twice used to destroy
the first copy at the exact moment the user was relying on it being kept.

`moveFile`/`renameFile` are the **deliberate** exceptions — an explicit move onto a name is the user
saying so.

**When the overwritten name is open, its tab is released without a flush and its pane closed**
(`App.releaseOverwritten`) — otherwise one path ends up in two tabs, drawing one document under two
names, and flushing the dead buffer would write it straight back over the file that just replaced it.
Three things about that release are each load-bearing, and each was got wrong once:

- It runs on **every** overwrite, not only when the file being renamed is itself open. The hazard
  belongs to the tab holding the *destination* name, whose handle still resolves to that directory
  entry; sitting below the handler's `if (!openTab) return` guard, it let a rename from a closed file
  leave that tab's autosave to put the old bytes back over the new ones (measured: `beta.md` reverted
  to its pre-rename content a second after the rename).
- It runs **before** the moved document's own per-path state is re-keyed onto that path
  (`movePdfRenderData`, `moveAssetRefs`). `releaseTab` clears exactly those two slots, so running it
  second wiped the *survivor's* rather than the loser's: an annotated PDF's parked original and
  overlays went, so its next save found nothing and silently wrote nothing, and a note's asset
  baseline went, so its `.Assets` diff was dead for the rest of the session.
- A path is not enough to tell the two documents apart, because for one commit they share one.
  `OpenTab.id` is what does — see the `tabs-and-panes` skill.

**`createFile` is the one hole in that rule, and it is guarded one level up.** The primitive is
`getFileHandle(name, {create:true})` with no `freeEntryName` and no question, so it
opens-or-**truncates**: "New note" onto an existing name empties that file, with no warning, no undo,
and a tree that looks exactly as it did a moment before. The guard is at the one user-facing entry
point — `App.handleCreateFile` (and `handleCreateFolder`), which asks for **both** a file handle and
a directory handle by that name and on a hit raises `tell` and creates nothing. There rather than in
the primitive on purpose: routing `createFile` through `freeEntryName` would quietly create
`note (1).md` while the caller went on to open the name it had asked for, and the other caller (the
annotated-PDF path) genuinely wants create-or-open. **The primitive itself is still unguarded, so
anything new that calls it inherits the hole.**

> Note: `App.tsx`'s `nameTaken` and `FileSystemContext.tsx`'s `entryExists` are two **independent**
> implementations of the same "taken by either kind" rule. They are not shared code. Change both.

## A rename or a move carries every open document with it — a FOLDER's included

`App.retargetTabs`, which `handleRenameFile` and `handleMoveFile` both go through. For a file that
is the file; for a folder it is every tab under its `path/` prefix, **re-pointed rather than
closed** — the same document, at a new name. Missing that, a folder rename left its notes open on
paths that no longer existed, holding handles into a directory that had just been removed: every
keystroke after it logged "Auto-save failed" and went nowhere, the tree highlighted nothing, and the
stored session named a file that was gone. Three things about it:

- New handles are walked down from the **vault root** (`resolveVaultFile`), not read out of
  `fileTree`. This runs after an await, and the tree is React state the rename's own `refreshTree`
  may not have committed yet — the answer has to be exact rather than probably-current.
- The overwrite pass runs first and covers **every destination**, not only the moved documents'. A
  rename or a move onto an existing folder MERGES, so each file inside overwrites whatever sat at its
  destination, and the tab holding that destination has to be released whether or not the file
  replacing it is itself open. The source paths come from the node's own `children`, the last
  description of the folder before it moved.
- `App.retargetExpanded` moves the tree's disclosure state the same way, so a renamed folder does not
  collapse itself and everything the reader had opened inside it.

Every mutation rebuilds the whole tree from scratch via `refreshTree` (dirs-first, alphabetical).
Hidden from the tree: `.Assets`, `.Garbage`, `.DS_Store` — the first two **per folder**.

## `.Assets` and `.Garbage` are per FOLDER (`utils/assets.ts`)

Both hidden folders belong to the folder they sit in, not to the vault. A picture pasted into
`math/units/unit1.md` is written to `math/units/.Assets`, and deleting that note moves it to
`math/units/.Garbage`; only a note at the vault root uses the root's. So a folder carries its own
pictures and its own deletions: move it, copy it out, or hand it to someone else and its notes still
render, and two folders each holding a `notes.md` no longer pile their deletions into one bucket at
the top of the vault. **`utils/assets.ts` owns both names plus the note-side rules; nothing else
should spell `'.Assets'`.**

- **Resolution consults the note's own `.Assets` and nothing else** — one directory lookup whatever
  the vault's depth, and a picture is never served out of a folder the note has nothing to do with.
  `getAssetUrl` walks **up** the ancestors only when that misses, purely for backwards compatibility:
  assets landed in the vault ROOT's `.Assets` before local ones existed (through commit `31ffe91`),
  and still do for a document with no folder of its own (the Help guide). Up is the *exact* direction
  — nothing has ever written an asset sideways — so the walk reaches every misplaced one without ever
  searching the vault. `ancestorsOf` derives the chain by descending from the root, because a handle
  knows its own name and nothing above it.
- **An asset is retired when the last reference to it goes** (`App.reconcileAssets` → `retireAsset`),
  into `<folder>/.Garbage/.Assets`. Retired, not erased, because unlike deleting a file this follows
  from an *edit*, with no confirmation in between — and `restoreAsset` puts it straight back when the
  reference returns, which is what makes ⌘Z after deleting an embed whole again. That round trip is
  why retired assets are parked under their own name in their own sub-folder rather than among the
  trashed files: same name, exact inverse, no chance of resurrecting a user-trashed file's bytes into
  `.Assets`.
- **Reconciles are serialized** (`reconcileQueueRef`, the same promise-queue shape as
  `utils/recentVaults.ts`). One pass can read a whole subtree while the saves that start them are a
  second apart, so they overlap easily — and raced, the classic sequence loses a picture: remove an
  embed (a long scan starts), undo (the next save restores the asset at once), then the first scan's
  retire lands on top and the note points at a file in `.Garbage`.
- **The diff is taken against the last SAVED text, not per keystroke** (`assetRefsRef`, seeded when a
  tab opens). Until a removal reaches the disk it isn't one; the 1s save debounce doubles as the undo
  grace period; and it is one regex pass per second instead of one per character. `flushTab` reads
  the baseline and replaces it **in one synchronous step, before the write**, then hands both sets to
  the async reconcile. Two things race that hand-over otherwise: `removeTab` drops the entry the
  moment after it calls `flushTab` (so a closing tab's last save has to capture first — it does,
  being synchronous up to the write), and a second save landing mid-reconcile would read a baseline
  the first had yet to replace and could retire a picture that save had just put back.
- **Nothing is taken away while a neighbour still shows it.** The set consulted is the folder's own
  notes **and its whole subtree**, with open tabs read from their *buffers* so an unsaved reference
  counts. The subtree is not optional: the legacy walk above means a note in any descendant folder
  may be resolving this very file, and going by the folder alone retired the picture out from under
  every one of them. It is affordable because it runs only when an embed was actually removed,
  same-folder notes come first, and the walk stops as soon as every dropped name is spoken for.
  **Every dropped name is answered in one pass holding one note's text at a time** — for a note at
  the vault root that subtree is the whole vault. The one remaining limit is deliberate and fails
  towards keeping the file: an asset that lives *above* its note is never retired at all
  (`retireAsset` only ever touches the folder it was given). `.Garbage` makes even a wrong call
  recoverable.

## Recent vaults (`utils/recentVaults.ts` + `VaultMenu.tsx`)

The explorer's vault button lists folders already opened as vaults rather than going straight to the
OS picker. A vault is just a folder, so `~/Notes` and `~/Notes/mathnotes` are two of them; the list
lives in IndexedDB under `recent-vaults` (capped at `MAX_STORED_VAULTS`), and how many the menu
prints is Settings → Vault → "Recent vaults shown" (`recentVaultLimit`, clamped on read like
`tabSize` — it reaches `Array.slice`). The store deliberately keeps more than the default 10 so
raising the setting later still has history to show.

- **The handle itself is what's stored**, because re-opening a vault needs a real handle and there is
  no path to rebuild one from. Which makes **`isSameEntry` the only identity test**: two handles for
  one folder are always distinct objects (a reload deserializes a new one out of IndexedDB, a re-pick
  mints another), and names collide freely. It is async, hence the module-level promise queue
  serializing every read-modify-write — StrictMode runs the provider's mount effect twice, and
  interleaved, both passes mint a different id for the same folder and the app ends up holding an id
  that isn't in storage.
- **A vault is listed by folder name alone, and a duplicated name is qualified with its parent —
  which has to be derived.** The API exposes a handle's `name` and nothing above it; the one thing it
  does expose is ancestry *between* two handles we hold (`a.resolve(b)`). So a duplicate is qualified
  whenever some other **known vault contains it** — which covers the case producing most duplicates,
  opening a vault's sub-folders as vaults. Two same-named folders with no opened vault above either
  both list as the bare name; nothing in the platform would do better, and inventing a qualifier
  would be worse than saying only what's known.
- **Single click lists, double click browses.** The gesture is read off the click's `detail`, not a
  timer: waiting out the double-click interval before showing the list would make the ordinary case —
  picking a vault you already have — the slow one. The cost is that the menu flashes open under the
  first click of a double-click. Keyboard activation reports `detail === 0` and lists; an empty list
  goes straight to the picker rather than making the user open a menu to reach it.
- **Each row carries a minus that forgets it** (`forgetRecentVault` on the context → the same
  serialized `forgetVault`). Every write to the list publishes through `publishVaults`, which
  re-labels first: a qualified `parent/name` is earned only while two listed vaults share a folder
  name, so dropping one of a pair has to leave the survivor as the bare name. Nothing on disk is
  touched, so there is no confirm in front of it, and `forgetRecentVault` reports whether the write
  landed — a refused one says so in the menu rather than leaving a dead click.
- **The open vault's row shows no minus**: every load re-records it (`recordVault`), so removing it
  would grow back before the user looked again. `.vault-menu-row` is a two-column grid, so that row
  and "Open folder…" keep every label on one x without a placeholder element to hold the gap.
- **The menu reads focus out of the DOM, not out of ref arrays** (`rowsIn`/`focusedRowIn` over
  `.vault-menu-row`). Rows are what shift when one is removed, and the row with no minus is exactly
  what would slide parallel arrays out of step. `Delete` is handled on the menu root beside the
  arrow keys — which walk rows only, since arrowing through twice as many stops would tax opening a
  vault to serve tidying the list. After a removal focus returns to the successor's button **of the
  same kind**; a minus click that handed focus to a vault row would arm the next `Enter` to open a
  vault nobody chose.
- **The menu's width is computed from its anchor, not just capped in CSS.** It hangs from the
  button's right edge, so the room it has is everything from the left of the screen to that edge;
  content-sized and unbounded, one long folder name pushed the whole menu off the left of the
  viewport with its shorter rows rendering outside the window entirely.
- **A folder in the file tree can be opened as a vault too** — `TreeNode`'s "Open as Vault" row →
  `App.handleOpenAsVault` → `openFolderAsVault`, which IS `openVaultHandle`, the same body
  `openRecentVault` runs (`openRecentVault` adds only "forget the row if the folder is `missing`").
  No picker: the handle is already in hand, so one would only ask the user to find the folder they
  just right-clicked. It records the vault, so the way back is the vault menu. App does no flushing
  or tab-closing of its own — setting `rootHandle` is the switch, and the vault-switch effect already
  flushes every open tab before emptying the workspace. It **holds an in-flight ref** covering the
  switch AND its error dialog, so a second right-click cannot stack a second question.
- **ONE vault switch at a time, across every raiser — `switchInFlightRef`, in the provider.**
  `refreshTree` is not serialized, so two switches at once are two vault walks racing and the
  LATER-FINISHING one wins the tree: the sidebar lists vault A while `rootHandle`, IndexedDB and the
  menu's current-vault check all say B, and a row clicked then opens A's handle under B's path. The
  tree starts that race easily — its old rows stay on screen until the new walk lands. Guarding each
  raiser separately does **not** stop it, which is what the per-raiser refs (`opening`,
  `openAsVaultInFlightRef`, `pickerOpenRef`) each did: measured, "Open as Vault" on a 40-file folder
  (walk ~4.5s) plus a recent-vault row clicked 260ms in produced exactly that split state. So the
  gate sits at the funnel both `openVaultHandle` and `pickDirectory` pass through; a blocked call
  returns **`'busy'`** — nothing happened, which is precisely what a caller with somewhere to say it
  must still say. The vault menu prints a neutral inline note in its `.vault-menu-error` element
  (deliberately not red — see the CSS comment) for **both** its raisers, the recent row and "Open
  folder…"; a row that greys and un-greys inside a walk running for seconds is the dead click
  `messageFor` exists to rule out. Only the tree row stays silent, having nowhere to put a note.
- **A vault switch WALKS BEFORE IT COMMITS, and commits in one synchronous burst.** `loadTree` (the
  walk, `null` on failure) is separate from `refreshTree` (the walk that leaves the current tree
  standing on failure) for exactly this: `openVaultHandle` and `pickDirectory` both call `loadTree`
  first, and only then do `set(IDB_KEY)` → `setRootHandle` → `setFileTree` with no await between the
  setters, so React batches them and `rootHandle` and `fileTree` are never seen describing different
  vaults. `setRootHandle` first and `await refreshTree` after left the app split for the WHOLE walk —
  the header, IndexedDB and `currentVaultId` on vault B, the sidebar still listing A's rows, nothing
  covering the tree — and `App.handleFileClick` on one of those rows opens A's handle under B's path.
  During the walk the app therefore stays wholly on the old vault, which is coherent: a row clicked
  then opens the old vault's file from the old vault. The one lag left is `recordVault`, deliberately
  still after the commit — `currentVaultId` trails by a tick and nothing reads it in between.
- Opening a row **re-requests permission when Chrome has let the grant lapse** (legal because it's a
  click), then touches the folder before committing the app to it — a vault deleted or moved since
  would otherwise just blank the sidebar. That entry is dropped from the list instead, and every
  failure says why in the menu: a click that silently does nothing is indistinguishable from a broken
  button.
- **Re-opening the vault that is already open is a no-op, and the provider has to say so
  (`isCurrentVault`), because App.tsx cannot.** The switch effect compares root handles by *object
  identity*, and the picker mints a fresh handle for the same folder every time — so picking the
  folder you already have open read as a switch and closed every tab (measured: 7 tabs → 0,
  `openTabPaths` overwritten with `[]`). `isSameEntry` is the only test that sees through that, so
  `pickDirectory` and `openRecentVault` both run it before touching `rootHandle`; the menu's own
  current-vault guard is by id and is absent whenever recording the vault failed. On a match
  `pickDirectory` keeps the handle the app is already using — its permission is live and every open
  tab's handle came from it — and only re-scans.
- **Only one folder picker at a time** (`pickerOpenRef`). Browsing is a *double*-click on the vault
  button, so with nothing in the recent list the first of those two clicks has already opened the
  picker and the second call rejects with `NotAllowedError` ("File picker already active"). That list
  is empty only when the IDB write failed — every path that sets `rootHandle` records it — which is
  exactly when the noise would be least welcome. **`pickDirectory` reports a `VaultOpenResult` like
  the other two raisers**, because "Open folder…" is a menu row and the menu closes on the result:
  refused by the switch gate it must come back `'busy'` and leave the menu up to say so, and while it
  returned void that row closed the menu, opened no picker and said nothing at all. A **cancelled**
  pick is `'ok'` — nothing failed, so the menu closes as it always did — and so is the unsupported
  browser's `alert` path being `'error'`. `FileExplorer.browseForVault` no longer closes the menu
  before the call; `VaultMenu.browse` owns that, mirroring its `activate`.
