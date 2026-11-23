---
name: live-preview
description: The note editor (src/editor/) — the incremental document analysis and windowed decoration pass in livePreview.ts, what each keystroke costs, math regions and KaTeX, hidden syntax, links, the embedded-image object, list indentation, collapsible headings, Reading mode and Word emphasis, note search keys, the separate code-file editor and the .tex route, and the widget/Decoration rules. Load before adding or changing anything the editor renders, any CodeMirror extension, StateField or keymap, or any regex/tree pass over note text. Tables have their own skill (markdown-tables).
---

# Live-preview editor (`src/editor/`)

`livePreview.ts` hides Markdown syntax and renders inline, Obsidian-style. `src/editor/` is React-free
(AGENTS.md); `DocumentPane` builds the state and reaches it through facets and plain callbacks. A
cached `EditorState` outlives its pane, so everything baked into it must be stable for the app's life
(`tabs-and-panes`). The pass runs per keystroke, per arrow key, on every open pane — measure or
memoize anything you add to it.

## How a note's state is assembled (`DocumentPane.createTabState`)

- Module singletons installed **outside every compartment**: `docAnalysisField`, `livePreviewField`,
  `headingFold(…)`, `wordCountField`, `readingEmphasis`. ⌘E reconfigures compartments, and a field
  inside one would lose its value (folds, analysis) on every mode switch.
- `livePreviewCompartment` holds `livePreviewFor(mode)` = `createLivePreviewPlugin(imageCtx, actions)`:
  the per-pane `imageContextFacet`, `imageEmbedActions`, `imageEmbedKeymap`, `tableReadingSelection`,
  `tableEntryKeymap`, `tableAdoptListener`. All three reconfigure sites (construction, ⌘E, cached-state
  adoption) go through `livePreviewFor`, which returns `[]` for code and `.tex` files.
- `readOnlyCompartment` holds `modeExtensions(mode)` (`readingMode.ts`): `EditorView.editable` **and**
  `EditorState.readOnly`. `readOnly` is what CodeMirror's own editing paths check (search Replace,
  drop, paste); `editable` keeps the view unfocusable. **Neither blocks a programmatic dispatch, so
  `canWrite(state)` is the only write predicate** — import it. Mode is always read from the state
  (`modeOf` = `editable ? 'edit' : 'read'`), never passed in.
- `readingEmphasisCompartment` holds the Word-emphasis options (below). Code, `.tex` and chat views
  never install emphasis.
- `markdownSession.ts` (the document/undo owner while a pane is viewless) and `externalReload.ts`
  (disk reloads, `externalReload` annotation → `{ fromDisk: true }`) belong to `tabs-and-panes`.

## The analysis and the windowed pass

**`docAnalysisField` (`docAnalysis.ts`)** is the per-state truth every pass reads: `codeRanges` (from
the tree: `FencedCode`, `CodeBlock`, `InlineCode`), `mathRegions` (sorted, disjoint), line scans
(`analysisLines.ts`: `$` runs, `==highlight==`, `[[wikilinks]]`, embed openers, math tokens), math
pairing (`analysisMath.ts`), objects (`analysisObjects.ts`: `![[embeds]]` and tables), and a `delta`
(`{ forRev, changed, treeChanged }`). It updates **incrementally** from the transaction's changes and
the tree diff (`analysisTree.ts`), never flattening the document per keystroke, and re-runs only when
the doc or the syntax tree changed. **Regex matches carry an `accepted` flag computed here**: a
highlight, wikilink or `$` run overlapping code or math, or an object a code range contains, is not
accepted. `analyzeDoc(state)` reads the field when installed and falls back to a full analysis.

**`livePreviewField`** holds `{ deco, atoms, images, tables, imageSelected, tableSelected, analysisRev }`
and provides `EditorView.decorations`, `readingDecorations`, `EditorView.atomicRanges` and the
`cm-image-selection` editor class. Its `update`:
1. Rebuilds only on doc change, **syntax-tree advance** (Markdown parses in idle chunks via otherwise
   empty transactions; ignoring them leaves everything past the first parsed prefix raw), a selection
   change **in Edit mode only**, or a mode change. Read mode is a pure function of the document (every
   selection branch is gated on `editorMode !== 'read'`), so selection-only transactions skip it.
