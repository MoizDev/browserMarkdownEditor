---
name: tabs-and-panes
description: Open documents and how they are arranged — the flat tab list vs. the pane layout (utils/tabPanes.ts), where a document's content really lives (the App-owned buffer ledger and per-document sessions), the save funnel and versioned autosave, outside changes and the DiskBar, crash recovery, per-vault session persistence and restore, pane keying, the per-pane header and history, the tab strip, the dividers, and the agent's view registry. Load before changing tabs, panes, the tab strip, the save funnel, documentBuffers/documentSessions, what is restored on reload, or anything that opens, closes, renames or reloads a document.
---

# Open documents: a flat list, a layout, and a ledger

Three structures, each with one job:
- **`tabs: OpenTab[]`** (`app/useOpenDocuments.ts`) — every open document, flat: `id`, `file`, `mode`,
  `dirty`, `representation` (loaded kind + write authority, see `documentReading.ts`), and session-only
  flags `readError`, `disk`, `pdfRebuild`, `diskRev`. Saving, assets, search, rename and move index it and
  never care how documents are arranged. **It holds no content.**
- **`layout: TabLayout`** (`utils/tabPanes.ts`) — `{panes, activeId, sizes?}`: one `TabPane` per COLUMN, up to
  `MAX_PANES` (5), all drawn at once, each with ordered `paths` and one `activePath`. `activeTabPath` is
  derived (`focusedPath(layout)`).
- **The buffer ledger + sessions** (`utils/documentBuffers.ts`, `utils/documentSessions.ts`), App-owned,
  outside React, keyed by **document id**: where the content is.

## Layout invariants
- **Every open path is in exactly one pane, once.** App pairs every `setTabs` with the matching layout
  transition; nothing in `tabPanes.ts` reads `tabs`, so a slip degrades to a pane with no document, never
  corruption. The keyboard-target registry and the per-path debounces assume "once" — `moveTabToPane`/
  `splitToPane` must never leave a path in two panes.
- **Panes, active id and widths are ONE state**, changed only by pure `(layout, …) => layout` functions inside
  the updater; two `useState`s would let `activeId` name a pane the same update removed.
- **Per-pane back/forward `history`** has one writer, `showInPane`, invariant `history[historyIndex] ===
  activePath` (if broken, both arrows read false — never a jump to a document the pane lacks). It pushes only
  when the target differs from the current entry (after `forgetInHistory` it may already be it). `closePath`
  and `moveTabToPane`'s source forget; `renamePath`/`relabelPaths` relabel. Not persisted.
- `openInSidePane(layout, path)` shows a document WITHOUT moving `activeId` (already visible → unchanged;
  behind a tab of an unfocused pane → fronted; else a new right column, or at the cap the right-most unfocused
  one). The agent uses it.

## Where content lives
- **`DocumentBufferStore`**: per document, the latest accepted `ContentSource` (a string, or a `DeferredSource`
  read on demand), App's `revision`/`savedRevision` (the dirty predicate), `readable` (text authority) and
  `flushable` (write authority). `contentOf(path)` resolves today's id at the path and flattens once per
  revision. `snapshotOf`/`snapshotForDocument` are borrowed synchronous reads; anything async (save, copy,
  agent, queued work) uses **`retainSnapshotOf`/`retainSnapshotForDocument` and releases in `finally`**.
  `markSaved(id, revision)` only advances — an old write never cleans a newer edit.
- **`DocumentSessionStore`**: one engine session per document (`'markdown'`, `'drawing'`, `'notebook'`,
  `'pdf'`), each a `SessionAdapter` (`hasPendingEdits`, synchronous `checkpoint`, `acknowledge`, `drain`,
  `journalDelta`, `recover`, media references, `onChange`). Created lazily on first pane mount or first
  programmatic edit — never by restore — and **released only by App** after the closing barrier, for
  `tab-close`, `trash`, `vault-switch` or `kind-change`. Never on hide, pane unmount, rename or `diskRev`.
  Session serials are page-unique and never reused; the funnel rejects a report from a non-live owner.
- **A Markdown session owns the `EditorState` and its undo history, viewless or not**
  (`editor/markdownSession.ts`, created via `useOpenDocuments` `markdownSessions`). A `DocumentPane` builds an
  `EditorView` on `adapter.state` and `attach`es it; on unmount the session keeps the state. That is what makes
  tab switches, the graph view (which unmounts `EditorPane`) and hidden agent edits lose nothing.
