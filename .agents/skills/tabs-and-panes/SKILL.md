---
name: tabs-and-panes
description: The multi-tab / split-pane model — the flat document list vs. the tab layout, autosave, session persistence, pane keying and the EditorState cache, and the divider-resize gesture. Load before changing tabs, panes, the tab bar, the save funnel, or what is restored on reload.
---

# Tabs: a flat document list + a tab LAYOUT

The app moved from a single `(activeFile + fileContent + editorMode)` trio to a tab list, and then
to **two structures rather than one**:

- **`tabs: OpenTab[]`** — every open document, flat. Autosave, the asset diff, vault search, rename
  and move all index it by path, and none of them care how the documents are arranged.
- **`layout: TabLayout`** (`utils/tabGroups.ts`) — what the tab bar shows. One `TabGroup` per tab,
  holding one path in the ordinary case and up to `MAX_SPLIT_PANES` (5) once tabs have been **merged
  into a split view**.

`activeTabPath` — the focused document — is *derived* (`focusedPath(layout)`), and
`activeFile`/content/mode are derived from it. Each tab's content lives in memory, so switching tabs
never re-reads disk or loses unsaved edits; `dirty` drives the tab dot.

- **The two structures are kept in step by construction.** Every open path is in exactly one group;
  App pairs each `setTabs` with the matching layout transition. Nothing in `tabGroups.ts` reads
  `tabs`, so a violation degrades to a pane with no document rather than to corruption. Folding the
  two together would have put a group walk in front of every save, search and asset lookup for a
  feature none of them are about.
- **Groups and the active id are ONE piece of state**, and every operation is a pure
  `(layout, …) => layout` applied inside the updater. Two `useState`s would let an update leave
  `activeId` naming a group the same update removed — exactly what the double-click-to-open race
  produces.

## Autosave and the save funnel

- **Autosave is per-tab**, via a `Map<path, timer>` (`saveTimersRef`, 1s debounce). Switching or
  closing one tab must never cancel another tab's pending write.
- **The save funnel `updateTabContent(path, content)` is path-explicit and the only one there is:**
  several documents are editable at once in a split tab, and the drawing/PDF canvases serialize on
  their own debounce that can fire *after* their pane has gone away — either way the text must land
  in the originating file's buffer, not "whatever pane has focus now."
- State is mirrored into refs (`tabsRef`, `layoutRef`, `visiblePathsRef`, `activeTabPathRef`,
  `writeFileRef`, `rebuildGraphRef`) so stable callbacks and timers never go stale without re-arming.
  A save reports "Saved" when its path is **visible** (any pane of the tab on screen), not merely
  focused.

## Session persistence

The whole tab set persists — `openTabPaths` + `openTabGroups` + `openTabGroupFocus` +
`openTabGroupSizes` + `openTabsVaultId` + `activeTabPath` in localStorage — and is restored once the
tree loads.

- **Each key is additive to the one before it and every one is optional**, so a session written by
  any earlier build still restores: the grouping rides alongside the flat list, the per-group focused
  pane rides alongside the grouping (without it a background split tab came back on its leftmost
  pane, since `activeTabPath` speaks for only one group), and the per-group pane widths ride
  alongside that (`null` for the tabs nobody resized, which is most of them; a session without the
  key restores in equal columns). Stored widths are validated at the pane count the session was
  *written* at and then narrowed by the positions that actually came back, so a note deleted on disk
  since takes its share with it and the rest divide it up — exactly as closing that pane would have.
- **The whole stored session is read synchronously, before the restore pass yields to its file
  reads** — persistence is un-gated the moment the pass starts, so a key read after the awaits could
  already have been rewritten by it.
- `restoreLayout` gives any path a stored group can't account for a tab of its own; a session written
  before split tabs restores as all-singletons.
- **The persist effect is gated on the restore pass having run** (`hasRestoredTabs`). Ungated, it
  fires at mount with zero tabs and clobbers the stored list moments before restore reads it — the
  old "only the active file survives a reload" bug. A *missing* `openTabPaths` falls back to the
  legacy single `lastFilePath`; a present-but-empty one means "no tabs" and restores nothing.
- Restored PDF tabs get `content: ''` exactly like `handleFileClick` (their buffer is a tldraw
  snapshot, never file bytes). The effect is keyed on `layout` rather than a joined path string,
  because the layout's identity already moves only when the tab bar does.

