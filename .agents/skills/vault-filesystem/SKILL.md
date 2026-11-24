---
name: vault-filesystem
description: How this app reads and writes the user's real files — the File System Access layer (FileSystemContext), create/rename/move/trash and the Trash bin, the overwrite rules (freeEntryName, the createFile hole), per-folder .Assets/.Garbage and asset retirement, board media, old boards' editable copies and conversion backups, outside-change detection and versioned writes, hidden entries, and the recent-vaults list and vault switching. Load before changing anything that touches the user's disk, adds a caller of createFile, writes into .Assets/.Garbage, or moves/renames/deletes/switches anything.
---

# The vault: reading and writing the user's real files

There is no backend and no undo stack behind these calls — a mistake here destroys the user's notes.
AGENTS.md's rule holds everywhere: **nothing the user made is destroyed outright**, and a wrong call that
keeps a file beats a right one that cannot be undone.

## The layer
- `context/FileSystemContext.tsx` is the only code that touches the File System Access API, on the main
  thread. The one worker exception is `context/vaultIndex/reader.ts`, which reads file handles the main
  thread sends it and never lists, prompts or mutates.
- Everything else uses `useFileSystem()`. The value is one memoized object (a fresh one per provider render
  went straight through every `React.memo`). Main groups:
  - text/binary: `readFile`/`writeFile`, `readFileBytes`/`writeFileBytes`, `readFileSnapshot` (immutable
    Blob, see `epub-reader`), `handleIO` (raw handle ops for caches and the agent);
  - documents: `readFileVersioned`/`readBytesVersioned`/`statFile`/`writeFileVersioned`/
    `writeConflictCopy`/`writeDistinctCopy`/`recreateFile`/`resolveFileHandle`, `subscribeVaultChanges`,
    `liveDetection`;
  - entries: `createFile`/`createFolder`/`nameTaken`, `importFiles`, `moveFile`/`renameFile`/`moveToTrash`;
  - Trash: `listTrash`/`restoreFromTrash`/`deleteFromTrash`/`emptyTrash`/`copyTrashFile`,
    `keepCopyInGarbage`, `keepConversionBackup`/`restoreConversionCopy`;
  - pictures: `getAssetUrl`/`saveAsset`/`retireAsset`/`restoreAsset`; board media `readBoardAsset`/
    `putBoardAsset`/`readLegacyBoardAsset`, an old board's copy `writeBoardCopy`; notebook export `inspectExportTarget`/`writeNotebookExport`;
  - vault: `pickDirectory`/`restoreVault`/`openRecentVault`/`openFolderAsVault`/`openLinkedVault`,
    `forgetRecentVault`/`pinRecentVault`, `ensureVaultId`, `getVaultActivation`, `registerBeforeRootChange`,
    `resolveVaultDir`/`resolveVaultFile`/`verifyVaultFileIdentity`/`vaultDirExists`.

## Load-bearing facts
- The root handle is persisted in IndexedDB (`idb-keyval`, key `vault-directory-handle`). On mount,
  `queryPermission` silently restores a `granted` vault; a `prompt` one shows "Restore Previous Vault"
  (`requestPermission` needs a gesture).
- **`readFile` decodes strict UTF-8 (`decodeDocumentText`) and normalizes `\r\n?` → `\n`.** CodeMirror does
  the same, so buffers, saves and search offsets agree; a reader that skips it drifts on CRLF. Strict
  decoding also rejects ZIP/PDF signatures and NUL bytes, so a renamed binary cannot gain text authority.
- `writeFileBytes` writes the *view*, not `.buffer`, so a subarray does not write its whole buffer.
- **`withMutation`** wraps every own mutation (create, import, saveAsset, moves, renames, trash, restore,
  empty, retire/restore, conflict/distinct copies, recreate, board media, backups, exports). The watcher
  holds its batches until the count returns to 0 and processes them once, so a copy-then-delete is never
  drawn half-done and App's own fix-ups land first.
