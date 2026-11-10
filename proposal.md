# Engine & Compositor Proposal — full investigation record

This file is a hand-off. It records what was asked, how the investigation was run, every number
that was measured, what was read in the code, what is proposed, and what is still unknown — so
a later agent can continue without redoing the work.

- **Status:** proposal only. No application code was changed. This branch adds this one file.
- **Base commit:** `9770d82` ("Make switching to a PDF cost what it looks like it costs (#60)").
- **Short version for the owner:** a published summary page exists at
  <https://claude.ai/artifact/W3ykvaN83HYcSANWCg1Hye> (private to the owner). This file is the
  long version and supersedes it where they differ (see §13).

## Contents

1. The ask
2. Recommendation in brief
3. What Figma does, and what transfers
4. Method
5. Measurements
6. Code-reading audits
7. Defects found on the way
8. Proposed architecture, in detail
9. Expected gains and what each rests on
10. Considered and rejected
11. Order of work and acceptance gates
12. Risks, unknowns, and what was not investigated
13. Corrections to the published summary
14. Appendix A — raw benchmark output
15. Appendix B — benchmark harness source

---

## 1. The ask

The owner's request, paraphrased closely:

> Figure out how we can do what Figma does to keep things running fast and smoothly, in this
> application. Some parts are insanely slow and are fundamentally limited by being pure
> TypeScript without the kind of optimizations and components Figma has. Investigate
> thoroughly, find the optimal choice, with estimated performance benefits in the key areas and
> what the architectural changes would be. Read only — no code changes.

A follow-up during the work:

> Give zero weight to technical cost, implementation time or complexity. Infinite budget, no
> concern about a massive overhaul. But do not be deliberately excessive or wasteful — be wise
> and pick the optimal outcome.

So options were ranked on end-state speed and correctness only. Anything that did not
measurably pay off was dropped regardless of how "Figma-like" it sounded.

## 2. Recommendation in brief

1. **Keep the text editor on CodeMirror 6 and the DOM, and make its per-keystroke work
   incremental.** Today every keystroke and every caret move re-derives decorations for the
   whole note. This is the largest felt problem and it is an algorithm problem, not a language
   problem.
2. **Build an engine in Rust → WebAssembly that runs in Web Workers** and owns:
   PDF rasterising and writing (PDFium, C++ → WASM), the ink scene, graph layout, and a
   persistent vault index.
3. **Draw PDFs, ink and the graph through one GPU tile compositor** (WebGPU, WebGL2 fallback).
   The UI thread places tiles and handles input; it never rasterises.
4. **Retire tldraw, pdf.js and pdf-lib** once the engine covers them.
5. **Fix three defects first** (§7). One of them makes some vaults impossible to open.

The premise "it is slow because it is pure TypeScript" is one-third right. Measured on this
app's own graph kernel at 5,000 nodes (§5.6): compiled code with SIMD bought about 4×; a
better algorithm in plain JavaScript bought about 40×; they multiply. The slow areas are slow
for three different reasons:

| Reason | Where it applies | Fix |
|---|---|---|
| Work proportional to the whole document per input | Editor, ink save, graph layout | Incremental algorithms |
| Heavy work on the UI thread | PDF raster, graph simulation, vault indexing | Workers |
| One DOM node per object | Ink (tldraw), PDF text layer | GPU tiles, engine-owned model |

## 3. What Figma does, and what transfers

Sourced facts:

- Figma's renderer is written in C++ and compiled to WebAssembly with Emscripten. The same
  code is also built natively for server-side rendering and testing. It originally targeted
  WebGL and moved to WebGPU, keeping WebGL as a fallback with a mid-session switch.
  Source: <https://www.figma.com/blog/figma-rendering-powered-by-webgpu/>
- Moving from asm.js to WebAssembly improved Figma's load time by more than 3×.
  Source: <https://www.figma.com/blog/webassembly-cut-figmas-load-time-by-3x/>
- Neither post quantifies runtime speed-ups, says which thread the renderer runs on, or
  mentions tile rendering. Do not attribute those to Figma.

Principles this proposal takes from that architecture:

| Principle | State here today |
|---|---|
| Own the document model; an edit touches what changed | Typing re-derives the whole note. One pen stroke re-serialises the whole board. |
| Draw on the GPU, no DOM node per object | Every stroke is an SVG element plus a React component. PDF pages are whole-page bitmaps. |
| Compiled engine, flat memory, no garbage collector | PDF pages are painted by JavaScript on the UI thread. |
| UI chrome stays ordinary web tech | Already true; React, the file tree and CodeMirror stay. |

Where this proposal goes further than the Figma posts: the engine runs in workers, not on
the UI thread.

Related fact about tldraw (the current canvas library): it still renders shapes as DOM/SVG
elements; culled shapes stay in the DOM with `display: none`; there is no WebGL renderer for
shapes. Source: <https://tldraw.dev/sdk-features/performance>,
<https://tldraw.dev/sdk-features/culling>.

## 4. Method

### 4.1 Three parallel code audits

Three read-only sub-agents each audited one subsystem and reported file/line findings plus
every in-code comment that states a measured number. Their findings are in §6. Line numbers
from those audits were spot-checked, not all re-verified; the ones re-verified by hand are
marked ✔.

### 4.2 Measurements on the real app

- `npm ci`, then `npm run build`, served with `npx vite preview --port 4611 --strictPort`.
  All "today" numbers are from this **production build** unless stated.
- Driven by Playwright 1.63 with its bundled headless Chromium (Chrome for Testing
  153.0.8010.12), Node 22.23.4, on a 4-vCPU, 15 GB Linux cloud VM.
- Followed `.agents/skills/verify-in-browser/SKILL.md`: `window.showDirectoryPicker` is
  stubbed to return a **named OPFS subfolder** (`bench`), and `queryPermission` /
  `requestPermission` are patched to `'granted'`. Fixtures are written into OPFS after
  `page.goto`, then the page is reloaded and "Open Vault" is clicked.
- An init script counts `FileSystemFileHandle.getFile`, `Blob.arrayBuffer`, `Blob.text`,
  directory iterations, long tasks (`PerformanceObserver` `longtask`) and Event Timing entries.
- CDP `Performance.getMetrics` gives UI-thread `ScriptDuration`, `LayoutDuration`,
  `RecalcStyleDuration` and `TaskDuration`; differences before/after a scenario give per-event
  costs.
- One CPU profile (CDP `Profiler`, 250 µs sampling) was taken against the **dev server**
  (`npx vite --port 4612`) so function names are readable. Dev React adds overhead
  (`addValueToProperties`, `jsxDEV`); the split it shows is indicative, the production totals
  in §5.1 are the reference.

Full harness source is in Appendix B; raw output is in Appendix A.

### 4.3 Caveats that apply to every number

