# Browser Markdown Editor

A local-first, Obsidian-style editor that runs **entirely in your browser**. Open any folder on your
computer as a *vault* and the app reads and writes those real files through the
[File System Access API](https://developer.mozilla.org/docs/Web/API/File_System_API): there is no
server, no database and no account. Notes stay plain Markdown that any other tool can open.

Besides notes, the same window opens **PDFs** (read, search, rotate and write on them),
**notebooks** (ruled pages you write on by hand, exported as real PDFs), **drawings** (an endless
whiteboard) and **EPUB books** — each drawn by engines built into this repository rather than
borrowed from a third-party canvas or viewer.

**Chromium only, by design.** The app depends on `showDirectoryPicker`, the Origin Private File
System and other APIs only Chromium-based browsers (Chrome, Edge, Brave, Arc, …) ship.

## What it does

**Notes**
- CodeMirror 6 live preview: syntax hides as you type and headings, lists, quotes, code blocks,
  KaTeX maths (`$…$`, `$$…$$`) and mermaid diagrams render in place. ⌘E switches between reading
  and editing.
- Tables and pictures behave as objects. Type straight into a table cell (Tab/Enter walk the
  cells, corner chips add rows and columns) and every edit writes back the narrowest change, so the
  file stays ordinary GFM. A pasted or dropped picture goes into a hidden `.Assets` folder beside
  the note and is resized, removed or inverted from the picture itself.
- Wiki links, backlinks, a graph view, vault-wide search, collapsible headings, code files and
  `.tex` files with highlighting.

**PDFs** — Google's PDFium, compiled to WebAssembly and run in workers. Page thumbnails,
Contents, find across every page, copy of the whole document's text, a reading-text view,
rotation saved into the file, dark pages, and **Annotate**: your ink is written into that same PDF
as vector artwork, with a pristine copy and the editable strokes carried inside it, so a mark can be
moved or erased days later and repeated saves never thicken it.

**Notebooks** (`.notebook`) — lined, grid, dotted or blank paper in Letter, A4 or Legal, a page
added as you reach the bottom, and **Export to PDF** as vector pages anything can print.

**Drawings** (`.drawing`) — an infinite board with pen, highlighter, eraser, laser, sixteen figures,
arrows, lines, text, sticky notes, frames, pictures, link cards and web embeds; selection,
grouping, alignment, locking, several sheets, a minimap, export to PNG, SVG, PDF and JSON, and
a board interface in 49 languages. Older `.tldraw` files convert on open, keeping the original in the
folder's Trash.

**EPUB books** — read-only, in a sandboxed frame: contents, find, scroll or page layout, and
reading appearance, without ever writing to the book.

**Around the documents**
- Split panes: drag a tab onto a page to put up to five documents side by side, each pane with its
  own tabs; the layout, scroll positions and open tabs come back per vault after a reload.
- Outside changes are handled: a file changed by `git pull`, a formatter or a sync service reloads
  live, and a note with unsaved edits gets a Reload / Keep mine bar instead of being overwritten.
  Every save checks the file is still the one you opened.
- Nothing you made is destroyed outright: deleting moves a file to that folder's `.Garbage`
  (the in-app Trash), and a file that would be overwritten is renamed aside instead.
- Light and dark themes, per-file and per-folder icons and colours, custom tree order, and the
  app's own context menus, dialogs and tooltips throughout.
- The full user guide is inside the app: **Help** at the bottom of the sidebar.

## How the canvases are drawn

PDFs, notebooks and drawings share one rendering platform (`src/platform/render/`). Each pane draws
with **WebGL2** when the browser provides it and with **canvas2d** otherwise; both are complete
paths, not a degraded preview. A drop from WebGL2 to canvas2d (no GPU, a lost context, memory
pressure) is per pane and is counted rather than silent, and a pane that is hidden gives back its
GPU memory at once. The fonts, the PDF engine and every other renderer asset are bundled with the
app and integrity-checked at build time: no CDN is needed to draw a line. The only network the
app itself uses is Google Fonts (the editor's code font, and any text font you pick in Settings),
and a link card's or embed's own site when you ask it to load.

## The optional helper: VaultAgent

Everything above works with nothing installed. **VaultAgent** is a small local helper (macOS,
Windows, Linux) that adds two things:

- **The AI agent panel** (⌘⇧X): a chat that runs Claude Code, Codex or OpenCode — whichever you
  already have and are logged into. It sees what you are looking at, and every change it makes to
  the vault goes through the editor, so it lands live and undoes with ⌘Z.
- **The terminal** (⌃\`): your own login shell docked under the editor, starting in the folder of
  the file you are in, with several tabs.

The panel's guide links the installer for your system, and the helper updates itself from this
repository's GitHub Releases.

## Running it

You need Node.js with npm, and a Chromium-based browser.

```bash
npm install
npm run dev        # Vite dev server with React Fast Refresh; open the printed link
npm run build      # production build into dist/
npm run preview    # serve that build
npm run typecheck  # TypeScript for the app, shared/ and the helper
npm run lint       # ESLint
```

`dist/` is a static site: any static host works, as long as it serves the app over HTTPS (or
`localhost`), which the File System Access API requires.

There is no unit-test suite. Behaviour is checked by driving the real app in headless Chromium with
Playwright against a stubbed vault (`verify/`); `typecheck` and `lint` are the static gates.

### The helper (`helper/`)

A Bun program; Bun comes with the dev dependencies.

```bash
npm run helper:dev    # run it from source; allows http://localhost:* origins
npm run helper:build  # compile a standalone binary for this OS into helper/dist
```

Pushing a `vaultagent-v*` tag builds and publishes the installers
(`.github/workflows/vaultagent-release.yml`); an installed helper updates itself from the latest
release when the person clicks **Update** in the panel. To test self-update without publishing,
build against a local fake release with
`bun helper/scripts/build.ts --releases-base http://127.0.0.1:<port>/releases`;
`bun helper/scripts/update-smoke.ts --replace-installed` does that end to end and **replaces the
helper installed for your user** (back it up first).

The macOS PTY host (`helper/ptyhost/vaultagent-pty`) is a committed, pinned binary that CI never
rebuilds: each change to it costs every macOS user one privacy re-grant. Rebuild it only
deliberately, with `helper/ptyhost/build.sh`.

### The PDF engine

`src/pdf/vendor/pdfium/` holds the committed PDFium WebAssembly build. Dev and production load
exactly those bytes, and the build fails if any of them differs from its manifest.
`build/pdfium/README.md` explains how it was built and how to rebuild or replace it.

## Where things are

| Path | What lives there |
|---|---|
| `src/app/` | The app's state, one hook per concern, composed by `App.tsx` |
| `src/components/` | React UI: panes, tab strip, file tree, panels, dialogs |
| `src/context/` | The only code that touches the File System Access API, plus the vault index worker |
| `src/editor/` | CodeMirror extensions for the Markdown editor (React-free) |
| `src/whiteboard/` | The board engine behind drawings, notebooks and PDF ink |
| `src/pdf/` | PDF reading, layout, text, writing and the PDFium engine |
| `src/platform/` | Rendering platform (WebGL2 and canvas2d) and sandboxed frames |
| `src/epub/` | The EPUB reader |
| `src/utils/` | Pure helpers; `helpDoc.ts` is the in-app user guide |
| `shared/` | Types and data shared by the app and the helper |
| `helper/` | VaultAgent |
| `build/` | Vite plugins: asset integrity, generated frames, third-party notices |
| `verify/` | Headless-browser verification toolbox and fixtures |

`AGENTS.md` holds the rules every change must respect, and `.agents/skills/` the deeper notes on
each subsystem.