- **`getVaultActivation()`** is a synchronous number that changes on every vault switch, including A→B→A.
  Long work captures it before its first await and checks it before each irreversible step; a reusable
  directory handle is NOT an identity.

## There is no native move
`moveFile`/`renameFile`/`moveToTrash` are **copy-then-delete**; folders recurse via `copyDirRecursive`
(which copies `.git` too). `moveToTrash` takes a folder like a file — into the `.Garbage` beside it
(`math/units` → `math/.Garbage/units`), its own `.Assets`/`.Garbage` included, so the trashed copy is as
self-contained as the folder was. `.Garbage`/`.Assets` themselves are refused (copying one into itself
never ends).

**Trashing a folder is the app's only unbounded-duration operation**, and every rule follows from that:
1. **All-or-nothing.** The original is removed (`{recursive:true}`) only after the copy completes; a throw
   takes the copy back out before returning false. Without that, a refused `removeEntry` left a complete
   second copy in `.Garbage` per retry. Removing it is safe only because `freeEntryName` certified the name
   moments earlier — it is not a licence to prune `.Garbage`, which nothing does.
2. **Serialized**: `useTrashActions.handleTrash` holds `trashInFlightRef` (from `useVaultMoves`) across the
   **question and** the copy, with `Moving "…" to Trash…` in the status line — the row stays on screen for
   seconds, which invites a second click (measured: two concurrent copies, one abandoned half-written).
3. **Pending saves flushed BEFORE the copy, and `reconcileQueueRef` drained**, so a debounced write cannot
   land on an original the copy already read, and no `retireAsset` moves a picture mid-walk.
4. **Then every open tab the deletion took is closed** — a `path/` prefix for a folder and nothing else
   (sibling `units2` survives); the equality branch is gated to files because the Help guide's pseudo-path
   is a bare name.
The agent's trash is `performTrash` without the question, under the same ref.

## The Trash bin (`listTrash`, `utils/trash.ts`, `components/TrashPanel.tsx`, `app/trashBin.tsx`)
- `walkForTrash` and its collectors (`collectGarbage`, `buildTrashedDir`, `collectRetired`,
  `measureLiveAssets`) are the only code that walks INTO a `.Garbage`. The crawl is **deliberately
  uncached** (it runs on a click, never on a save, never subscribes to `saveEpoch`), holds metadata only,
  re-crawls on every open, and skips an unreadable folder rather than failing.
- **An item belongs to the parent of the OUTERMOST `.Garbage` on its path** — carried down, never
  recomputed, nothing persisted. So nested children restore flat beside that `.Garbage`.
- Listing at every depth: a file or non-dot folder directly in `F/.Garbage` is a row (folders drill);
  `F/.Garbage/.Assets/*` are **retired** pictures, restored into `F/.Assets`; `F/.Garbage/homework/.Assets`
  is that folder's live pictures — never listed, they travel back with it; anything in a **nested**
  `.Garbage` is hoisted to the bin root with destination `F/` (deleted before its folder was).
- **Put-back never uses `moveFile`/`renameFile`** (they overwrite/merge). `restoreFromTrash` mode `'auto'`
  returns `'collision'` with nothing touched; App asks the app's only three-way question (`askChoice`).
  **"Replace" displaces**: the live entry moves into its folder's own `.Garbage` and comes back as
  `displaced`. `displaceInto` is shared with `moveToTrash` (change one, change both). `deleteFromTrash`/
  `emptyTrash` are the only calls that destroy user content with no copy surviving.
- Mutating bin actions take `trashInFlightRef` and drain the reconcile queue; a Replace closes tabs at or
  under the displaced path. `ask`/`askChoice`/`tell` go through `raise`, which settles a displaced question
  as cancel — otherwise its caller's in-flight ref stays true forever.
- Appearance is not restored (`forgetEntry` dropped it at trash time). The preview is text and images only,
  so the bin never pulls a PDF or board engine into its chunk.

