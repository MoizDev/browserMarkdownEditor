---
name: app-context-menu
description: The app's own right-click and dropdown menu — one module-level store (utils/contextMenu.ts), one component (components/ContextMenu.tsx) — used by notes, tables, the file tree, tabs, panes, boards, PDFs, EPUBs, the terminal and the agent panel. Rules for raising it, dismissing it, positioning it, its row kinds and flyouts, its clipboard rows, and how other floating surfaces share Escape and ⌘F with it. Load before adding a menu row or a raiser, before any new floating surface (popover, dialog, picker) that could swallow a right-click or Escape, or before touching utils/escapeDismiss.ts or utils/clipboard.ts.
---

# Right-click: one store, one menu

`src/utils/contextMenu.ts` holds one module-level slot (`openContextMenu`, `closeContextMenu`,
`subscribeContextMenu`, `getContextMenu`). `useMainView` (src/app) reads it with
`useSyncExternalStore` and `App.tsx` renders `<ContextMenu request onClose={closeContextMenu}>` once.
**Never write a second menu component or a menu of your own** — the board's, the PDF's and the
EPUB's menus are all this one. The browser's native menu never shows over app content.

## Why a module store, not a prop

Three constraints no prop satisfies together (the file's header says it at length):
1. `src/editor/` raises it (a table cell, `tableWidget.ts`/`tableEdit.ts`) and is React-free; so are
   `src/pdf/` (`pdf/overlay/textMenu.ts`) and the board engine, which reach it through plain callbacks.
2. A CodeMirror widget's handlers **outlive the pane that built them** (`tabs-and-panes`), so what
   they call must be stable for the app's life. A module function is; a `useCallback` is not.
3. `FileExplorer`/`TreeNode` are memoized so the tree does not re-render while the reader types. A
   threaded "menu target" prop would re-render every visible row twice per menu. Instead the row's
   "the menu is on me" highlight is the row's **own state**, cleared by the `onClose` it hands over.

`utils/contextMenu.ts` therefore stays React-free: entries are **plain data plus callbacks**, never a
node to render. `ContextMenu` decides what each kind draws.

## The request

`{ x, y, entries, label, opener, anchor?, onClose?, className?, lang?, dir? }`
- `label` is the menu's aria-label, in the house form `"<noun> actions"` (`Note actions`,
  `Vault actions`, `Pane actions`, `Book reading actions`) or the surface's name (`Board`, `Canvas`).
- `opener`: focus returns here on close **only if nothing else took the keyboard** (focus is on
  `body`) — a row's `run` may place focus deliberately (Insert table… puts the caret in the new cell);
  measured, an unconditional restore threw it back to `.cm-content`.
- `anchor`: pass the BUTTON for button-raised menus. A second press on the same anchor closes the menu
  (`openContextMenu` returns `false` — set a pressed look only on `true`), and the outside-pointerdown
  dismissal exempts the anchor; without both halves the pointerdown closed it and the same press's
  click re-opened it (the flicker bug). Right-click raisers pass no anchor: a second right-click
  re-raises at the new point.
- `onClose` runs exactly once however it closed. **Opening a menu closes the one it replaces**, running
  that request's `onClose`. Hence the load-bearing order in `TreeNode`: `setMarked(true)` runs
  **after** `openContextMenu(...)`, so right-clicking the same row twice batches the outgoing
  `setMarked(false)` before the new `true`.
- `lang`/`dir` localize the board's menus (`dir: 'rtl'` mirrors flyout side and arrow keys).
  `className` lands on the menu and its flyouts for a stylesheet only (`board-main-menu`, and
  `board-main-menu-dark` because the menu renders outside a dark board's pane and must carry its own
  tokens — `whiteboard/chrome/chrome.css`).

## Row kinds (`ContextMenuEntry`)

