# AGENTS.md

Guidance for AI coding agents working in this repository.

## Maintaining this file

Keep it current — fixing what is outdated, wrong or missing here is part of your change, not extra
credit — and keep it **at or under 150 lines**.

⚠️ **Maintenance here is ZERO-SUM.** The budget is the point: a file nobody finishes reading guides
nothing. So the test is never "is this true and useful" (almost everything is) but:

> **Is this worth removing something else to make room for?**

If no, it does not go here. If yes, name what you cut and cut it in the same change — though while
the file is *under* 150 that room already exists, so add freely without removing anything: spare
budget is there to be spent, and a file that uses it well beats one that leaves it on the table.
Where it goes instead:

1. **Has a detectable trigger** ("when editing a table", "when touching the PDF pipeline") → a
   **skill**, loaded only when needed and costing nothing otherwise. This is the default answer.
2. **Broad and unconditional** — every change must respect it, whatever it touches → this file.
3. **Neither** → bloat: delete it, or leave it as a comment beside the code, where a narrow fact
   stays honest longest. A fact with no trigger is not a skill either — never invent one to hold it.

Skills live in `.agents/skills/<name>/SKILL.md`.


## What this is

A local-first, Obsidian-style Markdown editor that runs **entirely in the browser** with no backend,
database, or network. It reads and writes the user's real files through the **File System Access
API**, so it is **Chromium-only by design** (`showDirectoryPicker`, OPFS, `color-mix` are used
freely). Stack: **React 19 + Vite 7 + TypeScript 6 + CodeMirror 6**, plus KaTeX, mermaid, tldraw
(whiteboards + PDF annotation), pdf.js + pdf-lib, idb-keyval.

> Converted from JS to TS: many comments cite `.jsx` line numbers from pre-conversion files. The real
> files are `.tsx`, and in `src/types/index.ts` the *numbers* are wrong too, often by hundreds of
> lines — never navigate by them, grep. That file is still the source of truth for domain types.

## Commands

```bash
npm run dev        # Vite dev server (React Fast Refresh)
npm run build      # production build → dist/
npm run typecheck  # tsc --noEmit  (the real "did I break types" check)
npm run lint       # eslint .      (flat config, loaded via jiti)
npm run preview    # serve a production build
```

**There is no test suite and no test runner.** `typecheck` and `lint` are the only static gates;
everything behavioural is verified by driving the app headlessly — see the `verify-in-browser` skill,
and use it before saying a change works.

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
- **State lives in `App.tsx`; the filesystem lives behind `useFileSystem()`.** `App.tsx` is the hub
  and owns nearly all state; every FS call goes through that one hook. There is no backend and no
  undo stack behind it: a mistake there destroys the user's notes.
- **Nothing overwrites an existing file by accident.** Every write that could land on a taken name
  goes through `freeEntryName`, which counts **both** files and folders; `moveFile`/`renameFile` are
  the deliberate exceptions. **`createFile` is the hole** — it opens-or-*truncates*, guarded only at
  `App.handleCreateFile`, so anything new calling it inherits the hole.
- **`.Assets` (pasted images) and `.Garbage` (trash) are per FOLDER, not per vault**, and
  `utils/assets.ts` owns both names — nothing else should spell `'.Assets'`. Neither appears in the
  file tree, so a folder carries its own pictures and deletions wherever it is moved to.
- **Paths are vault-root-relative with no vault-name prefix**, centralized in `utils/paths.ts`;
  `buildFileTree` and every create/move/rename tab handler must agree or tabs stop deduping.
- **Open documents are a flat list (`tabs`) plus a separate tab *layout*;** `activeTabPath` is
  derived. The save funnel `updateTabContent(path, content)` is **path-explicit and the only one** —
  several documents are editable at once and canvas panes serialize after their pane has gone.
- **A CodeMirror `EditorState` outlives the pane that built it**, and so does everything baked into
  it (`domEventHandlers`, the update listener); anything such a handler reaches must be **stable for
  the app's life**. A per-pane ref does not rescue that, it only hides the staleness.
- **Images and tables are deliberate abstractions over the app's own markdown**: the raw text is
  unreachable by design — never revealed by the cursor, and the range is atomic. The file on disk is
  still ordinary markdown; treat "the reader never sees the source" as the requirement.
- **The app draws its own context menu and its own `confirm()`; prefer them to native dialogs** (the
  three surviving `prompt()`/`alert()` calls are being retired one at a time).
- **Exactly one place in the app turns note text into DOM `innerHTML`** — the table cell renderer's
  attribute-free tag allowlist. This origin holds the vault's directory handle with permission
  already granted, so a hole there is read/write over the whole vault. Do not open a second sink.