## Nothing overwrites an existing file by accident
- Every write that could land on a taken name goes through **`freeEntryName`** (" (1)", " (2)", …), which
  counts **files and folders** and numbers a folder's whole name. `nameTaken` (`entryExists`, two positive
  lookups) is the one check the create handlers and the agent use.
- Deliberate exceptions: **`moveFile`/`renameFile`** (an explicit move onto a name is the user saying so) and
  **`writeNotebookExport`**, which replaces its target only against an `expected` `DiskVersion` and first
  keeps the old file in that folder's `.Garbage` (`freeEntryName(trash, name)`); with no `expected` it refuses a taken name.
- **`createFile` is the hole**: `getFileHandle(name,{create:true})` opens-or-**truncates**. It is guarded one
  level up at `useCreateEntries.handleCreateFile`/`handleCreateFolder` (both kinds checked, `tell` on a hit,
  `.epub`/`.pdf` refused as "import the original") and in the agent host. Routing it through
  `freeEntryName` would silently create `note (1).md` while the caller opened `note.md`. **Anything new that
  calls `createFile` inherits the hole.** Writers that must never truncate (`.VaultAgent/`, conflict/
  distinct copies, staging) create only on a name proven free.
- **What a note is CALLED is not its file name.** `noteDisplayName` (`/\.md$/i`) strips `.md` for display
  only; the rename input is seeded from the full `node.name`, because `renameFile` takes it verbatim (a
  stripped name would create `A` and delete `A.md`). Only `.md` is ever hidden.
- **When the overwritten name is open, its tab is released without a flush** (`useTabLifecycle.
  releaseOverwritten`) — on **every** overwrite, not just when the moved file is open (measured: a closed
  file's rename let the destination tab's autosave revert it a second later), and **before** the survivor's
  per-path state (`movePdfRenderData`, `moveAssetRefs`) is re-keyed, or it wipes the survivor's. Tabs are
  told apart by `OpenTab.id`, not path (`tabs-and-panes`).

## A rename or move carries every open document — a folder's included
`useRenameMove.retargetTabs` (both `handleRenameFile` and `handleMoveFile`) re-points every tab under the
`path/` prefix rather than closing it.
- New handles are walked down from the **vault root** (`resolveVaultFile`), not read from `fileTree`, which
  may not have committed the rename's own refresh yet.
- The overwrite pass covers **every destination**: a move onto an existing folder MERGES, so each file inside
  overwrites its destination and that tab must be released whether or not the replacing file is open.
- `retargetExpanded` keeps disclosure state. The core is path-based (`retargetPaths`/
  `retargetExpandedPaths`), so a rename noticed ON DISK (`useOutsideChanges.followDiskMove`, inside
  `trackVaultMove`) runs the same fix-ups: tabs, layout, styles and custom order, render caches, asset refs,
  reader records (`moveReaderViewState`), pending restore.
- A **cross-kind** rename (e.g. `.md` → `.txt`, or to/from a binary kind) preserves the latest live revision
  after the destination is acquired, repeats if editing continued meanwhile, and commits tab + layout
  synchronously with no await between. Binary destinations get empty content and reacquire; PDF edits are
  preserved as rebuilt PDFs. A failed preservation keeps the old editor.

## The tree
- Walked whole only on a vault open, a rescan or `refreshTree` (dirs first, alphabetical). Every published
  tree goes through `shareTree` (`utils/treeShare.ts`): unchanged nodes keep identity, so memo'd rows
  re-render only for what changed, and a no-change walk keeps the `fileTree` reference. A node's
  `parentHandle` IS its parent node's `handle`.
- Publishing is **ticketed** (`publishTree`): a walk publishes only if no later-started walk already has and
  its root is still open; root and tree are written only via `commitRoot`/`commitTree`.