2. Full render on mode change, on an image-context or emphasis change, when the analysis revision is
   not exactly the next one, when `bme.editor.incremental` is `'false'` (the Developer rollback,
   `incrementalEditorEnabled()` in `utils/engineRouting.ts`), or on any exception.
3. Otherwise `planPreviewWindows` (`livePreviewWindows.ts`) turns the analysis delta plus whatever the
   selection move revealed or hid into **whole-line windows**, widened to the enclosing paragraph /
   heading / block and to any math region, embed or table they touch. If windows exceed half the
   document it renders in full. `buildDecorations(…, window)` renders each window and `splicePreview`
   splices them into the previous set.
4. A preference-only change (image context, emphasis) re-mints only the affected widgets (images,
   tables) instead of re-rendering.

`buildDecorations` order: tree walk (headings, emphasis, code, lists, quotes, links, rules, mermaid),
math, `$` feedback, highlights, embeds, wikilinks, tables. **When you add a construct, make its reveal
state visible to `planPreviewWindows`** (a node name it watches, or an analysis list it scans), or the
window that should redraw it on a caret move will not include it.

`cursorInRange` / `cursorOnLine` decide reveal (Edit only). **Images and tables never reveal**; each
has its own rules. `atoms` is a `RangeSet.of(…, true)`: tables are appended after images, so the array
is not sorted.

## The hot path rules

- **Math overlap is binary-searched, never scanned** (`firstMathFrom` / `overlapsMath`, and
  `utils/rangeSearch.ts`). The node guard runs for every tree node; a linear scan measured ~186M
  comparisons and ~138 ms per keystroke on a 400 KB math note. Exact only because regions are sorted
  by `from` and disjoint — keep both properties.
- **Constant decorations are module singletons** (`HIDE`, `BOLD`, `CODEBLOCK_LINE[]`, …) and
  parameterized ones are cached by their varying value, bounded by `DEC_CACHE_MAX` (512). Rebuilding per
  site cost ~39k objects per rebuild on a 400 KB note; identical instances also short-circuit the diff.
- `docCache.docString(doc)` memoizes `Text.toString()` per immutable `Text` (CodeMirror does not);
  never call `doc.toString()` on the hot path.
- `editorPerf.ts` counters run only under `__BME_BENCH__`, which production strips.
- `livePreview.ts`, `headingFold.ts` and `readingEmphasis.ts` **decline HMR** (a hot swap would not
  take with cached decorations); edits there reload the page in dev.

## Hidden syntax, math, widgets

