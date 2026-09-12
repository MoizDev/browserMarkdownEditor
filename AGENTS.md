# AGENTS.md

Guidance for AI coding agents working in this repository.

## Maintaining this file

Keep it current — fixing what is outdated, wrong or missing here is part of your change, not extra
credit — and keep it **at or under 150 lines**.

⚠️ **Maintenance here is ZERO-SUM.** The budget is the point: a file nobody finishes reading guides
nothing. So the test is never "is this true and useful" (almost everything is) but:

> **Is this worth removing something else to make room for?**

If no, it does not go here. If yes, name what you cut and cut it in the same change — though while the
file is *under* 150 that room already exists, so add freely: spare budget is there to be spent, and a
file that uses it well beats one that leaves it on the table. Where it goes instead:

1. **Has a detectable trigger** ("when editing a table", "when touching the PDF pipeline") → a
   **skill**, loaded only when needed and costing nothing otherwise. This is the default answer.
2. **Broad and unconditional** — every change must respect it, whatever it touches → this file.
3. **Neither** → bloat: delete it, or leave it as a comment beside the code, where a narrow fact stays
   honest longest. A fact with no trigger is not a skill either — never invent one to hold it.

Skills live in `.agents/skills/<name>/SKILL.md`.

## What this is

A local-first, Obsidian-style Markdown editor that runs **entirely in the browser** with no backend,
database, or network. It reads and writes the user's real files through the **File System Access API**,
so it is **Chromium-only by design** (`showDirectoryPicker`, OPFS, `color-mix` are used freely). Stack:
**React 19 + Vite 7 + TypeScript 6 + CodeMirror 6**, plus KaTeX, mermaid, tldraw (whiteboards, ruled
notebooks, PDF annotation), pdf.js + pdf-lib, idb-keyval.

> Converted from JS to TS: comments cite stale `.jsx` line numbers — grep, never navigate by them.
> `src/types/index.ts` holds the domain types, and `declare global`s the File System Access API ones
> (`showDirectoryPicker`, …) stock `lib.dom` lacks.

## Commands

```bash
npm run dev        # Vite dev server (React Fast Refresh)
npm run build      # production build → dist/
npm run typecheck  # tsc --noEmit  (the real "did I break types" check)
npm run lint       # eslint .      (flat config, loaded via jiti)
npm run preview    # serve a production build
```

**There is no test suite and no test runner.** `typecheck` and `lint` are the only static gates;
everything behavioural is verified by Playwright driving the app in headless Chromium — see the
`verify-in-browser` skill, and use it before saying a change works.

**Env:** `VITE_TLDRAW_LICENSE_KEY` — production only; a missing key never shows up in `npm run dev`.

## Architecture: what every change must respect

- **The four layers, and what may not cross between them.** `src/context/` is the only code that
  touches the File System Access API. `src/editor/` is CodeMirror land and is **React-free**, reached
  through facets and plain callbacks, never by importing a component or a hook. `src/components/` is
  React; `src/utils/` is pure or DOM-light. An import crossing those lines is the change to rethink.
- **Nothing the user made is destroyed outright.** A deleted file is *moved* to `.Garbage`, an
  unreferenced asset is *retired* into it and returns if the reference does, an unasked-for overwrite
  is renamed aside — which is why each costs a copy instead of a `removeEntry`. Prefer a wrong call
  that keeps a file over a right one that cannot be undone.
- **State lives in `App.tsx`; the filesystem lives behind `useFileSystem()`.** App owns nearly all state
  and every FS call goes through it. There is no backend and no undo stack behind it: a mistake there
  destroys the user's notes.
- **Nothing overwrites an existing file by accident.** Every write that could land on a taken name
  goes through `freeEntryName`, which counts **both** files and folders; `moveFile`/`renameFile` and
  the notebook PDF export are the deliberate exceptions. **`createFile` is the hole** — it
  opens-or-*truncates*, guarded only at `App.handleCreateFile`; anything new calling it inherits it.
- **`.Assets` (images) and `.Garbage` (trash) are per FOLDER**, hidden, owned by `utils/assets.ts` — a
  folder carries its own pictures and deletions wherever it goes. `.appearance.json` is the third
  app-owned name and the only root-only one (`vault-filesystem`, `entry-styles`).
- **Paths are vault-root-relative with no vault-name prefix**, centralized in `utils/paths.ts`;
  `buildFileTree` and every create/move/rename tab handler must agree or tabs stop deduping.
- **The URL hash mirrors `{vault, file}`** (`utils/appUrl.ts`), NAMING a stored vault: the FS Access
  API takes no path. Read ONCE on load (a writer effect then owns it), it outranks the stored handle;
  its `file` is opened only BY the session restore, in the vault it names — never by a second opener.
- **Open documents are a flat list (`tabs`) plus a separate tab *layout*;** `activeTabPath` is
  derived. The save funnel `updateTabContent(path, content)` is **path-explicit and the only one** —
  several documents are editable at once and canvas panes serialize after their pane has gone. The
  session is per vault id (`utils/tabSessions.ts`); a switch empties the workspace without losing it.
- **A CodeMirror `EditorState` outlives the pane that built it**, and so does everything baked into
  it (`domEventHandlers`, the update listener); anything such a handler reaches must be **stable for
  the app's life**. A per-pane ref does not rescue that, it hides the staleness.
