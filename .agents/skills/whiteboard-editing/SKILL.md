---
name: whiteboard-editing
description: The editing side of whiteboards, notebooks and PDF ink — tools and their persistence, pointer/pen input and gesture ownership, the keyboard table, selection, previews and transactions, history and undo, text editing (EditContext), spell-check, pictures, link cards and embeds, the board chrome and its commands, and read-only rules. Load before touching src/whiteboard/ input/, tools/, commands/, change/, text/, media/, clipboard/, selection*, viewer/ (other than attachView/wetLayer drawing), whiteboard/model/ or chrome/, or components/whiteboard/ chrome, commands, keyboard or editing leases.
---

# Editing a board

Drawing is `board-gpu-path`; documents, sessions and saving are `pdf-and-drawings`. The engine is greenfield and
holds **zero tldraw code**: reading how tldraw behaves, or its public source to learn a behaviour, is fine; copying,
adapting or transcribing its code is not (`src/whiteboard/PROVENANCE.md`; the lint bans tldraw and
`perfect-freehand` imports in the engines).

## Who owns what

- **App owns the document session**; the **board runtime** (`whiteboard/host/runtime.ts`, `BoardRuntime`) owns the
  model, scene, `SelectionState`, `ToolState`, samples, media, jobs and history, and outlives every view. A view
  (`viewer/attachView.ts`, `viewer/nativeEditingServices.ts`, `viewer/inputHost.ts`) only borrows it: a pane
  unmounting never loses selection, tool or undo.
- `src/whiteboard` is React-free; the React chrome lives in `components/whiteboard/` and reaches the engine through
  plain ports (`nativeCommandSource.ts`, `nativeBoardOperations.ts`, `nativeEditingLease.ts`).
- Kinds of node (`model/nodes.ts`): `stroke`, `figure`, `text`, `sticky`, `connector`, `polyline`, `frame`,
  `group`, `picture`, `clip`, `linkcard`, `embed`, and `opaque` (a preserved unknown record nobody can make).
  Styles, figure shapes (`FIGURE_SHAPES`) and tools are in `model/styles.ts`.

## Changing the document

- **Every change is one transaction** (`change/ops.ts` ops built by a `TxBuilder`) applied by the session
  (`change/apply.ts`). Nothing writes the model directly; identity and preserved data (`id`, `kind`, `ext`, `raw`)
  are not settable. A refused command rolls back to its savepoint (`change/commands.ts`).
- **One shared history per document** (`change/history.ts`, byte-limited at 256 MB, `onHistoryLimit` tells the
  person). Steps coalesce per key (`historyCoalesce.ts`); typing has its own coalescing marks
  (`text/edit/typingHistory.ts`) but no second undo stack. Selection is session state, never an undo step; a step
  restores the selection it was made with. A style press (the style panel's whole press, a held slider key) is one step.
- **Previews never change the document.** A gesture shows its effect through `viewer/preview.ts` (the preview
  layers have a permanent slot, `previewSlot.ts`: inserting layers mid-gesture changed the topology, which seals
  platform input and cancelled the gesture itself). Only a completed, still-current pointer-up applies its
  prepared commit (`input/transformGestures.ts`, through `session.apply`).
- Geometry for a change is prepared off-thread (`render.prepareChangeGeometry` / `pinChangeGeometry`, the exact
  jobs in `geom/`); a commit waits for it rather than guessing.
- A command run under a transform's own held gesture declares it (`heldGestures`, `commands/flipLeaves.ts`): the
  session's `gestureHolds` must equal that count or the command is refused. Flip uses this.
- Read-only is the session's `isReadOnly` (admission or apply's seal; a developer setting can force it per kind,
  `utils/engineRouting.ts`) plus per-node `locked` (`isLocked` walks ancestors). Save must honour it too.
  A read-only board view still gets the accessibility mirror (skip link, live region, object list): the view lease builds
  `viewer/accessibilityDom.ts` with `readOnly: true` (`nativeViewLease.ts`, `readonlyAccessibility`), which omits the drawing
  cursor and pen-mode helper, and whose skip link only moves focus. A chosen object there gets its outline alone (the
  selection frame's `outlineOnly` mode, `viewer/selectionHandles.ts`, written from the view's `writeOverlays`), no handles.