## Switching vaults empties the workspace

Flushing every pending write first — those handles are still good. A tab only means anything inside
the vault it came from: its path indexes that vault's tree, its handle writes into that vault's
folder, and the editor's state cache is keyed by a string carrying that path, so a path two vaults
share could serve the old vault's buffer for the new vault's file. The effect is keyed on a
`rootHandle` change and guarded to fire only on a *real* switch — the `null → vault` assignment at
startup must not clear the tabs the restore pass is about to bring back. Clearing the tabs is also
what drops their cached editor states, since `EditorPane` prunes that map to the open set.

**The persisted session is stamped with the vault it belongs to** (`openTabsVaultId`, the
recent-vault id) and the restore pass declines a session from a different vault, because that effect
reaches the same hazard by a road the switch effect never sees: a *cold start* can land on another
vault — the last one's permission lapsed to `prompt`, or the user picked from the vault menu — and
those paths would then open whichever of the new vault's files happen to sit at them. An unstamped
session predates this and is restored as before. The pass re-checks the vault after its file reads
too, alongside the existing "did the user open something already" guard: the switch empties the tab
set, so that guard alone waves the old vault's tabs straight through.

# Split tabs (`utils/tabGroups.ts`, `DocumentPane.tsx`, `EditorPane.tsx`)

Dragging a tab out of the strip and dropping it on the panes below merges it into the tab on screen;
the panes are columns, left to right, even until the divider between two of them is dragged, and a
tab holds at most five. **Splitting is deliberately only ever vertical**, which is what lets a pane's
rectangle be a plain share of the width — and what makes a resizable pane one number rather than a
rectangle.

- **A pane is a `DocumentPane`, and it owns a CodeMirror view of its own.** The editor used to be one
  created-once `EditorView` re-pointed at each tab's cached state; showing five documents at once
  made that a special case inside the editor rather than five of the same thing. React keys a pane by
  `paneKey` — `OpenTab.id | path` — so a pane shows one document for its whole life and there is no
  tab-swap logic in it at all; switching tabs mounts and unmounts panes.
- **The `EditorState` cache is what makes that free.** A pane caches its state on the way out and
  adopts it on the way in, so undo history and selection survive every tab switch exactly as they did
  when one view was re-pointed — and still never reach across documents.
- **A pane and its cached state are keyed by `paneKey` — `OpenTab.id | path` — and a path alone would
  be wrong.** Both halves earn their place. The **id** because a rename that overwrites an open file
  leaves two different documents answering to one path for a single commit: keyed by path, React
  matched the survivor to the pane the *overwritten* document was drawn in and kept that pane's live
  view, while the cache handed over its text and its undo history — and the renamed file's first
  keystroke saved the dead document's bytes straight over it (measured: `alpha.md` renamed onto an
  open `beta.md` drew "BETA CONTENT" and wrote it back to disk; a PDF did the same, its re-read
  effect re-running on the new handle and returning early on the bytes it already had). The **path**
  because a rename must still rebuild the view: the update listener that reports edits has the path
  baked into it, so a pane carried across a rename would go on reporting the old one and every edit
  after it would land nowhere. Ids are session-only, like a group's, and re-minted on restore.
- **The three settings effects skip their mount run** (`settled`). The callback ref that builds the
  view has just configured it for exactly those values, and `livePreviewCompartment` is not a cheap
  thing to re-state: every `createLivePreviewPlugin` mints a **new `StateField`**, so reconfiguring
  it discards the field's value and runs `create()`, a full `buildDecorations` walk. Ungated, every
  pane mount paid for two of those instead of one, and a pane now mounts on every tab switch — a
  five-pane split cost ten walks where five would do.
- **A state outliving its pane cuts a second way: whatever is BAKED into it outlives the pane too.**
  The compartments are the part that can be re-supplied; `EditorView.domEventHandlers` and the update
  listener are not, so the handlers an adopted state runs are the ones the FIRST pane for that
  document built. Anything they reach must therefore be **stable for the app's life** — wrapping it
  in a per-pane ref does not rescue it, it only hides the staleness, since that ref stops being
  updated the moment its pane unmounts. `openNoteByName` was not stable (it closed over `mdFiles`,
  rebuilt on every tree refresh), so a `[[wikilink]]` in any note whose pane had been unmounted once
  silently did nothing for every note created, renamed or moved since — it is now stable in
  `App.tsx`, reading the index through a ref, which is where that kind of fix belongs. Genuinely
  per-document state that a baked handler needs goes **by path** instead, which is what
  `DocumentPane`'s `scrollDebounce` is: a per-instance timer meant the live pane's unmount flush could
  never find the timer the adopted handler had armed.