- **The walk is all-or-nothing, on purpose**: a folder whose listing throws fails the whole tree as a
  `FolderReadError` naming it, and a startup walk turns that into `vaultProblem` (the problem screen) — never a
  partial tree, because tabs, restore, the index and asset retirement all read a missing entry as deleted.
- **Startup never waits silently** (`openAtStartup`, `startupRef` tickets, `utils/startupProgress.ts`): the mount's
  reopen, "Restore 'X'" and Try again each report their step (and the walk its pending folders) for the loading
  screen and one console line; `isLoading` is settled in a `finally`, and a vault opened from the loading screen
  supersedes the startup, whose late writes then no-op (`recordVault` also re-checks the root before setting the id).
  The `b58f06ad` permit placement in `listDir` (one directory's enumeration per permit) is load-bearing.
- **Do not refresh the tree for something it cannot show** (a picture written into a hidden `.Assets`).
- **Hidden entries — ONE predicate**, `utils/vaultEntries.ts` `isHiddenVaultEntry` (the observer's
  `isIgnoredChangePath` is built on it): `.Assets`, `.Garbage`, `.DS_Store`, `.appearance.json` per folder;
  `.git` and `*.crswap` at any depth (`.git` is never even walked); at the root only, `.folders.json` (legacy
  looks) and `ROOT_HIDDEN_DIRS` (`utils/vaultAgentStore.ts`: `.VaultAgent`, `.claude`, `.agents`, `.codex`,
  `.opencode`). Graph and search inherit it from the tree; the agent's `vault_list` reads disk and hides
  only `.git` unless asked.

## What a save may NOT cost
A cache hit still costs one `getFile()` round trip per note (before #58 a 1,000-note vault paid 1,004 per
autosave). So:
- **`flushTab` primes, never re-reads**: it captures `indexGraphRef.current` before IO and, only while that
  root/activation still owns it, calls `client.prime(path, mtime, size, text)`. A closing save never primes
  the incoming vault. Graph publication is fenced twice (worker generation, then the live-owner check in
  React's updater).
- **Sweeps are for somebody ELSE's write** (a tree change, a rescan, a vault open), never ours.
- **No `Promise.all` over the vault**: `utils/pool.ts` (`mapPool`, `Limiter`, `VAULT_CONCURRENCY`); one
  `Limiter` spans a whole recursion.
- The index starts after session restore and the first pane's paint, then on idle (a search can demand it
  sooner); worker IO yields to foreground document reads. Search text is the activation-owned worker
  index's (4 MiB/file, 128 MiB total, admitted in tree order, `searchResidency.ts`), optionally persisted
  per vault in IndexedDB — never in the vault. Dirty open buffers overlay disk. Deterministic text refusals
  are cached by stat as negative results; IO failures retry. Index facts never authorize an asset retirement.

## Changes made outside the app (`FileSystemObserver` + versioned writes)
**Observer records are HINTS; a stat — and a SHA-256 of the raw bytes when the stat moved — is the truth.**
- One recursive `FileSystemObserver` per root (StrictMode-safe, generation-guarded): records →
  `normalizeRecords` (ignored paths dropped first) → coalescer (100 ms trailing, 500 ms ceiling) → one
  serialized `processVaultBatch`: re-list only dirty parent dirs, splice, `shareTree`, publish if changed,
  then always emit to `subscribeVaultChanges`. More than `MAX_DIRTY_DIRS` (64) or `rescan` → one full walk.
  `modified` never touches the tree, so our own autosaves cost it nothing.
- Fallback (no observer, `observe()` rejected, or `errored` plus a failed re-observe): `liveDetection:
  'polling'` — rescans on focus/visible (throttled 3 s) and every 15 s while visible.
- `readFileVersioned` hashes raw bytes then decodes (one retry on `NotReadableError`); `statFile` is null
  only for NotFound/TypeMismatch (a lock throws — it is not a deletion). **`writeFileVersioned(handle, data,
  expected)`**: missing → `deleted` (never recreates); stat equal → write; stat moved → hash equal writes,
  different → `changed` with the disk bytes. A check-to-write window remains; no API closes it.
- `writeConflictCopy(path, data, vaultRoot?)` → `stem (conflict).ext`, `(conflict 2)`…, name proven free
  (files and folders), deleted parents recreated (`ensureDirChain`); `vaultRoot` because a switch's closing
  flushes run after `rootHandleRef` names the next vault (measured: copy landed in the wrong vault).
  `writeDistinctCopy` is the same fresh-file transaction for a new sibling (the PDF "unsigned copy") and
  finishes once started, even if its pane closes. `recreateFile` writes only if nothing is there.
- App's half — baselines, `checkOpenDocs`, reload in place, the DiskBar, rename pairing by a `moved` record
  or a unique same-size same-hash file — is in `tabs-and-panes`.

## `.Assets` and `.Garbage` are per FOLDER (`utils/assets.ts`)
A picture pasted into `math/units/unit1.md` goes to `math/units/.Assets`; deleting that note moves it to
`math/units/.Garbage`. A folder carries its pictures and deletions wherever it goes. **`utils/assets.ts` owns
both names; nothing else spells `'.Assets'`.**
- **Resolution consults the note's own `.Assets` only**; `getAssetUrl` walks **up** the ancestors on a miss,
  purely for old vaults whose pictures went to the root (and for the Help guide). Nothing ever wrote an
  asset sideways, so up is exact. `ancestorsOf` descends from the root (a handle knows nothing above it).
- **Retired, not erased**: when the last reference goes, `useAssetLifecycle.reconcileAssets` → `retireAsset`
  moves it into `<folder>/.Garbage/.Assets`; `restoreAsset` puts it back when the reference returns (⌘Z
  after deleting an embed is whole again). Same name, own sub-folder: exact inverse, never confused with a
  user-trashed file.
- **Reconciles are serialized** (`reconcileQueueRef`) — raced, remove-embed / undo / late retire loses the
  picture. A reconcile belongs to **one activation**: `retireAsset`/`restoreAsset` require a guard checked
  before copying and right before removing the source; a late copy may leave both copies, never delete one.
- **The diff is against the last SAVED text** (`assetRefsRef`), not per keystroke; the 1 s debounce is the undo
  grace. A failed write leaves the baseline, so a later save still reconciles.
- **Nothing is retired while a neighbour still shows it**: the folder's notes **and its whole subtree** are
  consulted (open tabs from their buffers), one note's text at a time, stopping once every dropped name is
  spoken for. An asset living *above* its note is never retired — fails toward keeping.
- **Board media** (drawings/notebooks) is content-addressed: `putBoardAsset` writes `<sha256>.<ext>` into the
  board's folder `.Assets` (≤ 10 MiB, hash verified before and after, staged as `.incoming-<uuid>` under
  `freeEntryName`, one serialized queue, owner + activation re-checked at every step, only our own staging
  file removed). `readLegacyBoardAsset` resolves an old board's relative `src` with strict path checks
  (no scheme, no escape above the root, never `.VaultAgent`, ≤ 10 MiB).