- A board that opens in the VIEW route (an old-format board, the developer emergency switch, a failed editing chunk) has
  no editing chrome: `ReadOnlyBoardChrome.tsx` draws the strip (☰ with Print… and Export to PDF from the document's
  clipboard service, sheets, page thumbnails, invert) and the zoom panel in the editing chrome's places, and nothing
  that edits, so nothing on screen silently does nothing. ⌘A/⌘C/⇧⌘C/⌘P stay on their keys (`useNativeClipboard.ts`
  binds them on every view); its view rows (zoom, fit, sheets) run the zoom panel's operations through the lease's
  `setViewCommands`. An old board's strip adds its note and "Make an editable copy" (`pdf-and-drawings`).
- The AI agent edits boards through the same transactions (`whiteboard/agent/`, `change/agentBatch.ts`;
  `vault-agent` skill).

## Tools and input

- Tools are registered in `input/boardTools.ts`. `persistent` (select, pen, highlighter, eraser, hand, laser) stay
  chosen. `single-use` (text, sticky, figure, frame, connector, polyline, media) return to Select after one use;
  zoom is single-use and **not lockable** (`lockable: false`). `ToolState` (`input/gesture.ts`) keeps a lockable
  single-use tool when the tool lock is on (`Q`, Preferences, the padlock over the bar) or `keepToolOnce` was armed.
  Escape returns the chosen tool to Select (`ToolState.escape`). Tool choice is session UI state, never history. Choosing a tool
  keeps a placed keyboard cursor (only a gesture the cursor owns ends), and the keyboard cursor does not complete the tool
  for a `completesTool` route (`keyboardCompletes`), which completes itself once it lands.
