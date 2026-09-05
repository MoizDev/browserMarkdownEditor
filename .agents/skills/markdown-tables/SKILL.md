---
name: markdown-tables
description: The rendered-table subsystem — tableModel.ts, tableWidget.ts, tableEdit.ts, tableFit.ts. Load before changing anything about how tables parse, render, are edited in place, or are sized; and before adding any new construct that writes back into a cell.
---

# Tables: an editable object over raw markdown

A rendered table is an **object with an inside**: never revealed by the cursor, its range atomic,
each `<th>`/`<td>` a `contenteditable="plaintext-only"` island whose every keystroke writes markdown
back through `view.dispatch`. It is the embedded-image model extended to a thing with parts. The
file on disk still holds ordinary GFM pipe markdown — this is a layer over it, not a new format.

Four files, and the split matters:

| file | owns |
|---|---|
| `tableModel.ts` | pure geometry. DOM-free, `EditorView`-free. **The single definition of what a table is.** |
| `tableWidget.ts` | renders one; owns the HTML sink and the corner chips |
| `tableEdit.ts` | what happens inside a cell: keyboard contract, write-back, row/column commands, cell menu |
| `tableFit.ts` | sizes it |

## One escape loop, one answer

Three questions must be asked of the same pipe markdown and must never disagree: which document
spans are tables at all, where every cell begins and ends *in the document*, and what each cell
renders as. All three are in `tableModel.ts`, sharing `parseRow`'s character loop — **moved there
rather than copied**, because only *unescaped* pipes delimit and a second copy of that loop is a row
that silently gains a column.

## Parsing and the decoration pass

- **The pass is the regex**, not a syntax-tree node — `findTables(doc)` runs `/(^\|.+\|…)/gm`.
- It returns **only spans `parseGrid` accepts**. Load-bearing: the caller pushes an atomic,
  never-revealed `Decoration.replace` for every span it gets, so a span the widget cannot build
  cells for would be a block of the user's own text with **no way to put a caret in it**.
- `splitTable` is the gate — the delimiter must be line 1 exactly, because `isSeparatorLine` also
  accepts a bare `-`, so a table whose header row is `| - | - |`, or one carrying a duplicated
  delimiter row, would otherwise read as having no header. Such a span stays ordinary markdown.
- **The code guard is CONTAINMENT, not the image pass's intersection test.** `collectCodeRanges`
  collects `InlineCode` as well as fences, and a table spans several lines, so
  `from < r.to && to > r.from` rejects any table with one `` `code` `` cell. `r.from <= from &&
  r.to >= to` is exact. A quoted table that rendered could be neither revealed nor edited back out
  of its fence, and its cells would write into a code block. The Help guide carries exactly this case.
- **No math guard, deliberately.** `overlapsMath` is an intersection too, so it would reject any
  table containing `$x$`; a containment version could only fire for a table wholly inside a math
  region, which cannot occur.

## Entry: there is no typing exception, and there could not be

An image's three mechanisms are: never suppressed by the cursor, atomic, plus a
caret-strictly-inside exception for the embed being typed. A table cannot half-exist — the pattern
needs three complete lines — so the third is replaced by two narrow rules in `livePreview.ts`:

- **`tableEntryKeymap`** (`Prec.high`) binds the four arrows *beside* a table and returns `false`
  otherwise: Down/Right enter the first row, Up/Left the last, and the column comes from the
  caret's x so vertical motion feels continuous. Down/Up first ask `moveVertically` whether the
  move would **leave the logical line** — not whether it lands on the table's edge, because
  `skipAtomicRanges` parks a position on the range's *far* side, so a downward move over a table
  reports `to`, never `from`.