- **Software rendering.** Headless Chromium here has no GPU. An unaccelerated 2D canvas
  rasterises on the UI thread, so PDF `taskMs` figures are inflated relative to a machine with
  GPU canvas; `scriptMs` (pdf.js executing the page's operators) is not. Both are reported.
- **1× pixel density.** A Retina display has 4× the pixels per page.
- **OPFS, not a real disk.** OPFS reads are fast. Real folders through the File System Access
  API pay a browser round trip per `getFile()`; the repo's own comments measure 600 ms per
  read on a throttled disk. Vault-scale costs are therefore under-stated here.
- **Cloud CPU.** Absolute times differ from the owner's machine; ratios and scaling shapes
  should hold.
- **Synthetic fixtures.** Notes are generated text with links, lists, tables, maths and code.
  PDFs are three real arXiv papers (15, 36 and 88 pages). Ink is one hand-drawn stroke cloned
  N times in a grid.

## 5. Measurements

### 5.1 Editor (live preview)

Fixture: one generated Markdown note. Mix per ~60 lines: a heading, paragraphs with bold,
italic, inline code, wikilinks and inline maths, nested lists, 3-column tables with maths,
display maths, fenced TypeScript.

Typing 40 characters at 60 ms intervals in edit mode, production build:

| Note | Position | Script / key | Layout / key | UI-thread task / key | Event Timing p50 / p95 / max |
|---|---|---|---|---|---|
| 3,002 lines, 248 KB | middle | 31.6 ms | 1.9 ms | 47.6 ms | 32 / 56 / 56 ms |
| 3,002 lines, 248 KB | end | 25.6 ms | 1.4 ms | 37.8 ms | 32 / 40 / 48 ms |
| 10,001 lines, 826 KB | middle | 129.2 ms | 1.9 ms | 147.4 ms | 144 / 184 / 240 ms |
| 10,001 lines, 826 KB | end | 99.8 ms | 1.6 ms | 114.2 ms | 104 / 168 / 184 ms |

Caret movement only (40 arrow-key presses, edit mode):

| Note | Script / key | Layout / key | Task / key |
|---|---|---|---|
| 3,002 lines | 20.4 ms | 1.3 ms | 31.2 ms |
| 10,001 lines | 69.0 ms | 1.2 ms | 80.7 ms |

Other scenarios:

| Scenario | 3,002 lines | 10,001 lines |
|---|---|---|
| Click → first text on screen (read mode) | 359 ms | 402 ms |
| Open: script / longest task | 217 ms / 117 ms | 274 ms / 142 ms |
| Toggle to edit mode | 54 ms | 48 ms |
| Jump-scroll 120 screens: frame p50 / p95 / max | 17 / 25 / 30 ms | 17 / 25 / 29 ms |
| Scroll: script + layout + style per frame | 3.4 + 2.9 + 2.6 ms | 3.9 + 3.0 + 2.6 ms |

Readings:

- Cost per keystroke is **linear in note size** (≈0.13–0.16 ms per KB) and almost entirely
  script. Layout is 2 ms regardless of size. The DOM is not the problem.
- Opening and scrolling are fine. CodeMirror's viewport virtualisation works.
- The "top-of-doc" rows in the raw logs are invalid (focus was not in the editor for that
  run); ignore them.

CPU profile, dev build, 10,001-line note, typing mid-document, 142.8 ms of script per key:

| Share | ms / key | Where |
|---|---|---|
| 57% | 81.7 | `buildDecorations` (`src/editor/livePreview.ts`), inclusive |
| ↳ 20% | 28.6 | `analyzeDoc` → `findMathRegions` (`src/editor/latexSource.ts`) |
| ↳ 9% | 13.4 | Lezer `iterate` (full syntax-tree walk) |
| ↳ 4% | 5.6 | `intersectsCode` (linear scan per regex match) |
| 25% | 36.2 | React `performWorkOnRoot`, inclusive |
| ↳ 11% | 15.5 | a `useMemo` in `EditorPane.tsx` (word/char count over the whole text) |
| 13% | 18.4 | `@codemirror/state` self time, mostly building the `RangeSet` of ~40k decorations |
| 3% | 3.7 | `@codemirror/view` self time — the editor's own DOM/measure work |
| 5% | 7.2 | GC and native |

So what the editor genuinely needs per keystroke (CodeMirror view work) is about 4 ms. The
other ~97% is whole-document recomputation.

Why it happens (✔ re-verified):

- `src/editor/livePreview.ts:1153-1171` — decorations live in a `StateField` whose `update`
  calls `buildDecorations` for the whole document when
  `tr.docChanged || treeAdvanced || (tr.selection && editorMode !== 'read')`. A caret move in
  edit mode is a full rebuild.
- `src/components/DocumentPane.tsx:954` — the update listener calls
  `update.state.doc.toString()` on every change and passes the full string up to `App`.
- `src/components/EditorPane.tsx:583-592` — word and character counts split the whole text,
  debounced 250 ms.

### 5.2 Vault scale (tree, link graph, search)

Fixture: N notes of ~3 KB each (random words plus `[[wikilinks]]` to other notes), in 8
top-level folders with 32 nested folders.

| Phase | 1,000 notes (3.1 MB) | 10,000 notes (31 MB) |
|---|---|---|
| Click "Open Vault" → tree visible | 163 ms | 367 ms |
| Directory listings | 41 | 41 |
| Link graph built (background, idle) | by 423 ms | by 3,455 ms |
| ↳ file reads for the graph | 1,000 `getFile` + 1,000 `arrayBuffer` | 10,000 + 10,000 |
| ↳ long tasks | 0 | 1 (94 ms) |
| JS heap after open | 19 MB | 37 MB |
| Open Search panel, first query → index ready | 536 ms | 6,523 ms |
| ↳ file reads for search | 1,936 `getFile`, 2,000 `arrayBuffer` | 19,936 `getFile`, 19,926 `arrayBuffer`, 62 MB |
| JS heap after search index | 26 MB | 70 MB |
| Query latency per keystroke (input → results settled) | 3–25 ms | 8–38 ms |
| File reads per query | 0 | 0 |

Readings:

- Opening the tree is fast even at 10,000 notes.
- **Every vault open re-reads every note** for the link graph, and the first search reads
  every file **twice** (two overlapping `sync` passes, each reading everything because the
  cache map is only swapped in when a pass finishes). Nothing is persisted across reloads.
- **Search queries are already fast.** JavaScript's regex engine scans the 31 MB corpus in
  roughly 10–37 ms. WASM would not help here. The cost is reading files.
- On OPFS these reads are quick. On a real disk they are the dominant cost; the repo's own
  comments (see §6.2) show that.

### 5.3 Graph view

Fixture: N notes of ~600 bytes with links. Graph opened from the sidebar; frame intervals
recorded for 6 s while the simulation is hot.

| Notes | Frames in 6 s | fps | Frame p50 / p95 / max | Script / frame | Task / frame | Time to settle |
|---|---|---|---|---|---|---|
| 500 | 361 | 60.2 | 17 / 17 / 23 ms | 2.5 ms | 5.8 ms | ~6.5 s |
| 2,000 | 123 | 20.5 | 48 / 58 / 79 ms | 41.1 ms | 55.7 ms | ~14.3 s |
| 5,000 | 22 | 3.7 | 273 / 329 / 365 ms | 343.8 ms | 388.6 ms | not within 66 s |

Cause (✔ re-verified, `src/components/GraphView.tsx:277-296`): all-pairs repulsion,
O(n²), in the `requestAnimationFrame` loop on the UI thread, with two `Map.get` lookups by
string id per pair. Drawing is 2D canvas with one `beginPath`/`stroke` per edge. There is no
node cap. At 5,000 notes the tab is effectively frozen while the graph is open.

### 5.4 PDF viewing

Fixtures: three arXiv papers written into the vault — `attention.pdf` (15 pages, embedded
images and transparency), `figs.pdf` (36 pages, plots), `long.pdf` (88 pages, mostly text).
Viewport 1440×900 at 1× density; page canvases were 1120×1449.

| Scenario | attention (15 p) | figs (36 p) | long (88 p) |
|---|---|---|---|
| Click → first page pixels | 696 ms | 433 ms | 289 ms |
| Open: script / task | 111 / 466 ms | 84 / 651 ms | 80 / 494 ms |
| Text-layer spans after open | 2,286 | 7,705 | 9,409 |
| Scroll 40 screens: script / task | 1,839 / 3,386 ms | 512 / 2,696 ms | 376 / 2,280 ms |
| Scroll: frames > 33 ms (of ~300) | 44 | 34 | 9 |
| Scroll: frame p95 / max | 56 / 123 ms | 43 / 56 ms | 28 / 49 ms |
| Zoom, per step: script / task | 976 / 1,353 ms | 158 / 714 ms | 135 / 583 ms |
| Zoom, 8 steps: long tasks / longest / total blocking | 7 / 101 / 97 ms | 48 / 351 / 3,104 ms | 42 / 172 / 2,110 ms |

Readings:

- Every zoom step costs 0.6–1.4 s of UI-thread time. Scrolling drops frames.
- See the software-rendering caveat (§4.3): on a GPU machine the gap between `script` and
  `task` shrinks, so expect per-step cost nearer the script figure plus some — still
  135–976 ms at 1× density, before the 4× pixel count of a Retina display.
- Each page with text is rendered **twice** per paint (§7, defect 2).

### 5.5 Whiteboard ink (tldraw)

Fixture: an empty `.tldraw` file is opened, one 40-point stroke is drawn with the mouse, the
app saves it, and the saved draw-shape record (594 bytes of JSON) is cloned N times in a grid
into a new file. Then: open it, pan, zoom-to-fit (Shift+1), pan and zoom with everything in
view, and draw one more stroke.

| Scenario | 500 strokes | 3,000 strokes | 10,000 strokes |
|---|---|---|---|
| File size | 293 KB | 1,752 KB | 5,844 KB |
| Open: script / task | 137 / 257 ms | 442 / 647 ms | 1,259 / 1,545 ms |
| Open: longest task | 126 ms | 429 ms | 1,244 ms |
| Pan zoomed in (few in view): frame p50 / p95 | 17 / 18 ms | 17 / 20 ms | 17 / 27 ms |
| Pan with all in view: frame p50 / p95 / max | — | 17 / 21 / 32 ms | 46 / 88 / 144 ms |
| Pan with all in view: long tasks | — | 0 | 119 (8.8 s total) |
| Zoom in/out with all in view: frame p95 / max | 18 / 19 ms | 47 / 105 ms | 165 / 277 ms |
| Draw one stroke and let it save: script / task | 144 / 296 ms | 498 / 1,600 ms | 1,428 / 4,929 ms |
| ↳ of which layout | 3 ms | 164 ms | 576 ms |

Notes on reading this table:

- The 500-stroke column and a second 3,000-stroke run (few strokes in view when the stroke
  was drawn: 447 ms script, 735 ms task) come from the first run (`ink.log`); the rest from
  the second (`ink2.log`). Cost of one stroke depends on how many strokes are in view.
- **DOM and heap figures in the 10,000 run cover two boards.** The 3,000-stroke board opened
  earlier stays mounted (the app keeps panes mounted and hidden), so the run reported 13,004
  `.tl-shape` elements, 39,792 DOM nodes and 278 MB of JS heap for 13,000 strokes in total.
  That is about 3 DOM nodes and ~21 KB of heap per stroke, for a stroke that is 594 bytes on
  disk.
- tldraw culls off-screen shapes with `display: none` (9,923 hidden of 13,004 when zoomed
  in), which is why panning zoomed in is cheap. They are still in the DOM and in React.
- Context for scale: a page of handwriting is several hundred strokes, so a 30-page
  handwritten notebook is in the 10,000+ range. (This is an estimate, not a measurement.)

### 5.6 Micro-benchmarks

**(a) The graph repulsion kernel, four ways.** Node 22, one step, ms.

| Nodes | As shipped (Map + objects, O(n²)) | Flat `Float32Array`, O(n²), JS | C → WASM, SIMD, O(n²) | Barnes–Hut quadtree, JS typed arrays |
|---|---|---|---|---|
| 500 | 2.7 | 0.80 | 0.31 | 0.88 |
| 2,000 | 44 | 13.6 | 3.55 | 3.37 |
| 5,000 | 297.5 | 77.5 | 21.8 | 7.61 |
| 10,000 | 1,379.6 | 350.9 | 87.0 | 16.8 |
| 20,000 | — | 1,414.4 | 371.6 | 40.1 |

- "As shipped" reproduces `GraphView.tsx`'s loop shape; its figures match the in-app
  measurements (44 ms vs 41 ms at 2,000; 298 ms vs 344 ms at 5,000), which validates it.
- The WASM kernel was compiled with
  `clang --target=wasm32 -O3 -msimd128 -ffast-math -nostdlib`. It evaluates the full n×n
  matrix (twice the pair evaluations of the JS half-matrix versions) in `f32`.
- Barnes–Hut uses θ = 0.9. No WASM Barnes–Hut was built; "~3 ms at 5,000" in §9 is an
  extrapolation from the 4× seen on the O(n²) kernel.
- Takeaway: flat memory ≈ 4×, compiled SIMD ≈ another 4×, algorithm ≈ 40–80×.

**(b) pdf.js rasterising on the UI thread versus inside a worker.** Standalone page using the
repo's own `pdfjs-dist` build. Every page of each document rendered at two widths. "UI busy"
is UI-thread `TaskDuration` over the whole run.

| Document | Width | UI thread: mean / p95 per page | UI busy | 1 worker: UI busy | 4 workers: UI busy | Wall: UI / 1 w / 4 w |
|---|---|---|---|---|---|---|
| figs (36 p) | 1120 | 27 / 85 ms | 511 ms | 23 ms | 64 ms | 1,188 / 1,438 / 1,284 ms |
| figs (36 p) | 2240 | 31 / 78 ms | 877 ms | 30 ms | 74 ms | 1,333 / 2,397 / 1,629 ms |
| long (88 p) | 1120 | 16 / 21 ms | 914 ms | 27 ms | 64 ms | 1,651 / 1,388 / 1,086 ms |
| long (88 p) | 2240 | 20 / 27 ms | 1,616 ms | 32 ms | 105 ms | 2,026 / 5,413 / 1,580 ms |
| attention (15 p) | 1120 | 72 / 280 ms | 709 ms | failed | failed | 1,241 / — / — |
| attention (15 p) | 2240 | 96 / 454 ms | 1,095 ms | failed | failed | 1,702 / — / — |

- In a worker, pdf.js renders into an `OffscreenCanvas` and transfers an `ImageBitmap` back.
  UI-thread time falls by **94–98%**.
- It **fails on `attention.pdf`**: `DOMCanvasFactory._createCanvas` calls
  `document.createElement` for inline images and transparency groups, and there is no
  `document` in a worker. A custom `CanvasFactory` might fix it; this was not tried.
- Wall time with four workers did not improve much on a 4-vCPU box with software raster.
- **PDFium was not benchmarked.** `@hyzyla/pdfium` was installed into the scratch directory,
  but the sandbox's policy refused to execute freshly downloaded third-party code. Its raster
  speed relative to pdf.js is therefore unverified.

## 6. Code-reading audits

Three sub-agent reports, condensed. They are code reading, not measurement, unless they quote
a measured comment. ✔ marks what was re-verified by hand afterwards.

### 6.1 Editor (`src/editor/`, `EditorPane.tsx`, `DocumentPane.tsx`)

What runs when:

- `buildDecorations` (`livePreview.ts:340-1038`) covers the **whole document** every time: one
  full `syntaxTree.iterate` (368-834); regex passes over the whole flattened string for `$`
  runs (857, edit mode only), `==` (871), images (908), wikilinks (937); `findTables` with
  `parseGrid` per table (989, `tableModel.ts:225-238`); a `doc.slice` per table (1009);
  `Decoration.set(…, true)` which sorts all decorations (1019); two `decorations.filter`
  passes plus `mergeProjectionRanges` for the reading projection (1031-1035), built in edit
  mode too.
- Trigger (✔): `livePreview.ts:1165-1171` — document change, syntax-tree advance, or any
  selection change in edit mode.
- Memoised: only `analyzeDoc` (flattened string, code ranges from a second full tree walk,
  maths regexes), in a `WeakMap` keyed on `(Text, tree)` (`latexSource.ts:108-127`), plus
  `docString` (`docCache.ts`). The main tree walk and the regex passes are not memoised.
- Linear scans inside loops: `intersectsCode` is `codeRanges.some(...)` per regex match
  (`livePreview.ts:366`); `inCode` in `findMathRegions` likewise (`latexSource.ts:46,65`).
- On open, each background parse slice advances the tree and triggers another full rebuild,
  roughly O(n²/slice) over the open of a large note. Same trigger in `headingFold.ts:535` and
  `readingEmphasis.ts:26`.
- Outside the editor per keystroke (✔): `DocumentPane.tsx:954` `doc.toString()` → `App`
  `setTabs` (`App.tsx:2003`) → React re-render; word count (`EditorPane.tsx:583-592`).
- Widgets (`KaTeX`, tables, mermaid, images) only build DOM for the viewport; CodeMirror
  handles that. KaTeX has no render cache and renders synchronously in `MathWidget.toDOM`
  (`mathWidget.ts:133-137`). Mermaid SVG is cached by theme + source, LRU 100
  (`mermaidWidget.ts:29-57`).
- Layout-forcing reads: `applyFit` (`tableFit.ts:408-610`) does up to ~8 forced reflows per
  table on first draw and on resize; a first fit that changes height dispatches a selection
  transaction (602-607), which in edit mode triggers a full decoration rebuild per table.
- There is **no large-document fallback** for live preview. Caps that exist: `DEC_CACHE_MAX`
  512, `SVG_CACHE_MAX` 100, `FIT_CACHE_MAX` 32, `MAX_FIT_PASSES` 3, reading-emphasis chunks of
  8,192 with 128 chunks / 256K units.

Measured numbers already recorded in the repo:

- `latexSource.ts:138-141` — a previous O(nodes × regions) scan "measured ~186 million
  comparisons, ~138ms per keystroke on a 400KB note, versus ~3ms for the bare tree walk".
- `livePreview.ts:29-33` — "~10k-39k decorations per rebuild (measured)".
- `scrollAnchor.ts:93-95` — "1,510 measure passes against 930 over the same wheel scroll
  through a 9,069-line note".
- `.agents/skills/live-preview/SKILL.md:132` — "KaTeX is ~0.3ms each".

Audit judgement: the top remaining cost on a large note is the whole-document rebuild per
keystroke and per caret move. It is pure compute, but its output is `Decoration`/`RangeSet`
objects that must exist on the UI thread, so moving it to a worker means serialising ~40k
ranges per pass. Restricting it to what changed is the larger lever. Table fitting and widget
height churn are DOM-bound; workers, WASM and the GPU do not help them.

### 6.2 Vault-wide work (`FileSystemContext.tsx`, `graph.ts`, `vaultSearch.ts`, `App.tsx`)

- **No vault index survives a reload.** IndexedDB holds only the root directory handle
  (`FileSystemContext.tsx:1050`, `:1163`) and the recent-vaults list
  (`utils/recentVaults.ts:12`). Every cache is an in-memory `Map` on the UI thread and is
  wiped on vault change (`clearLinkCache()` at `App.tsx:1679`; `searchCache.clear()` in
  `FileExplorer.tsx`; `resetFileTimes`).
- Everything vault-wide runs on the UI thread. The only workers in the codebase are the
  snapshot fingerprint, PDF build and EPUB archive workers.
- Tree walk: `listDir` (`FileSystemContext.tsx:231-294` ✔), one `entries()` per directory,
  `Limiter(WALK_CONCURRENCY = 12)` (`:734` ✔). Per-directory sort uses
  `localeCompare(…, { sensitivity: 'base' })` (`:290` ✔), the slow form that
  `utils/treeSort.ts:64` measured as 44× slower than a cached `Intl.Collator`.
- Link graph: `buildGraph` (`graph.ts:147` ✔), `mapPool` limit 32; per note a `getFile()`,
  then `arrayBuffer` + decode + two regexes if `(lastModified, size)` moved. Only link targets
  are cached. Besides vault open, a full revalidating rebuild (one `getFile` per note) is
  triggered by an outside modification of a closed file (`App.tsx:4103-4105`), a
  `contentChanged` check (`:4083`), recreate (`:4209`) and every agent write (`:4339`).
- Search: literal case-insensitive `RegExp(…, 'gi')` (`vaultSearch.ts:69-71` ✔), synchronous
  on the UI thread in a `useMemo` keyed on `useDeferredValue(query)` (`SearchPanel.tsx:55`,
  `:94-100` ✔). Full decoded text of every file is held in memory. Caps: 4 MB per file,
  128 MB total, 100 matches per file, 500 total, 200 result files (✔).
- `cache.sync` runs on mount, tree change, input focus and **every `saveEpoch`**
  (`SearchPanel.tsx:79-84` ✔), and `flushTab` bumps `saveEpoch` on each autosave
  (`App.tsx:1953`). So with the Search panel open, each autosave costs one `getFile` per text
  file in the vault — the same problem `graph.ts` solved with `primeLinks`.
- The agent's `vault_search` keeps a second, independent cache (`vaultAgentTools.ts:675`).
- Asset reconcile reads neighbouring notes one at a time with no pool
  (`App.tsx:1241-1257`); for a note at the vault root that is the whole vault.
- File times: one `getFile()` per file, 32 at a time, only when a modified-time sort is
  selected, re-run on every tree change (`fileTimes.ts:96`).
- Watcher: `FileSystemObserver` records → coalescer → `relistDirs`; more than 64 dirty
  directories means a full walk; polling fallback is a full walk every 15 s while visible.
- Save: `statOf` → write → `crypto.subtle` SHA-256 → stat; then `primeLinks` (no I/O).
- Hashing: `crypto.subtle.digest('SHA-256')` for open documents only (`diskVersion.ts:168`).
- No `FileSystemHandle` is posted to a worker today. Handles are structured-cloneable (they
  are already stored in IndexedDB). Obstacles: tree nodes carry handles and
  `parentHandle === parent.handle` identity is an invariant (`treeShare.ts:20-28`), and a
  clone is a new object; `requestPermission` needs a user gesture on the UI thread.

Measured numbers already recorded in the repo:

- `App.tsx:1698-1701` — "Measured on a 1,000-note vault: typing twelve characters cost 1,004
  `getFile()` round trips".
- `App.tsx:1723-1726` — first graph build "measured at 1,000 reads and 2.6MB on a 1,000-note
  vault".
- `graph.ts:66-71` — "200 file reads and 2.07MB per keystroke-triggered autosave on a
  200-note vault".
- `App.tsx:2688-2690` — "600ms per read … ~3.05s from tree to tabs" on a throttled disk.
- `utils/treeSort.ts:64-66` — "sorting 2,300 names, 44 ms that way against 1 ms here".
- `index.css:891-894` — "~210ms of blocked main thread to move a drawer".
- `App.tsx:1138-1140` — "a 10MB document: 19MB read and 19MB hashed before the first page
  appeared".

### 6.3 PDF, ink and graph (`PdfViewer.tsx`, `PdfAnnotateCanvas.tsx`, tldraw panes, `GraphView.tsx`)

PDF view mode:

- A page becomes pixels through `page.render()` into a UI-thread 2D `<canvas>` created with
  `document.createElement`, then `drawImage` into the page's canvas
  (`PdfViewer.tsx:951-990` ✔). No `OffscreenCanvas`, `ImageBitmap` transfer or WebGL in any
  PDF or canvas code. The pdf.js worker only parses and builds operator lists.
- Scale is fit-width × zoom (0.4–4); device pixel ratio capped at 2 (`canvasDpr`, `:168`).
- Whole page while it fits `MAX_CANVAS_PIXELS = 2**24` (`:164`); above that, one band
  (visible strip plus margin), not tiles (`pageRegion`, `:244-289`).
- Windowing: render within 1 page of the viewport, evict bitmaps beyond 3, release beyond 12
  (`:130-143`, `updateWindow` `:1137-1191`). About 67 MB per page at the pixel cap; no global
  LRU.
- Zoom: CSS `scale()` while pinching, commit 180 ms after the wheel burst, then every page in
  the window re-renders (`:1216-1253`, `:1374-1417`).
- Text layers are pdf.js `TextLayer` DOM spans, built eagerly for every page up to 300 pages
  and never freed (`:147`, `:1501-1511`).
- Word-emphasis binding wraps every render, on or off (✔, see §7 defect 2).

Annotate / notebook mode:

- A second pdf.js document is opened; each page is rendered at `PAGE_RENDER_SCALE = 2`,
  encoded as JPEG q0.82 and placed under the ink as a locked tldraw `image` shape
  (`pdfAnnotation.ts:231-279`, `PdfAnnotateCanvas.tsx:283-292`, `:380-413`).
- Pages in view are re-rendered at `ceil(zoom × devicePixelRatio)` up to 6×, one page at a
  time, debounced 350 ms (`:111-121`, `:457-519`).
- Ink is tldraw draw shapes via a forked `TightDrawShapeUtil` (`tightDrawShape.tsx:92-110`).
  Each stroke is its own `<SVGContainer><path>`; the path is recomputed in `component`,
  `getGeometry` and `getIndicatorPath` with no cache of its own.
- `maxShapesPerPage` is raised from tldraw's 4,000 to 1,000,000 (`canvasPen.ts:118-119`).
  tldraw's thin-line level of detail below 50% zoom is disabled on pages with ≤1,000 shapes.

Saving an annotated PDF:

- UI thread, about every 1.5 s of idle (`PdfAnnotateCanvas.tsx:94`, `flush` `:563-669`):
  `JSON.stringify` of the whole tldraw store (`:576`), a signature `JSON.stringify` per page
  (`:606`), then for changed pages `editor.getSvgString` → `svgToVectorOps`
  (`pdfVector.ts:704`); text and images go through `editor.toImage` PNG at 2×.
- Worker (`pdfBuild.worker.ts`): the original PDF and overlays are structured-cloned, not
  transferred (`pdfBuildClient.ts:38-41`); `PDFDocument.load(original)` re-parses the whole
  document on every save; `doc.save()` re-deflates it (`pdfBuild.ts:139-188`).

Graph view: covered in §5.3. Also: one simulation step per frame, alpha decays to rest over
about 300 frames; opening the graph unmounts `EditorPane`, so every PDF and board rebuilds
afterwards.

Workarounds the app already carries for tldraw and pdf.js: forked draw shape (for
`streamline`), forked image shape (for invert), `maxShapesPerPage`, a monkey-patched
`getEfficientZoomLevel`, `maxFontsToLoadBeforeRender: 0`, locally served `assetUrls`,
`colorScheme` frozen at mount, deferred `fonts.dispose`, path normalisation because pdf-lib's
`drawSvgPath` mishandles quadratic curves (`pdfVector.ts:256-275`), `/Rotate` handled
differently by pdf.js and pdf-lib (`pdfBuild.ts:17-57`), the emphasis adapter pinned to
pdf.js 6.1.200 internals (`pdfNativeEmphasis.ts:6-11`), and a production licence key without
which the canvas is replaced by an empty gate after 5 s.

Measured numbers already recorded in the repo (selection):

- `PdfViewer.tsx:154-156` — at 4× zoom, two canvases of 9440×12216, "~923MB of backing store
  … 7fps with 1.3s of blocked main thread" (now capped; 923 MB → 63 MB).
- `PdfViewer.tsx:45` — "~4.3KB of renderer memory per positioned span"; the skill adds "a
  dense 300-page book runs to hundreds of MB".
- `PdfViewer.tsx:1096-1098` — two hidden documents held "322 page canvases and 62MB of
  bitmaps".
- `pdf-and-drawings/SKILL.md:152-153` — 40-page document at 4× CPU throttle: "blocked main
  thread per zoom step 223ms → 122ms".
- `pdfBuild.ts:127-128`, `pdfBuild.worker.ts:3-4` — "~150ms per annotated page … ~4.2s for 30
  annotated pages, measured".
- `canvasPen.ts:94-95` — "at 4,200 shapes, eight drawn strokes produced zero new shapes"
  (tldraw's silent cap).
- `canvasPen.ts:132-135` — "~1.7MB at 4,000 shapes … drawing eight strokes on a 3,900-shape
  board: 361ms of main-thread blocking, and ~130MB of garbage per ten strokes at 2,500".
- `pdf-and-drawings/SKILL.md:352-354` — "a 1,200-shape board carrying 12 screenshots cost
  150-250ms per return".
- `prefetchPanes.ts:4-6` — "pdf.js (~450kB) and tldraw (~1.7MB) … ~0.8s for a PDF and ~1.2s
  for a drawing".

## 7. Defects found on the way

Independent of the architecture. None were fixed (read-only task).

### Defect 1 — some vaults never finish opening (reproduced)

- **Where:** `src/context/FileSystemContext.tsx:274` (✔), inside `listDir`.
- **What:** `limiter.run(async () => { const sub = await listDir(dir.handle, …, limiter); … })`
  holds a concurrency slot for a directory's **entire subtree**. The recursive `listDir` then
  asks the same `Limiter` for slots for its own subdirectories. With `WALK_CONCURRENCY = 12`,
  as soon as 12 in-flight directories each have at least one subdirectory, every slot is held
  by a parent waiting for a child that can never get one.
- **Repro (Appendix B, `deadlock.mjs`):** a vault whose root has N folders, each containing
  one subfolder with one note.
  - N = 11 → opens; 23 directory listings.
  - N = 12 → never opens; 13 listings, then nothing. The welcome screen stays up, no error.
- **Not tested, by inference:** a single chain nested 13 deep should hang the same way.
- **Fix direction:** hold the slot only while iterating one directory's `entries()`, and
  recurse outside it.
- This was found by accident: the first benchmark fixture had 12 top-level folders with
  nested folders and the app hung.

### Defect 2 — every PDF text page is painted twice, with Word emphasis off too

- **Where:** `src/components/PdfViewer.tsx:957` and `:981` (✔),
  `src/utils/pdfNativeEmphasis.ts:47` and `:177` (✔).
- **What:** every page render calls `bindPdfNativeEmphasis`, which first walks
  `page.getOperatorList()` on the UI thread and wraps `ctx.fillText` / `ctx.fill`. After the
  real render, `verify()` renders the page a **second time** into a same-size canvas with the
  opposite emphasis setting and compares the two with `getImageData`, whenever the page has
  eligible glyphs (`if (!result.eligible) return;` is the only early exit, and `eligible` is
  counted during a normal emphasis-off render). In band mode a third, ~1 MP probe render is
  added.
- **Effect:** roughly 2× raster plus a pixel read-back per page paint and per zoom commit.
- **Fix direction:** skip `verify` when emphasis is off, or cache its verdict per page.

### Defect 3 — search reads the vault twice, and re-checks it on every autosave

- **Where:** `src/components/SearchPanel.tsx:79-84` (✔), `src/utils/vaultSearch.ts:183-215` (✔).
- **Measured:** 19,926 `arrayBuffer` reads for a 10,000-file vault on first search.
- **What:** two `sync` passes overlap on first use (mount and input focus). Each builds its
  own `next` map and reads everything, because the shared `entries` map is only replaced when
  a pass finishes. Separately, the effect depends on `saveEpoch`, so while the panel is open
  every autosave stats every text file.
- **Fix direction:** share one in-flight sync; on save, prime the one changed entry the way
  `primeLinks` does for the graph.

## 8. Proposed architecture, in detail

### 8.1 Shape

```
UI thread (TypeScript, stays)            Workers (new)
┌───────────────────────────────┐        ┌──────────────────────────────────────────┐
│ React chrome                  │  edits │ Engine (Rust → WASM)                     │
│ CodeMirror text (incremental) │ ─────▶ │  · vault index   (persisted in OPFS)     │
│ GPU compositor (WebGPU/WebGL2)│ viewport│  · ink scene     (strokes, tessellation) │
│  places tiles, never rasters  │ pointer│  · graph layout  (Barnes–Hut, SIMD)      │
│                               │ ◀───── │ PDFium (C++ → WASM) worker pool          │
│ useFileSystem(): all writes   │ tiles, │  · tile raster, text boxes, PDF writing  │
└───────────────────────────────┘ meshes └──────────────────────────────────────────┘
                                 positions, search hits (transferables)
```

Rules the new design is built on:

1. No UI-thread handler does work proportional to the document or the vault. Budget: 4 ms of
   script per input event.
2. Anything rasterised is a tile produced off the UI thread and composited on the GPU.
3. The engine owns canvas documents (ink, shapes, PDF overlays). The UI holds views of them.
4. Plain workers and transferables (`ArrayBuffer`, `ImageBitmap`). No `SharedArrayBuffer`, so
   the static deployment needs no cross-origin-isolation headers.
5. Writes to the user's files still go through `useFileSystem()` and `writeFileVersioned`.
   The engine returns bytes; it never writes to the disk itself.

### 8.2 Editor: incremental decorations (no new technology)

Target: `src/editor/livePreview.ts`, `latexSource.ts`, `DocumentPane.tsx`, `EditorPane.tsx`.

- Keep the `StateField`. On a document change, **map the existing `RangeSet` through the
  change** and rebuild only the damaged range: the changed ranges expanded to enclosing
  block boundaries using the syntax tree (and to the enclosing table, fence or maths block).
- On a syntax-tree advance, rebuild only the newly parsed range, not the whole document.
- Split selection-dependent decorations (revealing markers on the caret's line, etc.) into
  their own small layer. A caret move then touches only the lines the selection left and
  entered.
- Build the reading projection only in read mode.
- Replace the linear `intersectsCode` / `inCode` scans with binary search over sorted code
  ranges, and make `analyzeDoc` incremental or per-block.
- `DocumentPane.tsx:954`: stop materialising `doc.toString()` per keystroke. Mark the tab
  dirty and hand `App` a way to read the text when it flushes. `flushTab` is the only
  consumer that needs the string.
- Word count: maintain incrementally from the change, or compute at idle.
- Respect the existing rule in `AGENTS.md`: "The decoration pass runs per keystroke, per arrow
  key, on every open pane — memoize on immutable identity or measure it; read mode stays a
  pure function of the document + its folds."

A Markdown parser in WASM is **not** proposed. Lezer is already incremental and does not show
up as a top cost.

### 8.3 Engine shell

- A Rust crate compiled to `wasm32-unknown-unknown`, loaded in a dedicated worker, plus a
  typed TypeScript client under `src/engine/`. Protocol types can live in `shared/` beside the
  helper's.
- PDFium is a separate Emscripten module in its own pool of workers (one PDFium instance per
  worker; it is not thread-safe within an instance).
- The module split matters for bundle size the same way the current PDF/tldraw split does:
  the engine and PDFium must be lazy chunks, warmed at idle by `prefetchPanes.ts`, and a
  Markdown-only vault must keep fetching neither.

### 8.4 Vault index

- The worker receives a structured clone of the root `FileSystemDirectoryHandle` after the UI
  thread has obtained permission.
- It persists, per vault id, in OPFS: for every note `(path, lastModified, size)`, extracted
  link targets, and the decoded text in shards for search.
- On open it serves the last persisted index immediately (links, backlinks, autocomplete,
  search), then revalidates by stat in the background and patches what moved.
- `FileSystemObserver` records and the app's own saves prime single entries (generalising
  `primeLinks`).
- Search stays a literal scan — it is already fast — but runs in the worker and streams
  results. A trigram index is optional and was not shown to be needed.
- The agent's `vault_search` uses the same index instead of its own cache.
- The tree itself (handles, `parentHandle` identity) stays on the UI thread as today.

### 8.5 PDF

- **Raster:** PDFium renders fixed-size tiles (512 px suggested) at the exact zoom with
  `FPDF_RenderPageBitmapWithMatrix`, returns `ImageBitmap`s, and the compositor places them.
  While zooming, existing tiles are scaled on the GPU and replaced as sharp ones arrive.
  A tile LRU with a byte budget replaces the per-page window.
- **Text:** selection, copy and find-in-document use PDFium's character boxes with a light
  overlay, instead of one DOM span per text run (~4.3 KB each by the repo's own measure).
- **Word emphasis:** re-implemented on PDFium's page-object API (set text render mode to
  fill+stroke on the chosen glyph runs) instead of monkey-patching canvas calls and
  double-rendering to verify.
- **Annotate / notebook:** the PDF page is just a tile layer under the ink layer in the same
  compositor. No JPEG round trip, no per-zoom re-encode.
- **Saving ink into a PDF:** incremental update (append changed page content and xref) rather
  than re-parsing and re-deflating the whole file with pdf-lib. The rule "every document write
  is versioned" still holds: the engine produces bytes, `flushTab` writes them.
- pdf.js and pdf-lib are removed once parity is reached. EPUB is out of scope.

### 8.6 Ink and canvas documents

- The engine owns the scene: strokes as flat point buffers (x, y, pressure), plus images,
  text boxes and simple shapes. Spatial index (R-tree or grid) for culling and hit-testing.
- Each stroke is tessellated once into a triangle mesh. Tiles of the ink layer are cached
  textures; a new stroke dirties only the tiles it touches. The stroke in progress is drawn
  directly, ahead of tiles, for latency.
- Persistence is an append-only log plus periodic compaction, in a binary format. Committing
  a stroke is O(stroke), not O(board).
- Undo/redo, selection, lasso, transform and erase live in the engine.
- **Existing files:** `.tldraw`, `.notebook` and PDF-embedded tldraw snapshots must import
  losslessly. Whether the on-disk format changes, or the engine keeps writing tldraw-shaped
  JSON for compatibility, is the owner's decision ("Nothing the user made is destroyed
  outright"; new vault-file keys need the owner's OK). It was not decided here.
- The agent's canvas tools (`components/canvasAgentOps.ts`, `canvas_*` MCP calls) are
  re-targeted at the engine's API.
- tldraw is removed, with its licence key, its ~1.7 MB chunk and the workarounds in §6.3.

### 8.7 Graph

- Barnes–Hut force layout with SIMD in the engine, running continuously in the worker and
  posting position buffers.
- Drawing on the compositor: instanced points and lines, labels as a text atlas or a small DOM
  overlay for the handful that are visible.
- Hit-testing through the engine's spatial index instead of an O(n) scan per pointer move.

### 8.8 Compositor

- One WebGPU surface per canvas-type pane, WebGL2 fallback, as Figma does. The app is
  Chromium-only by design, which makes WebGPU a reasonable primary target.
- It knows layers (PDF tiles, paper, ink tiles, live stroke, selection chrome, graph), a
  camera, and nothing about documents.
- A hidden pane releases its GPU textures and tells the engine to stop producing tiles, per
  the existing rule "A mounted-but-hidden pane must be told".

### 8.9 Effect on the invariants in `AGENTS.md`

| Invariant | Effect |
|---|---|
| `src/context/` is the only code that touches the File System Access API | Bends: the engine worker becomes a second **reader**, for indexing only. Writes do not move. |
| `src/editor/` is React-free | Unchanged. |
| Every document write is versioned via `writeFileVersioned` | Unchanged; the engine hands bytes to the UI thread. |
| Nothing the user made is destroyed outright | Constrains the ink format migration (§8.6). |
| Anything that walks the whole vault goes through a validated cache and a bounded pool | Becomes the index worker's job; the rule gets simpler. |
| A mounted-but-hidden pane must be told | Applies to compositor textures and tile production. |
| PDF/tldraw module split is bundle-size discipline | Replaced by an engine/PDFium lazy-chunk split with the same discipline. |
| Third-party CDNs are not a dependency of drawing a line | Satisfied by removal of tldraw. |
| Two places turn note text into `innerHTML` | Unchanged; do not add a third. |
| The AI agent changes the vault only through the app | Unchanged; canvas tools re-target the engine. |

`AGENTS.md` and the `pdf-and-drawings`, `live-preview`, `vault-filesystem` and `vault-agent`
skills will need rewriting as each part lands.

## 9. Expected gains and what each rests on

| Interaction | Today (measured) | Proposed | Basis |
|---|---|---|---|
| Type one character, 10,000-line note | 129 ms script | ~5 ms | CPU profile: CodeMirror's own view work is ~4 ms; the rest is whole-document passes that go away |
| Move the caret, same note | 69 ms | ~1 ms | Same profile; a selection change would touch two lines |
| Type one character, 3,000-line note | 32 ms | ~5 ms | Same |
| PDF zoom step | 583–1,353 ms UI task (135–976 ms script) | ~5 ms on the UI thread | Worker prototype removed 94–98% of UI-thread time; compositing only remains |
| PDF scroll, 40 screens | 2.3–3.4 s of UI thread, up to 44 slow frames | 60 fps | Same |
| Save an annotated PDF | ~150 ms per annotated page, 4.2 s for 30 (repo figure) | under 200 ms regardless of page count | Estimate; incremental append not prototyped |
| Add one pen stroke, 10,000 strokes in view | 4,929 ms UI task (1,428 ms script, 576 ms layout) | ~5 ms | Estimate; append one mesh and one log record |
| Pan a 10,000-stroke board, all in view | 46 ms p50, 88 ms p95 per frame | ~2 ms | Estimate; tile composite |
| Open a 10,000-stroke board | 1,244 ms freeze | ~100 ms | Estimate; binary buffers, no DOM, no React |
| Graph frame, 5,000 notes | 344 ms script | ~2 ms UI thread; ~3 ms per step in the worker | Kernel benchmark (7.6 ms Barnes–Hut in JS) plus the ~4× seen for WASM+SIMD |
| Graph, 2,000 notes | 20 fps | 60 fps | Same |
| Reopen a 10,000-note vault | 10,000 reads for links, ~20,000 for first search | reads for changed files only; links and search usable at once | Read counts; persisted index not prototyped |

Everything in the "Proposed" column is a projection. None is a measurement of a finished
build.

## 10. Considered and rejected

- **A canvas- or GPU-rendered text editor** (the most literal "do what Figma does"). Layout
  is 2 ms of a 129 ms keystroke. The DOM provides input methods, spellcheck, selection,
  accessibility, KaTeX and mermaid. Replacing it would cost those and gain nothing measured.
- **Porting `buildDecorations` to WASM as it stands.** Perhaps 4× on a pass that should not
  run at all, and its ~40,000 results still have to become JavaScript `Decoration` objects on
  the UI thread.
- **Running decorations asynchronously in a worker.** Decorations that replace or hide text
  change layout; delivering them a frame late makes syntax markers flicker while typing.
- **WASM full-text search.** The existing regex scan handles 31 MB in 10–37 ms per keystroke.
- **pdf.js inside a worker as the end state.** It works as a prototype but needs the DOM for
  images and transparency groups (failed on 1 of 3 papers), is not a supported configuration,
  and cannot produce a tile without replaying the whole page's operators.
- **Keeping tldraw and replacing only its draw-shape rendering with a GPU layer.** It would
  fix panning but not the store: whole-board serialisation, one React component and one
  record per stroke, 1.2 s open at 10,000 strokes. Mixing a GPU ink layer with DOM shapes
  also breaks z-order between ink and other objects.
- **`SharedArrayBuffer` and WASM threads.** Not needed; would require cross-origin isolation
  on a static deployment that also loads Google Fonts.

## 11. Order of work and acceptance gates

Each step should be verified with the harness in Appendix B (re-create it under a scratch
directory; nothing here is committed as runnable code) per
`.agents/skills/verify-in-browser/SKILL.md`.

1. **Fix the three defects (§7).**
   Gate: `deadlock.mjs` opens the 12-folder vault; `arrayBuffer` count on first search equals
   the file count; PDF zoom-step task time roughly halves on text pages.
2. **Editor incremental.**
   Gate: `typing.mjs 10000` shows ≤ 8 ms script per key and ≤ 2 ms per arrow key, with
   identical rendered output to today on the fixture (read mode and edit mode).
3. **Engine shell and persistent vault index.**
   Gate: second open of the 10,000-note fixture performs zero `arrayBuffer` reads on the UI
   thread; backlinks and search answer before revalidation finishes.
4. **Compositor and PDFium tiles.**
   Before starting: benchmark PDFium against pdf.js on the owner's real documents (speed and
   fidelity). Gate: `pdf.mjs` shows no long tasks during zoom and scroll; text selection,
   copy, find, links, rotation and Word emphasis behave as today.
5. **Ink engine on the compositor; retire tldraw.**
   Gate: `ink.mjs 10000` — open under 300 ms, pan p95 under 20 ms with all strokes in view,
   stroke commit under 10 ms of UI-thread task; existing `.tldraw`, `.notebook` and annotated
   PDFs open unchanged; agent canvas tools pass.
6. **Graph on the engine.**
   Gate: `graph.mjs 5000` at 60 fps and settles.

Because cost was given zero weight, this order is by dependency and felt benefit, not effort.

## 12. Risks, unknowns, and what was not investigated

Unknowns that matter:

- **PDFium speed and fidelity versus pdf.js** — not measured (§5.6b). The PDF plan's certain
  gain is moving raster off the UI thread; the engine swap rests on reasoning.
- **Real-disk behaviour.** All vault numbers are OPFS. The File System Access API on a real
  folder, on the owner's OS, should be profiled before sizing the index work.
- **GPU machines.** PDF and ink UI-thread figures include work that a GPU build does
  elsewhere. `script` figures are the safe lower bound.
- **Retina.** Everything ran at 1× density.
- **Incremental PDF writes through PDFium** were not prototyped. PDFium's save API and its
  handling of the embedded snapshot/original scheme (`pdfAnnotation.ts`) need a spike.
- **Ink format and migration** need the owner's decision (§8.6).
- **Accessibility and selection** for PDF text without DOM spans need a deliberate design.
- **Feature parity with tldraw** (text boxes, shapes, arrows, images, lasso, undo) is the
  bulk of the ink work and was not inventoried in detail.

Not investigated at all:

- EPUB reader, terminal, agent panel, helper process.
- React render scope of `App.tsx` beyond the keystroke profile.
- File-tree rendering cost with thousands of expanded rows (the tree appeared in 367 ms with
  folders collapsed).
- KaTeX-, mermaid- and table-heavy notes specifically (table fitting forces layout; see §6.1).
- Memory profiles of PDFs, and long-session leaks.
- Startup/bundle cost. For reference, the production build's largest chunks were:
  `canvasAgentOps` 1,761 kB (tldraw), main `index` 1,169 kB, `cynefin` 688 kB and
  `mermaid.core` 622 kB (mermaid), `index` 498 kB, `cytoscape` 443 kB, `pdfWorker` 431 kB,
  `pdfRotate` 429 kB (pdf-lib), `icon-nodes` 395 kB, `EpubPane` 362 kB, `katex` 261 kB.

Harness limitations a future agent should know:

- Playwright's bundled Chromium crashes when a stored OPFS handle is read back from IndexedDB
  (documented in the `verify-in-browser` skill), so every run opens the vault through the
  stubbed picker once and never tests restore-on-reload.
- `npm run build` and `npm run dev` regenerate `src/epub/reader-frame.html` and its integrity
  file; both are git-ignored.
- tldraw worked in the production build on `localhost` without a licence key.
- The tldraw draw tool was selected with the `d` key; zoom-to-fit is `Shift+1`.
- The graph button is found by `button[aria-label*="raph" i]`; the search tab by
  `aria-label="Search"`; the PDF zoom buttons by `aria-label="Zoom in"` / `"Zoom out"`.

## 13. Corrections to the published summary

The summary page was written before this file. Differences:

- It states "278 MB heap, 40,000 DOM nodes" for a 10,000-stroke board. Those figures were
  taken with a 3,000-stroke board also mounted (13,004 shapes in total). See §5.5.
- It labels the 4.9 s stroke cost as "board with 10,000 strokes". Precisely: 10,000 strokes
  **all in view** (after zoom-to-fit). With few strokes in view it is lower (735 ms task at
  3,000 strokes, versus 1,600 ms with all 3,000 in view).
- It gives PDF figures as UI-thread task time. On a machine with GPU canvas the script share
  (135–976 ms per zoom step) is the more portable figure. See §4.3.

---

## 14. Appendix A — raw benchmark output

Lines are JSON as printed by the harness. `lt`/`longTasks` are counts and durations of tasks
over 50 ms; `tbt` is total time over 50 ms per task.

### Vault, 1,000 notes — `node vault.mjs 1000`

````text
{"N":1000,"seedMs":725}
{"phase":"open","tTreeMs":163,"tSettledMs":423,"atTree":{"getFile":194,"text":0,"arrayBuffer":182,"mb":0.6,"dirIter":41,"lt":0,"ltSum":0,"ltMax":0,"tbt":0},"total":{"getFile":1000,"text":0,"arrayBuffer":1000,"mb":3.1,"dirIter":41,"lt":0,"ltSum":0,"ltMax":0,"tbt":0}}
{"heapAfterOpenMB":19}
{"phase":"search-index","tIndexMs":536,"d":{"getFile":1936,"text":0,"arrayBuffer":2000,"mb":6.2,"dirIter":0,"lt":0,"ltSum":0,"ltMax":0,"tbt":0},"heapMB":26}
{"phase":"search-query","q":"theorem","perKeyMs":[18,20,11,11,10,9,9],"d":{"getFile":0,"text":0,"arrayBuffer":0,"mb":0,"dirIter":0,"lt":0,"ltSum":0,"ltMax":0,"tbt":0}}
{"phase":"search-query","q":"raster tile","perKeyMs":[8,10,16,8,8,25,9,23,19,13,12],"d":{"getFile":0,"text":0,"arrayBuffer":0,"mb":0,"dirIter":0,"lt":0,"ltSum":0,"ltMax":0,"tbt":0}}
{"phase":"search-query","q":"zzzznotfound","perKeyMs":[9,9,3,4,3,3,4,4,4,4,3,4],"d":{"getFile":0,"text":0,"arrayBuffer":0,"mb":0,"dirIter":0,"lt":0,"ltSum":0,"ltMax":0,"tbt":0}}
{"phase":"search-query","q":"Note 0012","perKeyMs":[9,12,10,10,10,12,10,24,13],"d":{"getFile":0,"text":0,"arrayBuffer":0,"mb":0,"dirIter":0,"lt":0,"ltSum":0,"ltMax":0,"tbt":0}}
````

### Vault, 10,000 notes — `node vault.mjs 10000`

````text
{"N":10000,"seedMs":7570}
{"phase":"open","tTreeMs":367,"tSettledMs":3455,"atTree":{"getFile":190,"text":0,"arrayBuffer":180,"mb":0.6,"dirIter":41,"lt":0,"ltSum":0,"ltMax":0,"tbt":0},"total":{"getFile":10000,"text":0,"arrayBuffer":10000,"mb":31.2,"dirIter":41,"lt":1,"ltSum":94,"ltMax":94,"tbt":44}}
{"heapAfterOpenMB":37}
{"phase":"search-index","tIndexMs":6523,"d":{"getFile":19936,"text":0,"arrayBuffer":19926,"mb":62,"dirIter":0,"lt":0,"ltSum":0,"ltMax":94,"tbt":0},"heapMB":70}
{"phase":"search-query","q":"theorem","perKeyMs":[22,36,17,14,12,14,10],"d":{"getFile":0,"text":0,"arrayBuffer":0,"mb":0,"dirIter":0,"lt":0,"ltSum":0,"ltMax":94,"tbt":0}}
{"phase":"search-query","q":"raster tile","perKeyMs":[12,10,12,8,14,9,8,15,21,14,16],"d":{"getFile":0,"text":0,"arrayBuffer":0,"mb":0,"dirIter":0,"lt":0,"ltSum":0,"ltMax":94,"tbt":0}}
{"phase":"search-query","q":"zzzznotfound","perKeyMs":[15,36,24,13,14,21,25,20,21,21,21,24],"d":{"getFile":0,"text":0,"arrayBuffer":0,"mb":0,"dirIter":0,"lt":0,"ltSum":0,"ltMax":94,"tbt":0}}
{"phase":"search-query","q":"Note 0012","perKeyMs":[11,12,10,10,10,16,16,38,37],"d":{"getFile":0,"text":0,"arrayBuffer":0,"mb":0,"dirIter":0,"lt":0,"ltSum":0,"ltMax":94,"tbt":0}}
````

### Editor, 3,000 lines — `node typing.mjs 3000` (ignore the top-of-doc row)

````text
{"doc":{"bytes":248524,"lines":3002}}
{"phase":"open-read-mode","which":"Big","tFirstTextMs":359,"scriptMs":217,"layoutMs":46,"styleMs":19,"taskMs":329,"heapMB":14,"nodes":1020,"lt":{"getFile":3,"text":0,"arrayBuffer":3,"mb":0.5,"dirIter":1,"lt":2,"ltSum":222,"ltMax":117,"tbt":122}}
{"phase":"toggle-edit","ms":54,"scriptMs":26,"layoutMs":12,"styleMs":8,"taskMs":92,"heapMB":19,"nodes":1215,"editable":"true"}
{"phase":"type","label":"top-of-doc","keys":40,"perKey":{"scriptMs":0.4,"layoutMs":0.2,"styleMs":0.1,"taskMs":1.5},"eventTiming":{"n":2,"p50":16,"p95":16,"max":16}}
{"phase":"type","label":"middle-of-doc","keys":40,"perKey":{"scriptMs":31.6,"layoutMs":1.9,"styleMs":0.8,"taskMs":47.6},"eventTiming":{"n":160,"p50":32,"p95":56,"max":56}}
{"phase":"type","label":"end-of-doc","keys":40,"perKey":{"scriptMs":25.6,"layoutMs":1.4,"styleMs":0.9,"taskMs":37.8},"eventTiming":{"n":160,"p50":32,"p95":40,"max":48}}
{"phase":"arrow-keys","perKey":{"scriptMs":20.4,"layoutMs":1.3,"taskMs":31.2}}
{"phase":"scroll-120-pages","frameMs":{"p50":17,"p95":25,"max":30},"perFrame":{"scriptMs":3.4,"layoutMs":2.9,"styleMs":2.6}}
````

### Editor, 10,000 lines — `node typing.mjs 10000` (ignore the top-of-doc row)

````text
{"doc":{"bytes":826488,"lines":10001}}
{"phase":"open-read-mode","which":"Big","tFirstTextMs":402,"scriptMs":274,"layoutMs":46,"styleMs":15,"taskMs":383,"heapMB":17,"nodes":1020,"lt":{"getFile":3,"text":0,"arrayBuffer":3,"mb":1.6,"dirIter":1,"lt":3,"ltSum":313,"ltMax":142,"tbt":163}}
{"phase":"toggle-edit","ms":48,"scriptMs":17,"layoutMs":11,"styleMs":8,"taskMs":128,"heapMB":12,"nodes":861,"editable":"true"}
{"phase":"type","label":"top-of-doc","keys":40,"perKey":{"scriptMs":8.6,"layoutMs":0.1,"styleMs":0.1,"taskMs":10.3},"eventTiming":{"n":8,"p50":120,"p95":160,"max":160}}
{"phase":"type","label":"middle-of-doc","keys":40,"perKey":{"scriptMs":129.2,"layoutMs":1.9,"styleMs":0.8,"taskMs":147.4},"eventTiming":{"n":160,"p50":144,"p95":184,"max":240}}
{"phase":"type","label":"end-of-doc","keys":40,"perKey":{"scriptMs":99.8,"layoutMs":1.6,"styleMs":0.8,"taskMs":114.2},"eventTiming":{"n":160,"p50":104,"p95":168,"max":184}}
{"phase":"arrow-keys","perKey":{"scriptMs":69,"layoutMs":1.2,"taskMs":80.7}}
{"phase":"scroll-120-pages","frameMs":{"p50":17,"p95":25,"max":29},"perFrame":{"scriptMs":3.9,"layoutMs":3,"styleMs":2.6}}
````

### Editor CPU profile, dev build — `node profile.mjs 10000 type`

````text
MODE=type LINES=10000 total script 142.8 ms/key
--- by module (self)
   38.6 ms/key  27%  src/editor/livePreview.ts
   26.6 ms/key  19%  src/editor/latexSource.ts
   18.4 ms/key  13%  dep:chunk-232J4UQK.js
   15.5 ms/key  11%  src/components/EditorPane.tsx
   11.3 ms/key   8%  dep:chunk-CU7ICZ3Y.js
   10.9 ms/key   8%  dep:chunk-UHMAKDID.js
    7.2 ms/key   5%  (native/gc)
    5.9 ms/key   4%  dep:react_jsx-dev-runtime.js
    3.7 ms/key   3%  dep:chunk-ZIRPVCRF.js
    1.8 ms/key   1%  src/editor/tableModel.ts
    0.9 ms/key   1%  dep:chunk-XREHI5EI.js
    0.4 ms/key   0%  dep:@codemirror_lang-markdown.js
    0.4 ms/key   0%  src/editor/lists.ts
    0.3 ms/key   0%  dep:chunk-IC5RKESQ.js
--- inclusive (top frames)
  142.8 ms/key 100%  (root) @ (native)
  102.7 ms/key  72%  (anon) @ node_modules/.vite/deps/chunk-ZIRPVCRF.js
  100.7 ms/key  70%  dispatch @ node_modules/.vite/deps/chunk-ZIRPVCRF.js
  100.6 ms/key  70%  update @ node_modules/.vite/deps/chunk-ZIRPVCRF.js
   97.2 ms/key  68%  (anon) @ node_modules/.vite/deps/chunk-232J4UQK.js
   94.8 ms/key  66%  flush @ node_modules/.vite/deps/chunk-ZIRPVCRF.js
   94.5 ms/key  66%  applyDOMChange @ node_modules/.vite/deps/chunk-ZIRPVCRF.js
   94.4 ms/key  66%  applyDOMChangeInner @ node_modules/.vite/deps/chunk-ZIRPVCRF.js
   86.5 ms/key  61%  get state @ node_modules/.vite/deps/chunk-232J4UQK.js
   86.5 ms/key  61%  applyTransaction @ node_modules/.vite/deps/chunk-232J4UQK.js
   86.5 ms/key  61%  update @ node_modules/.vite/deps/chunk-232J4UQK.js
   86.5 ms/key  61%  ensureAddr @ node_modules/.vite/deps/chunk-232J4UQK.js
   86.5 ms/key  61%  _EditorState @ node_modules/.vite/deps/chunk-232J4UQK.js
   82.0 ms/key  57%  update @ src/editor/livePreview.ts
   81.7 ms/key  57%  buildDecorations @ src/editor/livePreview.ts
   36.2 ms/key  25%  performWorkOnRoot @ node_modules/.vite/deps/chunk-CU7ICZ3Y.js
   28.6 ms/key  20%  analyzeDoc @ src/editor/latexSource.ts
   26.4 ms/key  18%  run @ (native)
   25.2 ms/key  18%  findMathRegions @ src/editor/latexSource.ts
   23.2 ms/key  16%  runWithFiberInDEV @ node_modules/.vite/deps/chunk-CU7ICZ3Y.js
   22.9 ms/key  16%  renderRootSync @ node_modules/.vite/deps/chunk-CU7ICZ3Y.js
   22.8 ms/key  16%  performUnitOfWork @ node_modules/.vite/deps/chunk-CU7ICZ3Y.js
   22.8 ms/key  16%  workLoopSync @ node_modules/.vite/deps/chunk-CU7ICZ3Y.js
   22.6 ms/key  16%  beginWork @ node_modules/.vite/deps/chunk-CU7ICZ3Y.js
   22.2 ms/key  16%  react_stack_bottom_frame @ node_modules/.vite/deps/chunk-CU7ICZ3Y.js
   22.2 ms/key  16%  updateFunctionComponent @ node_modules/.vite/deps/chunk-CU7ICZ3Y.js
   22.1 ms/key  15%  renderWithHooks @ node_modules/.vite/deps/chunk-CU7ICZ3Y.js
   18.5 ms/key  13%  (anon) @ node_modules/.vite/deps/chunk-CU7ICZ3Y.js
   18.3 ms/key  13%  processRootScheduleInMicrotask @ node_modules/.vite/deps/chunk-CU7ICZ3Y.js
   18.2 ms/key  13%  performSyncWorkOnRoot @ node_modules/.vite/deps/chunk-CU7ICZ3Y.js
   18.2 ms/key  13%  flushSyncWorkAcrossRoots_impl @ node_modules/.vite/deps/chunk-CU7ICZ3Y.js
   18.1 ms/key  13%  performWorkOnRootViaSchedulerTask @ node_modules/.vite/deps/chunk-CU7ICZ3Y.js
   18.1 ms/key  13%  performWorkUntilDeadline @ node_modules/.vite/deps/chunk-CU7ICZ3Y.js
   17.1 ms/key  12%  EditorPane @ src/components/EditorPane.tsx
   15.6 ms/key  11%  (anon) @ src/components/EditorPane.tsx
   15.5 ms/key  11%  exports.useMemo @ node_modules/.vite/deps/chunk-25UIJRR4.js
   15.5 ms/key  11%  useMemo @ node_modules/.vite/deps/chunk-CU7ICZ3Y.js
   15.5 ms/key  11%  updateMemo @ node_modules/.vite/deps/chunk-CU7ICZ3Y.js
   13.4 ms/key   9%  iterate @ node_modules/.vite/deps/chunk-UHMAKDID.js
   13.3 ms/key   9%  commitRootWhenReady @ node_modules/.vite/deps/chunk-CU7ICZ3Y.js
   13.3 ms/key   9%  commitRoot @ node_modules/.vite/deps/chunk-CU7ICZ3Y.js
   12.4 ms/key   9%  flushPendingEffects @ node_modules/.vite/deps/chunk-CU7ICZ3Y.js
   12.4 ms/key   9%  flushPassiveEffects @ node_modules/.vite/deps/chunk-CU7ICZ3Y.js
   12.3 ms/key   9%  flushSpawnedWork @ node_modules/.vite/deps/chunk-CU7ICZ3Y.js
   12.3 ms/key   9%  commitPassiveMountOnFiber @ node_modules/.vite/deps/chunk-CU7ICZ3Y.js
--- self
   20.8 ms/key  15%  buildDecorations @ src/editor/livePreview.ts
   19.9 ms/key  14%  findMathRegions @ src/editor/latexSource.ts
   15.4 ms/key  11%  (anon) @ src/components/EditorPane.tsx
    8.7 ms/key   6%  addValueToProperties @ node_modules/.vite/deps/chunk-CU7ICZ3Y.js
    7.8 ms/key   5%  (anon) @ src/editor/livePreview.ts
    5.9 ms/key   4%  next @ node_modules/.vite/deps/chunk-232J4UQK.js
    5.6 ms/key   4%  intersectsCode @ src/editor/livePreview.ts
    5.3 ms/key   4%  exports.jsxDEV @ node_modules/.vite/deps/react_jsx-dev-runtime.js
    4.2 ms/key   3%  (anon) @ src/editor/latexSource.ts
    3.3 ms/key   2%  run @ (native)
    3.1 ms/key   2%  (garbage collector) @ (native)
    2.9 ms/key   2%  of @ node_modules/.vite/deps/chunk-232J4UQK.js
    2.6 ms/key   2%  nextChild @ node_modules/.vite/deps/chunk-UHMAKDID.js
    1.9 ms/key   1%  forward @ node_modules/.vite/deps/chunk-232J4UQK.js
    1.8 ms/key   1%  get @ node_modules/.vite/deps/chunk-UHMAKDID.js
    1.7 ms/key   1%  compare @ node_modules/.vite/deps/chunk-232J4UQK.js
    1.7 ms/key   1%  enter @ src/editor/livePreview.ts
    1.6 ms/key   1%  mergeProjectionRanges @ src/editor/livePreview.ts
    1.6 ms/key   1%  updateHeight @ node_modules/.vite/deps/chunk-ZIRPVCRF.js
    1.5 ms/key   1%  sliceString @ node_modules/.vite/deps/chunk-232J4UQK.js
    1.4 ms/key   1%  lineInner @ node_modules/.vite/deps/chunk-232J4UQK.js
    1.1 ms/key   1%  inCode @ src/editor/latexSource.ts
    1.0 ms/key   1%  nextSibling @ node_modules/.vite/deps/chunk-UHMAKDID.js
    0.9 ms/key   1%  get node @ node_modules/.vite/deps/chunk-UHMAKDID.js
    0.9 ms/key   1%  cmpRange @ node_modules/.vite/deps/chunk-232J4UQK.js
````

### Graph view — `node graph.mjs 500 | 2000 | 5000`

````text
{"N":500,"phase":"graph-sim-6s","frames":361,"fps":60.2,"p50":17,"p95":17,"max":23,"scriptMsPerFrame":2.5,"taskMsPerFrame":5.8}
{"N":500,"phase":"graph-settle","extraMsUntilCalm":513}
{"N":2000,"phase":"graph-sim-6s","frames":123,"fps":20.5,"p50":48,"p95":58,"max":79,"scriptMsPerFrame":41.1,"taskMsPerFrame":55.7}
{"N":2000,"phase":"graph-settle","extraMsUntilCalm":8333}
{"N":5000,"phase":"graph-sim-6s","frames":22,"fps":3.7,"p50":273,"p95":329,"max":365,"scriptMsPerFrame":343.8,"taskMsPerFrame":388.6}
{"N":5000,"phase":"graph-settle","extraMsUntilCalm":-1}
````

`extraMsUntilCalm` is measured after the first 6 s; `-1` means not calm within a further 60 s.

### PDF in the app — `node pdf.mjs`

````text
{"f":"attention.pdf","phase":"open","tFirstPagePixelsMs":696,"scriptMs":111,"taskMs":466,"layoutMs":26,"longTasks":{"n":2,"sum":132,"max":77,"tbt":32},"pages":15,"liveCanvases":2,"canvasPx":[1120,1449],"spans":2286}
{"f":"attention.pdf","phase":"scroll-40-screens","frame":{"frames":280,"p50":17,"p95":56,"max":123,"over33":44,"blank":0},"scriptMs":1839,"taskMs":3386,"layoutMs":102,"longTasks":{"n":6,"sum":359,"max":91,"tbt":59}}
{"f":"attention.pdf","phase":"zoom-8-steps","perStep":{"scriptMs":976,"taskMs":1353},"longTasks":{"n":7,"sum":447,"max":101,"tbt":97}}
{"f":"figs.pdf","phase":"open","tFirstPagePixelsMs":433,"scriptMs":84,"taskMs":651,"layoutMs":24,"longTasks":{"n":1,"sum":108,"max":108,"tbt":58},"pages":36,"liveCanvases":2,"canvasPx":[1120,1449],"spans":7705}
{"f":"figs.pdf","phase":"scroll-40-screens","frame":{"frames":326,"p50":17,"p95":43,"max":56,"over33":34,"blank":0},"scriptMs":512,"taskMs":2696,"layoutMs":125,"longTasks":{"n":2,"sum":105,"max":53,"tbt":5}}
{"f":"figs.pdf","phase":"zoom-8-steps","perStep":{"scriptMs":158,"taskMs":714},"longTasks":{"n":48,"sum":5504,"max":351,"tbt":3104}}
{"f":"long.pdf","phase":"open","tFirstPagePixelsMs":289,"scriptMs":80,"taskMs":494,"layoutMs":25,"longTasks":{"n":1,"sum":53,"max":53,"tbt":3},"pages":88,"liveCanvases":2,"canvasPx":[1120,1449],"spans":9409}
{"f":"long.pdf","phase":"scroll-40-screens","frame":{"frames":357,"p50":17,"p95":28,"max":49,"over33":9,"blank":0},"scriptMs":376,"taskMs":2280,"layoutMs":76,"longTasks":{"n":0,"sum":0,"max":0,"tbt":0}}
{"f":"long.pdf","phase":"zoom-8-steps","perStep":{"scriptMs":135,"taskMs":583},"longTasks":{"n":42,"sum":4210,"max":172,"tbt":2110}}
````

### Ink, first run — `node ink.mjs 500,3000` (pan left the content; zoomed-out rows are not meaningful)

````text
{"seedShapeBytes":594,"segKeys":["segments","color","fill","dash","size","isComplete","isClosed","isPen","scale","scaleX","scaleY"]}
{"N":500,"fileKB":293,"phase":"open","tOpenMs":214,"scriptMs":137.2,"taskMs":257.2,"layoutMs":2.8,"styleMs":18,"longTasks":{"n":1,"sum":126,"max":126},"shapes":502,"hiddenShapes":431,"svgPaths":502,"domNodes":2080,"heapMB":26}
{"N":500,"phase":"pan-zoomed-in","frame":{"frames":204,"p50":17,"p95":18,"max":20},"perFrame":{"scriptMs":0.4,"taskMs":1.3,"layoutMs":0,"styleMs":0.1},"longTasks":{"n":0,"sum":0,"max":0}}
{"N":500,"phase":"pan-zoomed-out(1 visible)","frame":{"frames":204,"p50":17,"p95":18,"max":19},"perFrame":{"scriptMs":0.4,"taskMs":1.2,"layoutMs":0,"styleMs":0},"longTasks":{"n":0,"sum":0,"max":0}}
{"N":500,"phase":"zoom-in-out","frame":{"frames":408,"p50":17,"p95":18,"max":19},"perFrame":{"scriptMs":0.3,"taskMs":0.9,"layoutMs":0,"styleMs":0},"longTasks":{"n":0,"sum":0,"max":0}}
{"N":500,"phase":"draw-one-stroke(+save)","scriptMs":144.1,"taskMs":295.6,"layoutMs":2.9,"styleMs":5.6,"longTasks":{"n":0,"sum":0,"max":0}}
{"N":3000,"fileKB":1752,"phase":"open","tOpenMs":54,"scriptMs":439.7,"taskMs":634.1,"layoutMs":2.4,"styleMs":37.9,"longTasks":{"n":1,"sum":418,"max":418},"shapes":3504,"hiddenShapes":3424,"svgPaths":3504,"domNodes":11292,"heapMB":84}
{"N":3000,"phase":"pan-zoomed-in","frame":{"frames":205,"p50":17,"p95":21,"max":34},"perFrame":{"scriptMs":1.2,"taskMs":2.4,"layoutMs":0,"styleMs":0.1},"longTasks":{"n":0,"sum":0,"max":0}}
{"N":3000,"phase":"pan-zoomed-out(2 visible)","frame":{"frames":204,"p50":17,"p95":20,"max":27},"perFrame":{"scriptMs":0.9,"taskMs":1.9,"layoutMs":0,"styleMs":0},"longTasks":{"n":0,"sum":0,"max":0}}
{"N":3000,"phase":"zoom-in-out","frame":{"frames":410,"p50":17,"p95":21,"max":27},"perFrame":{"scriptMs":0.6,"taskMs":1.5,"layoutMs":0,"styleMs":0.1},"longTasks":{"n":0,"sum":0,"max":0}}
{"N":3000,"phase":"draw-one-stroke(+save)","scriptMs":446.6,"taskMs":735.4,"layoutMs":4.7,"styleMs":6.9,"longTasks":{"n":0,"sum":0,"max":0}}
````

### Ink, second run — `node ink.mjs 3000,10000` (zoom-to-fit, all strokes in view)

````text
{"seedShapeBytes":594,"segKeys":["segments","color","fill","dash","size","isComplete","isClosed","isPen","scale","scaleX","scaleY"]}
{"N":3000,"fileKB":1752,"phase":"open","tOpenMs":549,"scriptMs":442.3,"taskMs":646.9,"layoutMs":2.2,"styleMs":38.2,"longTasks":{"n":1,"sum":429,"max":429},"shapes":3002,"hiddenShapes":2923,"svgPaths":3002,"domNodes":9580,"heapMB":71}
{"N":3000,"phase":"pan-zoomed-in","frame":{"frames":199,"p50":17,"p95":20,"max":26},"perFrame":{"scriptMs":1,"taskMs":2.4,"layoutMs":0.1,"styleMs":0.2},"longTasks":{"n":0,"sum":0,"max":0}}
{"N":3000,"phase":"pan-zoomed-out(3001 visible)","frame":{"frames":202,"p50":17,"p95":21,"max":32},"perFrame":{"scriptMs":0.7,"taskMs":5.6,"layoutMs":0,"styleMs":0.1},"longTasks":{"n":0,"sum":0,"max":0}}
{"N":3000,"phase":"zoom-in-out","frame":{"frames":556,"p50":17,"p95":47,"max":105},"perFrame":{"scriptMs":1,"taskMs":4.8,"layoutMs":0.2,"styleMs":1.6},"longTasks":{"n":15,"sum":965,"max":106}}
{"N":3000,"phase":"draw-one-stroke(+save)","scriptMs":497.8,"taskMs":1600.3,"layoutMs":163.5,"styleMs":23.8,"longTasks":{"n":2,"sum":141,"max":84}}
{"N":10000,"fileKB":5844,"phase":"open","tOpenMs":53,"scriptMs":1259.4,"taskMs":1544.8,"layoutMs":2.3,"styleMs":99.4,"longTasks":{"n":2,"sum":1333,"max":1244},"shapes":13004,"hiddenShapes":9923,"svgPaths":13004,"domNodes":39792,"heapMB":278}
{"N":10000,"phase":"pan-zoomed-in","frame":{"frames":202,"p50":17,"p95":27,"max":48},"perFrame":{"scriptMs":3,"taskMs":5,"layoutMs":0.1,"styleMs":0.4},"longTasks":{"n":0,"sum":0,"max":0}}
{"N":10000,"phase":"pan-zoomed-out(10001 visible)","frame":{"frames":242,"p50":46,"p95":88,"max":144},"perFrame":{"scriptMs":9.2,"taskMs":38.3,"layoutMs":0.1,"styleMs":0.2},"longTasks":{"n":119,"sum":8847,"max":144}}
{"N":10000,"phase":"zoom-in-out","frame":{"frames":300,"p50":27,"p95":165,"max":277},"perFrame":{"scriptMs":8.2,"taskMs":34.1,"layoutMs":1,"styleMs":12.8},"longTasks":{"n":77,"sum":7878,"max":270}}
{"N":10000,"phase":"draw-one-stroke(+save)","scriptMs":1427.6,"taskMs":4929,"layoutMs":576.1,"styleMs":44.8,"longTasks":{"n":40,"sum":4123,"max":210}}
````

### pdf.js on the UI thread vs in workers — `node run.mjs` (error stacks truncated)

````text
{"f":"attention.pdf","W":1120,"pages":15,"main":{"perPage":{"mean":72,"p95":280,"max":280},"wallMs":1241,"mainThreadBusyMs":709},"worker×1":{"err":"TypeError: Cannot read properties of undefined (reading 'createElement')\n    at DOMCanvasFactory._createCanvas (http://localhost:4613/pdf.min.mjs:26:139459)\n    at DOMCanvasFactory.create (http://localhost:4613/pdf.min.mjs:26:138824)\n    at CanvasGraphics._scaleImage (http://localhost:4613/pdf.min.mjs:26:170359)\n    at CanvasGraphics.paintInlineImageXObject (http://localhost:4613/pdf.min.mjs:26:207919)\n    at CanvasGraphics.paintImageXObject (http://localhost:4613/pdf.min.mjs:26:20
{"f":"attention.pdf","W":2240,"pages":15,"main":{"perPage":{"mean":96,"p95":454,"max":454},"wallMs":1702,"mainThreadBusyMs":1095},"worker×1":{"err":"TypeError: Cannot read properties of undefined (reading 'createElement')\n    at DOMCanvasFactory._createCanvas (http://localhost:4613/pdf.min.mjs:26:139459)\n    at DOMCanvasFactory.create (http://localhost:4613/pdf.min.mjs:26:138824)\n    at CanvasGraphics.beginGroup (http://localhost:4613/pdf.min.mjs:26:199056)\n    at CanvasGraphics.executeOperatorList (http://localhost:4613/pdf.min.mjs:26:168434)\n    at InternalRenderTask._next (http://localhost:4613/pdf.min.mjs:29:14896)"},"work
{"f":"figs.pdf","W":1120,"pages":36,"main":{"perPage":{"mean":27,"p95":85,"max":102},"wallMs":1188,"mainThreadBusyMs":511},"worker×1":{"perPage":{"mean":26,"p95":77,"max":119},"wallMs":1438,"mainThreadBusyMs":23,"bitmaps":36},"worker×4":{"perPage":{"mean":86,"p95":345,"max":396},"wallMs":1284,"mainThreadBusyMs":64,"bitmaps":36}}
{"f":"figs.pdf","W":2240,"pages":36,"main":{"perPage":{"mean":31,"p95":78,"max":133},"wallMs":1333,"mainThreadBusyMs":877},"worker×1":{"perPage":{"mean":43,"p95":89,"max":119},"wallMs":2397,"mainThreadBusyMs":30,"bitmaps":36},"worker×4":{"perPage":{"mean":98,"p95":375,"max":407},"wallMs":1629,"mainThreadBusyMs":74,"bitmaps":36}}
{"f":"long.pdf","W":1120,"pages":88,"main":{"perPage":{"mean":16,"p95":21,"max":61},"wallMs":1651,"mainThreadBusyMs":914},"worker×1":{"perPage":{"mean":11,"p95":16,"max":70},"wallMs":1388,"mainThreadBusyMs":27,"bitmaps":88},"worker×4":{"perPage":{"mean":30,"p95":112,"max":184},"wallMs":1086,"mainThreadBusyMs":64,"bitmaps":88}}
{"f":"long.pdf","W":2240,"pages":88,"main":{"perPage":{"mean":20,"p95":27,"max":58},"wallMs":2026,"mainThreadBusyMs":1616},"worker×1":{"perPage":{"mean":53,"p95":96,"max":120},"wallMs":5413,"mainThreadBusyMs":32,"bitmaps":88},"worker×4":{"perPage":{"mean":46,"p95":123,"max":143},"wallMs":1580,"mainThreadBusyMs":105,"bitmaps":88}}
````

### Tree-walk hang — `node deadlock.mjs`

````text
{"topLevelFoldersEachWithASubfolder":11,"vaultOpenedWithin15s":true,"dirListings":23}
{"topLevelFoldersEachWithASubfolder":12,"vaultOpenedWithin15s":false,"dirListings":13}
````

### Force kernel — `node force.mjs` (ms per step)

````text
n      shipped: Map + objects, O(n²)   typed arrays O(n²) JS   WASM+SIMD O(n²)   Barnes–Hut JS typed arrays
500    2.7                             0.8                     0.31              0.88
2000   44                              13.62                   3.55              3.37
5000   297.5                           77.46                   21.78             7.61
10000  1379.6                          350.88                  86.99             16.83
20000  (not run)                       1414.44                 371.64            40.11
````

---

## 15. Appendix B — benchmark harness source

None of this is part of the application. It lived in a scratch directory outside the
repository and is reproduced here so it can be re-created. To run it:

1. `npm ci && npm run build`
2. `npx vite preview --port 4611 --strictPort`
3. Put the files below in one directory outside the repo and run them with `node`.
   `require('playwright')` must resolve (Playwright 1.63 with its bundled Chromium).
4. `profile.mjs` expects the dev server instead: `npx vite --port 4612 --strictPort`.
5. `pdf.mjs` expects three PDFs in `fixtures/`: `attention.pdf`
   (<https://arxiv.org/pdf/1706.03762>), `figs.pdf` (<https://arxiv.org/pdf/2312.00752>),
   `long.pdf` (<https://arxiv.org/pdf/1404.7828>).
6. The `pdfbench/` files need `pdf.min.mjs` and `pdf.worker.min.mjs` copied from
   `node_modules/pdfjs-dist/build/`, and the same three PDFs, beside them.
7. `force.wasm` is built with:
   `clang --target=wasm32 -O3 -msimd128 -ffast-math -nostdlib -Wl,--no-entry -Wl,--export-dynamic -o force.wasm force.c`

Known quirks: `typing.mjs`'s "top-of-doc" run does not have editor focus and should be
ignored. `run.mjs` prints harmless `PAGEERROR … e.data.times is not iterable` lines (the
bitmap message falls through to the completion branch). The vault fixture uses 8 top-level
folders on purpose, to stay clear of defect 1.

### `lib.mjs`

````js
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export const { chromium } = require('playwright');
export const PORT = 4611;
export const URL0 = `http://localhost:${PORT}/`;

export async function launch() {
  const browser = await chromium.launch({ headless: true, args: ['--enable-precise-memory-info'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    const grant = (h) => { h.queryPermission = async () => 'granted'; h.requestPermission = async () => 'granted'; return h; };
    const getDir = FileSystemDirectoryHandle.prototype.getDirectoryHandle;
    FileSystemDirectoryHandle.prototype.getDirectoryHandle = async function (...a) { return grant(await getDir.apply(this, a)); };
    window.showDirectoryPicker = async () => {
      const root = await navigator.storage.getDirectory();
      return grant(await getDir.call(root, 'bench', { create: true }));
    };
    // counters
    const C = window.__c = { getFile: 0, text: 0, arrayBuffer: 0, bytes: 0, dirIter: 0, longTasks: [], events: [] };
    const gf = FileSystemFileHandle.prototype.getFile;
    FileSystemFileHandle.prototype.getFile = function () { C.getFile++; return gf.apply(this, arguments); };
    const ab = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = function () { C.arrayBuffer++; C.bytes += this.size; return ab.apply(this, arguments); };
    const tx = Blob.prototype.text;
    Blob.prototype.text = function () { C.text++; C.bytes += this.size; return tx.apply(this, arguments); };
    for (const k of ['entries', 'values', 'keys']) {
      const o = FileSystemDirectoryHandle.prototype[k];
      FileSystemDirectoryHandle.prototype[k] = function () { C.dirIter++; return o.apply(this, arguments); };
    }
    try {
      new PerformanceObserver(l => { for (const e of l.getEntries()) C.longTasks.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ type: 'longtask', buffered: true });
      new PerformanceObserver(l => { for (const e of l.getEntries()) C.events.push([e.name, Math.round(e.startTime), Math.round(e.duration), Math.round(e.processingEnd - e.processingStart)]); }).observe({ type: 'event', durationThreshold: 16, buffered: true });
    } catch {}
  });
  return { browser, ctx, page };
}

// deterministic rng
export function rng(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }

/** Seed N notes into OPFS/bench from inside the page. */
export async function seedVault(page, n, opts = {}) {
  return page.evaluate(async ({ n, bytes, folders }) => {
    let s = 12345; const r = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
    const words = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega system design memory render thread worker index graph vault note link table math proof lemma theorem compile parse token buffer canvas vector raster tile cache frame budget'.split(' ');
    const root = await navigator.storage.getDirectory();
    try { await root.removeEntry('bench', { recursive: true }); } catch {}
    const bench = await root.getDirectoryHandle('bench', { create: true });
    const dirs = [];
    for (let f = 0; f < folders; f++) {
      const top = await bench.getDirectoryHandle('Area ' + String(f % 8).padStart(2, '0'), { create: true });
      dirs.push(f < 8 ? top : await top.getDirectoryHandle('Topic ' + f, { create: true }));
    }
    const name = i => 'Note ' + String(i).padStart(5, '0');
    const make = (i) => {
      let out = '# ' + name(i) + '\n\n';
      while (out.length < bytes) {
        const k = 1 + Math.floor(r() * 3);
        let p = '';
        const len = 40 + Math.floor(r() * 80);
        for (let w = 0; w < len; w++) p += words[Math.floor(r() * words.length)] + ' ';
        out += p.trim() + '.\n\n';
        if (r() < 0.5) for (let j = 0; j < k; j++) out += '- see [[' + name(Math.floor(r() * n)) + ']] for ' + words[Math.floor(r() * words.length)] + '\n';
        out += '\n';
      }
      return out;
    };
    const t0 = performance.now();
    let next = 0;
    const worker = async () => {
      while (next < n) {
        const i = next++;
        const d = dirs[i % dirs.length];
        const h = await d.getFileHandle(name(i) + '.md', { create: true });
        const w = await h.createWritable(); await w.write(make(i)); await w.close();
      }
    };
    await Promise.all(Array.from({ length: 16 }, worker));
    return Math.round(performance.now() - t0);
  }, { n, bytes: opts.bytes ?? 3000, folders: opts.folders ?? 40 });
}

export const counters = (page) => page.evaluate(() => { const c = window.__c; return { getFile: c.getFile, text: c.text, arrayBuffer: c.arrayBuffer, mb: +(c.bytes / 1048576).toFixed(1), dirIter: c.dirIter, lt: c.longTasks.length, ltSum: c.longTasks.reduce((a, b) => a + b[1], 0), ltMax: c.longTasks.reduce((a, b) => Math.max(a, b[1]), 0), tbt: c.longTasks.reduce((a, b) => a + Math.max(0, b[1] - 50), 0) }; });
export const diff = (a, b) => Object.fromEntries(Object.keys(a).map(k => [k, k === 'ltMax' ? b[k] : +(b[k] - a[k]).toFixed(1)]));

/** Wait until a counter stops moving for `quiet` ms. Returns elapsed ms (minus quiet). */
export async function settle(page, quiet = 1500, max = 180000) {
  const t0 = Date.now(); let last = JSON.stringify(await counters(page)); let lastChange = Date.now();
  while (Date.now() - t0 < max) {
    await page.waitForTimeout(250);
    const now = JSON.stringify(await counters(page));
    if (now !== last) { last = now; lastChange = Date.now(); }
    else if (Date.now() - lastChange >= quiet) return lastChange - t0;
  }
  return -1;
}

````

### `vault.mjs`

````js
import { launch, seedVault, counters, diff, settle, URL0 } from './lib.mjs';
const N = +process.argv[2] || 1000;
const { browser, page } = await launch();
page.on('pageerror', e => console.log('PAGEERROR', e.message));
await page.goto(URL0);
const seedMs = await seedVault(page, N);
console.log(JSON.stringify({ N, seedMs }));
await page.reload();
await page.getByRole('button', { name: 'Open Vault', exact: true }).waitFor();
const c0 = await counters(page);
const t0 = Date.now();
await page.getByRole('button', { name: 'Open Vault', exact: true }).click();
await page.waitForSelector('.tree-item', { timeout: 120000 });
const tTree = Date.now() - t0;
const cTree = await counters(page);
const settled = await settle(page);
const c1 = await counters(page);
console.log(JSON.stringify({ phase: 'open', tTreeMs: tTree, tSettledMs: tTree + settled, atTree: diff(c0, cTree), total: diff(c0, c1) }));

// heap
const heap = async () => page.evaluate(() => Math.round(performance.memory.usedJSHeapSize / 1048576));
console.log(JSON.stringify({ heapAfterOpenMB: await heap() }));

// ---- search ----
await page.getByRole('button', { name: 'Search', exact: true }).click();
const c2 = await counters(page);
const ts = Date.now();
await page.fill('.search-input', 'q');   // triggers indexing
await page.waitForFunction(() => !/Indexing/.test(document.querySelector('.search-results')?.textContent || ''), null, { timeout: 180000 });
const tIndex = Date.now() - ts;
const sIdx = await settle(page, 800);
const c3 = await counters(page);
console.log(JSON.stringify({ phase: 'search-index', tIndexMs: tIndex, d: diff(c2, c3), heapMB: await heap() }));

// per-keystroke query latency, measured in page: set value → results DOM changes → next frame
const queryLatency = async (q) => page.evaluate(async (q) => {
  const input = document.querySelector('.search-input');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  const out = [];
  for (let i = 1; i <= q.length; i++) {
    const t0 = performance.now();
    setter.call(input, q.slice(0, i)); input.dispatchEvent(new Event('input', { bubbles: true }));
    // wait until summary reflects (two frames after last mutation)
    await new Promise(res => { let last = performance.now(); const mo = new MutationObserver(() => { last = performance.now(); }); mo.observe(document.querySelector('.search-panel'), { subtree: true, childList: true, characterData: true }); const tick = () => { if (performance.now() - last > 120) { mo.disconnect(); res(); } else requestAnimationFrame(tick); }; requestAnimationFrame(tick); out.push(() => last - t0); });
    out[out.length - 1] = Math.round(out[out.length - 1]());
  }
  return out;
}, q);
for (const q of ['theorem', 'raster tile', 'zzzznotfound', 'Note 0012']) {
  const cA = await counters(page);
  const lat = await queryLatency(q);
  const cB = await counters(page);
  console.log(JSON.stringify({ phase: 'search-query', q, perKeyMs: lat, d: diff(cA, cB) }));
}
await browser.close();

````

### `typing.mjs`

````js
import { launch, counters, diff, settle, URL0 } from './lib.mjs';
const LINES = +process.argv[2] || 5000;
const { browser, page } = await launch();
page.on('pageerror', e => console.log('PAGEERROR', e.message));
const cdp = await page.context().newCDPSession(page);
await cdp.send('Performance.enable');
const metrics = async () => { const { metrics } = await cdp.send('Performance.getMetrics'); const m = Object.fromEntries(metrics.map(x => [x.name, x.value])); return { script: m.ScriptDuration, layout: m.LayoutDuration, style: m.RecalcStyleDuration, task: m.TaskDuration, heapMB: m.JSHeapUsedSize / 1048576, nodes: m.Nodes }; };
const mdiff = (a, b) => ({ scriptMs: Math.round((b.script - a.script) * 1000), layoutMs: Math.round((b.layout - a.layout) * 1000), styleMs: Math.round((b.style - a.style) * 1000), taskMs: Math.round((b.task - a.task) * 1000), heapMB: Math.round(b.heapMB), nodes: b.nodes });
await page.goto(URL0);
const size = await page.evaluate(async (LINES) => {
  let s = 777; const r = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const words = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda system design memory render thread worker index graph vault note link table math proof lemma theorem compile parse token buffer canvas vector raster tile cache frame budget'.split(' ');
  const sent = (n) => { let p = ''; for (let i = 0; i < n; i++) { const w = words[Math.floor(r() * words.length)]; const x = r(); p += (x < 0.04 ? '**' + w + '**' : x < 0.07 ? '*' + w + '*' : x < 0.09 ? '`' + w + '`' : x < 0.11 ? '[[Note ' + w + ']]' : x < 0.125 ? '$x_' + i + '^2$' : w) + ' '; } return p.trim() + '.'; };
  const L = [];
  let h = 0;
  while (L.length < LINES) {
    const x = r();
    if (L.length % 60 === 0) { L.push('#'.repeat(1 + (h++ % 3)) + ' Section ' + h, ''); }
    else if (x < 0.55) { L.push(sent(30 + Math.floor(r() * 60)), ''); }
    else if (x < 0.75) { for (let i = 0; i < 4; i++) L.push((i % 2 ? '  - ' : '- ') + sent(8)); L.push(''); }
    else if (x < 0.83) { L.push('| a | b | c |', '|---|---|---|'); for (let i = 0; i < 4; i++) L.push('| ' + sent(3) + ' | ' + sent(2) + ' | $y^' + i + '$ |'); L.push(''); }
    else if (x < 0.90) { L.push('$$', '\\int_0^1 x^' + L.length % 9 + ' \\, dx = \\frac{1}{' + (L.length % 9 + 1) + '}', '$$', ''); }
    else { L.push('```ts', 'function f' + L.length + '(a: number) {', '  return a * ' + L.length + ';', '}', '```', ''); }
  }
  const text = L.join('\n');
  const root = await navigator.storage.getDirectory();
  try { await root.removeEntry('bench', { recursive: true }); } catch {}
  const bench = await root.getDirectoryHandle('bench', { create: true });
  const hh = await bench.getFileHandle('Big.md', { create: true }); const w = await hh.createWritable(); await w.write(text); await w.close();
  const h2 = await bench.getFileHandle('Small.md', { create: true }); const w2 = await h2.createWritable(); await w2.write('# small\n\nhello world\n'); await w2.close();
  return { bytes: text.length, lines: L.length };
}, LINES);
console.log(JSON.stringify({ doc: size }));
await page.reload();
await page.getByRole('button', { name: 'Open Vault', exact: true }).click();
await page.waitForSelector('.tree-item');
await settle(page, 800);
for (const which of ['Big']) {
  const m0 = await metrics(); const t0 = Date.now();
  await page.locator('.tree-item', { hasText: which }).first().click();
  await page.waitForSelector('.cm-content');
  await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent.length > 20);
  const tOpen = Date.now() - t0;
  await settle(page, 800);
  await page.waitForTimeout(1500);
  const m1 = await metrics();
  console.log(JSON.stringify({ phase: 'open-read-mode', which, tFirstTextMs: tOpen, ...mdiff(m0, m1), lt: (await counters(page)) }));
}
// enter edit mode
const mA = await metrics(); const tA = Date.now();
await page.locator('.cm-content').first().click();
await page.keyboard.press('Control+e');
await page.waitForTimeout(1500);
const mB = await metrics();
console.log(JSON.stringify({ phase: 'toggle-edit', ms: Date.now() - tA - 1500, ...mdiff(mA, mB), editable: await page.evaluate(() => document.querySelector('.cm-content')?.getAttribute('contenteditable')) }));

const typeRun = async (label, prep) => {
  await prep();
  await page.waitForTimeout(800);
  await page.evaluate(() => { window.__c.events.length = 0; window.__c.longTasks.length = 0; });
  const m0 = await metrics();
  const N = 40;
  for (let i = 0; i < N; i++) { await page.keyboard.type('abcdefghij klmnop'[i % 17]); await page.waitForTimeout(60); }
  await page.waitForTimeout(300);
  const m1 = await metrics();
  const ev = await page.evaluate(() => window.__c.events.filter(e => /key|input/.test(e[0])));
  const durs = ev.filter(e => e[0] === 'keydown' || e[0] === 'keypress' || e[0] === 'beforeinput' || e[0] === 'input').map(e => e[2]).sort((a, b) => a - b);
  const d = mdiff(m0, m1);
  console.log(JSON.stringify({ phase: 'type', label, keys: N, perKey: { scriptMs: +(d.scriptMs / N).toFixed(1), layoutMs: +(d.layoutMs / N).toFixed(1), styleMs: +(d.styleMs / N).toFixed(1), taskMs: +(d.taskMs / N).toFixed(1) }, eventTiming: { n: durs.length, p50: durs[durs.length >> 1], p95: durs[Math.floor(durs.length * 0.95)], max: durs[durs.length - 1] } }));
};
await typeRun('top-of-doc', async () => { await page.keyboard.press('Control+Home'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('End'); });
await typeRun('middle-of-doc', async () => {
  await page.evaluate(() => { const s = document.querySelector('.cm-scroller'); s.scrollTop = s.scrollHeight / 2; });
  await page.waitForTimeout(600);
  const box = await page.locator('.cm-scroller').first().boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press('End');
});
await typeRun('end-of-doc', async () => { await page.keyboard.press('Control+End'); });

// arrow-key (selection-only) cost
await page.evaluate(() => { window.__c.events.length = 0; });
const mS0 = await metrics();
for (let i = 0; i < 40; i++) { await page.keyboard.press(i % 2 ? 'ArrowLeft' : 'ArrowUp'); await page.waitForTimeout(50); }
const mS1 = await metrics(); const dS = mdiff(mS0, mS1);
console.log(JSON.stringify({ phase: 'arrow-keys', perKey: { scriptMs: +(dS.scriptMs / 40).toFixed(1), layoutMs: +(dS.layoutMs / 40).toFixed(1), taskMs: +(dS.taskMs / 40).toFixed(1) } }));

// scroll cost: jump-scroll through doc
await page.evaluate(() => { window.__c.longTasks.length = 0; });
const mC0 = await metrics();
const frames = await page.evaluate(async () => {
  const s = document.querySelector('.cm-scroller'); const out = []; let last = performance.now();
  s.scrollTop = 0;
  for (let i = 0; i < 120; i++) { s.scrollTop += 900; await new Promise(r => requestAnimationFrame(r)); const n = performance.now(); out.push(n - last); last = n; }
  out.sort((a, b) => a - b); return { p50: Math.round(out[60]), p95: Math.round(out[114]), max: Math.round(out[119]) };
});
const mC1 = await metrics(); const dC = mdiff(mC0, mC1);
console.log(JSON.stringify({ phase: 'scroll-120-pages', frameMs: frames, perFrame: { scriptMs: +(dC.scriptMs / 120).toFixed(1), layoutMs: +(dC.layoutMs / 120).toFixed(1), styleMs: +(dC.styleMs / 120).toFixed(1) } }));
await browser.close();

````

### `profile.mjs`

````js
import { launch, settle } from './lib.mjs';
const LINES = +process.argv[2] || 10000; const MODE = process.argv[3] || 'type';
const URL1 = 'http://localhost:4612/';
const { browser, page } = await launch();
page.on('pageerror', e => console.log('PAGEERROR', e.message));
const cdp = await page.context().newCDPSession(page);
await page.goto(URL1);
await page.evaluate(async (LINES) => {
  let s = 777; const r = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const words = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda system design memory render thread worker index graph vault note link table math proof lemma theorem compile parse token buffer canvas vector raster tile cache frame budget'.split(' ');
  const sent = (n) => { let p = ''; for (let i = 0; i < n; i++) { const w = words[Math.floor(r() * words.length)]; const x = r(); p += (x < 0.04 ? '**' + w + '**' : x < 0.07 ? '*' + w + '*' : x < 0.09 ? '`' + w + '`' : x < 0.11 ? '[[Note ' + w + ']]' : x < 0.125 ? '$x_' + i + '^2$' : w) + ' '; } return p.trim() + '.'; };
  const L = []; let h = 0;
  while (L.length < LINES) {
    const x = r();
    if (L.length % 60 === 0) { L.push('#'.repeat(1 + (h++ % 3)) + ' Section ' + h, ''); }
    else if (x < 0.55) { L.push(sent(30 + Math.floor(r() * 60)), ''); }
    else if (x < 0.75) { for (let i = 0; i < 4; i++) L.push((i % 2 ? '  - ' : '- ') + sent(8)); L.push(''); }
    else if (x < 0.83) { L.push('| a | b | c |', '|---|---|---|'); for (let i = 0; i < 4; i++) L.push('| ' + sent(3) + ' | ' + sent(2) + ' | $y^' + i + '$ |'); L.push(''); }
    else if (x < 0.90) { L.push('$$', '\\int_0^1 x^' + L.length % 9 + ' \\, dx = \\frac{1}{' + (L.length % 9 + 1) + '}', '$$', ''); }
    else { L.push('```ts', 'function f' + L.length + '(a: number) {', '  return a * ' + L.length + ';', '}', '```', ''); }
  }
  const root = await navigator.storage.getDirectory();
  try { await root.removeEntry('bench', { recursive: true }); } catch {}
  const bench = await root.getDirectoryHandle('bench', { create: true });
  const hh = await bench.getFileHandle('Big.md', { create: true }); const w = await hh.createWritable(); await w.write(L.join('\n')); await w.close();
}, LINES);
await page.reload();
await page.getByRole('button', { name: 'Open Vault', exact: true }).click();
await page.waitForSelector('.tree-item');
await page.locator('.tree-item', { hasText: 'Big' }).first().click();
await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent.length > 20);
await page.waitForTimeout(3000);
await page.locator('.cm-content').first().click();
await page.keyboard.press('Control+e');
await page.waitForTimeout(1500);
await page.evaluate(() => { const s = document.querySelector('.cm-scroller'); s.scrollTop = s.scrollHeight / 2; });
await page.waitForTimeout(800);
const box = await page.locator('.cm-scroller').first().boundingBox();
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await page.keyboard.press('End');
await page.waitForTimeout(1500);
await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 250 });
await cdp.send('Profiler.start');
const N = 30;
for (let i = 0; i < N; i++) { if (MODE === 'type') await page.keyboard.type('abcdefghij klmnop'[i % 17]); else await page.keyboard.press(i % 2 ? 'ArrowLeft' : 'ArrowRight'); await page.waitForTimeout(250); }
const { profile } = await cdp.send('Profiler.stop');
// aggregate self + total time
const byId = new Map(profile.nodes.map(n => [n.id, n]));
const self = new Map(); const dt = profile.timeDeltas; let total = 0;
for (let i = 0; i < profile.samples.length; i++) { const n = byId.get(profile.samples[i]); const d = dt[i] || 0; self.set(n.id, (self.get(n.id) || 0) + d); }
const parent = new Map(); for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
const key = n => { const u = (n.callFrame.url || '').replace(/^.*\/(src|node_modules)\//, '$1/').replace(/\?.*$/, ''); return (n.callFrame.functionName || '(anon)') + ' @ ' + (u || '(native)') ; };
const selfBy = new Map(), totBy = new Map(), modBy = new Map();
for (const [id, t] of self) {
  const n = byId.get(id); const k = key(n);
  if (/^\((idle|program|root)\)/.test(k)) continue;
  total += t; selfBy.set(k, (selfBy.get(k) || 0) + t);
  const mod = (n.callFrame.url || '(native/gc)').replace(/^.*\/(src|node_modules)\//, '$1/').replace(/\?.*$/, '').replace(/^node_modules\/\.vite\/deps\//, 'dep:').replace(/^(.*)$/, '$1'); modBy.set(mod, (modBy.get(mod) || 0) + t);
  const seen = new Set(); let cur = id; while (cur !== undefined) { const kk = key(byId.get(cur)); if (!seen.has(kk)) { seen.add(kk); totBy.set(kk, (totBy.get(kk) || 0) + t); } cur = parent.get(cur); }
}
const top = (m, k) => [...m].sort((a, b) => b[1] - a[1]).slice(0, k).map(([n, t]) => `${(t / 1000 / N).toFixed(1).padStart(7)} ms/key ${(100 * t / total).toFixed(0).padStart(3)}%  ${n}`);
console.log(`MODE=${MODE} LINES=${LINES} total script ${(total / 1000 / N).toFixed(1)} ms/key`);
console.log('--- by module (self)'); console.log(top(modBy, 14).join('\n'));
console.log('--- inclusive (top frames)'); console.log(top(totBy, 45).join('\n'));
console.log('--- self'); console.log(top(selfBy, 25).join('\n'));
await browser.close();

````

### `graph.mjs`

````js
import { launch, seedVault, counters, settle, URL0 } from './lib.mjs';
const N = +process.argv[2] || 1000;
const { browser, page } = await launch();
page.on('pageerror', e => console.log('PAGEERROR', e.message));
const cdp = await page.context().newCDPSession(page);
await cdp.send('Performance.enable');
const metrics = async () => { const { metrics } = await cdp.send('Performance.getMetrics'); const m = Object.fromEntries(metrics.map(x => [x.name, x.value])); return m; };
await page.goto(URL0);
await seedVault(page, N, { bytes: 600 });
await page.reload();
await page.getByRole('button', { name: 'Open Vault', exact: true }).click();
await page.waitForSelector('.tree-item');
await settle(page, 2000);
const btn = page.locator('button[aria-label*="raph" i]').first();
console.log('graph button:', await btn.getAttribute('aria-label'));
const m0 = await metrics();
await btn.click();
await page.waitForSelector('canvas', { timeout: 30000 });
const res = await page.evaluate(async () => {
  const out = []; let last = performance.now(); const t0 = last;
  while (performance.now() - t0 < 6000) { await new Promise(r => requestAnimationFrame(r)); const n = performance.now(); out.push(n - last); last = n; }
  const s = [...out].sort((a, b) => a - b);
  return { frames: out.length, fps: +(out.length / 6).toFixed(1), p50: Math.round(s[s.length >> 1]), p95: Math.round(s[Math.floor(s.length * 0.95)]), max: Math.round(s[s.length - 1]) };
});
const m1 = await metrics();
console.log(JSON.stringify({ N, phase: 'graph-sim-6s', ...res, scriptMsPerFrame: +(((m1.ScriptDuration - m0.ScriptDuration) * 1000) / res.frames).toFixed(1), taskMsPerFrame: +(((m1.TaskDuration - m0.TaskDuration) * 1000) / res.frames).toFixed(1) }));
// how long until it settles (frames return to ~16ms)
const settleT = await page.evaluate(async () => {
  const t0 = performance.now(); let last = t0; let calm = 0;
  while (performance.now() - t0 < 60000) { await new Promise(r => requestAnimationFrame(r)); const n = performance.now(); if (n - last < 20) calm++; else calm = 0; last = n; if (calm > 30) return Math.round(n - t0); }
  return -1;
});
console.log(JSON.stringify({ N, phase: 'graph-settle', extraMsUntilCalm: settleT }));
await browser.close();

````

### `pdf.mjs`

````js
import { launch, settle, URL0 } from './lib.mjs';
import fs from 'node:fs';
const files = ['attention.pdf', 'figs.pdf', 'long.pdf'];
const { browser, page } = await launch();
page.on('pageerror', e => console.log('PAGEERROR', e.message.slice(0, 200)));
const cdp = await page.context().newCDPSession(page);
await cdp.send('Performance.enable');
const metrics = async () => { const { metrics } = await cdp.send('Performance.getMetrics'); const m = Object.fromEntries(metrics.map(x => [x.name, x.value])); return m; };
const md = (a, b) => ({ scriptMs: Math.round((b.ScriptDuration - a.ScriptDuration) * 1000), taskMs: Math.round((b.TaskDuration - a.TaskDuration) * 1000), layoutMs: Math.round((b.LayoutDuration - a.LayoutDuration) * 1000) });
const lt = () => page.evaluate(() => { const c = window.__c.longTasks; const r = { n: c.length, sum: c.reduce((a, b) => a + b[1], 0), max: c.reduce((a, b) => Math.max(a, b[1]), 0), tbt: c.reduce((a, b) => a + Math.max(0, b[1] - 50), 0) }; c.length = 0; return r; });
await page.goto(URL0);
for (const f of files) {
  const b64 = fs.readFileSync('fixtures/' + f).toString('base64');
  await page.evaluate(async ({ f, b64, first }) => {
    const root = await navigator.storage.getDirectory();
    if (first) { try { await root.removeEntry('bench', { recursive: true }); } catch {} }
    const bench = await root.getDirectoryHandle('bench', { create: true });
    const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const h = await bench.getFileHandle(f, { create: true }); const w = await h.createWritable(); await w.write(bin); await w.close();
  }, { f, b64, first: f === files[0] });
}
await page.reload();
await page.getByRole('button', { name: 'Open Vault', exact: true }).click();
await page.waitForSelector('.tree-item');
await settle(page, 800);
for (const f of files) {
  await lt(); const m0 = await metrics(); const t0 = Date.now();
  await page.locator('.tree-item', { hasText: f.replace('.pdf', '') }).first().click();
  await page.waitForFunction(() => [...document.querySelectorAll('.pdf-viewer-page canvas')].some(c => c.width > 0 && c.getBoundingClientRect().width > 0 && getComputedStyle(c.closest('.pdf-viewer') || c).visibility !== 'hidden'), null, { timeout: 60000, polling: 16 });
  const tFirst = Date.now() - t0;
  await page.waitForTimeout(2500);
  const m1 = await metrics();
  const info = await page.evaluate(() => { const vs = [...document.querySelectorAll('.pdf-viewer')].filter(v => getComputedStyle(v).visibility !== 'hidden'); const v = vs[vs.length - 1]; const cs = [...v.querySelectorAll('.pdf-viewer-page canvas')].filter(c => c.width > 0); return { pages: v.querySelectorAll('.pdf-viewer-page').length, liveCanvases: cs.length, canvasPx: cs[0] ? [cs[0].width, cs[0].height] : null, spans: v.querySelectorAll('.textLayer span').length }; });
  console.log(JSON.stringify({ f, phase: 'open', tFirstPagePixelsMs: tFirst, ...md(m0, m1), longTasks: await lt(), ...info }));
  // scroll: one viewport-height every 120ms for 40 steps
  const m2 = await metrics();
  const fr = await page.evaluate(async () => {
    const vs = [...document.querySelectorAll('.pdf-viewer-scroll')].filter(v => getComputedStyle(v).visibility !== 'hidden' && v.clientHeight > 0); const s = vs[vs.length - 1];
    const out = []; let last = performance.now(); const t0 = last; let step = 0;
    while (step < 40) { if (performance.now() - t0 > step * 120) { s.scrollTop += s.clientHeight * 0.9; step++; } await new Promise(r => requestAnimationFrame(r)); const n = performance.now(); out.push(n - last); last = n; }
    const t1 = performance.now(); while (performance.now() - t1 < 1500) { await new Promise(r => requestAnimationFrame(r)); const n = performance.now(); out.push(n - last); last = n; }
    const so = [...out].sort((a, b) => a - b);
    return { frames: out.length, p50: Math.round(so[so.length >> 1]), p95: Math.round(so[Math.floor(so.length * .95)]), max: Math.round(so[so.length - 1]), over33: out.filter(x => x > 33).length, blank: 0 };
  });
  await page.waitForTimeout(1500);
  const m3 = await metrics();
  console.log(JSON.stringify({ f, phase: 'scroll-40-screens', frame: fr, ...md(m2, m3), longTasks: await lt() }));
  // zoom in x4 then out x4
  const m4 = await metrics();
  for (const lab of ['Zoom in', 'Zoom in', 'Zoom in', 'Zoom in', 'Zoom out', 'Zoom out', 'Zoom out', 'Zoom out']) { await page.locator('.pdf-viewer:visible button[aria-label="' + lab + '"]').last().click(); await page.waitForTimeout(900); }
  await page.waitForTimeout(1500);
  const m5 = await metrics(); const d = md(m4, m5);
  console.log(JSON.stringify({ f, phase: 'zoom-8-steps', perStep: { scriptMs: Math.round(d.scriptMs / 8), taskMs: Math.round(d.taskMs / 8) }, longTasks: await lt() }));
}
await browser.close();

````

### `ink.mjs`

````js
import { launch, settle, URL0 } from './lib.mjs';
const COUNTS = (process.argv[2] || '500,3000,10000').split(',').map(Number);
const { browser, page } = await launch();
page.on('pageerror', e => console.log('PAGEERROR', e.message.slice(0, 160)));
const cdp = await page.context().newCDPSession(page);
await cdp.send('Performance.enable');
const metrics = async () => { const { metrics } = await cdp.send('Performance.getMetrics'); return Object.fromEntries(metrics.map(x => [x.name, x.value])); };
const md = (a, b, n = 1) => ({ scriptMs: +(((b.ScriptDuration - a.ScriptDuration) * 1000) / n).toFixed(1), taskMs: +(((b.TaskDuration - a.TaskDuration) * 1000) / n).toFixed(1), layoutMs: +(((b.LayoutDuration - a.LayoutDuration) * 1000) / n).toFixed(1), styleMs: +(((b.RecalcStyleDuration - a.RecalcStyleDuration) * 1000) / n).toFixed(1) });
const lt = () => page.evaluate(() => { const c = window.__c.longTasks; const r = { n: c.length, sum: c.reduce((a, b) => a + b[1], 0), max: c.reduce((a, b) => Math.max(a, b[1]), 0) }; c.length = 0; return r; });
const readFile = (name) => page.evaluate(async (name) => { const root = await navigator.storage.getDirectory(); const b = await root.getDirectoryHandle('bench'); const h = await b.getFileHandle(name); return (await h.getFile()).text(); }, name);
const writeFile = (name, text) => page.evaluate(async ({ name, text }) => { const root = await navigator.storage.getDirectory(); const b = await root.getDirectoryHandle('bench', { create: true }); const h = await b.getFileHandle(name, { create: true }); const w = await h.createWritable(); await w.write(text); await w.close(); }, { name, text });
await page.goto(URL0);
await page.evaluate(async () => { const root = await navigator.storage.getDirectory(); try { await root.removeEntry('bench', { recursive: true }); } catch {} });
await writeFile('Seed.tldraw', '');
await page.reload();
await page.getByRole('button', { name: 'Open Vault', exact: true }).click();
await page.waitForSelector('.tree-item');
await page.locator('.tree-item', { hasText: 'Seed' }).first().click();
await page.waitForSelector('.tl-canvas', { timeout: 60000 });
await page.waitForTimeout(2500);
const box = await page.locator('.tl-canvas').first().boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
const drawStroke = async (x0, y0) => { await page.mouse.move(x0, y0); await page.mouse.down(); for (let i = 1; i <= 40; i++) { await page.mouse.move(x0 + i * 4, y0 + Math.sin(i / 3) * 30, { steps: 1 }); } await page.mouse.up(); };
await page.keyboard.press('d');
await drawStroke(cx - 100, cy);
await page.waitForTimeout(4000);
let seedText = await readFile('Seed.tldraw');
let snap; try { snap = JSON.parse(seedText); } catch { console.log('seed not saved, len', seedText.length); await browser.close(); process.exit(1); }
const store = snap.document.store;
const draw = Object.values(store).find(r => r.typeName === 'shape' && r.type === 'draw');
if (!draw) { console.log('no draw shape; types:', [...new Set(Object.values(store).map(r => r.typeName + ':' + (r.type || '')))]); await browser.close(); process.exit(1); }
console.log(JSON.stringify({ seedShapeBytes: JSON.stringify(draw).length, segKeys: Object.keys(draw.props) }));
for (const N of COUNTS) {
  const s2 = JSON.parse(seedText); const st = s2.document.store; const cols = Math.ceil(Math.sqrt(N));
  for (let i = 0; i < N; i++) { const id = 'shape:b' + i; st[id] = { ...draw, id, x: (i % cols) * 190 - cols * 95, y: Math.floor(i / cols) * 80 - cols * 40, index: 'a' + String(i).padStart(6, '0').replace(/0+$/, '') + 'V' }; }
  const text = JSON.stringify(s2);
  await writeFile(`Ink${N}.tldraw`, text);
  await page.waitForTimeout(1500);
  await lt(); const m0 = await metrics(); const t0 = Date.now();
  await page.locator('.tree-item', { hasText: `Ink${N}` }).first().click();
  await page.waitForFunction((N) => document.querySelectorAll('.tl-shape').length >= Math.min(N, 50), N, { timeout: 120000, polling: 50 }).catch(() => console.log('timeout waiting shapes'));
  const tOpen = Date.now() - t0;
  await page.waitForTimeout(3000);
  const m1 = await metrics();
  const dom = await page.evaluate(() => ({ shapes: document.querySelectorAll('.tl-shape').length, hiddenShapes: [...document.querySelectorAll('.tl-shape')].filter(e => e.style.display === 'none').length, svgPaths: document.querySelectorAll('.tl-canvas path').length, domNodes: document.querySelectorAll('*').length, heapMB: Math.round(performance.memory.usedJSHeapSize / 1048576) }));
  console.log(JSON.stringify({ N, fileKB: Math.round(text.length / 1024), phase: 'open', tOpenMs: tOpen, ...md(m0, m1), longTasks: await lt(), ...dom }));
  const vis = page.locator('.tl-canvas:visible').last();
  const b = await vis.boundingBox(); const px = b.x + b.width / 2, py = b.y + b.height / 2;
  await page.mouse.move(px, py);
  // zoom out to see everything: ctrl+wheel
  const frameLoop = async (label, action, steps) => {
    await lt(); const mA = await metrics();
    await page.evaluate(() => { window.__fr = []; let last = performance.now(); window.__run = true; const tick = () => { const n = performance.now(); window.__fr.push(n - last); last = n; if (window.__run) requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
    for (let i = 0; i < steps; i++) { await action(i); await page.waitForTimeout(16); }
    await page.waitForTimeout(400);
    const fr = await page.evaluate(() => { window.__run = false; const o = window.__fr; const s = [...o].sort((a, b) => a - b); return { frames: o.length, p50: Math.round(s[s.length >> 1]), p95: Math.round(s[Math.floor(s.length * .95)]), max: Math.round(s[s.length - 1]) }; });
    const mB = await metrics();
    console.log(JSON.stringify({ N, phase: label, frame: fr, perFrame: md(mA, mB, fr.frames), longTasks: await lt() }));
  };
  await frameLoop('pan-zoomed-in', async (i) => { await page.mouse.wheel(i % 4 < 2 ? 60 : -60, i % 4 < 2 ? 60 : -60); }, 60);
  await page.keyboard.press('Shift+1');
  await page.waitForTimeout(1500);
  const dom2 = await page.evaluate(() => ({ visibleShapes: [...document.querySelectorAll('.tl-canvas')].filter(c => c.getBoundingClientRect().width > 0 && getComputedStyle(c).visibility !== 'hidden').map(c => [...c.querySelectorAll('.tl-shape')].filter(e => e.style.display !== 'none').length).pop() }));
  await frameLoop('pan-zoomed-out(' + dom2.visibleShapes + ' visible)', async (i) => { await page.mouse.wheel(i % 2 ? 40 : -40, i % 4 < 2 ? 40 : -40); }, 60);
  await frameLoop('zoom-in-out', async (i) => { await page.keyboard.down('Control'); await page.mouse.wheel(0, i < 30 ? -80 : 80); await page.keyboard.up('Control'); }, 60);
  // draw one stroke on the big board
  await page.keyboard.press('d');
  await lt(); const mC = await metrics();
  await drawStroke(px - 80, py + 10);
  await page.waitForTimeout(3500);
  const mD = await metrics();
  console.log(JSON.stringify({ N, phase: 'draw-one-stroke(+save)', ...md(mC, mD), longTasks: await lt() }));
}
await browser.close();

````

### `deadlock.mjs`

````js
import { launch, URL0 } from './lib.mjs';
for (const TOP of [11, 12]) {
  const { browser, page } = await launch();
  await page.goto(URL0);
  await page.evaluate(async (TOP) => {
    const root = await navigator.storage.getDirectory();
    try { await root.removeEntry('bench', { recursive: true }); } catch {}
    const bench = await root.getDirectoryHandle('bench', { create: true });
    for (let i = 0; i < TOP; i++) {
      const a = await bench.getDirectoryHandle('Folder ' + i, { create: true });
      const b = await a.getDirectoryHandle('Sub', { create: true });
      const h = await b.getFileHandle('note.md', { create: true }); const w = await h.createWritable(); await w.write('# hi'); await w.close();
    }
  }, TOP);
  await page.reload();
  await page.getByRole('button', { name: 'Open Vault', exact: true }).click();
  const ok = await page.waitForSelector('.tree-item', { timeout: 15000 }).then(() => true, () => false);
  console.log(JSON.stringify({ topLevelFoldersEachWithASubfolder: TOP, vaultOpenedWithin15s: ok, dirListings: await page.evaluate(() => window.__c.dirIter) }));
  await browser.close();
}

````

### `force.c`

````c
// O(n^2) repulsion kernel, same math as GraphView's step(), on flat float arrays.
#define N_MAX 20000
float X[N_MAX], Y[N_MAX], VX[N_MAX], VY[N_MAX];
__attribute__((export_name("x"))) float* gx(void) { return X; }
__attribute__((export_name("y"))) float* gy(void) { return Y; }
__attribute__((export_name("step"))) void step(int n, float alpha) {
  const float REP = 16000.0f, MIN_D2 = 100.0f;
  for (int a = 0; a < n; a++) {
    float xa = X[a], ya = Y[a], fxs = 0, fys = 0;
    for (int b = 0; b < n; b++) {
      float dx = xa - X[b], dy = ya - Y[b];
      float d2 = dx * dx + dy * dy;
      float m = d2 < MIN_D2 ? MIN_D2 : d2;
      float inv = d2 > 0.0f ? 1.0f / __builtin_sqrtf(d2) : 0.0f;
      float f = REP / m * alpha * inv;
      fxs += dx * f; fys += dy * f;
    }
    VX[a] += fxs; VY[a] += fys;
  }
  for (int a = 0; a < n; a++) { VX[a] *= 0.6f; VY[a] *= 0.6f; X[a] += VX[a]; Y[a] += VY[a]; }
}

````

### `force.mjs`

````js
import fs from 'node:fs';
const rnd = (() => { let s = 99; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; })();
const mk = n => Array.from({ length: n }, (_, i) => ({ id: 'Area/Topic/Note ' + i + '.md', x: (rnd() - .5) * 2000, y: (rnd() - .5) * 2000 }));
const time = (f, reps) => { f(); const t = performance.now(); for (let i = 0; i < reps; i++) f(); return (performance.now() - t) / reps; };
const out = [];
for (const n of [500, 2000, 5000, 10000, 20000]) {
  const pts = mk(n); const reps = n <= 2000 ? 10 : n <= 5000 ? 4 : 2;
  // (a) as shipped: array of nodes + Map<string,{x,y,vx,vy}> looked up per pair
  const nodes = pts.map(p => ({ id: p.id })); const sim = new Map(pts.map(p => [p.id, { x: p.x, y: p.y, vx: 0, vy: 0 }]));
  const a = n > 10000 ? NaN : time(() => {
    for (let i = 0; i < n; i++) { const pa = sim.get(nodes[i].id); for (let j = i + 1; j < n; j++) { const pb = sim.get(nodes[j].id); let dx = pa.x - pb.x, dy = pa.y - pb.y; let d2 = dx * dx + dy * dy; if (d2 < 0.01) { dx = 1; dy = 1; d2 = 2; } const dist = Math.sqrt(d2); const f = (16000 / Math.max(d2, 100)) * 1e-9; const fx = dx / dist * f, fy = dy / dist * f; pa.vx += fx; pa.vy += fy; pb.vx -= fx; pb.vy -= fy; } }
  }, reps);
  // (b) same O(n^2), flat Float32Array
  const X = new Float32Array(pts.map(p => p.x)), Y = new Float32Array(pts.map(p => p.y)), VX = new Float32Array(n), VY = new Float32Array(n);
  const b = time(() => { for (let i = 0; i < n; i++) { const xa = X[i], ya = Y[i]; let fxs = 0, fys = 0; for (let j = i + 1; j < n; j++) { const dx = xa - X[j], dy = ya - Y[j]; const d2 = dx * dx + dy * dy; const f = 16000 / (d2 < 100 ? 100 : d2) * 1e-9 / Math.sqrt(d2 || 1); const fx = dx * f, fy = dy * f; fxs += fx; fys += fy; VX[j] -= fx; VY[j] -= fy; } VX[i] += fxs; VY[i] += fys; } }, reps);
  // (c) Barnes-Hut quadtree (theta 0.9), flat arrays, JS
  const bh = (() => {
    const cap = n * 8 + 64; const child = new Int32Array(cap * 4), cmx = new Float32Array(cap), cmy = new Float32Array(cap), mass = new Float32Array(cap), size = new Float32Array(cap), leaf = new Int32Array(cap); const stack = new Int32Array(4096);
    return () => {
      let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
      for (let i = 0; i < n; i++) { const x = X[i], y = Y[i]; if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; }
      const S = Math.max(maxx - minx, maxy - miny) + 1; let count = 1; child.fill(-1, 0, 4); mass[0] = 0; cmx[0] = 0; cmy[0] = 0; size[0] = S; leaf[0] = -1;
      const ox = new Float32Array(cap), oy = new Float32Array(cap); ox[0] = minx; oy[0] = miny;
      for (let i = 0; i < n; i++) {
        let node = 0, depth = 0;
        for (;;) {
          const m = mass[node]; cmx[node] = (cmx[node] * m + X[i]) / (m + 1); cmy[node] = (cmy[node] * m + Y[i]) / (m + 1); mass[node] = m + 1;
          if (m === 0 && child[node * 4] === -1 && child[node * 4 + 1] === -1 && child[node * 4 + 2] === -1 && child[node * 4 + 3] === -1) { leaf[node] = i; break; }
          if (depth > 40) break;
          const h = size[node] / 2;
          const push = (p) => { const q = (X[p] >= ox[node] + h ? 1 : 0) + (Y[p] >= oy[node] + h ? 2 : 0); let c = child[node * 4 + q]; if (c === -1) { c = count++; child[node * 4 + q] = c; child.fill(-1, c * 4, c * 4 + 4); mass[c] = 0; cmx[c] = 0; cmy[c] = 0; size[c] = h; leaf[c] = -1; ox[c] = ox[node] + (q & 1 ? h : 0); oy[c] = oy[node] + (q & 2 ? h : 0); } return c; };
          if (leaf[node] >= 0) { const old = leaf[node]; leaf[node] = -1; const c = push(old); mass[c] = 1; cmx[c] = X[old]; cmy[c] = Y[old]; leaf[c] = old; }
          node = push(i); depth++;
        }
      }
      const TH2 = 0.81;
      for (let i = 0; i < n; i++) {
        const xa = X[i], ya = Y[i]; let fx = 0, fy = 0, sp = 0; stack[sp++] = 0;
        while (sp) { const nd = stack[--sp]; const dx = xa - cmx[nd], dy = ya - cmy[nd]; const d2 = dx * dx + dy * dy; const s = size[nd];
          if (leaf[nd] >= 0 || s * s < TH2 * d2) { if (leaf[nd] === i) continue; const f = 16000 * mass[nd] / (d2 < 100 ? 100 : d2) * 1e-9 / Math.sqrt(d2 || 1); fx += dx * f; fy += dy * f; }
          else { const c = nd * 4; if (child[c] >= 0) stack[sp++] = child[c]; if (child[c + 1] >= 0) stack[sp++] = child[c + 1]; if (child[c + 2] >= 0) stack[sp++] = child[c + 2]; if (child[c + 3] >= 0) stack[sp++] = child[c + 3]; } }
        VX[i] += fx; VY[i] += fy;
      }
    };
  })();
  const c = time(bh, reps * 3);
  // (d) C -> WASM (SIMD), O(n^2) full matrix
  let d = NaN;
  try { const { instance } = await WebAssembly.instantiate(fs.readFileSync('force.wasm')); const mem = new Float32Array(instance.exports.memory.buffer); mem.set(X, instance.exports.x() / 4); mem.set(Y, instance.exports.y() / 4); d = time(() => instance.exports.step(n, 1e-9), reps); } catch (e) { d = 'ERR ' + e.message; }
  out.push({ n, 'shipped: Map + objects, O(n²) ms/step': +a.toFixed(1), 'typed arrays O(n²) JS': +b.toFixed(2), 'WASM+SIMD O(n²)': typeof d === 'number' ? +d.toFixed(2) : d, 'Barnes–Hut JS typed arrays': +c.toFixed(2) });
}
console.table(out);

````

### `pdfbench/index.html`

````html
<!doctype html><meta charset="utf-8"><body><canvas id="c"></canvas>
<script type="module">
import * as pdfjs from './pdf.min.mjs';
pdfjs.GlobalWorkerOptions.workerSrc = './pdf.worker.min.mjs';
window.mainRender = async (file, W) => {
  const data = new Uint8Array(await (await fetch(file)).arrayBuffer());
  const lt = pdfjs.getDocument({ data }); const doc = await lt.promise; const times = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i); const base = page.getViewport({ scale: 1 }); const vp = page.getViewport({ scale: W / base.width });
    const canvas = document.createElement('canvas'); canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
    const t = performance.now(); await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport: vp }).promise; times.push(performance.now() - t);
    canvas.width = 0; page.cleanup();
  }
  await lt.destroy(); return times;
};
window.workerRender = (file, W, workers = 1) => new Promise(async (resolve, reject) => {
  const data = new Uint8Array(await (await fetch(file)).arrayBuffer());
  const ws = Array.from({ length: workers }, () => new Worker('./raster.worker.mjs', { type: 'module' }));
  const t0 = performance.now(); let done = 0; const all = []; let pages = 0; let got = 0;
  ws.forEach((w, k) => { w.onerror = e => reject(new Error(e.message)); w.onmessage = e => { if (e.data.err) return reject(new Error(e.data.err)); if (e.data.bitmap) { got++; const c = document.getElementById('c'); if (got === 1) { c.width = e.data.bitmap.width; c.height = e.data.bitmap.height; c.getContext('bitmaprenderer').transferFromImageBitmap(e.data.bitmap); } else e.data.bitmap.close(); return; } all.push(...e.data.times); pages += e.data.times.length; if (++done === workers) { ws.forEach(x => x.terminate()); resolve({ times: all, wall: performance.now() - t0, pages, got }); } }; w.postMessage({ data: data.slice(), W, k, workers }); });
});
window.ready = true;
</script>

````

### `pdfbench/raster.worker.mjs`

````js
import * as pdfjs from './pdf.min.mjs';
pdfjs.GlobalWorkerOptions.workerSrc = './pdf.worker.min.mjs';
self.onmessage = async (e) => {
  try {
    const { data, W, k, workers } = e.data;
    const lt = pdfjs.getDocument({ data }); const doc = await lt.promise; const times = [];
    for (let i = 1 + k; i <= doc.numPages; i += workers) {
      const page = await doc.getPage(i); const base = page.getViewport({ scale: 1 }); const vp = page.getViewport({ scale: W / base.width });
      const canvas = new OffscreenCanvas(Math.floor(vp.width), Math.floor(vp.height));
      const t = performance.now(); await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport: vp }).promise; times.push(performance.now() - t);
      const bitmap = canvas.transferToImageBitmap(); self.postMessage({ bitmap }, [bitmap]); page.cleanup();
    }
    await lt.destroy(); self.postMessage({ times });
  } catch (err) { self.postMessage({ err: String(err && err.stack || err) }); }
};

````

### `pdfbench/run.mjs`

````js
import { createRequire } from 'node:module'; import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const require = createRequire(import.meta.url); const { chromium } = require('playwright');
const dir = path.dirname(new URL(import.meta.url).pathname);
const types = { '.html': 'text/html', '.mjs': 'text/javascript', '.pdf': 'application/pdf' };
const srv = http.createServer((q, r) => { const f = path.join(dir, path.basename(q.url.split('?')[0]) || 'index.html'); fs.readFile(f, (e, b) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(b); } }); }).listen(4613);
const browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
page.on('pageerror', e => console.log('PAGEERROR', e.message)); page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 200)); });
const cdp = await page.context().newCDPSession(page); await cdp.send('Performance.enable');
const task = async () => { const { metrics } = await cdp.send('Performance.getMetrics'); return metrics.find(m => m.name === 'TaskDuration').value * 1000; };
await page.goto('http://localhost:4613/index.html'); await page.waitForFunction(() => window.ready);
const st = a => { const s = [...a].sort((x, y) => x - y); return { mean: Math.round(a.reduce((p, c) => p + c, 0) / a.length), p95: Math.round(s[Math.floor(s.length * .95)]), max: Math.round(s[s.length - 1]) }; };
for (const f of ['attention.pdf', 'figs.pdf', 'long.pdf']) for (const W of [1120, 2240]) {
  let t0 = await task(); let w0 = Date.now();
  const m = await page.evaluate(([f, W]) => window.mainRender(f, W), [f, W]);
  const mainWall = Date.now() - w0, mainTask = await task() - t0;
  const row = { f, W, pages: m.length, main: { perPage: st(m), wallMs: mainWall, mainThreadBusyMs: Math.round(mainTask) } };
  for (const k of [1, 4]) {
    t0 = await task(); w0 = Date.now();
    const r = await page.evaluate(([f, W, k]) => window.workerRender(f, W, k).catch(e => ({ err: e.message })), [f, W, k]);
    row['worker×' + k] = r.err ? r : { perPage: st(r.times), wallMs: Math.round(r.wall), mainThreadBusyMs: Math.round(await task() - t0), bitmaps: r.got };
  }
  console.log(JSON.stringify(row));
}
await browser.close(); srv.close();

````