- Canvas documents get a session bridge (`canvasSessionBridge.ts`; PDF adds `pdfSessionRoute`); see
  `pdf-and-drawings`.

## Pane keying and the EditorState rules
- **`paneKey = id|loadedKind`** (`EditorPane.tsx`), plus `|unread` for an unreadable tab (a successful retry
  remounts) and `|diskRev` on canvas floats (a disk reload remounts on the new bytes). The **id** is why an
  overwrite-rename cannot hand the survivor the dead document's pane (measured once: `alpha.md` renamed onto an
  open `beta.md` drew and saved "BETA CONTENT"). The **kind** releases the old session on a cross-kind rename.
  A same-kind rename keeps the pane: sessions report by document id, and the current path is resolved per call.
- **Whatever is baked into an `EditorState` outlives every pane** — `domEventHandlers`, the update listener,
  extension closures. Anything they reach must be **stable for the app's life** (App-level, e.g.
  `openNoteByName`, `getWikiLinkTargets`, reading through refs); a per-pane ref only hides staleness.
  Per-document state a baked handler needs goes **by path** (`scrollDebounce`).
- **Compartments are module-level singletons** (a state outlives the pane that built it, and a reconfigure
  naming an unknown compartment is silently dropped). Every setting is reconfigured in its own effect AND when
  a state is adopted (theme, read-only, live preview, indent, reading emphasis; an open ⌘F box follows the
  mode by itself). The three settings effects skip their mount run (`settled`): each `livePreviewCompartment`
  reconfigure is a full decoration walk.
