---
name: live-preview
description: The live-preview editor subsystem (src/editor/) — how buildDecorations works and what it costs, math regions, the embedded-image object, list indentation, and the widget/Decoration rules. Load before adding or changing anything the editor renders, any CodeMirror extension, or any keymap.
---

# Live-preview editor subsystem (`src/editor/`)

This is the most intricate area of the app. `livePreview.ts` hides Markdown syntax and renders
inline, Obsidian-style. Tables have their own skill (`markdown-tables`); everything else is here.

## The decoration field

- It's a **StateField, not a ViewPlugin** — a StateField may `replace` ranges spanning line breaks,
  which block math / images / tables / fenced code all need. Its value is
  `{deco, atoms, imageSelected, tables, tableSelected}`: the decorations to draw plus what the two
  object models need — the atomic ranges, which of the two kinds is the current selection, and where
  the rendered tables are, so the table entry keymap and the caret-adoption rule can find one beside
  the caret without re-scanning. All of it comes out of one pass and is handed to three facets from
  `provide`. `atoms` is built with `RangeSet.of(atoms, true)`: the image scan and the table scan are
  each left-to-right, but tables are appended after images, so the combined array is **not** sorted.
- `buildDecorations` walks the Lezer syntax tree **plus** regex passes, in this order: `analyzeDoc`
  (flatten + code ranges + math regions) → one tree walk (headings, emphasis, strikethrough, inline
  code, fences incl. mermaid, links, blockquote, list items, HR) → math regions → `$`-delimiter
  feedback → `==highlight==` → image embeds → wikilinks → tables.
- `cursorInRange`/`cursorOnLine` decide when to reveal raw syntax — only in edit mode, and **images
  and tables are the two constructs that never reveal** (each has its own rules). The table branch
  does not call `cursorInRange` at all. **Read mode is a pure function of the document** (every
  selection-dependent branch is gated on `editorMode !== 'read'`), so read-mode rebuilds skip
  selection-only transactions.
- **Math is located before the Markdown pass** (`findMathRegions`, after `collectCodeRanges`) so
  Markdown constructs *inside* a formula (`[x](y)`, `_`, `*`) are skipped as LaTeX, and `$` inside
  code stays literal.
- It **rebuilds when the syntax tree advances**, not only on `docChanged`: Markdown parses
  asynchronously, so on a large file the tree covers only a prefix at open and the parser advances
  during idle time via otherwise-empty transactions. Missing this leaves everything past the initial
  prefix raw.

## The hot path

- **Memoized on `(doc, tree)` object identity**, which is exact because both are immutable and
  persistent. `analyzeDoc` (in `latexSource.ts`) computes the flattened document, the code ranges and
  the math regions once per parse, in a **`WeakMap` keyed on the `Text` — one entry per document, not
  one entry**; `docCache.ts` memoizes `Text.toString()` the same way. The single slot it used to hold
  was right while one view was ever live, and a split tab falsifies that: up to five documents are
  live at once, each with its own state, field and background parser, so they took turns through the
  slot and every alternation between two panes re-walked a whole document. This matters because in
  edit mode the field also rebuilds on **selection-only** transactions (to reveal syntax under the
  cursor) — every arrow key used to re-flatten the document and re-scan it. `isInMathContext` /
  `inCodeRange`, which run *synchronously inside* a bracket or `$` keystroke before the transaction
  dispatches, read through the same memo. Keying on the tree as well as the doc is deliberate: it
  keeps the memo from defeating the `treeAdvanced` rebuild above.
- **Math-region overlap is binary-searched, never scanned** (`firstMathFrom`/`overlapsMath`). The
  node-level guard runs for *every node of the whole tree*, so a linear scan over regions made it
  O(nodes × regions) — measured ~186M comparisons and ~138ms per keystroke on a 400KB math note,
  versus ~3ms for the bare walk. The search is exact because `findMathRegions` returns regions sorted
  by `from` **and disjoint** (each regex consumes its match; inline regions overlapping a block are
  dropped). Preserve both properties if you touch it.
- **Constant `Decoration` values are module-level singletons** (`HIDE`, `BOLD`, `CODEBLOCK_LINE[]`,
  …), and the parameterized ones are cached by the value that varies (bounded by `DEC_CACHE_MAX`,
  since those key spaces — every ordered-list marker, every wikilink target — accumulate across every
  document opened in a session). A `Decoration` is positionless and immutable — `.range()` makes the
  positioned value — so sharing is the supported pattern, and rebuilding them per call site cost
  thousands of identical objects per rebuild (measured ~39k decorations on a 400KB note). Identical
  instances also let CodeMirror's decoration diff short-circuit.