- **An old board's editable copy** (`writeBoardCopy`; old boards are never written, see `pdf-and-drawings`): in the
  board-asset queue and one mutation, it stores the copy's pictures as `putBoardAsset` does, builds the bytes from
  the stored names, takes the first free name from the caller's list (`entryExists`: files AND folders, as
  `freeEntryName`), writes it with `getFileHandle({create:true})` on that proven-free name, then verifies the stat
  and a read-back fingerprint. On ANY failure it removes only the file it created (`isSameEntry`) and RETIRES the
  pictures it added (never `removeEntry` on a picture), so nothing half-written is left beside the original.
- **Conversion backups** (old annotated PDFs; boards an EARLIER build converted in place): `keepConversionBackup`
  copies the verified source bytes into the folder's `.Garbage` before a PDF conversion — or, when a verified copy of
  those exact bytes is already there under `freeEntryName`'s names, returns it (conversion and first save both ask); `restoreConversionCopy`
  brings one back as a **separate copy** beside the file, never over it. A board an earlier build converted in place
  recorded no digest: `app/conversionRestore.ts` finds its backup by content (`utils/conversionRestore.ts`
  `matchesConversionEvidence`: verbatim envelope, shape ids, kept records), preferring the board's own folder's Trash, and
  restores nothing when two different files fit. The tree offers the row only for PDFs and boards made from an old one. `keepCopyInGarbage` is the generic "preserve these bytes" path (a failure
  must stop the caller's rebuild).

## Recent vaults and switching (`context/recentVaults.ts`, `utils/recentVaults.ts`, `VaultMenu.tsx`)
- The list lives in IndexedDB `recent-vaults`, capped at `MAX_STORED_VAULTS` (30); the menu shows Settings →
  "Recent vaults shown" (`recentVaultLimit`, clamped on read). **Pinned** vaults (`StoredVault.pinned`) sit
  outside both caps. Unknown stored keys are not shape-checked (older entries read as unpinned).
- **An unreadable list is never an empty one** (`readList` retries, the last time over its own connection, then
  throws): every mutation writes back what it read, and "unreadable = []" once re-minted the open vault's id over the
  whole list, orphaning its session and pruning every other vault's. Never open `keyval-store` with a version.
- **The handle is what's stored, so `isSameEntry` is the only identity test** (two handles for one folder are
  always distinct objects). Every read-modify-write goes through one module-level promise queue — StrictMode
  double-mounts would otherwise mint two ids for one folder.