- A tool whose work lands after pointer-up returns to Select itself (`completesTool` in `input/pointerRouter.ts`).
- **A released gesture lands; it is not pending work.** After pointer-up a box (and an erase, for the last stretch of its
  path) keeps a `settling` session hold
  (`session.beginGesture('settling')`, and so does the preview's commit hold) and registers with `registerSettling`, not
  `registerPending`: the next press is admitted (`claimInput` reads `isInputGestureActive`), Escape/Delete/tool keys wait for it
  (`attach.ts` queues them with `enqueueAfterGesture`), only the view's end or — for an erase — an undo cancels it, and a
  revision that moves meanwhile is prepared again, not abandoned. A new gesture that reads the selection waits for `settled()`:
  the work landing when it was pressed, never its own entry (a press released before deciding registers itself).
  Leaving the document waits for all of it: `session.settle()` resolves once no hold is open and no `trackEdit`ed work
  (paste, duplicate, drop: they apply through `enqueueAfterGesture`, so they must never hold a gesture) is running, and
  focus leaving the board does not cancel such work (`session.isEditLanding`, `attach.ts` `clearLatches`).
  **A paste (drop, duplicate) the person asked for always lands**: nothing cancels it but its document's end (the import
  adapter's `cancelPending` only closes the file picker), ⌘V during a gesture is taken, and it has no revision fence. Its
  prepared ops are carried onto the board as it is when they land (`change/insertionLanding.ts` `rebaseInsertion`: on top,
  ids, frame and pictures re-checked); only what that cannot follow (`InsertionStale`) prepares it again. It selects what it
  placed unless the selection changed since ⌘V (`selectLanded`). Keys pressed after it wait for it (`pasteLanding`), and a
  press queued behind such a key waits on `afterKeys`, never on the gesture FIFO alone (that spun in microtasks).
  The creation tools (figure, frame, connector, polyline, text/sticky placement) follow the same rule: released shapes land
  in the order drawn (`creationTurn`), each prepared again on a moved revision (`CreationGesture.rebase`); an undo while
  work settles cancels only the latest undoable one; an arrow key waits behind settling work, then nudges or pans.
  A key's edit (nudge, turn, flip, stretch, resize: `selectServices` `keyEdit`) is released work from the press: tracked
  (`trackEdit`), never cancelled by a press or by the view's end (a tab switch unmounts the board; it lands on the session),
  stale only for a changed document; out of sight it commits without its preview frame. Its preparation pins `doc.rev`,
  which a tool change moves too (no content): cut off that way it is prepared again (`KEY_EDIT_ATTEMPTS`), never dropped.
  A press made while a key still waits behind landing work (`attach.ts` `keysWaiting`) is queued behind that key and
  resolved with the tool the key leaves (`pressed()` undefined): taken at once, D then a stroke right after a sweep erased.
- **No press before a presented frame.** A press is placed through a presented frame's mapping, so `PointerAcquisition`
  takes a new press (and the context menu) only once `MappingHistory.ready()`: a frame presented since the view was last shown
  (`framePresented`, from the lease's `presentedView`); meanwhile the surface shows the `progress` cursor (`inputHost.ts`
  `syncWaiting`). Only presses wait: gating the whole input detached the editing services, which faded the chrome and dropped
  keys on every tab switch. Taking the press earlier raised "No presented input mapping" and lost the stroke.
- **One gesture owner at a time** (`input/router.ts`, `InputRouter`): tools receive normalised `RealSample`s only,
  stamped with an `InputToken` (vault epoch, tab, session and view generations). A replaced view cannot finish its
  successor's contact; check the token before acting on anything async.
- The ink curve is ONE function, `ink/curve.ts` `writeCurveSpan`: every freehand span is a tangent-continuous cubic
  through its samples (a turn of 120°+ is a corner; `'straight'` runs stay straight), whatever the stroke's saved
  `fairTol` (validated, never a limit). Wet, dry, both backends, picking, export and omission all read it; a span
  depends on samples i−1…i+2, so the wet tail is replaceable (`finalizedSpanCount`). Anything that bounds a stroke
  without building cubics uses the curve enclosure (`ink/reach.ts`, `SampleSummary.curveBounds`), never the sample box.
  A `closed` stroke's caller passes `curveClosure(points, node.closed)` (its last span arrives along its first).
  LIVE pointer samples are first moved within their pointer-grid cell (`ink/dequantize.ts`, a provisional wet tail);
  replayed, imported or agent samples never are.
- A superseded hover pick, a marquee the person ended, any async step a newer one replaced: its rejection is never
  shown. Report only `!isCancellation(error) && !signal.aborted` (`platform/workers/envelope.ts`; it covers the worker
  host's own `'Cancelled'`, which a DOM-`AbortError`-only check showed as "bme-worker-host-v1: Request aborted").
- Draw and highlight: `input/liveInk.ts` (wet curve), `sessionInk.ts`, `continueInk*.ts` (Shift-click continues the
  last stroke), `straightInk.ts` (Shift: a straight run whose direction snaps to 15°; Cmd/Ctrl turns the snap off);
  delegated ink (`delegatedInk.ts`) uses the browser's ink presenter when present. Cmd/Ctrl held over Draw or
  Highlight is a temporary whole-item eraser (`input/attach.ts`, `holdAccelEraser`), never the chosen tool.
- **The eraser removes whole items, as it goes** (`input/basicTools.ts` `EraserGesture`, `input/eraseSweep.ts`); there is no
  partial erase and no preview. The path is kept in world units; each round asks the stretches drawn since the last one
  against the board as it is by then (`region(…, { at, painted })`, exact, reach `eraserRadiusCss`: 8 CSS px, 12 for a
  finger, the ring cursor `[data-board-cursor="eraser"]` and the trail's width) and deletes what they touch in that task.
  The whole gesture is one history step (`history.open('Erase')`; a step already open is marked and rolled back to), open
  only while the pointer is down: release closes it and each stretch still to land reopens it (`reopenLast`), so a stroke
  drawn meanwhile is its own step and never part of the erase. Escape/undo before release cancels it, an undo while the
  last stretch lands undoes it if it is still the latest step (`EraseStep.latest`), any other end keeps what went. Only items whose delete reads
  geometry (containers, attached arrows, group children: `eraseReadsGeometry`) wait for a pin. A camera move does not end
  an erase (`cancelForCamera` skips it). `painted`: an unfilled figure is touched by its outline, its marks and its label
  only (a dashed line whole: `VectorNarrowPart.solid`). With Cmd/Ctrl and the Eraser a stretch takes the top-most item and
  spares what lay under it for the rest of the gesture. A frame's border or name takes the frame with all it holds.
- **Inside a frame a region query must still answer** (`viewer/regionQuery.ts`, eraser, box and lasso alike): the scene's
  bounds of a text, note, arrow or labelled shape stay uncertified on a reopened board (`ColdLayout`), so the frame decision
  reads the prepared geometry's own bounds, and an item its frame cuts is asked through its clipped parts
  (`registerClippedNarrow` for kinds with no narrow job). An undecided item is a silent miss: never refuse for missing bounds.
  **Never make the erase wait for a frame**: applied at release behind a preview frame, it never landed on a 10,000-stroke
  board, and pacing rounds by `presented` cost 50-100 ms on a 3,000-stroke one.
- Pen mode (`ToolState.penMode`, `penTransitions.ts`) routes a stylus to ink or eraser while touch pans. A pen contact whose
  eraser end changed holds the input past its lift until its erase lands; a press meanwhile (not a finger) is queued and
  replayed in order when it ends, resolved with the tool chosen at the press (`pointerRouter.ts` `queued`), never refused.
  A press made while a key's edit (a nudge, a turn: `keyEdit`, `keyEditLanding`) still lands is queued the same way. Its
  mode starts from the eraser bit.
- A pen is a mouse with its own tolerances: its barrel press is a right press (`secondaryPan`: drag pans, a click opens the
  menu, with the click slop of a pen), and its double-tap is decided by the board host (`components/whiteboard/penDoubleClick.ts`:
  one `dblclick` per pen double-tap within 16 px, the browser's own withheld), since Chromium's double-click rectangle is a mouse's.
- On a paged board (notebook, PDF) Space pages on release, or on its key repeats, and pans when a press comes while it is
  held (`keyboard.ts` `spacePage`).
- The laser (`input/laserTrail.ts`) is a session fade, never saved; Escape clears a visible trail before it
  returns the tool to Select (`input/attach.ts`).
- A bar press dragged off the bar goes to `ToolState.beginChromeDrag` → `input/chromeDrag.ts` (router-owned): the
  shape is created where the pointer is released (a Text drop shows its mark on the pointer meanwhile). A mouse or
  pen click only selects the tool on release; a finger's press selects it at once (touch-start). Bar buttons carry
  `touch-action: none` (`chrome.css`), else the browser pans and cancels the finger drag. In pen mode a finger drag
  off the bar creates nothing (`attach.ts` resolve gate); the tap still selects.
- Select (`tools/select.ts`, `input/selectGesture.ts`, `viewer/selectServices.ts`): click, marquee (the accelerator,
  ⌘ on macOS and Ctrl elsewhere, inverts `isWrapMode` full containment; a mac Ctrl press is a right click), Alt-drag scribble; both select live and Escape restores the start
  selection. Handles: `viewer/selectionHandles.ts`, `shapeHandles.ts`, `stickyHandles.ts`; a coarse pointer draws
  them larger (`viewer/pointerKind.ts`).
- Creation: `viewer/creationTools.ts` (`boardCreationTool`: figure, text, sticky, frame, connector, polyline) and the
  text tool in `text/edit/tool.ts`. With grid mode on, every figure and frame rounds its origin and size, and a note its
  centre; an arrow's free start rounds to the grid (`input/gridCreation.ts` `gridBox`, `gridPoint`). A frame's border double-click fits it to its children (`viewer/frameBorderFit.ts`).
- Arrow ends (`input/connectorHandles.ts`, `input/bindingPrecision.ts`, `viewer/connectorHints.ts`): precise after
  320 ms of rest, 600 ms of arrow-tool hover, or on a slow entry; a fast entry binds to the centre. Alt is exact,
  Cmd/Ctrl skips binding. A figure changing shape re-snaps its precise ends that its new outline leaves outside to
  the nearest outline point (`geom/attachments.ts` `resnappedShapeAnchors`, called by `chrome/styleCommands.ts`
  `setShape`; the same transaction). Route changes (arc/elbow) keep the anchors as they are.
  A bound arrow's container is the nearest ancestor its two shapes share (`geom/connectorParent.ts` `bindingContainer`), set by
  creation and by the end drag's commit; a release keeps an arc's radius (`geom/connectorBend.ts`). Creation drops a drag under 10
  units (`CONNECTOR_MIN_LENGTH`, `viewer/creationTools.ts`). An elbow's target hint draws its edge dots and anchor circle
  (`viewer/connectorHints.ts` `elbowHintOf`, `setTarget`); its arrow-tool hover draws the dots without an anchor.
  An elbow end on an edge is an edge port: `geom/resolveConnector.ts` `edgePort` takes the outward world axis of the edge
  its anchor sits on, and `geom/elbow.ts` builds the routes that leave or arrive along it, `elbowLeg(width)` out (tip gap
  6 × width, the head, and a shaft as long); the route may not run through the shape before that anchor.
  `render/conservativeConnector.ts` pads its envelope by the same leg.
- Translation commits positions rounded to 1e-6 board units (`geom/runtimeTranslation.ts`, `cleanPlacement`); the
  live preview keeps exact arithmetic, so a grid-snapped drop no longer commits 119.99999999999994.
- Navigation: `input/navigation.ts` and the wheel, touch and pinch modules (`cameraZoom.ts`, `oneFingerZoom.ts`,
  `touchDoubleTap.ts`, `panFling.ts`, `zoomBrush.ts`, `edgeScroll.ts`). Space + arrow pages through
  `viewer/keyboardNavigation.ts`: the glide lasts `PAGE_GLIDE_MS` (320 ms) times the board's animation speed, and
  jumps under reduced motion (speed 0). It glides on the platform scheduler (`rendering-platform`).
- Holding Z (zoom) sets the surface cursor to zoom-in, zoom-out while Alt is held, and the default cursor during the
  quick overview (Shift+Z); `input/attach.ts` `showZoomCursor` owns it and restores the saved cursor on release. The overview
  zooms about the pointer (`input/quickOverview.ts`), so the point under it stays fixed.

## Keyboard

- **One table** (`boardBindings` in `input/keyboard.ts`) supplies both dispatch and the shortcuts dialog
  (`components/whiteboard/chrome/ShortcutsDialog.tsx`, grouped by `shortcutGroups`). Add a row there, next to its
  related rows, never a stray listener. Commands that need app state go through
  `components/whiteboard/nativeEditingKeyboard.ts` with the same command ids. Chords are drawn by `bindingChord`, so
  the dialog and the tooltips read the same row.
- Row fields: `accel` is Cmd on Mac and Ctrl elsewhere; `shift` and `alt` are as named. Shifted digits and Alt letters
  match by physical `code`. `repeat` lets a held key repeat the row; a held key otherwise repeats only the shortcut
  it started (`started`). `alias` rows dispatch but are never listed (`b`/`x` for Draw, `Backspace` for Delete, the
  `tool.bar.N` digits, the unmodified `=`/`-` beside `Cmd+=`/`Cmd+-`, the arrow families). `dialogOnly` rows are
  listed but never dispatched: a momentary mode (`zoom.hold`, `zoom.quick`, `pan.camera`) or a family the dispatcher
  reads from the key (`tool.bar.position`, `nudge.move`); `chordKey` is the cap the dialog draws for them.
  `required` rows still work while the Keyboard shortcuts preference is off (Delete, `help.shortcuts`,
  `accessibility.repeat`, `accessibility.contextMenu`, `style.adjust`). `group` picks the dialog section; the
  `text-formatting` rows are the text editor's keys, which the board's dispatch skips.
- The listener is on the board's interaction root: a key reaches the board only while focus is inside it. Opening
  a document from the tree hands it the keyboard (`utils/documentKeyboard.ts` → `EditorPane`'s keyboard-target
  registry; `ViewerHost` registers the interaction root), and a pointer click on a board toolbar button hands it
  back (`returnKeyboard` in `ViewerHost.tsx`), except a button that opens a popup or a keyboard activation. A new
  floating control must keep this: a click that strands focus outside the root silently kills every shortcut.
  Closing a popup returns focus through `components/whiteboard/chrome/boardFocus.ts`; leaving a text edit does so in `viewer/textEditor.ts` (`returnFocus`).
- Order inside `keydown`: browser zoom keys (Cmd/Ctrl `+` `-` `0`) are taken first; then the guards (modal open,
  editing, a text-owned target); the keyboard cursor when active; Escape; paged keys and arrows (arrows nudge a
  selection, Space held pages the view, otherwise they pan); a printable unbound key with a selection starts typing
  into it (`typeText`; Space never does); Space and `z` hold pan and zoom; then the binding. A bound key is a shortcut
  before it is text (⌘⌥/, Ctrl+Alt+/ off macOS, opens the dialog, never types `/`). Modifier releases are debounced 150 ms
  (`input/modifierRelease.ts`), and every pointer event's own flags (and blur, focus loss, a hidden page) reconcile what
  is held: the board may see only half of a keydown/keyup pair. A temporary tool a view put up (the ⌘ eraser) is given
  back when that view detaches; the tool state outlives it. A read-only board runs only the `view` and `accessibility` rows, `select.*`,
  `tool.select`, `tool.hand` and `preferences.*`.
- Every gesture or shortcut a person can use belongs in the help page (`utils/helpDoc.ts`, owned by AGENTS.md's
  rule): a user-facing change is not finished until it is described there.

## Text

- Text, sticky, figure labels and frame names are rich text (`text/rich*.ts`), edited in place through
  `text/edit/` (`manager.ts` owns one binding per pane; content and history stay in the session). Input uses
  Chromium's **EditContext** (`text/edit/host.ts`) with a hidden textarea fallback; IME composition,
  character bounds and format updates come through it. Layout and caret come from the shared layout engine
  (`text/layout*.ts`, `caretIndex.ts`); the edit layer never measures a second copy of the text.
- Typed typography (quotes, dashes, ellipsis, arrows, symbols) and wrapping a selection with a typed bracket or
  quote are `text/edit/rules.ts`; both are skipped inside code and while a backtick is open.
- The formatting bar above a selection is `viewer/textFormatToolbar.ts`: it shows a format as on only when every
  character of the selection carries it. Its icons are Lucide data (see `PROVENANCE.md`).
- Click runs are counted by `PointerAcquisition` (`RealSample.clicks` on a press's first sample; `MULTI_CLICK_MS`, wider
  `MULTI_CLICK_CSS` for a pen): a pointerdown's `detail` is always 0. Inside an edit, 2 selects a word and 3 a paragraph, and a
  drag or Shift-click after them extends by that unit (`text/edit/pointer.ts`); a double-click that opens a text selects all.
- Cmd/Ctrl+K in a text edit finishes it and opens the palette (`text/edit/keys.ts`, `commandPalette` port). While editing,
  a press on another shape's text ends the edit and edits that text on release without a drag (`text/edit/inputBridge.ts`,
  `editOnRelease`); a press on the editing shape with focus elsewhere ends the edit so a drag moves the shape (`hasFocus`).
- While a node is being edited its paint is exact (`editingChanged`); a figure's label growth is measured exactly as
  an edit measures it (`text/edit/growth.ts`).
- Links in text are normalised through `text/edit/format.ts` (`linkUrl`) and opened only by an explicit gesture.

## Spell-check

- `text/spell/`: nspell with `dictionary-en` in a worker (`spell.worker.ts`), incremental over changed text
  (`incremental.ts`), only for what is visible (`visible.ts`), suggestions in the app's own context menu (`menu.ts`).
- The user dictionary is `localStorage['bme.whiteboard.userDictionary']` (registered in `utils/storage.ts`), at most
  10,000 words of 64 characters; storage is user-editable, so it is normalised on read. Board language tables are in
  `chrome/i18n/` (`chrome/language.ts`); the board dictionary setting is `components/BoardDictionarySetting.tsx`.
- Worker replies are validated (ranges inside the text, ordered) before use.

## Pictures, cards and embeds

- Media enters by the media tool, drop or paste (`media/ingest.ts`, `clipboard/`): sniffed, inspected and stored
  in the document's media store (`media/store.ts`); decoding runs in `media/decode.worker.ts`. SVG and video decode
  in opaque contained frames (`contained-frames` skill).
- **Crop is in-canvas**: `components/whiteboard/NativePictureCrop.tsx` (the crop bar and the floating controls over
  the picture) with `pictureCropStore.ts`, `nativeCropGeometry.ts` and the geometry in `media/crop.ts`. Enter applies,
  Escape cancels, and a click outside applies; a press on the bar (aspect, zoom, Fit) is not outside, and Apply or an
  outside commit returns focus to the board. Ctrl/Cmd-drag from a selected picture's handle starts a crop from that edge
  (`selectServices.ts` `beginHandle` → `cropFromHandle` → `beginEdge`: the press's drag follows on the window, capture
  phase). A dblclick on the body opens the crop after the press's gesture ends (`enqueueAfterGesture`), since the store
  refuses to start during one. A dblclick on a crop edge gives that side back.
- A pasted URL becomes a `linkcard`, or an `embed` for a known provider (`clipboard/insertText.ts`,
  `media/embed.ts`: seventeen providers in `EmbedProvider`, YouTube via youtube-nocookie; identifier-only path rules
  so a link cannot smuggle a second address). A pasted link fills a selected link-carrying item instead.
- **Embeds are inert until the person loads them** (`viewer/cardControls.ts`, `host/nativeEmbeds.ts`): consent is
  per node, URL and view lifetime, never saved. Opening a link (`media/openLink.ts`) and fetching a card preview are
  explicit gestures, never done while rendering. URL policy is `security/urlPolicy.ts`.

## Chrome and commands

- `components/whiteboard/chrome/`: `ToolStrip.tsx` (the bar, the padlock, the figure slot, More tools;
  `toolChoices.ts` for the figures on the bar and in More tools), `StylePanel.tsx` (+ `styleIcons.tsx`,
  `stylePanelStore.ts`; its row model is `src/whiteboard/chrome/stylePanel.ts`), `CommandPalette.tsx` (+
  `commandPaletteModel.ts`, `commandPaletteGroups.ts`; `commandPalette.open` opens it; it lays over the chrome's middle row (`.board-chrome-middle`), so the docked style panel never moves under it), `ZoomControls.tsx`,
  `BoardHeader.tsx`, menus (`mainMenu.ts`, `preferencesMenu.ts`, `themeMenu.ts`, `languageMenu.ts`), `boardCommands.ts`.
- The paged bar under the header (`NotebookControls.tsx` `PagedBar`, for notebooks and PDF ink) never wraps: what a narrow pane
  cannot show moves into its ⋯ popover, the paper settings first, then the view toggles; the page box stays. Each level's width
  is measured when shown, so it steps back only when the wider level fits (wrapped, a 339 px pane's bar was four rows over the page).
- The minimap is `components/whiteboard/NativeMinimap.tsx`; its open state is `boardPreferences.minimapOpen`.
- Context menus are the app's own (`nativeBoardContextMenu.ts`; `app-context-menu`).
  Dialogs and notices are the app's own UI; no native confirm/alert/prompt/tooltip. A board's notices (the render
  notices included) show together in its own `.board-viewer-notice` box, each with Dismiss, newest last (`useBoardNotices`,
  `BoardNoticeStack`): a new notice never replaces one, and only Dismiss counts as dismissing. In viewing and editing alike, a bare
  `role="status"` element with no place in the layout is in the DOM and nowhere on screen.
- Board preferences persist in `localStorage['bme.whiteboard.preferences']` (`utils/boardPreferences.ts`).
- ⌘C's copy is prepared ahead for the selection (`host/clipboardCommands.ts`), idle-only and paused for any gesture: it
  measures every item exactly (`render/worldBounds.ts`, which skips a stroke piece already inside the measured box: 4,000
  strokes ~3 s of main thread, ~60 s before it, which once made a nudge take 72 s). Only a board on screen prepares or
  keeps one (`shown`, `shownChanged`: the service's view bindings): it is charged to the shared CPU pool as `critical`
  with no evict, and three boards left with large selections starved the visible one until its nudge never landed.
- Copy/cut/paste are listened on the board surface (`useNativeClipboard.ts`); paste classifies native records,
  legacy, Excalidraw and HTML (`clipboard/paste.ts`), each admitted as an external source. A plain paste of board
  content stays where it was copied when it came from this board and sheet and overlaps the view, else it lands in the view's centre (`clipboard/placement.ts`); a cursor paste takes the deepest unlocked frame under the pointer (`frameUnder`), and Cmd/Ctrl+D repeats the last
  copy's offset (`clipboard/duplicateRepeat.ts`).

## Checking an editing change

Drive it as a person would (`verify-in-browser`): click the board first so it holds focus, choose tools by their
buttons (`getByRole('button', { name: /^Draw/ })`) or keys, draw with real `page.mouse` moves, and read the result
from the saved file or the screen — never from engine internals.