- `livePreview.ts` **declines HMR** (`import.meta.hot.decline()`): the cached decoration logic means
  a hot swap wouldn't take, so it forces a full reload in dev instead.

## The files

- `latexSource.ts` owns math-region detection (Obsidian rules: `$…$` single-line inline, `$$…$$`
  block, `\$` literal, `$`-in-code literal), a LaTeX source tokenizer for revealed-source
  highlighting, and the **app-wide `$` pairing + in-math `{ ( [` auto-pairing**
  (`mathEditingExtensions`). It is registered **before** `closeBrackets` so LaTeX gets first claim on
  `$ { ( [`.
- Widgets are `WidgetType` subclasses: `MathWidget` (KaTeX; normalizes
  `\begin{equation|align|gather}` onto KaTeX-supported forms), `MermaidWidget` (async render but sync
  DOM → SVG cached by `theme+source`, bounded; a `MutationObserver` re-renders on theme flip),
  `TableWidget`, `ImageWidget` (async `getAssetUrl`; the only one that is interactive and updates in
  place), `CopyCodeWidget`, `HorizontalRuleWidget` (whose `eq()` is unconditionally `true` — every
  instance is interchangeable, which is only sound while the widget carries no varying state).
  `ignoreEvent()` returning **`false`** is what makes a widget clickable-into: `MathWidget`,
  `MermaidWidget` and `HorizontalRuleWidget` do; `CopyCodeWidget` returns `true` to keep its button's
  clicks; `TableWidget` deliberately keeps the default (see `markdown-tables`).
- `cmTheme.ts`: Obsidian dark/light themes + One Dark/One Light code-token palettes. The **caret is
  driven entirely by CSS variables** set from Settings (line/block, thickness, smooth glide) — the
  native caret is hidden and `drawSelection()` renders `.cm-cursor`.
- `revealHighlight.ts` backs the search-result "you are here" flash, cleared on doc change, selection
  or tab swap. `formatKeymap.ts` implements `⌘B`/`⌘I` wrap-selection **with a `domEventHandlers`
  keydown fallback**, specifically because the browser's contenteditable layer can otherwise eat
  `⌘I` via a `beforeinput: formatItalic` before the keymap runs. `wikiLinkComplete.ts` is the `[[`
  autocomplete; `getTargets` is called per-keystroke rather than snapshotted, so a note created
  moments ago is offered.

## Revealing a list item's syntax must not move its text

When the cursor lands on a list line the drawn bullet is replaced by the real `- ` / `1. `, and that
marker is **lifted out of the text flow** (`.cm-live-list-marker`, absolutely positioned into the
slot the bullet occupied) so the line keeps the *rendered* `padding-left` — wrapped rows included. It
used to drop to a narrow padding and let the marker flow, which slid the whole item ~9px left for as
long as the caret sat in it. An item also stops revealing when the caret is merely inside one of its
**sub-items** — a ListItem's range covers its children, so `cursorOnLine` is given the item's own
lines only. Two consequences of lifting are load-bearing:

- **A prefix of unknown width is anchored by its END, not its start.** An ordered marker grows with
  its number and a revealed indentation run grows with its depth, so both are pinned to the content
  column with `right:` and overhang leftwards into the gutter (`white-space: pre` is what lets them
  overhang instead of wrapping onto a second row). A fixed `left:` gave every marker the same 24px
  slot, and `100. ` printed straight over the item's own text — the rendered `::before` is anchored
  the same way, which is also how a real `<ol>` lays its numbers out.
