# AGENTS.md

Guidance for AI coding agents working in this repository.

## Maintaining this file

Keep it current — fixing what is outdated, wrong or missing here is part of your change, not extra
credit — and keep it **at or under 150 lines**.

⚠️ **Maintenance here is ZERO-SUM.** The budget is the point: a file nobody finishes reading guides
nothing. So the test is never "is this true and useful" (almost everything is) but:

> **Is this worth removing something else to make room for?**

If no, it does not go here. If yes, name what you cut and cut it in the same change — though while the
file is *under* 150 that room already exists, so spend it freely. Where it goes instead:

1. **Has a detectable trigger** ("when editing a table", "when touching the PDF pipeline") → a **skill**
   (`.agents/skills/<name>/SKILL.md`), loaded only when needed, free otherwise. The default answer.
2. **Broad and unconditional** — every change must respect it, whatever it touches → this file.
3. **Neither** → bloat: delete it, or leave it as a comment beside the code, where a narrow fact stays
   honest longest. A fact with no trigger is not a skill either — never invent one to hold it.

## What this is

A local-first, Obsidian-style Markdown editor that runs **entirely in the browser**, no backend or
database. Optional fonts use Google; the local VaultAgent helper serves AI and terminal. It reads and
writes the user's real files through the **File System Access API**, so it is **Chromium-only by
design** (`showDirectoryPicker`, OPFS, `color-mix` are used freely). Stack: **React 19 + Vite 7 +
TS 6 + CodeMirror 6**, KaTeX, mermaid, tldraw (drawings, notebooks, PDF ink), pdf.js + pdf-lib, idb-keyval, xterm.js.

## Commands

```bash
npm run dev        # regenerate contained EPUB frame, then Vite + React Fast Refresh
npm run build      # regenerate EPUB frame + notices, production build → dist/
npm run typecheck  # tsc for src+shared, then -p helper (the real "did I break types" check)
npm run lint       # eslint .      (flat config, loaded via jiti)
npm run preview    # serve a production build
npm run helper:dev # the VaultAgent helper (Bun) from source, dev origins allowed; helper:build compiles
```