- **Images and tables are deliberate abstractions over the app's own markdown** — the raw text is
  unreachable by design and the file on disk stays ordinary markdown (`markdown-tables` has the how).
- **The app draws its own context menu and its own `confirm()`; prefer them to native dialogs.**
- **TWO places turn note text into DOM `innerHTML`, safe for different reasons** — `tableWidget`'s
  `renderCellContent` (attribute-free allowlist; one sink AND one write site, KaTeX splices in built DOM,
  never a string) and `mermaidWidget`'s `renderInto` (mermaid's `securityLevel: 'strict'` DOMPurify pass).
  This origin holds the vault's handle with permission granted, so a hole is read/write over the whole
  vault. Do not open a third.
- **Anything that walks the whole vault goes through a `(lastModified, size)`-validated cache**
  (`utils/graph.ts`, `utils/vaultSearch.ts`) and holds one file's text at a time. Both run after *every*
  save — an uncached walk is a full vault read per keystroke-triggered autosave.
- **The decoration pass runs per keystroke, per arrow key, on every open pane** — memoize on immutable
  identity or measure it; read mode stays a pure function of the document (`live-preview`).
- **Long-running async work over the vault is serialized, never merely started** — trashing a folder,
  asset reconciles, the recent-vaults read-modify-write and every vault switch each hold an in-flight
  ref or a promise queue: `StrictMode` double-runs effects and users click twice mid-copy.
- **The PDF/tldraw module split is bundle-size discipline enforced only by import discipline** —
  there is no manual chunking in `vite.config.ts`, so one new import silently pulls pdf-lib (~400kB),
  pdf.js or tldraw into the main bundle. Check the `pdf-and-drawings` skill (it covers notebooks and
  drawings too) before adding one; `utils/paper.ts` importing nothing is part of that split. Those
  chunks warm at idle via `components/prefetchPanes.ts`, gated on the kinds the open vault holds —
  a markdown-only vault must keep fetching nothing.
- **`readFile` normalizes `\r\n → \n`, and everything downstream depends on it** — CodeMirror does
  the same, so buffers and search offsets stay in step; a reader that skips it drifts on CRLF.
- **The app's user documentation is a file in this repo** — `utils/helpDoc.ts`, one exported string
  opened as a read-mode tab: a user-facing change is not finished until it describes the gestures it
  adds. Its pseudo-path is a **bare name**, so tab-closing code gates its equality branch to files.

## Conventions & gotchas

- **Object URLs are cached by file version, never minted per use** — keyed on path, validated on
  `(lastModified, size)`. Each pane likewise holds **one stable resolver identity and one stable
  `imageActions`** for life; a fresh closure per call makes every image widget compare unequal on every
  ⌘E and tab switch.
- **`saveEpoch` is an external store** (`utils/saveEpoch.ts`), not a prop, and so are the context-menu,
  entry-style, create-request and **active-file** stores. `FileExplorer`/`TreeNode` are `React.memo`'d so
  the tree stops re-rendering while the user types: never thread a per-save/menu/search/icon/create/
  active value through, and never hand them an inline arrow — one un-`useCallback`'d prop in `App.tsx`
  defeats the memo outright. Rows subscribe to a BOOLEAN ("am I active?"), so a tab switch re-renders
  the two that changed, not all 2,300.
- **Anything repeated thousands of times carries `content-visibility: auto`** (`.tree-item`,
  `.pdf-viewer-page`) plus a known box — or all of them lay out and paint on every ancestor's frame.
- **The two path-keyed position records** (`fileScrollPositions`, `pdfViewPositions`) are held parsed
  in memory via `readRecord`/`flushRecord` in `utils/storage.ts`, keyed by its `scopedKey` — two
  vaults share paths freely. Never pruned (recency capping was **rejected**), so they grow per vault.
- **Settings → CSS variables.** Appearance state persists to `localStorage` and is applied by setting
  CSS variables on `document.documentElement`. Two are not variables: **Tab size** (a CodeMirror
  compartment) and **Recent vaults shown** (a plain prop); both are clamped on read, since
  `localStorage` is user-editable and a `NaN` reaches `' '.repeat()` / `Array.slice`. Theme is
  `data-theme` on `<html>` (**absent = dark**); custom accent/code colors are inline `<html>` style
  overrides that intentionally outrank both theme blocks.
- **`React.StrictMode` is on** (`main.tsx`), so effects run twice in dev — write effects to tolerate
  it, including the async read-modify-write ones.
- **ESLint config carries intentional relaxations** (`eslint.config.ts`): `no-unused-vars` ignores
  PascalCase/UPPER vars, all args and catch bindings; `set-state-in-effect` is off (the app
  deliberately does it); `only-export-components` is off for `src/context/**`. `tsconfig` is `strict`
  but leaves `noUnusedLocals`/`noUnusedParameters` to lint. Don't "fix" these into failures.
- **Match the house comment style.** This codebase explains *why*, beside the code, with the measured
  evidence that forced the decision ("measured: 7 tabs → 0", "~186M comparisons per keystroke"); a
  comment restating what the line does is not it. Narrow, hard-won facts belong there.
- **Three things exist twice, as independent copies — change both halves.** "Is this name taken by
  either kind" is `App.nameTaken` *and* `FileSystemContext.entryExists`; the editable-view test is
  `lists.ts`'s *and* `tableEdit.ts`'s `canWrite`; ruled-paper colours are `paper.ts`'s SVG *and*
  `pdfBuild.ts`'s pdf-lib constants.