- Duplicate folder names are qualified with a parent only when another known vault contains it
  (`a.resolve(b)` is the only ancestry the API exposes); otherwise both show the bare name.
- `StoredVault.id` keys the vault's browser state: its tab session and the `scopedKey` records. **Forget**
  (`forgetRecentVault`, the row's minus; never on the open vault, which re-records itself) deletes the
  session (`pruneSessions`) and orphans the path-keyed records; a re-opened folder starts fresh.
  `utils/storagePersistence.ts` `requestPersistentStorage()` runs on each open — eviction would lose every
  handle, with no path to rebuild them.
- **ONE vault switch at a time across every raiser** (`switchInFlightRef` in the provider; measured split
  state when each raiser guarded only itself). A blocked call returns `'busy'` and the menu says so; the
  tree row stays silent. **A switch walks BEFORE it commits** (`loadTree`), awaits App's
  `registerBeforeRootChange` drain (every open tab saved), then sets root and tree in one synchronous burst
  so they never describe different vaults.
- **Re-opening the open vault is a no-op** (`isCurrentVault` via `isSameEntry`; measured: re-picking it
  closed 7 tabs and overwrote the session); `pickDirectory` keeps the existing handle and only rescans.
  One picker at a time (`pickerOpenRef`); `pickDirectory` returns a `VaultOpenResult` (`'busy'`, cancel =
  `'ok'`, unsupported browser = error).
- Opening a row re-requests a lapsed permission (it is a click) and touches the folder before committing; a
  missing folder is dropped from the list with a reason. "Open as Vault" in the tree is `openVaultHandle`
  directly (no picker) and holds an in-flight ref over the switch and its error dialog. A `#vault=` link
  whose permission lapsed waits on `openLinkedVault` from a click.
- Menu details that were each a bug once: single click lists / double click browses (read from `detail`, not
  a timer); focus is read from the DOM (`rowsIn`/`focusedRowIn`), and after a removal returns to the
  successor's control of the same kind; the width is computed from the anchor so long names stay on screen.

## Verify
Drive the real app per `verify-in-browser` (OPFS-stubbed vault): after a change here, check the file on disk,
the tree, open tabs, and `.Garbage` — and repeat the gesture twice quickly, since double clicks are what
these rules were written against.
