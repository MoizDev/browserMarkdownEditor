# W-01: native drawing registration

Plain Playwright runs of the real production app, not code-based tests. No application module is
imported into the browser. Use the shared lock and run slow commands in `hc run --bg` terminals.
Stop preview **between runs**, before writing code; start nothing during a timing window.

## Clean candidate

Commit the candidate first. The independently expected identity names that reviewed checkout:

```sh
W=/Users/adham/Developer/bme-impl
L=$W/scratch/bin/bme-lock
S=$W/scratch/w-b/candidate
C=$(git rev-parse HEAD)
node verify/whiteboard/w-b/w-01-build.mjs --scratch "$S" # holds L build for copy + Vite
$L serve -- ./node_modules/.bin/vite preview --config "$S/vite.config.mjs" --port 6520 --strictPort
# After preview is ready, in another terminal:
$L run -w 2 -- node verify/whiteboard/w-b/w-01-drawing.mjs --url http://localhost:6520/ \
  --expected-commit "$C" --out "$S/results"
# Stop preview immediately after the run.
```

Repeat with `--theme dark/light --dpr 1/2`. The run asserts the **installed** Playwright package is
1.63.0, compares the real executable path with the pinned CfT path, then asserts the launched
browser is 157.0.8103.39. Post-launch failures close all contexts and the browser. Three isolated
contexts (weight 2) use fresh OPFS vaults/cache; no stored-handle reads or IDB shim are needed.

## Witness, identity, false pass and loss

- **Native witness:** clicking the native tree row shows the unsupported notice, with neither
  CodeMirror nor tldraw. Twenty keyboard attempts and twenty pointer strokes are followed by the
  save debounce, a write counter and byte comparison. The counter starts after fixture seeding,
  **before opening the vault/native document**, and raw writes plus expected/observed hashes are
  saved before assertions, even when the mutant fails.
- **Search witness:** the ordinary note's `positivecontrol` content is found before native-only
  `zebracorn` is searched. Search precedes attempted editing, so the mutant cannot destroy the
  marker and accidentally pass search exclusion.
- **Prefetch witness:** native-only (`board.drawing`, `note.md`) and legacy-only (`old.tldraw`)
  contexts open their vaults, **click no document**, then share the same 4.5-second observation
  window and two real idle callbacks each. Exact file lists and no mounted document renderer are
  asserted. Native must request no DrawingPane chunk; legacy must request it **by idle prefetch
  alone**. The separate clicked legacy control must actually render all four fixture shapes.
- **Icons:** the tree's type SVG, not its action SVG, is compared with the legacy drawing's type
  icon. Trash's two drawing icons are independently compared with that legacy tree icon.
- **Identity:** `--expected-commit` is required and must equal the local reviewed git checkout.
  The source-diff SHA is computed from git and must equal `--expected-diff` (empty diff by default).
  `--expected-mutant none/registration/prefetch` chooses an independently known committed patch;
  its on-disk bytes must equal `git show <reviewed-commit>:<patch-file>`, and the SHA is calculated
  locally. The served receipt must match **every** expected commit/diff/mutant/patch/path/mode field.
  Then the actual entry chunk body from the browser network log is hashed and compared with the
  receipt's final-file hash. Each idle context repeats this identity assertion. A stale server with
  its own matching receipt/chunk fails against the independently supplied expected commit.
- **False passes excluded:** empty search is not credited without its positive note-content arm;
  a quiet native network window is not credited without same-wait **no-click** legacy prefetch;
  fast snapshots cannot skip App's 4-second idle deadline; a receipt's self-consistency cannot
  substitute for the expected git/patch identity. A write-counter mistake is checked against bytes.
- **Loss:** one valid native envelope, one corpus drawing and ordinary keyboard/pointer input are
  sampled, not every suffix/case, hostile file, concurrent rename or physical stylus. Idle prefetch
  is observed by requested chunks, not by importing App internals. Agent arms are explicitly
  **NOT COVERED (pending-V02)** until the real-bridge helper stand-in exists; no direct tool imports
  substitute for it. This package adds no old-library/React-internals probe.

## Both working mutants

The builder makes a fresh independent source/dependency copy under scratch (no shared node_modules),
checks and applies the committed unified patch with `git apply`, then builds with the production
configuration. A patch that no longer applies fails before Vite. Patch hashes enter the receipt.

```sh
M=$W/scratch/w-b/registration-mutant
node verify/whiteboard/w-b/w-01-build.mjs --scratch "$M" --mutant
$L serve -- ./node_modules/.bin/vite preview --config "$M/vite.config.mjs" --port 6521 --strictPort
$L run -w 2 -- node verify/whiteboard/w-b/w-01-drawing.mjs --url http://localhost:6521/ \
  --expected-commit "$C" --expected-mutant registration --out "$M/results"
# Expected exit 1. Stop preview.
```

`mutants/registration.patch` removes `.drawing` only from `isCanvasFile`. It must fail
`unsupported-editor`, `search-exclusion` **and** `zero-writes`. `nativeWriteObservation` must record
an actual `board.drawing` write, `changed: true`, and unequal byte hashes. Identity, positive note
search, both idle-prefetch arms, the four-shape legacy control and Trash control must still pass.
The native tree icon also rejects this mutant. A failure caused only by missing focus is not proof.

```sh
M=$W/scratch/w-b/prefetch-mutant
node verify/whiteboard/w-b/w-01-build.mjs --scratch "$M" --prefetch-mutant
$L serve -- ./node_modules/.bin/vite preview --config "$M/vite.config.mjs" --port 6522 --strictPort
$L run -w 2 -- node verify/whiteboard/w-b/w-01-drawing.mjs --url http://localhost:6522/ \
  --expected-commit "$C" --expected-mutant prefetch --out "$M/results"
# Expected exit 1. Stop preview.
```

`mutants/prefetch.patch` changes only App's legacy-only prefetch predicate back to `isCanvasFile`.
It must fail `native-only-prefetch`, while the genuine no-click `legacy-only-idle-prefetch` and all
other safety/control arms still pass. A prefetch-disabled implementation cannot pass the positive
idle control, even though clicking a legacy document would still fetch its renderer.

**Stale-server identity control:** serve a retained older clean build, but run the current driver
from the reviewed checkout with its current `--expected-commit "$C"`. Identity must fail before
behaviour is credited. Do not pass the older server's own commit back as the expected candidate.

## Fixture origins

- `fixtures/old.tldraw`: byte-for-byte copy of planning corpus
  `team/TEXT--prod-dpr1--corpus-whiteboard.tldraw`; full SHA and script provenance in
  `fixtures/ORIGIN.md` (four app-written text shapes). No third-party package source was copied.
- `board.drawing`: generated from `formats/native-format.md` §3.1, with one `zebracorn` sheet,
  the R-W15 plain-language fence label and end-record count.
- Notes are generated positive/control inputs; Trash holds copies of the two drawing fixtures.

Reports and screenshots stay in the requested scratch directory. `CALLERS.md` inventories every
isCanvasFile caller and the native safety reason, including the corrected legacy-only prefetch.
