---
name: app-context-menu
description: The app's own right-click menu — one module-level store, one component — and the rules for raising it, dismissing it, positioning it, and its clipboard rows. Load before adding a context-menu row, a new raiser, or any new floating surface that could swallow a right-click.
---

# Right-click: one store, one menu (`utils/contextMenu.ts` + `components/ContextMenu.tsx`)

The app draws its own context menu instead of the browser's, in note text, in a table cell, on a
file-tree row and on the empty tree area. There is exactly **one** component and **one** module-level
store; `App` reads it with `useSyncExternalStore` and renders `<ContextMenu>` once.

- **The store is a module, not a prop, and that satisfies three constraints no prop could satisfy
  together.** `src/editor/` raises this menu (a right-click in a table cell) and knows nothing about
  React, so the raiser has to be a plain function. A widget's handlers **outlive the pane that built
  them** (see `tabs-and-panes`), so anything they call must be stable for the app's life; a
  `useCallback` with dependencies is not, and a per-pane ref only hides the staleness. And
  `FileExplorer` is `React.memo`'d and `TreeNode` memoized *specifically* so the tree stops
  re-rendering while the reader types — a threaded `contextTargetPath` would re-render every visible
  row twice per menu, once on open and once on close, for a value exactly one row cares about.
  Importing the store adds **no prop at all**: `FileExplorerProps` and `TreeNodeProps` gained none,
  and the "this row is the menu's target" highlight is the row's **own local state**, cleared by the
  `onClose` the row hands over with its request. It is the same trap `saveEpoch` was moved out of the
  prop tree to escape.
- **`openContextMenu` closes the menu it replaces**, running the previous raiser's `onClose`. Which
  makes an ordering in `TreeNode` load-bearing: `setMarked(true)` runs **after**
  `openContextMenu(...)`, not before. Right-clicking one row twice makes both calls that row's own —
  the outgoing request's `setMarked(false)` and this one's `setMarked(true)` — and React batches them
  into one render, so marking first leaves the row unmarked underneath its own open menu.
- **The editor's handler is a React `onContextMenu` on `.view-content`, and WHERE it lives is the
  whole safety argument.** That element is rendered `{!isCanvas && …}`, `DrawingPane` is its sibling,
  `EditorPane` mounts every `PdfPane` *outside* the slot, and `GraphView` replaces `EditorPane`
  altogether — so tldraw's own menu, a PDF's and the graph's are excluded **by construction, with no
  `closest()` list to drift out of step** as new floating surfaces are added. Do not "improve" this
  into a document-level listener with an exclusion list: **suppressing tldraw's own menu would be a
  regression, not a feature.** It is also not `EditorView.domEventHandlers`, for two independent
  reasons: those are baked into the cached `EditorState` and outlive the pane, and CodeMirror's own
  event dispatch refuses events raised inside a widget — the one place a menu is most wanted. It uses
  the **loose `posAtCoords` overload** deliberately: the precise one returns `null` for the last,
  empty line of a document, which broke "Insert table…" at end-of-note.
- **Escape is on `window`, in the CAPTURE phase, and both prevented and stopped.** `VaultMenu`'s
  bubble-phase Escape is fine in the sidebar and wrong here: this menu is drawn over CodeMirror, which
  binds Escape itself, and focus is usually still in a pane behind it. That is the bug
  `ConfirmDialog.tsx` was written to fix. The cell's own Escape does both too.
- **A scroll dismisses it, and a resize does.** Unlike `VaultMenu`, which hangs off a button, this one
  hangs off a **point in the viewport** — a scroll moves the thing it was aimed at out from under it,
  and it is routinely raised inside a scrollable editor. The scroll listener is capture-phase (an
  editor scroll does not bubble to `window`) and excludes scrolls **inside** the menu, which is what
  lets the menu itself have a `max-height` and scroll.
- **Position: measure at the corner, then flip, then clamp.** The menu is rendered once at `0,0` and
  **`opacity: 0`, not `visibility: hidden`** — measured: a visibility-hidden element cannot take focus
  and `focus()` on it is a silent no-op, so the menu opened with the keyboard still on whatever raised
  it. At `0,0` rather than at the click, because a `position: fixed` box with `left` set and no width
  shrinks to fit the room to the viewport's edge, so measuring near the right edge measures a box
  squeezed to its `min-width` and the flip would then place a *wider* menu back off the screen. One
  menu replacing another **re-renders rather than remounts**, so the measured position and any open
  flyout are reset during render when the request changes.
- **A row that cannot act stays on screen and says why** (its `reason` becomes the `title`) —
  `VaultMenu.messageFor`'s rule: a dead row that says nothing is indistinguishable from a broken one.
  Arrow-key navigation skips disabled rows, and the first *enabled* row takes focus on open (a
  disabled `<button>` cannot). Focus goes back to the opener on close, but **only if nothing else has
  taken the keyboard**: a row's `run` may place focus deliberately and runs synchronously while the
  cleanup does not — measured, an unconditional restore sent the caret from the new table's first cell
  back to `.cm-content`, past the table.
- **Both the menu and the flyout cancel their own `dragover`/`drop`.** An uncancelled drop target
  navigates the whole app away to the dropped file, taking every unsaved buffer with it — the same
  rule `.view-content` and the split divider already follow. A right-click **on** the menu is
  prevented too, or the browser's menu opens on top of the app's.
- **The clipboard is two different stories and the menu has to tell both.** `⌘X`/`⌘C`/`⌘V` are the
  browser's and need no permission — they *are* the gesture. A **menu row** is not: by the time it is
  clicked the right-click is spent, so Chromium permission-gates `navigator.clipboard.readText()` and
  can refuse outright. That refusal is the normal case, not an error case, so `utils/clipboard.ts`
  resolves rather than throws and every refusal raises the app's own dialog **naming `⌘V`**. Cut
  deletes only once the clipboard **write resolves**, so a refused clipboard never also destroys the
  text. `document.execCommand('paste')` is not usable in Chromium web content and is deliberately not
  attempted.
- **A menu row closes over a view or a tree node**, so `App` closes the menu whenever `mainView` or
  `rootHandle` changes — both of those unmount the things the rows act on.
- **The size picker is a flyout, not a modal.** `ConfirmDialog` could not host it anyway (its
  `children` render inside a `<p>`, its `onConfirm` carries no value, and focus goes to a button), and
  a flyout beside the row needs no backdrop and no focus round trip. It is positioned inline by the
  component — only it knows the row it hangs off — and the stylesheet supplies chrome only.
  `TableSizeGrid` floors rows at `MIN_ROWS`, uses a roving tabindex, and lets ArrowLeft at column 1
  bubble so `ContextMenu` can close the flyout.