- **The CodeMirror compartments are module-level singletons, and must stay that way.** A Compartment
  is an identity key, not state, so views share them freely — but a state OUTLIVES the pane that
  built it, and a reconfigure effect naming a compartment its state has never heard of is silently
  dropped. Per-pane compartments would give an adopted document a theme, mode and tab size frozen at
  whatever the pane that last held it had. Anything a *setting* feeds is therefore reconfigured in
  **both** places: its own effect (for the live view) and the moment a cached state is adopted.
- **A canvas document builds no view**: a drawing renders its tldraw pane inside the slot, and a
  PDF's surface is a `PdfPane` that EditorPane positions *over* the slot. See the `pdf-and-drawings`
  skill for why the PDF panes stay outside the panes, and for the two consequences of floating over a
  slot (a surface must report focus for the slot itself; a hidden pane keeps the geometry it was last
  shown at).
- **The drop zone is a layer over the panes, present only while a tab is actually in flight.**
  CodeMirror handles `drop` itself and would insert the dragged text; a PDF pane would swallow it
  outright. Which half of which pane the pointer is in decides the insertion index, painted with the
  same purple dashed outline the file tree uses. A drag carries a bespoke `dataTransfer` type
  (`utils/tabDrag.ts`) so the explorer — a drop target for everything, reading the drag long before
  any drop — stays inert as a tab passes over it; `types` is the only thing readable during
  `dragover`.
- **Only a tab with more than one pane draws pane headers**, so an ordinary tab is laid out exactly
  as it always was. The header names its document and carries the two inverses of a merge: close this
  pane, or move it back to a tab of its own. The tab-bar entry shows its focused pane's name plus a
  count badge, and its × closes every document in it (a merged tab is one tab).

## The dividers

- **The dividers between panes are drawn over them, not as borders on them** — a PDF pane floats
  above its slot and would paint straight over an edge belonging to it. That is doubly load-bearing,
  because the divider is also the **handle**: a border on a slot could never be grabbed over a PDF
  either. It is an 8px strip with the 1px rule drawn by `::before`, offset 3px into the left pane and
  5px into the right rather than centred — the left pane's scrollbar is 6px and ends exactly at the
  boundary, and its pane header's close button stops 4px short of it. Its `z-index: 6` is load-bearing
  in both directions: above the panes (5) so the press reaches the strip rather than CodeMirror or a
  PDF's capture-phase `pointerdown`, and below `.editor-split-dropzone` (20), which exists only while
  a *tab* is in flight — which is what makes the two gestures mutually exclusive without either
  knowing about the other. Giving it a hit area also made it a **drop target**, so it cancels
  `dragover`/`drop`: an OS file dropped on an uncancelled one navigates the whole app away to that
  file.
- **A pane's width lives in its `TabGroup`, as a percentage, and absence means equal.**
  `sizes?: number[]` sits beside `paths` because every transition that changes the pane list has to
  change the widths *in the same update* — a second piece of state would allow exactly the
  intermediate where one array is indexed against a list it no longer describes. Absent is the
  encoding of "nobody has arranged this": a single pane, a tab nobody resized, and a session written
  before dividers could be dragged are one thing drawn one way, so nothing invents an arrangement the
  reader never made and evening the panes up again is a field being deleted. `normalizeSizes` is the
  single gate every row passes (a commit, a redistribution, a stored session) and `paneSizes` the only
  reader, so a row out of step with `paths` degrades to equal columns — the geometry's version of "a
  pane with no document rather than corruption".