- **A lifted line still needs something in flow.** `- ` and `1. ` are whole lines in themselves — and
  one is exactly what Enter leaves behind on a list item — so once the marker lifts, the `.cm-line`
  has no in-flow content, generates no line box and is **zero pixels tall**: the row collapses and the
  document below jumps up over it. `.cm-live-list-lift::after` is a zero-width `inline-block` strut
  that keeps the line box alive. (CodeMirror's own `<br>` filler doesn't rescue this: it is only
  appended when the line has no content tiles at all, and a mark tile counts as content — which is why
  the fully-hidden *rendered* state, a `replace` widget, keeps its height and the revealed one didn't.)

# The embedded image is an object, not text (`imageWidget.ts`)

`![[diagram.png]]` is what the *file* holds; it is never what the reader sees, in either mode. Unlike
every other live-preview construct, an image is **not revealed by the cursor** — clicking it selects
the picture the way a word processor does, and a selected picture carries the two things anyone would
want to do to one: resize it, or take it out. `|320` is written and read by those controls and is not
syntax anyone has to know. This is one of the app's two deliberate *abstractions* over its own
markdown — the other is a table — so treat "the raw text is unreachable" as the requirement, not an
accident.

- **Three things keep the object from coming apart**, and removing any one breaks the other two: the
  decoration is never suppressed by the cursor; the range is registered in
  **`EditorView.atomicRanges`**, so no arrow key, click or drag can land a caret inside it (and a
  Backspace beside it takes the whole embed); and the single exception is a caret *already strictly
  inside*, which only the keystrokes that typed the embed can produce. That exception is load-bearing
  — with `closeBrackets` on, typing `![[` yields `![[]]` and the very first character of the name
  would otherwise collapse the line into a broken picture mid-word. `livePreview`'s
  `caretInsideRange` and the atomic set are two faces of one predicate: what is being typed is text,
  what is finished is an object.
- **An embed inside code is quoted, not embedded**, and the image pass skips `codeRanges` for that
  reason. It matters more here than for any other construct precisely *because* of the rule above: a
  quoted embed rendered as a picture could never be revealed or edited back, so a note documenting
  `` `![[picture.png]]` `` — the Help guide among them — would show a permanent "not found" box
  mid-sentence with no way out.
- **Atomic-range skipping does not fight the typing exception.** CodeMirror applies it to cursor
  MOTION (`moveByChar`) and to pointer selections only — never to the selection left behind by an
  edit — so the caret stays inside the embed being typed. It also only moves a position *strictly*
  inside a range, which is why selecting exactly `[from, to)` survives untouched and is a usable
  "this picture is selected" state.
- **The widget is re-dressed, never rebuilt** (`updateDOM`). Selecting, resizing and ⌘E all change the
  widget, and each rebuild would drop the `<img>`, re-resolve the asset and flash the picture through
  its placeholder. The DOM therefore outlives the widget instance that built it, so the buttons'
  handlers must not close over that instance — they read an `ImageModel` hung off the element, which
  `updateDOM` refreshes. For the same reason a handler never remembers its position: CodeMirror can
  hand image A's DOM to image B's widget, so `embedAt()` re-locates the embed in the *current*
  document (via `posAtDOM` + a re-scan of that line) every time a button is pressed.
- **Deleting is confirmed, and the confirmation is the app's** — the editor subsystem raises a
  request through `ImageEmbedActions` and EditorPane decides. The deletion itself only removes the
  TEXT: retiring the file is the save path's job (see `vault-filesystem`), which is precisely what
  makes ⌘Z whole. Retiring it here as well would break that, since an undo inside the save debounce
  would leave the picture in the trash with the note still pointing at it. Because the dialog is
  async, `removeEmbed` refuses unless the sliced document text still equals the confirmed text
  exactly, and `deleteSelectedImage` requires the selection to be *exactly* one embed.
- **A selected picture wears its own ring, so the editor's text selection is turned off while one is
  selected** (`imageSelected` → an `editorAttributes` class → CSS; a selected *table* contributes the
  same class, and the class name `cm-image-selection` is now the only thing left saying otherwise).
  Note the division of labour: that class is on the **editor root** and says "*something* is
  selected", while the ring itself hangs off the widget's own `cm-image-selected` /
  `cm-table-selected` class and says *which* — a ring scoped to the root class would outline every
  table in the note at once. Both halves show otherwise: the selection band as a sliver past the
  widget's edge (CodeMirror pads a replaced range with zero-width buffer elements), and the caret as a
  full-height bar. `.cm-image-widget` is `width: fit-content` for the same reason — a full-width box
  put the band across the whole line.
- Two smaller shapes worth keeping: the controls are **one row pinned to both edges**, not two
  independently-cornered groups, because a shrunk picture can be narrower than they are and cornered
  separately they end up stacked on each other; and below `NARROW_WIDTH` they lift clear of the
  picture entirely (measured once, when it is selected). The `+`/`−` step is a share of the *available
  note width*, not of the current image width, so the two buttons are exact inverses. A picture that
  failed to load keeps only the bin, below its notice.
- `retryMissingAssets()` re-runs *only* the failed resolutions when an asset comes back (undo).
  Rebuilding the widgets instead would flash every other image in the document through its
  placeholder.

# List editing (`src/editor/lists.ts`)

The single place that knows what a Markdown list line looks like — `parseListMarker` is shared by
`livePreview` and the Tab commands, so a line that renders as a bullet is exactly a line Tab will
re-nest.

- **Tab / Shift-Tab re-nest the item**, Google-Docs style: Tab makes it a sub-point of the item above
  and Shift-Tab lifts it back out, moving the item's **whole sub-tree** (nested items, wrapped text,
  embedded code) by one delta. Off a list, Tab is a soft tab to the next tab stop. Either way the key
  is **handled in an editable view** — before this, nothing bound Tab and it moved focus to the
  browser chrome. Reading mode is the deliberate exception: nothing there is editable, so Tab is left
  to the browser and moves focus on, as on any read-only page.