- **`tableAdoptListener`** catches the two cases a keypress could not produce: a caret **strictly
  inside** a rendered table (Home/End with wrapping on is the one motion path CodeMirror does not
  run through `skipAtoms`; an undo or programmatic dispatch can leave a caret anywhere), and a table
  **typed into existence** (the last body row may have no trailing newline, so the caret sits on the
  new table's `to`; left alone the next character un-renders it, one flicker per keystroke).
  Boundaries are otherwise **never** adopted — `from` and `to` are where every documented way *out*
  parks the caret. The typed-into-existence case is gated on `input.type` (excluding pastes and
  every write this feature makes) **and on the last body row being column-complete**: the body group
  is `(?:^\|.+\|[ \t]*\n?)+`, so a row matches with ONE cell, and typing `| a | b |`⏎`| --- | --- |`⏎
  `| c | d |` makes a table two keystrokes early. Adopting there pulled the caret into the empty
  last cell, so the user's own closing `|` was correctly escaped and landed in the file as
  `| c | d \| |` (measured, 4/4).

**Backspace and Delete beside a table select it first.** The range is atomic, so
`@codemirror/commands` would widen through the whole table and swallow it in one keystroke. A
second press deletes through the default command. A selected table carries `cm-table-selected` on
**its own container**; the root's `cm-image-selection` class is document-wide, so a ring scoped to
it would outline every table in the note at once.

## The editable island

Four facts of the pinned CodeMirror 6.39.15 source are why this is a supported door: CodeMirror
discards every DOM mutation inside a widget (`readMutation`, `:7329-7332`), ignores a selection
change inside one (`:7092-7105`), never moves the DOM selection while focus is off the `contentDOM`
(`:2994-3002`), and reports `eventBelongsToEditor === false` for any event whose path crosses a
widget that ignores events (`:4775-4785`).

**`ignoreEvent()` is therefore NOT overridden** — keeping the default (`true`) buys all four. The
last one is why `tableEdit.ts` binds Tab, the arrows, Escape, `Mod-a`, `Mod-b`/`Mod-i` and **even
`⌘Z`**: inside a cell this app's whole keymap stack is not running, so an unbound `⌘Z` would reach
only the browser's per-element contenteditable undo stack, which knows nothing about our
transactions. `⌘X`/`⌘C`/`⌘V` and text selection are deliberately left to the browser — native
operations on a `plaintext-only` element, needing no permission, and the `input` event that follows
runs the ordinary write-back.

**Focus must be repaired after every write-back, and it is the mechanism, not a safety net.**
Measured in this app's real extension stack: a dispatch that changes a table's source **blurs the
focused cell to `BODY`**, even though the element identity survives, it is still connected, and
`updateDOM` returned `true`. Without the repair — `cell.focus({preventScroll:true})` plus the caret
range, synchronously at the end of `writeBack` — the table takes exactly **one** character. The
repair checks `isConnected` first: the cell can genuinely be gone (typing `-` into every header cell
makes the header row a valid separator, which `parseGrid` rejects by design).

## `updateDOM`'s session guard

`findWidget`'s second pass offers any same-class tile's DOM to any widget of that class, so a second
table on screen could adopt the element the caret is sitting in. The guard refuses `dom` to any
widget whose text is not the one this edit just wrote — written on `session.dom === dom`, **never on
`!==`**: refusing every dom that is not the session's would refuse a widget its own pooled element
and send it through `destroy()` + `toDOM()`, the exact tear-out the guard prevents.

Every dispatch that changes a live session's table publishes `session.expected` **first**
(`publishExpected`), or the guard fires on the session's own write. The structural commands do the
opposite — they **end** the session before dispatching, because a published `expected` sends
`updateDOM` down its "our own write-back, touch nothing" branch and a table that just gained a row
would never be redrawn.

**Nothing reachable from `updateDOM` or `destroy` may dispatch.** Both run inside a CodeMirror
update, where `EditorView.update` throws. That is why a shape change **defers** its re-fit.
Conversely `updateListener` handlers run *after* the `finally { this.updateState = 0 }`, which is
what makes the entry rules above legal.

## The `canEdit` naming trap

**The widget's flag is `canEdit`, and must never be called `editable`.** `WidgetType.prototype`
carries an undocumented `get editable()` that is absent from the `.d.ts`. Measured twice: a
`readonly editable` constructor parameter property — the exact idiom `ImageWidget` uses — **throws**
at runtime with a completely clean typecheck; a plain field declaration instead silently shadows the
getter, stopping CodeMirror marking the widget root `contenteditable="false"` and letting the editor
put a caret in the table's chrome. `eq` compares `rawTable`, `canEdit` and `selected`.

## Every write is surgical

Nothing that already exists is ever reconstructed. A cell edit replaces that cell's inter-pipe span;
insert row is one `\n| … |` at a line end; insert column inserts one segment per line at a known pipe
offset; delete column removes one segment plus its pipe per line. Whole-table serialization exists
**only to create a table that did not exist before** (*Insert table…*, and a brand-new row's text).

Three bug classes are made unreachable rather than merely avoided:

1. The user's hand-aligned padding, their `:---:` and their `\|` all survive an edit to the cell
   beside them byte for byte.
2. The caret is never mapped onto both edges of a replaced span, which used to de-render the table
   under the reader's hands.
3. **`parseGrid` truncates an over-long row on RENDER only** — a serializing writer would write that
   truncation back, so a body row `| 1 | 2 | 3 |` under a two-column header would lose the `3` on
   the first keystroke.

**The inverse of the parse is one function, `escapeNewPipes`:** escape a `|` that is not already
escaped (odd-run parity — not a `(?<!\\)` lookbehind, which misclassifies `a \\| b`), collapse
`[\r\n\t]+` to a space, carry a caret map. It is idempotent and a **no-op on untouched text**, which
is why the focused cell is shown its **raw source slice** (`a \| b`, not `a | b`) rather than needing
a blanket `\\` doubling that would rewrite `C:\path` to `C:\\path` on the first edit.

**The trailing-backslash guard is a SECOND function** (`protectTrailingBackslash`), and where it
runs is the whole of it. A cell's span excludes the padding either side, so in an unpadded table
(`|a|b|`) that span abuts the row's closing pipe and a cell ending in an odd run of `\` would escape
it — the row loses a segment and a whole column leaves the screen. Three rules, the first two each
got wrong once:

- It runs **after the trim**, because the writers trim and the trim is what strips the whitespace
  hiding the run: `escapeNewPipes('cmd \ ').text` ends in a space so nothing is doubled, and
  `.trim()` then hands the document `cmd \` — measured, `|a|b|` fell from two columns to one.
- It runs on the **document-bound string only, never on the DOM**, because it is idempotent, so a
  cell showing its result is a *fixed point*: typing `\` gave `\\` and every Backspace after it was
  undone by the re-escape on the next `input`.
- It runs **only when the span abuts the pipe** — elsewhere the next character is a space, `\ ` is
  not an escape, and rewriting the user's bytes buys nothing. That is why it is not folded into
  `escapeNewPipes`, which is fed the DOM's text and must stay something a keystroke can take back.

`writeBack` trims before writing to the document but never trims the DOM node's text — reversing
that compounds whitespace into the saved file on every keystroke.

**Alignment is parsed, preserved and rendered.** Preserving is free (the delimiter row is never
rewritten by a cell edit); rendering closes a real defect — a table whose file says `---:`
displaying left-aligned in the reader's only editor. The classes need **two-class specificity**
(`.cm-table-widget th.cm-table-align-center`), because the `text-align: left` beside them is
`.cm-table-widget th`. There is no alignment *editing* UI.

## The cell menu and the corner chips

The DOM outlives the widget instance that built it, so nothing hung off it may close over that
instance or remember a position: the chips read the table's current shape off a `TableModel` hanging
under a `Symbol` on the container (`ImageModel`'s pattern), every command re-locates the table in the
*current* document through `posAtDOM` + `parseTableLayout`, and listeners are delegated on the
**container** — a shape change replaces every cell element but never the container.

The cell menu's Cut/Copy/Paste act on the **cell's** own selection, captured as offsets when the menu
is built (by the time a row is clicked the menu has taken focus and the DOM selection is gone;
`caretOffset` is the fallback when there was no selection). Reusing the editor menu's clipboard rows
would copy nothing and paste into the document immediately *before* the table.

**Each corner chip is summoned by its own edge, and neither by the caret** (`attachEdgeReveal`,
`EDGE_BAND_PX`). A `pointermove` on the container toggles `cm-table-near-right` /
`cm-table-near-bottom`, so the only thing that puts a chip on screen is a reader already reaching
for it. Four facts:

- **It is pointer arithmetic, not a pair of CSS `:hover` zones, because a hoverable zone takes
  clicks.** Both bands lie over real cells, so a CSS answer would swallow the click that puts a caret
  in them. Same reason the layer is `pointer-events: none`, and why the chips are `pointer-events:
  none` *until revealed*: `opacity: 0` still hit-tests, so a hidden chip otherwise sat in the corner
  of every editable table quietly taking clicks — and showing `cursor: pointer` — that belong to the
  cell underneath.
- **`:focus-within` used to hold both chips up while the caret was in a cell, and it FLICKERED once
  per character.** Every write-back blurs the focused cell to `BODY` and refocuses it synchronously,
  so the predicate went false→true per keystroke on a transitioned property. Measured: ten characters
  with the pointer parked off the table drove the layer `1 → 0 → 0.85 → 0 → …`. It bought nothing —
  the chips are `tabIndex: -1` and were never keyboard-reachable; the keyboard route to a row or
  column is the cell's own context menu.
- **The band (48px) is deliberately wider than a chip** (~21px at the default 16px editor font,
  ~35px at the maximum 28px). A narrower band would let the pointer land *on* a revealed chip from
  outside the band that revealed it, blinking it away as it was being aimed at.
- **The box is re-read every frame, not cached when the pointer arrives** — a re-fit, an added row
  or a window resize all move it under a pointer that never moved — and at most once per frame,
  since `pointermove` outruns paint.

**`tableEdit.ts` and `tableWidget.ts` import each other, deliberately.** Leaving a cell has to put
the cell's *rendered* HTML back, which is an HTML path, and doing it in `tableEdit` would open a
**second `innerHTML` sink** away from the allowlist. So `tableWidget` exports `restoreRenderedCell`.
The rule that keeps the cycle safe: **neither side may touch the other's exports at
module-evaluation time.** Every use on both sides is inside a function body.

**"Read-only" here is `EditorView.editable` and nothing else** — `!state.readOnly &&
state.facet(EditorView.editable)`. `EditorState.readOnly` is never set anywhere in `src/`, so a
guard written as `view.state.readOnly` is always `false`; and `editable.of(false)` does **not** block
a programmatic `view.dispatch`, so such a guard would let *Insert table…* really insert a table into
a document the reader is only reading. Note the predicate exists twice — `lists.ts`'s and
`tableEdit.ts`'s `canWrite` — as independent copies; change both.

## How a table gets its width (`tableFit.ts`)

A markdown table has no width of its own and the text width is whatever the reader configured, so
something has to decide.

- **The starting point was a CSS inheritance bug.** CodeMirror's line wrapping puts
  `white-space: break-spaces; word-break: break-word; overflow-wrap: anywhere` on `.cm-content`, and
  cells inherit all three. `anywhere` doesn't merely permit a mid-word break — it collapses the
  table's intrinsic **minimum** width to about one character per column, so `width: 100%` could
  squeeze a column narrower than its longest word and "Location" rendered as "Locat / ion".
  `.cm-table-widget` resets all three; without that reset every measurement below is meaningless.
- **Columns are sized by max-min fairness, not the browser's.** The available width is shared by
  raising one common level, so short columns get everything they ask for and only greedy ones split
  the remainder. Chromium's auto layout shares space in *proportion* to what each column wants,
  letting one paragraph column starve every short column beside it. Note where `COMFORT_EM` applies:
  it caps what a column may **demand** (and so how far the table shrinks), but the share-out's upper
  bounds are the raw max-content widths, which is what lets a paragraph column absorb what the short
  columns didn't need. Widths are written to `<col>` as **percentages** with `table-layout: fixed`.
- **`COMFORT_EM` is the one knob that decides when a table shrinks**, and it exists because wrapping
  per se isn't the problem — a column holding a sentence is *expected* to wrap. Only wrapping a
  reader would take for damage is: a broken word, or a short label folded in half.
- **The type scale is found by MEASURING at it, never by scaling the note-size measurements down.**
  Text width is not proportional to font size — glyph advances round, and the error runs to several
  percent, easily enough to wrap the one cell the shrink was protecting. Each pass measures, sees how
  far off that leaves it, and steps; a table that already fits stops after the first pass. Two floors
  bound it: a comfort floor, and a lower hard floor worth crossing only to prevent a broken word.
- **Last resort, per column, never table-wide.** A column whose longest unbreakable run still doesn't
  fit gets `overflow-wrap: break-word` **on its own cells**. Applying it to the table broke
  "Environment" for a neighbouring URL's sake.
- **A fitted table can't overflow, which cuts both ways.** Pinned to exactly 100% of the text width,
  the `overflow-x: auto` on **`.cm-table-scroll`** — the box between the widget and the `<table>`,
  which exists so the overflow is *not* on the widget, since an overflow container clips in both axes
  and cut the corner chips off — only engages before the first fit. It does *not* rescue oversized
  content inside a fitted cell: fixed column widths mean such content overflows the **cell** while
  the table still measures 100%, so nothing scrolls and it paints across the next column.
- **A cell's HTML is an allowlist, and the allowlist admits no attributes.** `renderInlineMarkdown`
  escapes everything except a fixed set of attribute-free inline tags (`br`, `b`, `i`, `code`, `kbd`,
  `sub`, `sup`, …), re-emitted from the pattern's own alternation rather than copied out of the
  input — so no untrusted markup is ever parsed and no attribute is ever emitted. **This is the only
  place in the app where note text reaches the DOM as HTML**, and this origin holds the vault's
  directory handle in IndexedDB with permission already granted, so a note carrying
  `<img src=x onerror=…>` would get read/write over the whole vault the moment it was opened.
  `<br>` is in because it is the only way to break a line inside a cell; `<a href>` and `<img src>`
  are out because they need attributes. Side benefit: `Type<T>` renders instead of being swallowed.
- **Two structural facts the chips depend on and the fit must survive.** `.cm-table-widget` is
  `position: relative`, because `contain: inline-size` is **size** containment only and does not
  establish a containing block: measured without it, a chip at `top: 2px` escaped to `.cm-content`
  and landed 60px down the page (`position` does not alter inline size, so the fit is untouched).
  And **both chips sit fully inside the box**, never at a negative offset, which made the widget
  scrollable back when the overflow was still on it. The chips are out of flow and the width probe is
  still the container's **direct first child**.
- **Re-fitting is driven by two probes inside the widget** — a zero-height block whose width *is* the
  available text width, and hidden text (normally sized, clipped by that box) whose width changes iff
  the note's font metrics do — watched by one shared `ResizeObserver`. They are the fit's INPUTS and
  nothing the fitter writes changes either, so a fit can't re-trigger one from inside the widget;
  watching the container instead would notify on its own height change every time. That invariant
  stops at the widget's edge: a fit changes the table's height, and where scrollbars take layout
  space that can toggle the editor's own, moving `.cm-content`'s *percentage* padding. Chromium
  bounds that at a round per frame and it hasn't been observed on overlay-scrollbar platforms — don't
  restate the claim more broadly. Between them the probes cover window and sidebar resizes, the
  Text-width and font-size settings, and a Google Font arriving late.
- **A fit must not change the table's height after CodeMirror has measured it**, and three things
  cooperate. Resize observations arrive *after* the frame in which CM measures, so a table laid out
  at its natural size and fitted a moment later leaves CM's height map — and the caret the selection
  layer drew from it — describing the taller table; nothing corrects that on its own, because CM
  re-reads line heights only when its own content box changes, which on a short document it never
  does. The symptom was a caret stranded hundreds of pixels below the click that placed it. So:
  1. **`contain: inline-size` on `.cm-table-widget`.** Restoring `overflow-wrap: normal` gives the
     table a real min-content again, which while still browser-laid-out propagates up and pushes
     `.cm-content` *wider than its scroller* — so the first fit reads an inflated text width, fits
     too generously, and a second fit corrects it a frame later. Containment makes the box's inline
     size a function of its container alone: one fit is enough.
  2. **The last fit is remembered per table source and re-applied in `toDOM`**, so a re-created table
     (the caret leaving it, ⌘E, a tab switch, scrolling back) has its first layout already be its
     final one. The entry carries the editor width and font it was computed at, read live from
     `.cm-content` rather than remembered — a remembered value goes stale exactly when it matters,
     since the editor can be resized while a table is showing its source.
  3. **A widget's FIRST fit, if it did change the height, re-states the selection.** That is the one
     public lever reaching the selection layer (it re-measures on `selectionSet`); `requestMeasure`
     alone only refreshes the height map, and only when the content box moved. Restricted to the
     first fit because later ones are resizes, where CM re-measures anyway.
- **The fit's contract with the editing layer: a content change does not re-fit, a shape change
  does.** The cell write-back calls `rekeyTableFit`, which points the memo at the new source **and
  nothing else** — columns moving under the reader's hands mid-word is what the "a content change
  alone never re-fits" rule already forbids, and without the re-key the cache would accumulate one
  entry per character. A row or column change, a `⌘E` flip, or a source change from anywhere else
  (an undo, another pane) calls `retuneTableFit`, which resets `lastAvail`/`lastFont`/`lastBreaks`
  **and `fitted`** — required, because `fitted` licenses the height-map re-state at the end of
  `applyFit`, and a shape change is precisely the case that changes an already-measured height.
  `retuneTableFit` re-applies the remembered fit synchronously (style writes only) and schedules
  `applyFit` for the next animation frame, coalesced per table. Leaving a cell re-renders it and does
  **not** re-fit.
- Cell padding is in **em, not px**, so it shrinks with the type; padding that stayed put would grow
  into the space the text just gave up. Same for the inline-code chip's padding.
- **Only unescaped pipes split a row.** `\|` is GFM's one way to put a pipe in a cell and is required
  everywhere, code spans included. Splitting on every pipe used to merely mis-render such a row; once
  rows are truncated to the header's column count it silently *drops* everything past the phantom
  split, so the two must stay in step.