- `OpenTab.id` never repeats in a page load (`newTabId`'s counter — never make it recycle).

## The save funnel
- **`updateTabContent(path, content, {fromDisk?})` is path-explicit and the only funnel** (`app/useSaveFunnel.ts`):
  several documents are editable at once, and canvases serialize after their pane has gone. It checks
  `canUpdateTabContent` and the live session owner, reports to the ledger, and schedules the per-tab save.
  `fromDisk` reports a saved revision: no dirty, nothing scheduled.
- **`dirty` is cleared when nothing is left to write**, at the write and again when a session's pending work
  settles (`settleCleanTabs`): a board acknowledges its write while its after-write step is still tracked work.
- **Autosave is per tab** (`saveTimersRef`, 1 s debounce); closing one tab never cancels another's write.
- **`flushTab` writes are serialized per DOCUMENT** (`flushChainsRef` by `OpenTab.id`, so a rename mid-write
  cannot split a chain) and go only through `writeFileVersioned` against `getBaseline(id)`
  (`utils/docBaselines.ts`). `written` → new baseline; `changed` → `disk:'conflict'`; `deleted` →
  `disk:'deleted'`. `diskStateRef` mirrors `OpenTab.disk` synchronously and is the gate: a held tab is never
  autosaved. With `closing` (close, trash, vault switch) a write the file cannot take becomes a `(conflict)`
  copy, announced in a dialog — nobody is left to ask.
- A save captures immediately; only leaving a document **drains** its session first (2 s deadline). Close
  removes the path from the layout at once but keeps the document (and a PDF's canvas) mounted until drain and
  write settle; a failed save restores the tab.
- A `readError` tab's buffer is **not the file** — ⌘S force-flushes the focused tab and would write `''`.
  `flushTab`, the funnel, mode toggles, search (reads disk instead), the asset neighbour scan and restore seeding
  all guard it; a new reader of a tab's content joins that list.
- An annotated PDF's file is rebuilt (off the main thread) from its pristine source plus the board's ink; its
  baseline is hashed in the background at open (`seedPdfBaseline`) and its first save awaits it.
- A failed save is never silent: told once per document until a save succeeds, the tab stays dirty. A save a
  newer revision overtook is not a failure. "Saved" shows when the path is **visible** in any column.
- `beforeunload` is armed while any revision or canvas serializer is pending, until its write is acknowledged
  (AGENTS.md's sanctioned native prompt). Hide/pagehide checkpoints drain serializers then use the funnel, and so
  does `beforeunload` itself, so a person who chooses Leave right after a change still gets Recover. A journal
  write made then (`markLeaving`) is put and committed at once with no read first: a read-then-put transaction
  had not committed when the page went, and Chrome dropped it (measured).

## Crash recovery (`utils/recovery*.ts`, `RecoveryBar`, `RecoverySurface`)
Every change also reports through ONE App-lifetime funnel (`useRecoveryJournal` → `createRecoveryFunnel`)
into an IndexedDB journal keyed by vault and a random window id; the session's `journalDelta` supplies an
immutable capture pinned to its revision, and `recoveryAdapters` binds each document's session. Checkpoints
are serialized and revision-aware (a late one never replaces a newer one). On open, the Recover bar offers an
entry **in place only when the path and the raw-byte baseline both match**; other windows' and older entries
are copy-only (`recoveryCopy`), never applied to the live file. A board journals as a change is handed off (150 ms
after a stroke, at most every 500 ms: a PDF's recipe holds its whole file), and an unsaved plain PDF's empty board
is made the same on every open, or its baseline never matches and Recover could only save a copy.

## Outside changes (`useOutsideChanges`, `useDiskBarActions`, `DiskBar`)
- Every read that fills a tab records a baseline (`handleFileClick`, restore, `retryUnreadTab`, `addTabQuietly`);
  a vault switch clears them only after its pre-commit drains.
- **`checkOpenDocs(scope | 'all', batch?)`**: serialized; waits out `vaultMovesRef`, `trashInFlightRef` and
  `restoringRef`; skips a document with a write in flight. Per tab: fresh handle from the root → missing →
  follow a certain move (`followDiskMove`) or `disk:'deleted'`; stat = baseline → nothing (our echo); hash equal →
  refresh the stat; hash differs → unsaved work (`dirty`, armed timer, write in flight, session pending) ?
  conflict : **reload in place**. Disk back at baseline lifts a held tab. Followed moves are re-checked at the
  new path on a 750 ms retry. Triggered by every vault-change batch, focus/visibility, and a 2 s poll while
  `liveDetection === 'polling'`. Success messages use the status line (`announce`), never `notify`.
- **Reload in place**: Markdown dispatches one minimal change annotated `externalReload` + `isolateHistory`
  into its session (caret, scroll and history outside the change survive; ⌘Z steps back over it). Canvases get a
  fresh session (`documentSessions.replace`) and `diskRev + 1`. EPUB/PDF invalidate their reader token.
- **The DiskBar** sits between the slot header and body (inside `PdfPane` for a PDF; read-only for EPUB).
  Conflict: **Reload** (mine → `(conflict)` copy, disk re-read now) / **Keep mine** (disk → copy, baseline := what
  was read, then `flushTab(path, 'rewrite')`, which also writes a canvas whose checkpoint is already saved; a disk that
  moved again re-raises it, and a write that did not happen puts the bar back). Deleted: **Save again** (`recreateFile`) /
  **Close** (asks when unsaved). A conflict can be raised with nothing unsaved (a save or a PDF turn met the other
  write): the bar words it from `unsaved` (the buffer's dirty bit), never assumes edits.
- **A PDF's mode never moves under the bar.** `changeTabMode` refuses a switch while the bar is up (silently: the bar
  is the message, and a dialog there covered its buttons), and leaving Annotate commits only if its flush wrote, or had
  nothing to write, with no bar raised meanwhile; `changed`/`deleted`/`failed` abandon it, the board keeps the ink.
  Original's "Applying annotations…" waits only for a write that can still land (no bar, no failed save).
- **A PDF's "mine"** is its Annotate session's build (pristine + ink) when one is live; otherwise the bytes Original
  shows — the reader's memory-backed copy (`pdf/session/sourceFactory.ts` `pdfReaderBytes`), used only while its hash is
  the baseline's. Neither → `OpenTab.diskMineLost`, and the bar offers only Reload. (`pdfRenderCache` is the pre-native
  path; nothing fills it, so nothing may decide a PDF's authority by it.)

## Session persistence is PER VAULT (`utils/tabSessions.ts`, `useSessionPersistence`, `useSessionRestore`)
- One localStorage record `vaultSessions: Record<vaultId, StoredSession>` = `{v:2, paths, groups, focus, sizes,
  active}` (`groups[i]` = pane i's tabs; `sizes` one row or `null` = equal). This module is its only writer.
  Old flat keys migrate one way; a record with no `v` (pre-transposition, rows were side-by-side panes) is read by
  `migrateV1` as one pane holding everything. Everything read back is shape-guarded (`isStoredSession`).
- **An empty `paths` is a real session** ("I closed everything") and survives a switch.
- **The restore pass is the ONLY thing that opens documents when a vault loads.** The address bar's link
  (`initialLocation`, read once) is folded into it — applied only when `findLinkedVault` resolves to
  `currentVaultId`, which works because `recordVault` sets the id and the labelled list in ONE batch (issue #6).
  Its `file` stays in the bar (`pendingLinkFile`) until the pass consumes it. A second opener racing the pass
  once filed one tab as the vault's whole session.
- The stored session is read **synchronously** before the reads yield; during the reads **nothing is persisted**
  (`restoringRef`, a per-pass token reset at every claim). What the user opens meanwhile is **merged**
  (`mergeLayouts`: saved tabs first, then the new ones, keeping their focus). Reads run concurrently, merge once.
- **`restoreLayout` drops nothing**: rows past `MAX_PANES` and unaccounted paths become tabs of the last column
  (issue #8). **Only a GONE file is dropped**; an unreadable one gets one re-read then comes back as a
  `readError` tab, keeping its place. Retry (`retryUnreadTab`) is serialized per id and matches on id.
- **Every read the pass makes has a deadline** (`utils/fileReadDeadline.ts`, carried by the context's reads): a read (or a re-validating resolve) that does not
  answer comes back as a `readError` tab — never dropped, never holding the others — and the guide tab's chunk
  failing comes back the same way (Retry reloads it). The vault index starts after `INDEX_WAIT_MS` however the pass
  is doing. **A pass that cannot finish keeps `restoringRef`** (persistence stays shut for that vault): the first
  layout change after an unfinished restore was once written as the vault's whole session.
- Restoring documents follow renames/moves and never come back from Trash: the pass publishes
  `restorePendingRef` (`utils/pendingRestore.ts`), which `retargetTabs`, `handleTrash` and the bin's Replace
  update synchronously inside `trackVaultMove`; it waits for ANY move in flight, re-resolves survivors from the
  root, repeats if the epoch moved, and from there to dispatch has **no await**. The layout is built in origin
  space and `relabelPaths`'d in one step (chained `renamePath` could delete a live pane).
- **One tab is replaced in place outside the opener**: an old board's editable copy (`app/useEditableCopy.tsx`
  `make`) takes the original's slot in one commit — `releaseTab` for the original, `setTabs` swapping in a tab with
  a NEW id, `renamePath` on the layout — so column, strip index, focus and the URL follow the copy. The original
  is released as a closed document is, with nothing to save (it is never written; `pdf-and-drawings`, old boards).
- **Two refs say which vault the workspace is the session of** — `sessionRootRef` and `sessionVaultIdRef`, written
  together at the claim and checked by both effects. The switch effect sets `sessionRootRef.current = null` and
  re-points `sessionVaultIdRef` at the vault being LEFT; **`if (!currentVaultId) return;` stays above the claim**.
  Each line closed a measured loss (a vault's tabs never coming back, or the empty layout filed under its id).
  The pass re-checks handle AND id after its last await and before merging.
- `pruneSessions` deletes a forgotten vault's session (gated on "list ever loaded", not length 0).

## Switching vaults empties the workspace, never loses it (`useVaultSwitch`)
The provider's pre-commit hook drains and saves every tab first (handles still good); then App releases every
session (`'vault-switch'`) and removes its buffer, then clears baselines, disk state, render data and
`clearViews()`; the reopen stack empties when `currentVaultId` changes. It fires only on a
real switch, never the `null → vault` startup assignment. A tab only means anything inside its vault.

## Keyboard
- ⌥⇥ / ⌥⇧⇥ walk every column's tabs in drawn order, ⌥⇧W closes, ⌥⇧T reopens. They live in **`EditorPane`**,
  capture phase, matched on `e.code` (⌃⇥/⌘W belong to the browser; ⌥W types `∑`), and skip the terminal.
  The reopen stack (`closedPathsRef`, `CLOSED_TAB_MEMORY` 20) records only `closeTab`/`closePaneAndTabs`, never a
  rename, overwrite or switch, and is emptied on a vault switch.
- **A tab-bar select or close hands the keyboard to the note's `.cm-scroller`** (`handKeyboardToNote`, in a rAF,
  through `registerKeyboardTarget`) unless focus is in something that types or a menu. A lazy target (EPUB)
  keeps the request until its current registration takes focus.
- A document's scroll place is a text anchor `{pos, offset}` (`editor/scrollAnchor.ts`, `fileScrollAnchors`), held
  on mount until reader input; a search jump must be a `revealMatch` effect (held centred), and a widget that
  resizes after `toDOM` must `requestMeasure()`. See `live-preview`.

## Panes on screen (`EditorPane`, `TabBar`, `DocumentPane`)
- **ONE filtered array drives the strip and the columns** (`panes = layout.panes.filter(...)`), so group index ===
  column index. Both read `--pane-w-<i>`/`--pane-x-<i>` on `.editor-pane` through module-level frozen style arrays
  (`TAB_GROUP_STYLE`, `PANE_WIDTH_STYLE`), at every pane count including one; horizontal insets live inside each
  group's scroller, and `box-sizing: border-box` stays global.
- **A canvas is a float**: PDFs, drawings and notebooks mount per open tab at `EditorPane` level (`PdfPane`,
  `CanvasPane`, geometry in `floatingSlot.ts`) and are hidden, not unmounted — and **must be told** (`isVisible`)
  so they release memory and work (AGENTS.md). EPUB mounts inside its `DocumentPane`. A text pane is a
  `DocumentPane` with its own `EditorView`.
- **Every pane draws a header, a lone one included** (product decision; do not add a `paneCount > 1` gate):
  `[← →] [title + dirty dot] [mode] [⋯]`. `⋯` focuses its pane **before** opening (insert-table requests are
  answered by the focused pane only). The focus underline shows only when split.
- A tab group is `[tabs] [+] [⌄]`; drop handlers sit on `.tab-group` so `+`/`⌄` accept drops. `.tab` has a definite
  `width: var(--tab-width)` (a flex-basis alone is invisible to intrinsic sizing: tabs collapsed to 116px). Tabs
  name notes with `noteDisplayName`; `data-tooltip` carries the full path. `dirty`/`unreadable` are per tab.
- The drop zone exists only while a tab is in flight (CodeMirror would insert the text; a PDF would swallow it);
  the drag carries its own `dataTransfer` type (`utils/tabDrag.ts`) so the explorer stays inert.
- The **status pill** (bottom right: backlinks, counts from `wordCountField` published at most once per frame,
  save status) speaks for the focused pane, is `pointer-events: none` except its button, mounts only when it has
  something to say, lifts (`.is-lifted`) over a PDF/notebook's own pills, and keeps a reserved `min-width`.

## The dividers
- **Drawn over the panes, not as borders** (a PDF float would paint over a border, and the divider is the handle):
  an 8px strip, rule offset 3px/5px, `z-index: 6` (above panes at 5, below the tab drop zone at 20). It cancels
  `dragover`/`drop` — an OS file dropped on it would navigate the app away.
- **Widths live on the LAYOUT as percentages; absence means equal** (`normalizeSizes` gates every row,
  `paneSizes` is the only reader). Closing rescales survivors proportionally; `insertSize` gives a new column
  `1/(n+1)`. `MIN_PANE_PX` (200) is a gesture-only floor capped at half the dragged pair, never re-applied on
  window resize.
- **The drag writes CSS variables and commits once** — no React render per frame (it would re-render the strip
  and every PDF and persist the session 60×/s). React diffs `style` by value through the same `pct` helper, so a
  mid-drag re-render writes nothing. A **cancelled** drag restores the columns by hand; an **abandoned** one
  (panes changed under it) must not repaint.
- Terminators check `pointerId`; an effect on `(group.id, paneCount)` abandons a drag whose handle left the DOM
  (a detached handle's `lostpointercapture` reaches no listener). The handle takes `focus()` on pointerdown so
  the arrow-key nudge works. A gesture whose row cannot be committed is refused before it starts.

## The agent's view of the panes (`utils/viewRegistry.ts`)
- Every mounted pane registers a reporter under its path from an effect — **never inside the `EditorState`**.
  `describe()` is called only at send time. `retargetTabs` calls `moveView` on rename; `clearViews()` runs on
  a vault switch. Hidden floats stay registered.
- Agent text edits: a mounted note through its reporter (one transaction through the funnel); an open, hidden
  note through `markdownSessions.dispatch` (so the next mount shows it and ⌘Z undoes it); a closed file is
  written and runs `afterWrite`. Canvases go through their session (`vault-agent`).

## Verify
Per `verify-in-browser`: split into columns, rename/move an open note, reload (layout and focus come back),
switch vaults and back, edit a note on disk while it is open (clean → reloads, dirty → DiskBar), and close a tab
mid-save. Watch the stored `vaultSessions` and the file on disk, not just the screen.
