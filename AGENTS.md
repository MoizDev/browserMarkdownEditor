# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

## What this is

A local-first, Obsidian-style Markdown editor that runs **entirely in the browser** with no backend, database, or network. It reads and writes the user's real files through the **File System Access API**, so it is **Chromium-only by design** (`window.showDirectoryPicker`, OPFS, `color-mix`, etc. are used freely). Stack: **React 19 + Vite 7 + TypeScript 6 + CodeMirror 6**, plus KaTeX (math), mermaid (diagrams), tldraw (whiteboards + PDF annotation), pdf.js + pdf-lib (PDF read/write), idb-keyval (handle persistence).

> The codebase was converted from JS to TS. Many comments cite `.jsx` line numbers (e.g. `FileSystemContext.jsx:51`) that refer to the pre-conversion files — the real files are `.tsx`. `src/types/index.ts` is the single, heavily-annotated source of truth for cross-cutting domain types; read it first.

## Commands

```bash
npm run dev        # Vite dev server (React Fast Refresh)
npm run build      # production build → dist/
npm run typecheck  # tsc --noEmit  (the real "did I break types" check)
npm run lint       # eslint .      (flat config, loaded via jiti)
npm run preview    # serve a production build
```

**There is no test suite / test runner.** Changes are verified by driving the running app headlessly — see the `verify` skill (`.claude/skills/verify/SKILL.md`): it launches `npm run dev -- --port 5199` and drives the GUI with Playwright, stubbing `showDirectoryPicker` with OPFS (the native picker can't open headless). Files open in **Reading mode** by default — press `⌘E` to edit before testing cursor/typing behavior.

**Env:** `VITE_TLDRAW_LICENSE_KEY` — required in production only. Without it, tldraw (drawings + PDF annotate) replaces the canvas with an empty gate 5s after load on any non-localhost HTTPS origin. Localhost counts as development, so a missing key never shows up in `npm run dev`.

## Architecture

### State lives in App.tsx; the FS lives behind useFileSystem()

`App.tsx` is the hub and owns nearly all state. `context/FileSystemContext.tsx` is the *only* thing that touches the File System Access API — everything else goes through the `useFileSystem()` hook (`readFile`/`writeFile`, binary `readFileBytes`/`writeFileBytes`, `createFile`/`createFolder`, `moveFile`/`renameFile`/`moveToTrash`, `importFiles`, `getAssetUrl`/`saveAsset`, `pickDirectory`/`restoreVault`).

Load-bearing FS facts:
- The root directory handle is persisted in **IndexedDB** (`idb-keyval`, key `vault-directory-handle`). On mount, `queryPermission` (no user gesture needed) silently restores a `granted` vault; a `prompt` vault instead surfaces a "Restore Previous Vault" button (`requestPermission` *does* need a gesture).
- **`readFile` normalizes `\r\n → \n`.** This is not cosmetic: CodeMirror normalizes the same way, so tab buffers, saved output, and vault-search match offsets all stay in agreement. The vault-search cache normalizes identically.
- **There is no native move.** `moveFile`/`renameFile`/`moveToTrash` are **copy-then-delete**; folders recurse via `copyDirRecursive`. `moveToTrash` only handles *files* (folders `alert()` and bail).
- Every mutation rebuilds the whole tree from scratch via `refreshTree` (dirs-first, alphabetical). Hidden from the tree: `.Assets` (pasted/dropped images), `.Garbage` (trash), `.DS_Store`.
- The path convention (vault-root-relative, **no** vault-name prefix) is centralized in `utils/paths.ts` `joinVaultPath`. `buildFileTree` and every create/move/rename tab handler must agree on it or tabs stop deduping/highlighting/restoring.

### Multi-tab model + one reused EditorView (the central design)

The app moved from a single `(activeFile + fileContent + editorMode)` trio to a **tab list**: `tabs: OpenTab[]` + `activeTabPath`. `activeFile`/`fileContent`/`editorMode` are now *derived* from the active tab. Each tab's content lives in memory, so switching tabs never re-reads disk or loses unsaved edits; `dirty` drives the tab dot.

- **The whole tab set persists** (`openTabPaths` + `activeTabPath` in localStorage) and is restored once the tree loads. The persist effect is **gated on the restore pass having run** (`hasRestoredTabs`) — ungated, it fires at mount with zero tabs and clobbers the stored list moments before restore reads it, which was the old "only the active file survives a reload" bug. A *missing* `openTabPaths` key falls back to the legacy single `lastFilePath`; a present-but-empty one means "no tabs" and restores nothing. Restored PDF tabs get `content: ''` exactly like `handleFileClick` (their buffer is a tldraw snapshot, never file bytes).

- **Autosave is per-tab**, via a `Map<path, timer>` (`saveTimersRef`, 1s debounce). Switching or closing one tab must never cancel another tab's pending write. The save funnel `updateTabContent(path, content)` is **path-explicit on purpose**: the drawing/PDF canvases serialize on their own debounce that can fire *after* a tab switch, and that JSON must land in the originating file's buffer, not "whatever tab is active now."
- State is mirrored into refs (`tabsRef`, `activeTabPathRef`, `writeFileRef`, `rebuildGraphRef`) so stable callbacks and timers never go stale without re-arming.
- **One CodeMirror `EditorView` is created once** (callback ref guarded on `!viewRef.current`) and reused for every tab. Each tab's full `EditorState` (doc + undo history + selection) is cached in `stateCacheRef` (`Map<path, EditorState>`) and swapped in on tab change — keyed on **path, not content**, so typing never triggers a swap. This is why undo can't reach across files.
- **The editor container is always mounted, even with no file open.** Canvas panes (drawing, PDF) and the empty state are **absolutely-positioned overlays** (`top: var(--header-height)`, `z-index: 5`) *over* the hidden view — never a replacement. Unmounting the container would orphan the single view and it would never re-parent. This overlay-not-unmount rule recurs in `EditorPane`, `.drawing-pane`, `.pdf-pane`, `.editor-empty-overlay`; respect it.
- Theme / read-only / live-preview are swapped live through **Compartments**, reconfigured on theme change, mode toggle, and tab swap.

### Live-preview editor subsystem (`src/editor/`)

This is the most intricate area. `livePreview.ts` hides Markdown syntax and renders inline, Obsidian-style.

- It's a **`StateField<DecorationSet>`, not a ViewPlugin** — a StateField may `replace` ranges spanning line breaks, which block math / images / tables / fenced code all need.
- `buildDecorations` walks the Lezer syntax tree **plus** regex passes. `cursorInRange`/`cursorOnLine` decide when to reveal raw syntax — only in edit mode; **read mode is a pure function of the document** (every selection-dependent branch is gated on `editorMode !== 'read'`), so read-mode rebuilds skip selection-only transactions.
- **Math is located before the Markdown pass** (`findMathRegions`, after `collectCodeRanges`) so Markdown constructs *inside* a formula (`[x](y)`, `_`, `*`) are skipped as LaTeX, and `$` inside code stays literal.
- It **rebuilds when the syntax tree advances**, not only on `docChanged`: Markdown parses asynchronously, so on a large file the tree covers only a prefix at open and the parser advances during idle time via otherwise-empty transactions. Missing this leaves everything past the initial prefix raw.
- `livePreview.ts` **declines HMR** (`import.meta.hot.decline()`): the created-once view caches the decoration logic, so a hot swap wouldn't take — it forces a full reload in dev instead.
- `latexSource.ts` owns math-region detection (Obsidian rules: `$…$` single-line inline, `$$…$$` block, `\$` literal, `$`-in-code literal), a LaTeX source tokenizer for the revealed-source highlighting, and the **app-wide `$` pairing + in-math `{ ( [` auto-pairing** (`mathEditingExtensions`). It's registered **before** `closeBrackets` so LaTeX gets first claim on `$ { ( [`.
- Widgets are `WidgetType` subclasses: `MathWidget` (KaTeX; normalizes `\begin{equation|align|gather}` onto KaTeX-supported forms), `MermaidWidget` (async render but sync DOM → SVG cached by `theme+source`; a `MutationObserver` re-renders on theme flip), `TableWidget`, `ImageWidget` (async `getAssetUrl`), `CopyCodeWidget`, `HorizontalRuleWidget`.
- `cmTheme.ts`: Obsidian dark/light themes + One Dark/One Light code-token palettes. The **caret is driven entirely by CSS variables** set from Settings (line/block, thickness, smooth glide) — the native caret is hidden and `drawSelection()` renders `.cm-cursor`.

### Links, graph, search

- `utils/graph.ts` `buildGraph` reads **every** Markdown file (concurrently) and extracts `[[wikilinks]]` and `[text](note.md)` links (image embeds `![[...]]` excluded). Unresolved targets become faint placeholder nodes. It's rebuilt on every tree change **and after every save** (`rebuildGraphRef` inside `flushTab`). Feeds the Neural Brain graph, the `[[` autocomplete, and the backlinks ("Linked mentions") popover.
- `GraphView.tsx` is a **dependency-free force-directed simulation on `<canvas>`**. All physics state is in refs so the RAF loop never restarts; it cools to rest and then only repaints when `dirtyRef` is set.
- `utils/vaultSearch.ts` is a pure, synchronous VSCode-style matcher (names + contents, capped) fed by an in-memory `VaultTextCache` validated by `(lastModified, size)` so unchanged files are never re-read. Open-tab buffers overlay the disk index (unsaved edits are searchable) via a **ref-backed** `getOpenTabContent` so keystrokes don't re-render the memoized sidebar; `saveEpoch` triggers re-index after saves.

### File-type routing (`utils/fileTypes.ts`)

`.tldraw` → `DrawingPane` (tldraw), `.pdf` → `PdfPane`, everything else textual → CodeMirror. Note the deliberate split between two predicates: **`isTextFile` (vaultSearch)** = shown/indexed as text; **`isDrawingFile`/`isPdfFile` (fileTypes)** = which pane. A drawing *is* text on disk (JSON snapshot) so it flows through `readFile`/`writeFile`/autosave, but it must **not** be shown or content-indexed as text.

### PDF annotation pipeline (the subtlest subsystem)

Files: `pdfAnnotation.ts` (read + rasterize, pdf.js), `pdfBuild.ts` (write, pdf-lib), `pdfBuild.worker.ts` + `pdfBuildClient.ts` (off-main-thread), `pdfFormat.ts` (shared attachment names), `pdfRenderCache.ts` (canvas↔save handoff), `PdfPane.tsx`, `PdfViewer.tsx` (view mode), `PdfAnnotateCanvas.tsx`.

- An **annotated PDF (`<name> (annotated).pdf`) is a genuine PDF**: original pages + stamped transparent stroke overlays + two embedded attachments — `original.pdf` (pristine) and `tldraw-snapshot.json` (editable strokes). It opens in any viewer *and* reopens here as live tldraw shapes.
- **THE LOAD-BEARING RULE: every save rebuilds from the embedded pristine original, never the currently-stamped pages.** Rebuilding from stamped pages re-stamps strokes over themselves — each save darkens/duplicates annotations and inflates the file.
- The annotated tab's `content` buffer is the **tldraw snapshot string** (rides normal autosave). Building the PDF *also* needs the original + rasterized overlays, which only the live canvas can make — it parks them per-path in `pdfRenderCache` (kept **outside React state**; these are megabytes of binary that must never enter a re-render path or localStorage), and `flushTab` picks them up and calls `buildAnnotatedPdfAsync`.
- **Deliberate module fragmentation is for bundle size.** pdf-lib (~400kB) + pdf.js must stay out of the main bundle for markdown-only sessions: `pdfRenderCache`/`pdfFormat` import no PDF libs; the builder is dynamically `import()`ed only at the two write sites; reader (pdf.js) and writer (pdf-lib) never import each other (they share names via `pdfFormat`); the writer runs in a **DOM-less Web Worker**; `PdfPane`/`PdfAnnotateCanvas`/`DrawingPane` are `React.lazy`. Don't collapse these modules together.
- View mode = **`PdfViewer.tsx`, a pdf.js-rendered continuous scroll** (fit-width + zoom pill), *not* the browser's viewer in an iframe: the native viewer is a closed box that can't report its page, and page persistence requires reading it. Selection/copy/⌘F come from pdf.js **`TextLayer`** spans (the `.textLayer` CSS in `index.css` is the library's contract — percent positions + `--scale-factor`/`--total-scale-factor` sizing — so zoom rescales text layers without rebuilding them; they're built for every page up to 300, windowed beyond). Canvas **bitmaps are windowed**: only pages near the viewport hold one (~10MB each); scrolled-away canvases are freed and re-rendered on approach.
- **Position persistence**: the viewer tracks `{page, offset-into-page}` (+ zoom) on scroll and persists it per vault path to localStorage `pdfViewPositions` (debounced); geometry changes (zoom, resize, reload, the byte-swap after an annotated save) re-anchor scroll from that record.
- **One `PdfPane` is mounted per open PDF tab** (EditorPane maps over PDF tabs), hidden via `.pdf-pane-hidden` (visibility) when inactive — never unmounted — so tab switches keep the document and reading position. Panes lazy-activate on first focus (a restored background PDF touches neither disk nor pdf.js until clicked). Only the annotate canvas is torn down when its tab is backgrounded: unmounting tldraw is what flushes pending strokes. The view re-read is driven by **this tab's `dirty` falling edge**, not the old global `saveEpoch` (which reloaded the view — and its scroll position — whenever *any* file autosaved).
- Annotate mode = a tldraw canvas over rasterized pages that are **locked backdrop image shapes, excluded from the exported overlay**. Two modes rather than one because a rasterized page has no selectable text.
- `stampOverlay` handles the `/Rotate` trap: pdf.js *applies* `/Rotate` (canvas is landscape) but pdf-lib *ignores* it (`getSize()` returns the portrait MediaBox), so overlays are mapped back into user space by hand per rotation angle.

### Drawings (`DrawingPane.tsx`, tldraw)

A `.tldraw` file is a tldraw snapshot **plus an extra `ui` block** (current tool + `stylesForNextShape`, which tldraw snapshots omit). Parsed **once per file**, not per render (`content` churns on save round-trips but tldraw owns the doc after mount; re-parsing would clobber in-progress edits). Serialize debounce (400ms drawings / 1500ms PDF annotate) → app's 1s save. `store.listen` is scoped `{source:'user', scope:'document'}` so programmatic loads and camera moves don't dirty the file; unmounting mid-debounce flushes synchronously.

## Conventions & gotchas

- **Settings → CSS variables.** All appearance state (font sizes, editor padding, caret, accent color, plain-code-block ink) persists to `localStorage` and is applied by setting CSS variables on `document.documentElement`. Theme is the `data-theme` attribute on `<html>` (**absent = dark**). Custom accent/code-block colors are inline `<html>` style overrides that intentionally outrank both theme blocks so they survive dark/light switches.
- **File System Access API types** (`showDirectoryPicker`, `queryPermission`, `requestPermission`) are not in stock `lib.dom` — they're augmented via `declare global` at the bottom of `src/types/index.ts`.
- **`React.StrictMode` is on** (`main.tsx`), so effects run twice in dev — write effects to tolerate it.
- **ESLint config carries intentional relaxations** (`eslint.config.ts`): `no-unused-vars` ignores PascalCase/UPPER vars, all args, and catch bindings; `react-hooks/set-state-in-effect` is off (the app deliberately sets state in effects to rebuild the graph / restore the last file); `react-refresh/only-export-components` is off for the context module (it exports the Provider alongside `useFileSystem`). These preserve existing patterns — don't "fix" them into failures.

---

_**Keep this file current:** if, while working in this repository, you notice anything in this document that has gone stale or inaccurate — a changed command, a renamed or removed file, drifted architecture, an invariant that no longer holds — update it as part of your change, even when the task did not explicitly ask you to._