- Widths are picked out **by index**, by the same walk that produced the paths: `closePath` and
  `renamePath` both drop *every* occurrence of a name, and `renamePath`'s overwrite branch is the one
  place a pane leaves a tab without anything closing. Redistribution: **closing or splitting off
  rescales the survivors proportionally** (the only rule that preserves every surviving ratio and
  doesn't depend on which neighbour the departing pane sat beside), and **a merge gives each arriving
  pane the share a new pane is drawn at** while both sides keep their internal proportions — so
  equal-into-equal is still equal, i.e. still absent.
- **Percentages, not pixels**: the window and the sidebar resize constantly and a restored session
  lands in a window of another size — the same reason a fitted table's columns are percentages. The
  **pixel floor (`MIN_PANE_PX`) is a gesture constraint**, converted against the live width and
  capped at half *the pair being dragged* — never at a share of the whole tab, which put the floor at
  118px on a five-pane 1176px editor. It is never re-applied on a window resize, because that would
  rewrite an arrangement from a window size the reader was only passing through.
- **The drag writes CSS variables and commits once.** `--pane-w-<i>` and `--pane-x-<i>` on
  `.editor-pane` — the one box holding both the columns and the PDF panes floating over them — feed
  the slots' `flex-grow` (against a zero basis, so the browser divides by the sum and the columns tile
  exactly however the percentages rounded), the dividers' `left`, and every visible PDF pane's
  rectangle. (The tab-drop highlight is the one column-aligned box that does *not* read them — it
  exists only while a tab is in flight, which a divider drag excludes.) So one write per frame moves
  all of it, with **no React render at all**: a `setState` per frame would re-render this component,
  the tab bar and every mounted PDF pane on top of the work the width change already causes, and would
  run App's persist effect — writing the whole session to localStorage sixty times a second. The seam
  is safe because React diffs `style` **by value**: mid-drag its view of the variables is still the
  committed one, so a re-render (a save status arriving, a keystroke next door) writes nothing and
  leaves the gesture's values alone — both sides format through the same `pct` helper so that
  comparison is on identical strings. The corollary is that a **cancelled** drag must put the columns
  back by hand; React has not re-rendered and nothing else would. The exception, and the one exit that
  must *not* repaint, is the gesture being **abandoned** because the panes it was moving are no longer
  the panes on screen — React has just re-rendered, which is what raised the abandon, so repainting
  the old row would drag the tab that replaced it into a shape nobody chose.
- **A gesture is ended by its own pointer, by its own tab, or by nothing at all — so both of those
  have to be watched.** Every exit is a React handler on the handle and React delegates at the root,
  so a handle removed from the document while it still holds the capture gets its implicit
  `lostpointercapture` at a detached node, which reaches no listener: nothing would release the body
  class, the Escape listener, or `startResize`'s own guard, leaving every divider dead and the whole
  window on a `col-resize` cursor with text selection off for the rest of the session. `⌘N` mid-drag
  is enough to do it. An effect on `(group.id, paneCount)` abandons the drag instead. Separately, a
  capture retargets *its* pointer and nothing else, so a second finger landing on the same strip still
  gets its `pointerup` there — unguarded it committed the drag the first finger was still making, so
  all three terminators check `pointerId`.
- **The handle takes focus on pointerdown, because nothing else would give it any.**
  `setPointerCapture` does not focus, and the `mousedown` that would is deliberately cancelled (that
  cancel preserves the double-click reset and suppresses the text selection). Without the explicit
  `focus()` the arrow-key nudge the Help guide describes could never be reached by the gesture that
  documents it, and the only way to a divider at all was tabbing out of a CodeMirror that binds Tab.
- **A gesture that could not be committed is refused rather than started.** A tab holding a path with
  no open document draws fewer columns than it has panes, and a row that short is one `setGroupSizes`
  declines by length, which returns the same layout, which means no re-render: the columns would move
  under the pointer and then silently not be recorded, with the DOM left describing an arrangement
  React does not hold. `startResize` and `keyResize` both check the two agree first. `tableFit`
  re-fits and `PdfViewer` re-rasterizes live and are deliberately left alone: both are
  `ResizeObserver`-driven, both already absorb exactly this from the sidebar drag, and the reflow *is*
  the feedback the gesture exists to give (measured: a PDF beside a dragged divider stays rendered).
- **`.editor-empty-overlay` is still an overlay**, but the reason changed: with no tab open there are
  simply no panes and no view to orphan. The overlay-not-unmount rule now applies *within* a pane
  (`.drawing-pane`, `.pdf-pane` over their slot), not to the editor as a whole.
