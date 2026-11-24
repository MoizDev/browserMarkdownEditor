---
name: markdown-tables
description: The rendered, in-place-editable GFM table in notes — tableModel.ts (what a table is), tableWidget.ts (rendering, the cell HTML allowlist sink, maths in cells, grips and chips), tableEdit.ts (cell editing, write-back, row/column commands, the cell menu), tableFit.ts (column widths and type scale), tableReadingSelection.ts, and the table entry rules in livePreview.ts. Load before changing how tables parse, render, are edited, sized or selected, and before adding any construct that writes back into a cell or renders cell text.
---

# Tables: an editable object over raw markdown

A rendered table is an **object with an inside**, like an embedded image: never revealed by the
cursor, its range atomic, each `<th>`/`<td>` a `contenteditable="plaintext-only"` island whose every
keystroke writes markdown back through `view.dispatch`. The file still holds ordinary GFM pipe
markdown — a layer over it, never a new format. Read `live-preview` first for the decoration pass.

| file | owns |
|---|---|
| `editor/tableModel.ts` | pure geometry, DOM- and view-free. **The single definition of a table** (`tablePattern`, `findTables`, `parseGrid`, `parseTableLayout`, `pipeOffsets`, `rowColumnCount`, `escapeNewPipes`, `protectTrailingBackslash`) |
| `editor/tableWidget.ts` | `TableWidget`; the cell HTML sink `renderCellContent`; maths in cells; grips and corner chips |
| `editor/tableEdit.ts` | inside a cell: keyboard, `writeBack`, session guard, row/column commands, cell menu, `insertTableAtCursor` |
| `editor/tableFit.ts` | column widths and the table's type scale |
| `editor/tableReadingSelection.ts` | native selections that cross table cells in Reading mode |
| `editor/livePreview.ts` | decorating tables, `tableEntryKeymap`, `tableAdoptListener`, `completeHeaderRow` |
| `utils/tableInsertRequest.ts` | Insert table… from the pane's `⋯` (no view there), grid size 8×10 |

## One escape loop, one answer

