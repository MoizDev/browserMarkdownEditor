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
  place in the app where note text reaches the DOM as HTML by this repo's own code** — the one other
  sink is `mermaidWidget.renderInto`, which rests on mermaid's `securityLevel: 'strict'` DOMPurify
  pass instead of on an allowlist. This origin holds the vault's directory handle in IndexedDB with
  permission already granted, so a note carrying `<img src=x onerror=…>` would get read/write over
  the whole vault the moment it was opened.
  `<br>` is in because it is the only way to break a line inside a cell; `<a href>` and `<img src>`
  are out because they need attributes. Side benefit: `Type<T>` renders instead of being swallowed.
- **`renderCellContent(cell, text)` is that sink's ONE write site** — it used to be three
  (`buildRow`, `restoreRenderedCell`, `updateDOM`'s per-cell diff, each doing its own
  `cell.innerHTML = renderInlineMarkdown(...)`). They all call it now, and the single
  `CELL_PARSER.innerHTML = renderInlineMarkdown(masked)` inside it is the only assignment left.
  Collapsing them is what made maths in a cell safe to add; don't reopen a second one.
- **Maths is MASKED out of the cell before the allowlist runs, and spliced back in as DOM.** The
  order matters in both directions: on the way in, `$a_1 + b_2$` came back with its subscripts eaten
  by the `_(.+?)_` italic rule — the old behaviour was not "maths didn't render", it MANGLED it; on
  the way out, KaTeX's output is markup the allowlist would rightly escape into visible tag text.
  So: strip the two sentinels from the cell text, `findMathRegions` over it, replace each region
  with `\uE000<index>\uE001` (Private Use Area, written as escapes), run the **unmodified** allowlist
  over the masked string, parse once into the shared module-level `<template>` (`CELL_PARSER` —
  appending `.content` empties it, so a table re-dressing every cell allocates no template per cell),
  then walk the fragment's text nodes and `splitText`/`replaceWith` each slot for a
  `<span class="cm-table-math">` filled by `renderMath`.
  - **Masked, not split at the math boundaries.** Running `renderInlineMarkdown` over the pieces
    would break emphasis that spans a formula: `**bold $x$ end**` would lose its bold and show the
    literal asterisks, because neither piece holds a matched pair. The emphasis rules must see the
    whole cell, with each formula standing in as one inert token.
  - **The inline-code ranges fed to `findMathRegions` use the SAME `` /`(.+?)`/g `` the allowlist
    uses**, so both agree what is code and a `$` inside backticks stays literal.
  - **Sentinel forgery is possible and is handled at the LOOKUP, not the strip.** Stripping the cell
    text is not enough: `escapeText` leaves `&` alone by design, so `&#xE000;9&#xE001;` survives
    every string stage and the HTML parser decodes it into real sentinels inside the text node
    `fillMathSlots` walks. Measured — such a cell beside any real formula threw `undefined.latex` out
    of `toDOM`, React unmounted and **`#root` was left empty on every open of the note**; the
    in-range `&#xE000;0&#xE001;` rendered region 0 twice, doubling `cell.textContent`. So `MATH_SLOT`
    matches a lone sentinel too, and a token naming no region — or one already in `used` — is
    **deleted**. Escaping `&` is not the fix; it breaks the cell that means to show `&lt;br&gt;`.
  - **The parse container must be an ordinary element, not a `<template>`.** Fragment parsing takes
    its insertion mode from the context element; `<template>` parses "in template", which *ignores*
    a stray `</br>` that `<td>` (and a `<div>`) turn into `<br>`. `CELL_HTML` admits `</br>` on
    purpose, so a `<template>` silently rendered `one</br>two` as `onetwo`. Measured across all
    thirteen allowlisted tags, open and close: that is the only divergence.
  - **Holders are collected in full before any split** — `splitText` mutates the tree the
    `TreeWalker` is walking and the walker's position does not survive its current node being split.
  - **`katex.render` is a DOM builder, not a sink**: it builds with `createElement`/`createTextNode`,
    so no note text is ever parsed as markup. And it is synchronous, which is required — `updateDOM`
    may not go async. Don't lazy-import KaTeX in this path.
  - **`output: 'html'` is load-bearing here**, not just cosmetic: MathML would put every formula in
    `cell.textContent` TWICE, and `tableEdit`'s caret arithmetic, its copy path and `beginCellEdit`'s
    "does the rendered text differ from the raw source" guard all read that. Its price is that
    KaTeX's tree is entirely `aria-hidden` with no MathML beside it, so the span carries
    `role="math"` + `aria-label` of the LaTeX source — without it a maths cell is announced as
    **empty**, where before the change it at least read out its `$…$`.
  - **`displayMode: false` even for `$$…$$`.** A cell is one line; `.katex-display`'s
    `display:block; margin:1em 0; text-align:center` would break the row and the fitter's height
    accounting. Deliberate divergence from Obsidian.
  - Clicking a maths cell lands the caret at the **end** of it, because `beginCellEdit`'s
    `textContent !== raw` guard now always fires there — exactly as it already did for `**bold**`.
    Expected; do not "fix" it by weakening the guard.
  - CSS: `.cm-table-math { white-space: nowrap }` (a formula is one atom — `.katex .base` says it per
    base, this says it for the whole span; the fitter reads it through min-content as the column's
    floor) **plus `.cm-table-widget .cm-table-math .katex-html > .newline { display: inline }`,
    without which nowrap does not deliver it**: KaTeX breaks a top-level `\\` *structurally*, as a
    `.newline` span that katex.css makes `display: block`, and `displayMode: false` makes that
    unconditional rather than avoiding it. Measured, `$p \\ q$` in a cell rendered on two lines in a
    65.8px row against a plain row's 39.4px. The leading `.cm-table-widget` is for SPECIFICITY —
    katex.css is imported from `EditorPane` and so wins every tie against `index.css`. Environment
    row separators (`matrix`, `aligned`) carry no `.newline` and are untouched: verified. And the SVG exemption `.cm-table-widget .cm-table-math svg { max-width: none; height:
    inherit }` — `\sqrt` surds and stretchy delimiters are inline `<svg>`, which the widget's
    `img, svg, video { height: auto }` cap would collapse. It **restates** `katex.css`'s own
    `.katex svg { height: inherit }` rather than using `revert`, which would roll back the whole
    author origin — KaTeX's rule included — and land on the UA's `auto`, the value being escaped.
    And **the CELL holding a formula scrolls**, `th:has(.cm-table-math), td:has(.cm-table-math) {
    overflow-x: auto }`: the nowrap raises the column's min-content floor, but `COMFORT_EM` caps what
    a column may demand and `overflow-wrap: break-word` (the fitter's per-column last resort) cannot
    touch an unbreakable formula, so an over-wide one **overhung its neighbour** — measured on a
    five-column table, 18.9px past the cell at 1400px and 62.4px at 520px, with the rendered bands
    differing pixel-for-pixel, i.e. real ink on the next column's prose. Scoped by `:has()` so
    ordinary cells and a cell being edited (raw source, no `.cm-table-math`) are untouched. Do NOT
    instead scroll the formula's own span (`display:inline-block; max-width:100%; overflow-x:auto`):
    an inline-block baselines at its bottom margin edge, not its text's, so every formula would sit
    off the text beside it and grow its row — and `vertical-align: bottom` does not recover a formula
    taller than the line box. Cell scrolling costs nothing: measured, a formula's rect and the rect
    of the text node beside it in the same cell are identical, math rows keep plain-row height, and
    the fitter's per-column min-content/max-content are unchanged by the rule.
    **Known cost:** an over-wide formula is then CLIPPED with no affordance on overlay-scrollbar
    platforms (13–22px lost, measured at 820px). The fitter declined to shrink because `COMFORT_EM`
    capped the column's demand below its true `tight` width — arguably an unbreakable column should
    be exempt from that cap in `wordsWhole`. Deliberately NOT changed here; it is a fitter decision.
- **Two structural facts the chips depend on and the fit must survive.** `.cm-table-widget` is
  `position: relative`, because `contain: inline-size` is **size** containment only and does not
  establish a containing block: measured without it, a chip at `top: 2px` escaped to `.cm-content`
  and landed 60px down the page (`position` does not alter inline size, so the fit is untouched).
  And **both chips sit fully inside the box**, never at a negative offset, which made the widget
  scrollable back when the overflow was still on it. The chips are out of flow and the width probe is
  still the container's **direct first child**.
- **Re-fitting is driven by three probes inside the widget** — a zero-height block whose width *is*
  the available text width, hidden text (normally sized, clipped by that box) whose width changes iff
  the note's font metrics do, and a third hidden span holding the sample **twice — in `KaTeX_Main`
  and in italic `KaTeX_Math`** — whose width moves when either of KaTeX's text webfonts lands (until
  then it measures the serif fallback). Do NOT collapse those two into one: a maths *variable*
  renders in KaTeX_Math-Italic, and with only KaTeX_Main sensed an all-variable formula grew 26.7px
  after its font landed with no probe moving. The Size/AMS/Typewriter faces are still unsensed and
  that is a known limit, not coverage — `FONT_PROBE_TEXT` is letters and digits, which the Size faces
  do not even contain. All three probes are watched by one shared `ResizeObserver`, and the last two
  are **summed into the single `fontWidth`**, so the `lastFont` gate covers both without a second
  field. (`restoreFit` does not
  screen for it — its `done.at.font` is the note's computed font shorthand, which KaTeX's webfonts
  landing does not move — but it adopts the sum into `fit.lastFont`, so a pre-webfont cached fit
  misses that gate and re-fits.) Without that third probe a table holding maths stays
  fitted to pre-webfont metrics: nothing else in the widget notices KaTeX's fonts arriving. It is
  created for every table, math-free ones included — one extra fit pass, and the font is bundled
  locally. They are the fit's INPUTS and
  nothing the fitter writes changes either, so a fit can't re-trigger one from inside the widget;
  watching the container instead would notify on its own height change every time. That invariant
  stops at the widget's edge: a fit changes the table's height, and where scrollbars take layout
  space that can toggle the editor's own, moving `.cm-content`'s *percentage* padding. Chromium
  bounds that at a round per frame and it hasn't been observed on overlay-scrollbar platforms — don't
  restate the claim more broadly. Between them the probes cover window and sidebar resizes, the
  Text-width and font-size settings, and a Google Font — or a KaTeX font — arriving late.
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
