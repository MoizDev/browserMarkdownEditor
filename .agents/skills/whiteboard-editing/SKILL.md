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
  restores the selection it was made with.
- **Previews never change the document.** A gesture shows its effect through `viewer/preview.ts` (the preview
  layers have a permanent slot, `previewSlot.ts`: inserting layers mid-gesture changed the topology, which seals
  platform input and cancelled the gesture itself). Only a completed, still-current pointer-up applies its
  preflighted transaction (`tools/transform.ts`).
- Geometry for a change is prepared off-thread (`render.prepareChangeGeometry` / `pinChangeGeometry`, the exact
  jobs in `geom/`); a commit waits for it rather than guessing.
- Read-only is the session's `isReadOnly` (admission or apply's seal; a developer setting can force it per kind,
  `utils/engineRouting.ts`) plus per-node `locked` (`isLocked` walks ancestors). Save must honour it too.
- The AI agent edits boards through the same transactions (`whiteboard/agent/`, `change/agentBatch.ts`;
  `vault-agent` skill).

## Tools and input

- Tools are registered in `input/boardTools.ts`. `persistent` (select, pen, highlighter, eraser, hand, laser) stay
  chosen; `single-use` (zoom, text, sticky, figure, frame, connector, polyline, media) return to Select after one
  use (`ToolState` in `input/gesture.ts`) unless the tool lock is on or `keepToolOnce` was armed. Escape returns
  to Select. Tool choice is session UI state, never history.
- A tool whose work lands after pointer-up returns to Select itself (`completesTool` in `input/pointerRouter.ts`).
- **One gesture owner at a time** (`input/router.ts`, `InputRouter`): tools receive normalised `RealSample`s only,
  stamped with an `InputToken` (vault epoch, tab, session and view generations). A replaced view cannot finish its
  successor's contact; check the token before acting on anything async.
- A superseded hover pick, a marquee the person ended, any async step a newer one replaced: its rejection is never
  shown. Report only `!isCancellation(error) && !signal.aborted` (`platform/workers/envelope.ts`; it covers the worker
  host's own `'Cancelled'`, which a DOM-`AbortError`-only check showed as "bme-worker-host-v1: Request aborted").
- Ink: `input/liveInk.ts` (wet curve), `sessionInk.ts`, `continueInk*.ts`, `straightInk.ts`; delegated ink
  (`delegatedInk.ts`) uses the browser's ink presenter when present. Pen mode (`ToolState.penMode`) and
  `penTransitions.ts` route a stylus to ink or eraser while touch pans. The eraser removes whole items
  (`input/basicTools.ts`); there is no partial erase.
- Select (`tools/select.ts`, `viewer/selectServices.ts`): click, marquee (Ctrl = full containment), scribble/lasso (Alt+drag);
  handles and transforms in `viewer/selectionHandles.ts`, `shapeHandles.ts`, `stickyHandles.ts`,
  `tools/transformDrivers.ts`. Creation tools are `viewer/creationTools.ts`.

## Keyboard

- **One table** (`boardBindings` in `input/keyboard.ts`) supplies both dispatch and the shortcuts dialog
  (`components/whiteboard/chrome/ShortcutsDialog.tsx`); add a shortcut there, never a stray listener. Extra
  bindings that need app state go through `components/whiteboard/nativeEditingKeyboard.ts` with the same commands.
- The listener is on the board's interaction root: a key reaches the board only while focus is inside it. Opening
  a document from the tree hands it the keyboard (`utils/documentKeyboard.ts` → `EditorPane`'s keyboard-target
  registry; `ViewerHost` registers the interaction root), and a pointer click on a board toolbar button hands it
  back (`returnKeyboard` in `ViewerHost.tsx`), except a button that opens a popup or a keyboard activation. A new
  floating control must keep this: a click that strands focus outside the root silently kills every shortcut.
- Order inside `keydown`: paged/arrow navigation (arrows nudge a selection, else pan), then a printable unbound key
  with a selection starts typing into it (`typeText`), then Space/`z` hold pan/zoom, then the binding. A bound key is
  a shortcut before it is text (⇧/ opens the dialog, never types `?`). Read-only boards run only view,
  accessibility, select and navigation bindings. Shifted digits and Alt letters match by physical `code`.
- Every gesture or shortcut a person can use belongs in the help page (`utils/helpDoc.ts`, owned by AGENTS.md's
  rule): a user-facing change is not finished until it is described there.

## Text

- Text, sticky, figure labels and frame names are rich text (`text/rich*.ts`), edited in place through
  `text/edit/` (`manager.ts` owns one binding per pane; content and history stay in the session). Input uses
  Chromium's **EditContext** (`text/edit/host.ts`) with a hidden textarea fallback; IME composition,
  character bounds and format updates come through it. Layout and caret come from the shared layout engine
  (`text/layout*.ts`, `caretIndex.ts`); the edit layer never measures a second copy of the text.
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
  in opaque contained frames (`contained-frames` skill). Crop is `NativeCropDialog.tsx` + `media/crop.ts`.
- A pasted URL becomes a `linkcard`, or an `embed` for a known provider (`clipboard/insertText.ts`,
  `media/embed.ts`: seventeen providers in `EmbedProvider`, YouTube via youtube-nocookie; identifier-only path rules
  so a link cannot smuggle a second address).
- **Embeds are inert until the person loads them** (`viewer/cardControls.ts`, `host/nativeEmbeds.ts`): consent is
  per node, URL and view lifetime, never saved. Opening a link (`media/openLink.ts`) and fetching a card preview are
  explicit gestures, never done while rendering. URL policy is `security/urlPolicy.ts`.

## Chrome and commands

- `components/whiteboard/chrome/`: `ToolStrip.tsx` (tools; `toolChoices.ts` for the figures on the bar and its
  More-tools menu), `PenPanel.tsx` (colours and width), `BoardHeader.tsx`, `ZoomControls.tsx`, menus
  (`mainMenu.ts`, `preferencesMenu.ts`, `themeMenu.ts`, `languageMenu.ts`), `boardCommands.ts`.
- Context menus are the app's own (`openBoardContextMenu.ts`, `nativeBoardContextMenu.ts`; `app-context-menu`).
  Dialogs and notices are the app's own UI; no native confirm/alert/prompt/tooltip. A board's notices (the render
  notices included) show in its own `.board-viewer-notice` box with Dismiss, in viewing and editing alike: a bare
  `role="status"` element with no place in the layout is in the DOM and nowhere on screen.
- Board preferences persist in `localStorage['bme.whiteboard.preferences']` (`utils/boardPreferences.ts`).
- Copy/cut/paste are listened on the board surface (`useNativeClipboard.ts`); paste classifies native records,
  legacy, Excalidraw and HTML (`clipboard/paste.ts`), each admitted as an external source.

## Checking an editing change

Drive it as a person would (`verify-in-browser`): click the board first so it holds focus, choose tools by their
buttons (`getByRole('button', { name: /^Draw/ })`) or keys, draw with real `page.mouse` moves, and read the result
from the saved file or the screen — never from engine internals.