- **Anything that walks the whole vault goes through a `(lastModified, size)`-validated cache**
  (`utils/graph.ts`, `utils/vaultSearch.ts`) and holds one file's text at a time. Both run after
  *every* save, so an uncached walk is a full vault read per keystroke-triggered autosave.
- **The editor's decoration pass runs per keystroke AND per arrow key, on every open pane**, and a
  split tab has up to five live documents. Anything added there must be memoized on immutable
  identity (`Text`/tree, in a `WeakMap`), reuse a shared `Decoration`, or be measured; a per-node
  linear scan once cost ~138ms/keystroke. Read mode is a **pure function of the document**.
- **Long-running async work over the vault is serialized, never merely started** — trashing a folder,
  asset reconciles, the recent-vaults read-modify-write, the folder picker and every vault switch
  (one gate for all three raisers, and it walks the new vault before committing anything) each hold
  an in-flight ref or a promise queue, because `StrictMode` double-runs effects and users click twice
  mid-copy.
- **The PDF/tldraw module split is bundle-size discipline enforced only by import discipline** —
  there is no manual chunking in `vite.config.ts`, so one new import silently pulls pdf-lib (~400kB),
  pdf.js or tldraw into the main bundle. Check the `pdf-and-drawings` skill before adding one.
- **`readFile` normalizes `\r\n → \n`, and everything downstream depends on that agreement.**
  CodeMirror normalizes the same way, so tab buffers, saved output and vault-search match offsets
  stay in step. A new reader of file text that doesn't normalize drifts silently on a CRLF file.
- **The app's user documentation is a file in this repo** — `utils/helpDoc.ts`, one exported string
  opened as a real read-mode tab, and the only thing telling a user a gesture exists: a user-facing
  change is not finished until it describes them. Its pseudo-path is a **bare name**, not a vault
  path — which is why tab-closing code gates its equality branch to real files.

## Conventions & gotchas

- **Object URLs are cached by file version, never minted per use** — keyed on path, validated on
  `(lastModified, size)`. Each pane likewise holds **one stable resolver identity and one stable
  `imageActions`** for life; a fresh closure per call makes every image widget compare unequal on
  every ⌘E and tab switch.
- **`saveEpoch` is an external store** (`utils/saveEpoch.ts`), not a prop, and so is the context-menu
  store. `FileExplorer` and `TreeNode` are `React.memo`'d specifically so the tree stops re-rendering
  while the user types — do not thread a per-save or per-menu value through them.
- **The two path-keyed position records** (`fileScrollPositions`, `pdfViewPositions`) are held parsed
  in memory via `readRecord`/`flushRecord` in `utils/storage.ts`. They are never pruned; capping by
  recency was considered and **rejected**, as it discards the position of a file returned to later.
- **Settings → CSS variables.** Appearance state persists to `localStorage` and is applied by setting
  CSS variables on `document.documentElement`. Two settings are not variables: **Tab size** (a
  CodeMirror compartment) and **Recent vaults shown** (a plain prop). Both are clamped on read —
  `localStorage` is user-editable and a `NaN` reaches `' '.repeat()` / `Array.slice`. Theme is
  `data-theme` on `<html>` (**absent = dark**); custom accent/code colors are inline `<html>` style
  overrides that intentionally outrank both theme blocks.
- **File System Access API types** (`showDirectoryPicker`, `queryPermission`, `requestPermission`)
  are not in stock `lib.dom` — they are augmented via `declare global` in `src/types/index.ts`.
- **`React.StrictMode` is on** (`main.tsx`), so effects run twice in dev — write effects to tolerate
  it, including the async read-modify-write ones.
- **ESLint config carries intentional relaxations** (`eslint.config.ts`): `no-unused-vars` ignores
  PascalCase/UPPER vars, all args and catch bindings; `react-hooks/set-state-in-effect` is off (the
  app deliberately sets state in effects); `react-refresh/only-export-components` is off for
  `src/context/**` only. `tsconfig` is `strict` but leaves `noUnusedLocals`/`noUnusedParameters` off
  — lint, not tsc, is the gate there. Don't "fix" these into failures.
- **Match the house comment style.** This codebase explains *why*, beside the code, with the measured
  evidence that forced the decision ("measured: 7 tabs → 0", "~186M comparisons per keystroke"); a
  comment restating what the line does is not the standard. Narrow, hard-won facts belong there.
- **Two predicates exist twice, as independent copies — change both.** "Is this name taken by either
  kind" is `App.nameTaken` *and* `FileSystemContext.entryExists`; the editable-view test is
  `lists.ts`'s *and* `tableEdit.ts`'s `canWrite`.