- **It only indents when there's an item above it at the same level.** Markdown cannot express a
  first item that is nested: indenting it reads as an indented code block. Tab is still swallowed, it
  just does nothing.
- The landing column is `clamp(indent + tabSize, parentContentCol, parentContentCol + 3)` — **less**
  and the line parses as a sibling, **more** and it parses as an indented code block inside the
  parent. This is what makes a 2-space tab still nest under `1. `, an 8-space tab not break the list,
  and a sub-item of `1499. ` land at column 6. If the new parent **already has a sub-list**, the item
  joins it at *its* indent instead: one tab stop could otherwise overshoot into a grandchild.
- **Structural columns are measured with a fixed FOUR-column tab stop (`MD_TAB`), never
  `EditorState.tabSize`.** CommonMark expands tabs at 4 whatever the editor is set to
  (`@lezer/markdown`'s `countIndent` hard-codes `4 - indent % 4`), and Obsidian vaults are full of
  tab-indented lists. Measuring with the view's tab size put the landing column on the wrong side of
  the parser's threshold: at tab size 8 a nested item was re-indented so far it stopped being a list
  item at all; at tab size 2 it silently landed as a sibling. `tabSize` still governs how wide a tab
  *looks*, which is what `plainTab` measures the next soft-tab stop with.
- **Ordered markers are renumbered on both sides of the move** (the "tab `4.` and it becomes the
  sub-list's `1.`" behaviour, plus the gap it left closing up). Numbering is rebuilt from the
  *post-move* indentation with a parent-stack walk, because the syntax tree still describes the old
  shape. Items **above** the move keep their numbers verbatim. Below it, an item that now heads a list
  keeps its start number only if it **already headed that same list** — so a list deliberately
  starting at `5.` is never "fixed", while one whose first item was just tabbed away restarts at 1
  instead of beginning at `2.`.
- Two things the renumber pass must keep in step with the document:
  - The region is the **contiguous run of adjacent lists**, not one list (`outerListRange`). Markdown
    starts a new list at every change of bullet char or delimiter, so `- a` / `1. b` is two lists —
    and `prevItem` deliberately moves items between them, which renumbers both.
  - A renumber that **changes the marker's digit count moves that item's content column**, so its
    whole sub-tree is shifted to follow (`bump`). Without it, `9.` → `10.` leaves a child one column
    short of the new content column and the child drops clean out of the item. Indent shifts are
    accumulated per line in a map — travelling delta plus any ancestor's width change — rather than
    applied in one pass.
- **Structure comes from the syntax tree, never a line scan**: a `- x` inside a fenced code block is
  not a list item, and a `3. code` line inside one must never be renumbered. `ensureSyntaxTree` covers
  the selection first (Markdown parses lazily); if the parse can't be had, or the list is inside a
  blockquote (whose `> ` prefixes this module's column maths ignores), it falls back to the plain soft
  tab rather than guessing.
- Tab size is one setting (`indentUnit` + `EditorState.tabSize`, kept equal) and the commands read it
  from the state via `getIndentUnit`, so nothing closes over it.
- Changes are emitted sorted by position, **pure insertions before same-position replacements**: a
  line with no indentation yet gets its indent inserted at exactly the offset its marker is replaced
  at, and `ChangeSet.of` only builds one flat set while ranges arrive in order — out of order it
  flushes and composes instead.
- The logic is pure state→changes, so it is testable headless: build an `EditorState` with
  `markdown()` + `indentSettings()`, call `listIndentBindings`' `run`/`shift` with a
  `{state, dispatch}` stub, and compare documents.