- **`HIDE` is a `HiddenMarkerWidget` span (`cm-live-hidden`, `hiddenMarker.ts`), not a widgetless
  replace**: CodeMirror's zero-width `cm-widgetBuffer` images beside a replace are line-break
  opportunities, so a long first word after a hidden `# `/`> `/`- ` wrapped under a blank row (#20).
  `index.css` takes only the buffers beside `.cm-live-hidden` out of flow — except on a line that is all
  hidden syntax, where they are its only line box. Safe only because every HIDE reveals when a selection
  touches it in Edit mode. Heading marks come from the tree's `HeaderMark`s, never a line search.
- **Math is located before the Markdown pass**, so Markdown inside a formula is skipped as LaTeX and
  `$` in code stays literal. `latexSource.ts` owns detection (Obsidian rules: `$…$` single-line inline,
  `$$…$$` block, `\$` literal), revealed-source highlighting, and **app-wide `$` pairing + in-math
  `{ ( [` auto-pairing** (`mathEditingExtensions`, registered **before** `closeBrackets`).
- **`mathWidget.renderMath(el, latex, displayMode)` is the app's one KaTeX call**, exported so table
  cells share its options. `output: 'html'` (no MathML double text). Load-bearing by absence: `trust`
  falsy (keeps `\href`/`\url`/`\includegraphics`/`\html*` inert, one step from an HTML sink) and
  `maxSize` Infinity (so `\rule{9999em}{9999em}` is the one way a cell can grow huge — known). KaTeX
  loads lazily; until then the element shows source tagged `data-math-pending`.
- Math inside a table span is drawn by the table (`markdown-tables`); the pass's own `MathWidget` there
  is dropped by `SpanCursor` because the table's replace wins.
- Widgets: `MathWidget`, `MermaidWidget` (sync DOM, async SVG cached by theme+source, `SVG_CACHE_MAX`
  100, `securityLevel: 'strict'` set at every render — AGENTS.md's second HTML sink, never relax it; a
  `MutationObserver` re-renders on theme flip), `TableWidget`, `ImageWidget`, `CopyCodeWidget` (reads the
  current fence text on click), `HorizontalRuleWidget`, the heading-fold widgets. `ignoreEvent()`
  returning `false` makes a widget clickable-into (math, mermaid, rule); `CopyCodeWidget` returns `true`
  to keep its button's clicks; `TableWidget` keeps the default on purpose.
- **A widget whose size changes after `toDOM` must call `view.requestMeasure()`** (mermaid SVG landing,
  picture `load`/`error`, a "not found" box): CodeMirror ignores mutations inside widgets, and the
  search jump's centre hold (`scrollAnchor.ts`) only hears measured height changes.
- Any `innerHTML` in `src/editor/` is limited by lint `bme/html-sinks` to the two note-text sinks and
  three constant icon strings (`headingFold`, `imageWidget`, `copyCodeWidget`). Build DOM otherwise.

## Links: Reading mode emits real `<a>` elements

- Three tree shapes: `Link` (`[a](b)`), `Autolink` (`<https://x>`), and a **top-level `URL` with no
  wrapper** (GFM's bare `https://x`, `www.x`, `a@b.com`). Which nodes wrap a `URL` is stated once in
  `URL_WRAPPERS` (`Link`, `Autolink`, `Image`, `LinkReference`); the bare branch tests `node.parent`.
- `linkTextMark` returns `externalLinkMark(href)` only in Reading mode and only when `externalHref`
  accepts; Edit mode keeps the attribute-free `LINK_MARK` (contenteditable owns the click).
- **`externalHref` is the security boundary and the check IS the parse**: `new URL()` (the navigator's
  own WHATWG parse), link `url.href`, require `url.protocol` in `SAFE_PROTOCOLS` (`https: http: mailto:
  tel:`). Testing one string and linking another lets `java\nscript:` through. Bare forms get `mailto:`
  (`BARE_EMAIL`, no colon) or `https://` (`BARE_WWW`). Relative destinations are rejected: an `<a>` to
  `notes/x.md` navigates the SPA away and drops the vault handle. `rel="noopener noreferrer"` is
  required (an opener handle onto this origin is a capability leak). Marks use `setAttribute`, not an
  HTML sink.
- Geometry comes from the tree: `Link`'s `LinkMark`s are `[ ] ( )`; the destination is
  `marks[2].nextSibling` **when it is a `URL`**. **Never `getChild('URL')` on a `Link`**: GFM autolinks a
  URL inside the label too, so the first `URL` child can be label text — an href chosen by the label.
  Fewer than four marks = reference/shortcut link or a `[[wikilink]]` artefact: fall through. Empty
  label: return early (an empty mark is illegal; hiding both sides would erase it).
- The `Link` branch **descends into its label** so `[a **b**](u)` formats; the hidden `**` nest inside
  the label mark. `.cm-live-strikethrough` sets a colour, so `.cm-live-link .cm-live-strikethrough`
  resets it — any new inline class that sets a colour needs the same.
- **Nothing inside a label may mint a second anchor** (`[x <https://evil>](https://good)`; CodeMirror
  builds with `createElement`, so anchors really nest): `insideLinkLabel` walks **ancestors** and the
  `Autolink` and bare-`URL` branches consult it.
- `[[wikilinks]]` are the in-app link, opened by `DocumentPane`'s own mousedown path;
  `wikiLinkComplete.ts` is the `[[` autocomplete (targets read per keystroke so a new note is offered).
- **Regex-found constructs need the code guard; tree nodes get it from the parser.** Wikilinks,
  highlights, `$` runs, embeds and tables are regex scans, so `docAnalysis` marks them unaccepted when
  they overlap (or, for objects, sit inside) code. A new regex pass must get the same treatment — the
  Help guide prints `` `![[x.png]]` ``, `` `==text==` `` and quoted tables as source.

## The embedded image is an object (`imageWidget.ts`)

`![[diagram.png|320]]` is what the file holds and never what the reader sees: click selects the
picture; a selected picture offers resize and delete. One of the app's two deliberate abstractions over
its own Markdown (the other is the table).
- **Three things keep it whole**: never suppressed by the cursor; registered in `atomicRanges` (no caret
  inside; Backspace beside it takes it); and one exception, a caret **already strictly inside**
  (`caretInsideRange`), which only typing the embed produces — with `closeBrackets`, `![[` becomes
  `![[]]` and the first letter would otherwise turn the line into a broken picture. Atomic skipping
  applies to motion and pointer selections, never to an edit's resulting selection, and moves only a
  position strictly inside, so selecting exactly `[from, to)` is the "picture selected" state.
- **Re-dressed, never rebuilt** (`updateDOM`), or the `<img>` flashes through its placeholder. The DOM
  outlives the widget instance: handlers read an `ImageModel` on the element, and `embedAt()`
  re-locates the embed in the current document (`posAtDOM` + re-scan) at every press — CodeMirror can
  hand image A's DOM to image B.
- **Delete is confirmed by the app** (`ImageEmbedActions` → EditorPane) and removes only the TEXT;
  retiring the file is the save path's job (`vault-filesystem`), which is what makes ⌘Z whole.
  `removeEmbed` refuses unless the text still equals the confirmed text; `deleteSelectedImage` requires
  the selection to be exactly one embed.
- A selected picture or table sets `cm-image-selection` on the editor root (hides the text selection
  band and caret); the ring itself comes from the widget's own `cm-image-selected` /
  `cm-table-selected`, so only that object is outlined. `.cm-image-widget` is `width: fit-content`.
- Controls are one row pinned to both edges; below `NARROW_WIDTH` they lift clear of the picture. `+`/`−`
  step by a share of the note width, so they are exact inverses. `retryMissingAssets()` retries only
  failed resolutions (an undo restoring an asset), never rebuilding the rest.

## Lists (`lists.ts`) and revealed markers

- `parseListMarker` is shared by the pass and the Tab commands: what renders as a bullet is what Tab
  re-nests. **Structure comes from the syntax tree** (`ensureSyntaxTree` first); a blockquoted list or
  an unavailable parse falls back to a plain soft tab.
- Tab/Shift-Tab re-nest the item's whole sub-tree (Edit mode; in Reading mode Tab moves focus). Only
  under an item above at the same level (a nested first item would be an indented code block). Landing
  column `clamp(indent + tabSize, parentContentCol, parentContentCol + 3)`, or the parent's existing
  sub-list indent. **Columns use a fixed 4-column tab stop (`MD_TAB`)** — CommonMark's — never
  `EditorState.tabSize` (at 8 a nested item stopped being a list; at 2 it landed as a sibling).
- Ordered markers renumber on both sides of a move from the post-move indentation; items above keep
  their numbers; a list deliberately starting at `5.` is never "fixed". The region is the contiguous
  run of adjacent lists (`outerListRange`); a digit-count change shifts that item's sub-tree (`bump`).
  Changes are emitted sorted, insertions before same-position replacements.
- **Revealed markers are lifted out of flow** (`.cm-live-list-marker`), anchored by their **end**
  (`right:`, `white-space: pre`), so revealing `100. ` never moves the text; `.cm-live-list-lift::after`
  is a zero-width strut so a line that is only `- ` keeps its height. An item does not reveal while the
  caret is only in one of its sub-items.

## Collapsible headings (`headingFold.ts`, Reading mode only)

- A heading that is a **direct child of the Document** (never inside a quote, list, code or math —
  `mathSkipsRange`) with content under it gets a margin arrow folding to the next heading of the same
  or higher level. Sections memoized on `(doc, tree)`; only closed sections get an arrow. Nothing is
  written to the note.
- **The fold wins by containment**: points starting inside its replace are skipped by `SpanCursor`.
  The hazard: **no live-preview point may start before a heading's line end and end after it**.
- State is heading-line starts mapped `TrackAfter`; `reanchorFolds` follows a heading moved by
  Alt-↑/↓ or replaced by a dropped file. Pruning runs only in Reading mode where the parse covers the
  line. A non-pointer selection strictly inside a fold expands it (vault-search reveal, ⌘F), held until
  the parse reaches it.
- Persisted by `DocumentPane` in the path-keyed `collapsedHeadings` record as `[lineText, occurrence]`
  keys, debounced per path. Widgets find their heading with `posAtDOM` at click time (their DOM is
  reused across headings). The arrow's anchor is inline, never `inline-block` (same #20 wrap).

## Reading-mode Word emphasis (`readingEmphasis.ts`)

`readingEmphasis` is a singleton ViewPlugin outside its compartment; `readingEmphasisFacet` carries
`{ enabled, mode, locale }`. It does nothing unless enabled, in Read mode and not composing. It projects
visible prose (`readingProseRuns`, which uses the pass's `readingDecorations` to skip hidden syntax and
widgets), segments words (`utils/readingEmphasis.ts`), caches per `Text` in 8 KB chunks (bounded), skips
folded sections, and marks `cm-reading-prefix`. Mode and preference reconfigures go through
`deferReadingConfiguration` (latest wins, applied after IME composition ends);
`cancelReadingConfiguration` runs before view teardown. Table cells do their own emphasis
(`markdown-tables`). Never let emphasis touch saved text.

## Search keys, Tab into text, theme

- `noteSearch.ts`: ⌘F, ⌘G/⇧⌘G, F3/⇧F3 for a note that cannot take focus. CodeMirror runs keymaps only
  for keys aimed at `.cm-content`, so `DocumentPane`'s `window` listener runs them for the focused pane
  when `keyIsForNote` allows (see `app-context-menu`). Escape is left out on purpose. `SearchPanel`
  reads `readOnly` once, so an open panel is rebuilt on every mode flip (`rebuildSearchPanelForMode`),
  keeping query, focused control and caret; a panel takes the keyboard on mount, so rebuilds hand it
  back (`returnKeyboard`); closing in Reading mode hands a stranded keyboard to `.cm-scroller`
  (`keyboardAfterSearchClose`).
- `tabIntoText.ts`: Tab on a focused `.cm-scroller` in Edit mode focuses the text, moving an off-screen
  caret to the end of the first single-line block in view. A table or diagram is one multi-line block
  there, which is the tell to skip it.
- `cmTheme.ts`: Obsidian dark/light; the caret is drawn by `drawSelection()` and styled from CSS
  variables (Settings); the search panel shares one `searchPanelStyles` object. `formatKeymap.ts`'s
  ⌘B/⌘I has a `domEventHandlers` keydown fallback because Chromium can eat ⌘I as `formatItalic`.
  `revealHighlight.ts` is the search-result flash.

## Code files and `.tex` files take other routes

- **Code** (`isCodeFile` in `utils/fileTypes.ts`): `codeEditor.ts` builds a different state — no
  wrapping, Markdown, preview or wikilinks; line numbers, folds, brackets, autocompletion, multiple
  cursors. Grammars load lazily into `codeLanguageCompartment` (`loadCodeLanguage`, cached).
  `drawSelection()` is required (the theme hides the native caret). The prose highlight style is
  **replaced**, not layered (`themeExtensions(theme, code)`); theme selectors are `&.cm-editor …` to win
  import-order ties. A parser's `tokenTable` cannot remap CodeMirror's legacy names (`variable`,
  `builtin`), so `codeHighlight.ts` uses custom names (`racketParser` relabels Racket: special forms,
  call heads, quoted symbols, numbers in `[…]`). `rainbowBrackets.ts` scans the whole document,
  decorates only visible ranges, takes strings/comments from the tree, **must rebuild when the tree
  changes** (empty on first mount), and colours both the mark and its inner highlighter span. Palette:
  the user's Zed One Dark/One Light; size is `--code-font-size`. Code tabs open in Edit mode.
- **`.tex`**: no live preview (Markdown misreads LaTeX). Reading mode builds no editor at all:
  `components/TexView.tsx` renders `utils/texDoc.ts`'s parse in a `.tex-slot`, with maths rendered
  lazily through one shared IntersectionObserver.

## The agent's edits and replies

`DocumentPane` applies an agent edit as ONE transaction with `userEvent: 'input.agent'` and
`isolateHistory.of('full')`. It is allowed in Reading mode on purpose — there is no transaction filter
in `src`; keep it that way. Agent replies render in a read-only view from `replyView.ts` (the same
analysis and preview fields, Read mode), which is how they get headings, code, KaTeX, mermaid and tables
without a third HTML sink; streamed text is appended once per animation frame.