**Checks — CODE-BASED TESTS ARE BANNED (the user's decision; never reintroduce them unasked).** No
unit tests, test suites, `.test`/`.spec` files, test runner or `test` script, in-file test or self-test
functions — all were deleted. The ONLY tests are headless-browser runs driving the real app (load
`verify-in-browser` before claiming anything works); `typecheck` and `lint` are the static gates. **One
exception:** when the user EXPLICITLY asks for a code-based test, write it — only that test, that task.

**Env:** `VITE_TLDRAW_LICENSE_KEY` — production only; a missing key never shows up in `npm run dev`.

## Architecture: what every change must respect

- **The four layers, and what may not cross between them.** `src/context/` is the only code that
  touches the File System Access API. `src/editor/` is CodeMirror land and is **React-free**, reached
  through facets and plain callbacks, never by importing a component or a hook. `src/components/` is
  React; `src/utils/` is pure or DOM-light. An import crossing those lines is the change to rethink.
  `shared/` is pure data and types both the app and `helper/` (a Bun program) import.
- **Nothing the user made is destroyed outright.** A deleted file is *moved* to `.Garbage`, an
  unreferenced asset is *retired* into it and returns if the reference does, an unasked-for overwrite
  is renamed aside — which is why each costs a copy instead of a `removeEntry`. Prefer a wrong call
  that keeps a file over a right one that cannot be undone.
- **State lives in `App.tsx`; the filesystem lives behind `useFileSystem()`.** App owns nearly all state
  and every FS call goes through it; no undo stack stands behind it.
- **The AI agent changes the vault ONLY through the app** — its CLI runs never-ask with full normal tools
  (the user's decision; never restrict them again), but each vault read/write is a `vault_*`/`canvas_*` MCP
  call run in the browser (`utils/agentHost.ts` → App); the prompt bans disk edits. The **terminal** is the
  helper's PTY running the user's login shell: unrestricted (also their decision), invisible to the agent.
- **Every document write is versioned** — `flushTab` writes only via `writeFileVersioned` against the
  document's disk baseline (`utils/docBaselines.ts`, by tab id); a file changed or gone on disk raises the
  DiskBar instead. Observer records are hints, stat + hash the truth. Never write a document around it.
- **Nothing overwrites an existing file by accident.** Every write that could land on a taken name
  goes through `freeEntryName`, which counts **both** files and folders; `moveFile`/`renameFile` and
  the notebook PDF export are the deliberate exceptions. **`createFile` is the hole** — it
  opens-or-*truncates*, guarded at `App.handleCreateFile` and the agent host; anything new inherits it.
- **`.Assets` (images), `.Garbage` (trash) and `.appearance.json` (looks, custom tree order; **new
  keys need the user's OK**) are per FOLDER**, hidden at every depth — a folder carries its own
  pictures, deletions and looks wherever it goes, and a folder opened as a vault of its own still
  has them. `.VaultAgent` stays root-only (`vault-filesystem`).
- **Paths are vault-root-relative with no vault-name prefix**, centralized in `utils/paths.ts`;
  `buildFileTree` and every create/move/rename tab handler must agree or tabs stop deduping.
- **The URL hash mirrors `{vault, file}`** (`utils/appUrl.ts`), NAMING a stored vault. Read ONCE on
  load (a writer then owns it, keeping the link's `file` until consumed), it outranks the stored handle;
  its `file` is opened only BY the session restore, in the vault it names — never by a second opener.
- **Open documents are a flat list (`tabs`) plus a *layout* — a row of panes, each owning its tabs,
  widths on the layout** (`utils/tabPanes.ts`); `activeTabPath` is derived. The save funnel
  `updateTabContent(path, content, {fromDisk?})` is **path-explicit and the only one** — several documents are
  editable at once and canvas panes serialize after their pane has gone. The session is per vault id
  and **versioned** (`utils/tabSessions.ts`); a switch empties the workspace without losing it.
- **A CodeMirror `EditorState` outlives its pane — and `EditorPane`, which the graph view unmounts** (the
  cache is App's) — and so does everything baked into it (`domEventHandlers`, the update listener): all
  it reaches must be **stable for the app's life**, i.e. App-level. A per-pane ref only hides staleness.
- **Loaded representation authorizes content operations**, never extension alone (`documentReading.ts`).
  EPUB is binary/read-only; sentinels never enter text saves/assets/tools (`epub-reader`). Word emphasis
  stays in the original PDF/EPUB view; Text is explicit. Images/tables keep source Markdown (`markdown-tables`).
- **The app draws its own context menu, `confirm()`, `prompt()` and tooltips (`data-tooltip`, drawn by
  `utils/tooltip.ts`; lint bans `title`) — NO native one is left; keep it so.**
- **TWO places turn note text into DOM `innerHTML`, safe for different reasons** — `tableWidget`'s
  `renderCellContent` (attribute-free allowlist; one sink AND one write site, KaTeX splices in built DOM,
  never a string) and `mermaidWidget`'s `renderInto` (mermaid's `securityLevel: 'strict'` DOMPurify pass).
  This origin holds the vault's handle — and, through the terminal, a shell. Do not open a third.
- **Anything that walks the whole vault goes through a `(lastModified, size)`-validated cache**
  (`utils/graph.ts`, `utils/vaultSearch.ts`) and a bounded pool (`utils/pool.ts`), never `Promise.all`
  over the vault. **A CACHE HIT IS NOT FREE** — it costs a `getFile()` round trip PER NOTE — so a save
  never walks: it primes the cache (`primeLinks`) and revalidates nothing (`vault-filesystem`).
- **A MOUNTED-BUT-HIDDEN PANE MUST BE TOLD.** Panes stay mounted, hidden with `visibility`, so anything
  that holds memory or runs work needs an `isVisible` and has to let go — a hidden PDF held 62MB of
  page bitmaps (`pdf-and-drawings`). `isActive` is keyboard focus and is NOT this.
- **Third-party CDNs are not a dependency of drawing a line.** tldraw fetches fonts, icons and
  translations from `cdn.tldraw.com` unless given `assetUrls` (37 requests per board). Serve them here.
- **Nothing the reader is waiting for may queue behind an index** — the first graph build runs `onIdle`,
  and the tree walk is bounded-concurrent across the whole recursion (one `Limiter`, not one per level).
- **The decoration pass runs per keystroke, per arrow key, on every open pane** — memoize on immutable
  identity or measure it; read mode stays a pure function of the document + its folds (`live-preview`).
- **Long-running async work over the vault is serialized, never merely started** — trashing a folder,
  asset reconciles, the recent-vaults read-modify-write and every vault switch each hold an in-flight
  ref or a promise queue: `StrictMode` (on, `main.tsx`) double-runs effects; users click twice mid-copy.
- **The PDF/tldraw module split is bundle-size discipline enforced only by import discipline** —
  there is no manual chunking, so one new import silently pulls pdf-lib (~400kB), pdf.js or tldraw into
  the main bundle; load `pdf-and-drawings` (notebooks and drawings too) before adding one. The chunks
  warm at idle (`components/prefetchPanes.ts`) by the kinds the vault holds: markdown-only fetches none.
- **`readFile` normalizes `\r\n → \n`, and everything downstream depends on it** — CodeMirror does
  the same, so buffers and search offsets stay in step; a reader that skips it drifts on CRLF.
- **The app's user documentation is a file in this repo** — `utils/helpDoc.ts`, one exported string
  opened as a read-mode tab: a user-facing change is not finished until it describes the gestures it
  adds. Its pseudo-path is a **bare name**, so tab-closing code gates its equality branch to files.

## Conventions & gotchas

- **Object URLs are cached by file version, never minted per use** — keyed on path, validated on
  `(lastModified, size)`. Each pane likewise holds **one stable resolver and one stable `imageActions`**
  for life; a fresh closure per call makes every image widget compare unequal on every ⌘E and tab switch.
- **`saveEpoch` is an external store** (`utils/saveEpoch.ts`), not a prop, as are the context-menu,
  entry-style, create-request, file-times and **active-file** stores. `FileExplorer`/`TreeNode` are
  `React.memo`'d: never thread such a value through, nor an inline arrow — one un-`useCallback`'d prop in
  `App.tsx` defeats the memo. Rows subscribe to a BOOLEAN ("am I active?"), so a switch re-renders two.
- **Anything repeated thousands of times carries `content-visibility: auto`** (`.tree-item`,
  `.pdf-viewer-page`) plus a known box — or all of them lay out and paint on every ancestor's frame.
- **The path-keyed records** (`fileScrollAnchors`, `pdf`/`canvasViewPositions`, `collapsedHeadings`) live
  parsed in memory (`utils/storage.ts`) per-vault `scopedKey`; never pruned (capping was **rejected**).
- **Settings → CSS variables** on `document.documentElement`, persisted to `localStorage` — except **Tab
  size** (a CodeMirror compartment), **Recent vaults shown** (a prop), the **Terminal** font/size
  (`utils/terminalSettings.ts`), all clamped on read (`localStorage` is user-editable), and **Vault name
  as tab title**. Theme is `data-theme` on `<html>` (**absent = dark**); custom accent/code colors are
  inline `<html>` overrides that intentionally outrank both theme blocks.
- **ESLint's relaxations are intentional**, each explained in `eslint.config.ts` — do not tighten them.
- **Match the house comment style.** Explain *why*, beside the code, with the measured evidence that
  forced it ("measured: 7 tabs → 0"); a comment restating what the line does is not it.
- **Two things exist twice — change both halves.** "Is this name taken by either kind" is
  `entryNames.nameTaken` *and* `FileSystemContext.entryExists`; ruled paper is `paper.ts` *and* `pdfBuild.ts`.
