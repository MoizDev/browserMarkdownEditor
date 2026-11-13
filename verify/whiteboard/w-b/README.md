# W-01: native drawing registration

These are plain Playwright runs of the real production app, not code-based tests. They never
import application modules into the browser. Use the shared-machine lock for every build,
server and browser, and run slow commands in an `hc run --bg` terminal.

```sh
W=/Users/adham/Developer/bme-impl
L=$W/scratch/bin/bme-lock
S=$W/scratch/w-b/candidate
node verify/whiteboard/w-b/w-01-build.mjs --scratch "$S" # takes the build lock itself
$L serve -- ./node_modules/.bin/vite preview --config "$S/vite.config.mjs" --port 6520 --strictPort
# In another terminal, after the preview is ready:
$L run -w 2 -- node verify/whiteboard/w-b/w-01-drawing.mjs --url http://localhost:6520/ --out "$S/results"
```

Repeat the last command with `--theme light --dpr 2` (all four light/dark × DPR 1/2 combinations
are meaningful). Stop preview after each use. The driver is the worktree's pinned Playwright 1.63.0;
the browser is Chrome for Testing 157.0.8103.39, not bundled Chromium or auto-updating Chrome.
The run opens a named OPFS vault in each of two isolated contexts (weight 2); it does not deserialize
stored handles or require an IDB shim.

## Witness, identity, false pass and loss

- **Witness:** the named native file is clicked in the tree and its unsupported notice is visible;
  the ordinary note's `positivecontrol` content is found before native-only `zebracorn` is searched;
  the legacy file mounts tldraw with four actual rendered shapes, not merely a loading container.
  Twenty keyboard attempts and twenty pointer strokes are followed by the save debounce, a write
  counter and a full native-byte comparison. The tree's *type* icon (not its action icons) is compared
  with the legacy drawing's icon. An isolated context holds only `board.drawing` and `note.md`:
  it observes beyond App's 4-second prefetch deadline and witnesses two real idle callbacks before
  asserting no `DrawingPane` request. The legacy control must fetch that chunk and render shapes.
- **Identity:** the build script records the source commit and source-diff SHA-256 in a scratch-only
  build receipt. After Vite has written its final chunks it hashes the actual entry file. The run
  fetches this receipt and checks the SHA-256 of the main chunk returned in the browser's network
  log. A mismatched server or transformed entry chunk fails. The legacy rendered shapes witness the
  old host/backend; no library/React internals are probed.
- **False pass:** checking only an empty result panel could mean search never ran; the positive
  note-content arm prevents that. Checking the last SVG in a row would compare Trash buttons,
  not type icons; the selector explicitly scopes to `.tree-item-icon`. A zero-write counter alone
  could miss an instrumentation mistake; byte equality is independently checked. The native-only
  network arm has its own context/cache and exact file-list assertion; it neither inherits a warmed
  module from the legacy control nor declares success before idle prefetch could have run.
- **Loss:** this samples one valid native envelope, one corpus drawing, one note and ordinary
  pointer/keyboard input. It does not prove every suffix/case, hostile file, concurrent rename or
  physical stylus. Agent arms remain **pending-V02** until the real-bridge helper stand-in exists;
  no direct tool imports substitute for it. This package adds no reference-internals probe.

## Working mutant

```sh
M=$W/scratch/w-b/mutant
node verify/whiteboard/w-b/w-01-build.mjs --scratch "$M" --mutant
$L serve -- ./node_modules/.bin/vite preview --config "$M/vite.config.mjs" --port 6521 --strictPort
$L run -w 2 -- node verify/whiteboard/w-b/w-01-drawing.mjs --url http://localhost:6521/ --out "$M/results"
```

The build script copies the app and its dependencies into scratch (no shared `node_modules`),
requires one exact source anchor, removes `.drawing` **only** from `isCanvasFile`, then builds the
patched app with the same production config. A stale patch stops before the build. The browser run
must exit nonzero, specifically failing `unsupported-editor` and `search-exclusion`; it collects both
failures rather than aborting on the first. Identity and the positive search/legacy witnesses must
still pass. This mutant proves the central predicate actually protects the open and search paths.

For the prefetch arm, use a separate scratch directory and `--prefetch-mutant` instead of `--mutant`.
That exact-source patch changes only App's legacy-only prefetch predicate back to `isCanvasFile`.
The same production browser run must fail `native-only-prefetch`, while the legacy network/control
and the other safety arms still pass. A changed anchor fails before building. This is also the
bug reproduced on the original W-01 production build before the prefetch correction.

## Fixture origins

- `fixtures/old.tldraw`: byte-for-byte copy of the planning corpus's
  `team/TEXT--prod-dpr1--corpus-whiteboard.tldraw`, app-written text actions; its provenance is listed
  in `planning/10-whiteboard/formats/corpus/INDEX.md` and `manifest.json` (original SHA-256
  `83faaf830494…`; the full hash is recorded in this directory's `fixtures/ORIGIN.md`).
- `board.drawing`: generated by the run from `formats/native-format.md` §3.1, with one sheet whose
  name is `zebracorn`, the compatibility fence and end-record count. No third-party source copied.
- `note.md`: generated by the run, containing only the positive search control.

All output (JSON reports and screenshots) stays in the requested scratch directory.