Which spans are tables, where each cell begins and ends in the document, and what each cell renders
as must never disagree. All three live in `tableModel.ts` and share `parseRow`'s character loop:
**only unescaped pipes delimit** (`\|` is GFM's pipe-in-a-cell, required even in code spans), and a
second copy of that loop is a row that silently gains a column. Rows are truncated to the header's
column count on render, so a split on an escaped pipe would *drop* content, not just misdraw it.

## Finding tables (the decoration pass)

- `tablePattern()` is a regex (header row, delimiter row, body rows), not a syntax-tree node. The scan
  is incremental: `analysisObjects.ts` (`scanObjects` / `updateObjects`) runs `findTables` over changed
  windows and marks each span `accepted` unless a code range **contains** it; `livePreview` decorates
  only accepted spans inside the visible window.
- `findTables` returns **only spans `parseGrid` accepts**. Load-bearing: every returned span becomes
  an atomic, never-revealed `Decoration.replace`, and a span the widget cannot build cells for would be
  the user's own text with no way to put a caret in it. `splitTable` requires the delimiter on line 2
  exactly (`isSeparatorLine` also accepts a bare `-`, so `| - | - |` would otherwise read as no header).
- **The code guard is containment, not intersection.** `collectCodeRanges` includes `InlineCode`, so
  an intersection test rejects any table with one `` `code` `` cell; a fenced table must stay text,
  because an atomic widget could never be edited back out of its fence. **No math guard**, deliberately
  (an intersection would reject any table with `$x$`).
- The widget's identity is `eq(rawTable, canEdit, selected, emphasis key)`. A Reading-emphasis
  preference change rebuilds only table widgets (`livePreview`'s field `update`), not the whole pass.

## Entering and leaving

There is no "caret inside reveals source" exception: a table cannot half-exist. Instead:
- **`tableEntryKeymap`** (`Prec.high`) binds the four arrows *beside* a table (else returns `false`):
  Down/Right enter the first row, Up/Left the last, column from the caret's x. Down/Up first ask
  `moveVertically` whether the move **leaves the logical line** — `skipAtomicRanges` parks a position
  on the range's far side, so a move over a table never reports its near edge.
- **`tableAdoptListener`** catches a caret **strictly inside** a table (Home/End with wrapping skip
  `skipAtoms`; undo or a programmatic dispatch) and a table **typed into existence** (gated on
  `input.type`, excluding pastes and this feature's own writes, **and** on the last body row being
  column-complete: the body regex matches a one-cell row, and adopting early sent the user's own
  closing `|` into the cell as `\|` — measured 4/4). Boundaries (`from`, `to`) are never adopted:
  they are where every way out parks the caret.
- **Enter on a lone header row** (`completeHeaderRow`) adds the delimiter and one blank body row and
  puts the caret in it. It declines mid-line, on a delimiter-shaped line, before a pipe-fenced line,
  inside a table or code. Tagged `input`, not `input.type`, so adoption ignores it.
- **Backspace/Delete beside a table select it first** (the range is atomic; the default command would
  swallow it in one press). The selected table gets `cm-table-selected` on its own container — the
  root's `cm-image-selection` is document-wide and would ring every table.
- In a cell: Tab/Shift-Tab step cells; Enter goes down a row (from the last row it appends one);
  Shift-Enter inserts the literal `<br>`; arrows at a cell edge move cells or leave the table; Escape
  leaves (prevented **and** stopped — CodeMirror binds it too); **Alt+↑/↓ moves the row**.

## The editable island

Pinned `@codemirror/view` 6.39.15 discards DOM mutations and selection changes inside a widget, never
moves the DOM selection while focus is off `contentDOM`, and reports `eventBelongsToEditor === false`
for events crossing a widget that ignores events. **So `ignoreEvent()` is NOT overridden** — the
default buys all four. The cost: inside a cell the app's keymaps do not run, so `tableEdit.ts` binds
Tab, arrows, Enter, Escape, `Mod-a` (the cell's contents), `Mod-b`/`Mod-i` (swallowed; bold is typed),
and **`⌘Z`/`⌘Y`/`⌘⇧Z`** (ends the cell session, runs CodeMirror's undo/redo) — an unbound ⌘Z would hit
the element's own contenteditable undo, which knows nothing of our transactions. ⌘X/⌘C/⌘V and text
selection stay native; the `input` that follows runs the ordinary write-back.

- **Focus is repaired after every write-back — it is the mechanism, not a safety net.** Measured: a
  dispatch that changes the table's source blurs the focused cell to `BODY` though the element
  survives. Without `cell.focus({preventScroll:true})` + caret range at the end of `writeBack`, the
  table takes exactly one character. Check `isConnected` first: the cell can be gone (typing `-` into
  every header cell makes a delimiter row, which `parseGrid` rejects).
- **The `canEdit` naming trap.** Never name the widget's flag `editable`: `WidgetType.prototype` has an
  undocumented `get editable()` missing from the `.d.ts`. A `readonly editable` parameter property
  throws at runtime with a clean typecheck; a plain field shadows the getter and lets the caret into
  the table's chrome.
- **`updateDOM`'s session guard.** `findWidget` offers any same-class tile's DOM to any widget of that
  class, so a second table could adopt the element the caret is in. The guard refuses `dom` to a widget
  whose text is not what this edit just wrote — written as `session.dom === dom`, **never `!==`**
  (that would refuse a widget its own pooled element and tear it out). Every dispatch that changes a
  live session's table calls `publishExpected` **first**; structural commands do the opposite and
  **end** the session before dispatching, or `updateDOM` takes the "our own write, touch nothing"
  branch and a new row is never drawn.
- **Nothing reachable from `updateDOM` or `destroy` may dispatch** (inside an update
  `EditorView.update` throws), which is why a shape change defers its re-fit. `updateListener`s run
  after the update finishes, which is what makes the entry rules legal.
- **"May this be written" is `canWrite(state)` from `editor/readingMode.ts`** — one copy. Reading
  mode sets `editable: false` and `readOnly: true`, but neither blocks a programmatic dispatch, so every
  write the table code dispatches must test it.
- `tableEdit.ts` ↔ `tableWidget.ts` import each other on purpose: leaving a cell restores its rendered
  HTML via `tableWidget.restoreRenderedCell`, so the HTML sink stays in one file. **Neither side may
  touch the other's exports at module-evaluation time.**

## Every write is surgical

Nothing that exists is reconstructed. A cell edit replaces that cell's inter-pipe span; insert row is
one `\n| … |`; insert/delete column touches one segment per line; `moveRow` swaps two lines byte for
byte; `moveColumn` swaps two raw segments per line **including the delimiter** (alignment travels);
`setColumnAlign` rewrites one delimiter cell. A blank delimiter cell is written ` --- `, never empty,
or the row stops matching. Whole-table serialization exists **only to create** a table (Insert
table…, a new row's text). This makes three bugs unreachable: hand padding, `:---:` and `\|` survive
edits beside them; the caret is never mapped onto both edges of a replaced span (that de-rendered the
table); and `parseGrid`'s render-only truncation of an over-long row is never written back.

- **`escapeNewPipes` is the inverse of the parse**: escape a `|` not already escaped (odd-run parity —
  a `(?<!\\)` lookbehind misreads `a \\| b`), collapse `[\r\n\t]+` to a space, carry a caret map.
  Idempotent and a no-op on untouched text, which is why a focused cell shows its **raw source slice**
  (`a \| b`), not a doubled-backslash rewrite that would turn `C:\path` into `C:\\path`.
- **`protectTrailingBackslash` is separate**, and where it runs is the point: in an unpadded table
  (`|a|b|`) a cell ending in an odd run of `\` would escape the closing pipe and drop a column. It runs
  **after the trim** (the trim exposes the run; measured, `|a|b|` fell to one column), **on the
  document-bound string only, never the DOM** (it is idempotent, so a cell showing its result can never
  be backspaced out of `\\`), and **only when the span abuts the pipe**.
- `writeBack` trims what goes to the document, never the DOM text (that compounds whitespace into the
  file per keystroke).
- Alignment is parsed, preserved and rendered (`.cm-table-widget th.cm-table-align-center` needs the
  two-class specificity to beat the default `text-align: left`).

## Grips, chips and the cell menu

The DOM outlives the widget instance that built it, so nothing hung off it may close over the instance
or remember a position: the current shape is a `TableModel` under a `Symbol` on the container, every
command re-locates the table in the **current** document (`posAtDOM` + `parseTableLayout`), and
listeners are delegated on the **container** (a shape change replaces cells, never the container).

- **Corner chips** (add row / add column) are summoned by pointer distance to their own edge
  (`attachEdgeReveal`, `EDGE_BAND_PX` = 48), never by the caret and never by CSS `:hover` zones (a
  hoverable zone over cells takes their clicks). Hidden chips are `pointer-events: none` (`opacity: 0`
  still hit-tests). `:focus-within` was removed: every write-back blurs and refocuses, so it flickered
  once per keystroke. The box is re-read at most once per frame, never cached.
- **Grips** (`gripButton`, `placeGrips`): one per axis, moved to the row/column under the pointer,
  **outside and flush** against the table (a gap fires `pointerleave` on the way). The index is written
  to `data-index` by the reveal pass and read at the press. Their menus (`rowMenuEntries`,
  `columnMenuEntries`) use the shared menu with the grip as `anchor`; `openFor` remembers which index,
  so a press beside another row reopens for it. Shade with `cm-table-target` only when
  `openContextMenu` returns `true`, unshade in `onClose`.
- **The cell menu's Cut/Copy/Paste act on the CELL's selection**, captured as offsets when the menu is
  built (the menu then takes focus and the DOM selection is gone; `caretOffset` is the fallback). The
  editor menu's clipboard rows would paste before the table. The table's `contextmenu` listener stops
  propagation so `.view-content`'s note menu does not open on top (`app-context-menu`).
- **Insert table…** from the pane's `⋯`: that menu has no view, so the pick is a one-shot
  `requestTableInsert` answered by the **focused** `DocumentPane` for that path via
  `insertTableAtCursor` — the menu focuses its pane before opening.

## Cell HTML: the allowlist sink (AGENTS.md's "two places")

- `renderInlineMarkdown` escapes everything and re-emits only a fixed set of **attribute-free** inline
  tags (`br`, `b`, `i`, `code`, `kbd`, `sub`, `sup`, …) from the pattern's own alternation — no input
  markup is parsed, no attribute is ever emitted. `<a href>`/`<img src>` are out because they need
  attributes. This origin holds the vault handle: `<img src=x onerror=…>` in a note would own the vault.
- **`renderCellContent(cell, text, emphasis)` is the ONE write site**, and
  `CELL_PARSER.innerHTML = renderInlineMarkdown(masked)` the one assignment (lint `bme/html-sinks`
  allows `innerHTML` in `tableWidget.ts`; don't add a second). `CELL_PARSER` is a detached **`<div>`,
  not a `<template>`**: template parsing drops a stray `</br>`, which `CELL_HTML` admits and a `<td>`
  turns into `<br>` (the only divergence across all thirteen tags, measured).
- **Maths is masked out before the allowlist and spliced back as DOM.** Strip `\uE000`/`\uE001` from
  the text, find math regions (`findMathRegions`, with inline-code ranges from the **same** `` `(.+?)` ``
  regex the allowlist uses), replace each with `\uE000<i>\uE001`, run the unmodified allowlist, then
  `fillMathSlots` replaces each slot with a `span.cm-table-math` filled by `renderMath`
  (`mathWidget.ts`). Masked, not split: splitting at formulas breaks emphasis around them, and
  unmasked, `_…_` italics ate subscripts. Collect all text-node holders before splitting any.
- **Sentinel forgery is handled at the lookup.** `&#xE000;9&#xE001;` survives every string stage and is
  decoded by the parser; `MATH_SLOT` also matches a lone sentinel, and a token naming no region or one
  already used is **deleted** (measured: a forged slot emptied `#root` on every open). Escaping `&`
  is not the fix (it breaks a cell meant to show `&lt;br&gt;`).
- KaTeX is a DOM builder, not a sink. `output: 'html'` is required (MathML doubles `textContent`, which
  caret arithmetic, copy and `beginCellEdit`'s raw-vs-rendered guard read), so the span carries
  `role="math"` + `aria-label` of the source. `displayMode: false` even for `$$…$$` (a cell is one
  line). While KaTeX loads, `renderMath` shows source tagged `data-math-pending`. Clicking a maths cell
  lands the caret at the end, as for `**bold**` — expected; do not weaken the guard.
- Maths CSS (`index.css`), each measured: `.cm-table-math { white-space: nowrap }` **plus**
  `.cm-table-widget .cm-table-math .katex-html > .newline { display: inline }` (KaTeX's top-level `\\`
  is a block span); `.cm-table-widget .cm-table-math svg { max-width: none; height: inherit }` (surds
  are inline SVG; restate, never `revert`); and the **cell** holding a formula scrolls
  (`th:has(.cm-table-math), td:has(.cm-table-math) { overflow-x: auto }`) — never the formula's own
  span (an inline-block shifts its baseline). Known cost: an over-wide formula is clipped on overlay
  scrollbar platforms; that is a fitter decision, left alone. `renderCellContent` resets that cell
  scroll when it replaces children.
- **Reading emphasis** in Reading mode is DOM-built on top of the sink for body cells only
  (`emphasizeCell`, not `<th>`); editable widgets ignore it (`effectiveEmphasis`), and the fit key
  includes the emphasis key. `tableReadingSelection.ts` keeps a native selection that crosses cells: it
  captures both endpoints (CM position or cell + text offset) before CodeMirror redraws and restores
  once after, without a transaction, and stops CodeMirror's `selectionchange` handling when either end
  is in a cell (CM checks only the anchor). Read-only only; never in Edit.

## Width and type scale (`tableFit.ts`)

- `.cm-table-widget` resets `white-space`/`word-break`/`overflow-wrap` inherited from `.cm-content`:
  `overflow-wrap: anywhere` collapses min-content to a character per column ("Locat / ion"). Every
  measurement depends on that reset.
- **Max-min fairness**, not Chromium's proportional auto layout (one paragraph column starved the
  rest). `COMFORT_EM` (12) caps what a column may **demand**; share-out bounds are raw max-content.
  Widths go to `<col>` as percentages with `table-layout: fixed`.
- The type scale is found by **measuring at each size** (≤ `MAX_FIT_PASSES` 3), never by scaling
  measurements (glyph advances round). Floors: comfort `MIN_TABLE_FONT_PX` 11 / `MIN_SCALE` 0.6, then a
  hard floor 8 px / 0.45 used only to avoid a broken word. Last resort is `overflow-wrap: break-word`
  **per column**, never table-wide. Cell padding is in em so it shrinks with the type.
- `.cm-table-scroll` (between widget and `<table>`) holds `overflow-x: auto`, so overflow does not clip
  the chips; a fitted table is exactly 100% wide, so oversize content in a cell overflows the cell.
  `.cm-table-widget` is `position: relative` (`contain: inline-size` is not a containing block) and
  both chips sit fully inside it; the width probe is the container's first child.
- **Three probes, one shared `ResizeObserver`:** a zero-height block (available width), hidden text in
  the note's font, and a span with `FONT_PROBE_TEXT` in **both** `KaTeX_Main` and italic `KaTeX_Math`
  (a variable renders in KaTeX_Math; measured +26.7 px when only Main was sensed). The two font widths
  are summed into `fontWidth`. They are the fit's inputs and nothing the fit writes moves them, so a fit
  cannot re-trigger itself. Size/AMS/Typewriter faces are unsensed — a known limit.
- **A fit must not change height after CodeMirror measured it** (the caret was stranded hundreds of px
  below the click): `contain: inline-size` makes one fit enough; the last fit is cached per
  `fitKey` (bounded, `FIT_CACHE_MAX` 32) and re-applied in `toDOM`, validated against the live editor
  width and font; and a widget's **first** fit that changed height re-dispatches the current selection
  (the one public lever that re-measures; it runs from a frame callback, not an update).
- **A content change does not re-fit; a shape change does.** `writeBack` calls `rekeyTableFit` (points
  the cache at the new source, nothing else — columns must not move under the reader mid-word). Row or
  column changes, ⌘E, and source changes from elsewhere (undo, another pane) call `retuneTableFit`,
  which resets `lastAvail`/`lastFont`/`lastBreaks` **and `fitted`**, re-applies the cached fit
  synchronously and schedules `applyFit` on the next frame, coalesced per table. Leaving a cell
  re-renders it without re-fitting.