- `command`: `{ id, label, run, shortcut?, danger?, checked?, disabled?, reason? }`. Set `checked` on
  **every** command of a pick-one menu (the explorer's sort): rows become `menuitemradio` with a shared
  ✓ gutter; leave it undefined everywhere else so no empty gutter appears.
- `separator`; `label` (quiet text, `role="none"`, outside the arrow-key walk, optional tooltip).
- `submenu`: `{ entries: (command | separator | submenu)[] }`, opens on hover, click or the forward
  arrow, nests (`SubmenuRows`), and positions beside its row, flipping to the other side at the edge.
- `grid` (Insert table… → `TableSizeGrid`: `rows` includes the header and is floored at 2, roving
  tabindex, ArrowLeft at column 1 bubbles so the menu closes the flyout). Picking closes the menu.
- `entry-style` (a file/folder icon and colour → lazy `EntryStylePicker`, the only route to the
  Lucide set, which keeps it out of the main bundle). Picking does **not** close the menu (icon and
  colour are two choices), and the picker seeds its own state from the entry because entries are built
  once at raise time. See `entry-styles`.

**`label` may be a file NAME, never note contents or markup.** Labels render as React text children
(so names are escaped — the tab strip's `⌄` lists tabs by name), but the menu must never become an
HTML sink: this origin holds the vault's handle. Spelling suggestions on a board are words from the
dictionary, which is the same category as a name.

**A row that cannot act stays on screen, disabled, with a `reason`** (its tooltip) — a dead row that
says nothing looks broken (`VaultMenu.messageFor`'s rule). Arrow keys skip disabled rows; the first
**enabled** row takes focus on open (a disabled `<button>` cannot), else the menu itself does.

**A row runs against the state that raised the menu.** Entries are built at raise time and the menu
stays open while things change underneath, so a row that acts on a selection must re-check it. The
board's menu (`nativeBoardContextMenu.ts`) captures `selection` + `doc.rev` and every row says
"The selection changed; open the menu again." instead of acting on a different selection.
`useMainView` closes any menu when `mainView` or `rootHandle` changes, because both unmount what rows
close over.

## Who raises it

- **Right-click:** note text (`DocumentPane`, `.view-content`), table cells (`tableEdit.ts`, native
  listener that stops propagation), tree rows (`TreeNode`) and the empty tree (`FileExplorer`), board
  canvas/selection (`whiteboard/viewer/toolServices.ts` → `nativeBoardContextMenu.ts`; also from the
  keyboard via `KeyboardContextRequest`), board text editing and spelling (`nativeEditingLease.ts`),
  the plain canvas view (`useNativeClipboard.ts`), PDF text (`pdf/overlay/textMenu.ts`,
  `PdfReadingText`, `usePdfTiledCopyMenu`), PDF and note find fields (`editor/findPanel.ts`), EPUB text, terminal, agent panel.
- **Buttons** (positioned from `getBoundingClientRect()` bottom-left, `opener` + `anchor`): tab group
  `⌄` (`TabBar`), pane `⋯` and history `↔` (`DocumentPane`), explorer create and sort
  (`FileExplorer`), table row/column grips (`tableWidget`), board main menu (`BoardHeader`), sheets
  (`SheetMenu`), zoom (`ZoomControls`), agent panel `⋯`.

**The note handler's location is its safety argument.** It is a React `onContextMenu` on
`.view-content`, which is rendered only for text documents (`!isCanvas && !unreadable && !texReading`):
board, notebook, PDF and EPUB panes and the graph view are never inside it, so their own menus are
excluded by construction with no `closest()` list to drift. Do not turn it into a document-level
listener with an exclusion list. It is also not `EditorView.domEventHandlers`: those are baked into
the cached `EditorState`, and CodeMirror refuses events raised inside widgets. It moves the caret to
the click first unless the click is inside the selection, using the **loose** `posAtCoords(…, false)`
— the precise one returns `null` on an empty last line, which put "Insert table…" at the top of the
note.

**Contained frames** (`contained-frames`): the EPUB reader is an opaque iframe, so its runtime
forwards the right-click as frame-relative coordinates and `EpubPane` adds the iframe's rect. A
pointerdown **inside** an iframe never reaches the parent document, so the outside-click dismissal
cannot see it: the reader sends a `dismiss` command and `useReaderIntegration` calls
`closeContextMenu()`. Any new framed surface that raises the menu needs the same.

## Dismissal and position (`ContextMenu.tsx`)

- **Escape: `window`, capture phase, prevented and stopped.** The menu is drawn over CodeMirror and
  boards, which bind Escape themselves, and focus is usually still behind it. (The same reason as
  `ConfirmDialog`.)
- Outside `pointerdown` (capture, anchor exempt) closes without restoring focus; **any scroll** closes
  it (capture-phase on `document`, so an editor scroll counts) except scrolls inside the menu (it has a
  `max-height`) and a `<textarea>`/`<input>` scrolling its own text (xterm scrolls its hidden textarea
  on the raising right-click); a window `resize` closes it.
- The menu and its flyouts `preventDefault` their own `contextmenu` (or the browser menu opens on top)
  and their own `dragover`/`drop` (an unclaimed desktop file dropped on the menu opened a new browser
  tab).
- **Position: render at `0,0` hidden with `opacity: 0` (not `visibility: hidden`), measure, then flip,
  then clamp** to an 8 px margin (`place`). `visibility: hidden` cannot take focus, so the menu opened
  with the keyboard elsewhere. At `0,0` because a fixed box with `left` set shrinks to the room left
  before the viewport edge, so measuring at the click near the right edge measured a squeezed box.
- One menu replacing another **re-renders, not remounts**: the measured position and any open flyout
  are reset during render when the request object changes. Keep that if you add per-menu state.

## Clipboard rows (`utils/clipboard.ts`)

⌘X/⌘C/⌘V are the browser's and need no permission. A **menu row** is not a live gesture, so
Chromium may refuse `navigator.clipboard.readText()`/`writeText()`. That is normal: `copyText` and
`readClipboardText` resolve (never throw) and the caller shows `CLIPBOARD_READ_BLOCKED` /
`CLIPBOARD_WRITE_BLOCKED`, which name the keystroke that works. **Cut deletes only after the write
resolves**, so a refused clipboard never destroys the text. `document.execCommand('paste')` does not
work in Chromium web content; do not try it.

## Other floating surfaces

- **Modal** surfaces carry `role="dialog" aria-modal="true"`, take the keyboard on open, hand it back to
  the opener on close and close on Escape (`ConfirmDialog`, `TrashPanel`, `SettingsPanel`). The note's
  ⌘F/⌘G/F3 handler (`DocumentPane`'s `keyIsForNote`) stands down while any `[aria-modal="true"]` is in
  the document and when focus is inside `[role="menu"|"dialog"|"listbox"]` or a text field — so a
  surface that owns the keyboard must say so in its markup, or ⌘F opens the note's search behind it.
- **Non-modal** surfaces (VaultMenu, backlinks popover, PDF find bar and outline, board sheets/tool
  strip, agent popovers) close on Escape through `dismissOnEscape(close)` from `utils/escapeDismiss.ts`
  — never a `keydown` listener of their own. Register in the effect that opens the surface and return
  its unsubscriber from that effect (registration order is stacking order; do not let the effect re-run
  while open). It is one bubble-phase `document` listener with a stack: only the newest surface closes,
  the press is prevented, an Escape already `defaultPrevented` or composing is ignored. The other half:
  **anything that consumes Escape must `preventDefault()` it**, or the surface behind closes on the same
  press (#36). Capture-and-stop is only for surfaces over CodeMirror/boards or modals.
- The inline "new note/folder" name box in the tree is the same module-store pattern
  (`utils/createRequest.ts`): one box, keyed by folder path (`''` = root); the raiser expands the
  ancestors, the target row expands itself.
