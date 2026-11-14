# C-13 — real-app fence bounds, copy and diagram gate

`reproduce.mjs <url> <output>` ports the four original E01 cases, but uses the pinned Chrome for
Testing157.0.8103.39, Playwright1.63.0, the real permitted clipboard, real tree navigation, and a
rendered EOF heading instead of imported view/grammar probes. It failed on the unfixed production
build (`abeb639`) with exactly the tilde Reading/Copy/diagram defects; both backtick controls passed.
No application module is imported or called by either driver.

## Production primary gate

`fixtures.mjs` names one note for each case: both delimiter types at lengths3/4/5, longer/shorter
closers, mismatched markers, trailing garbage, unclosed/empty/opener-only bodies, preserved blank
rows, three-space indentation, space/tab list indentation, blockquotes, mixed-case Mermaid, empty
Mermaid and malformed/unclosed Mermaid. Source prefixes inside container bodies are intentionally
preserved in Copy: this fixes fence-row bounds, not code normalization.

```sh
W=/Users/adham/Developer/bme-impl
L=$W/scratch/bin/bme-lock
# In wt/c-d; all builds/installs/static/serve/run commands need the HOWTO lock.
$L run -- node verify/core/C-13/fences.mjs --url=http://localhost:6340/ --identity=$W/scratch/c-d/C-13/head.identity.json --out=$W/scratch/c-d/C-13/head-table
$L run -- node verify/core/C-13/fences.mjs --url=http://localhost:6341/ --identity=$W/scratch/c-d/C-13/candidate.identity.json --out=$W/scratch/c-d/C-13/candidate-table --reference=$W/scratch/c-d/C-13/head-table
```

Run each slow command in an hc terminal. Start the matching `vite preview` immediately before the
browser through `bme-lock serve`, with `--strictPort`, and stop it immediately afterward. Scratch
config `W/scratch/c-d/C-13/vite.config.mjs` roots at the lane, has a private cache and chooses outDir
from `BME_OUT`. Build directly with Vite, never npm run build/dev. The baseline outDir is retained
unchanged after the fix. Each build writes a sidecar identity with the existing
`verify/core/C-15d/write-identity.mjs`; every fetched script body is hash-matched through actual
browser responses. The recorded commit remains an immutable git object even after the lane moves.

Witness and false-pass controls:

- Every fixture opens from its real tree row in a fresh named OPFS vault. Read-only is asserted;
  the rendered EOF heading or visible code-end/actual widget after the EOF search witnesses the
  final render boundary. Opening/closing rows, real Copy results and actual SVG node labels A/B
  are asserted separately. A broken Mermaid import cannot stand in for a source-only outcome.
- The native clipboard gets a fresh per-case marker **before** the app's Copy button is clicked.
  Its completed-feedback class witnesses writeText fulfilment; only then is the actual clipboard
  read. No clipboard recorder/mock replaces the native API.
- Edit/Find puts a real caret inside the source; both real marker rows must reveal. Moving it to
  the outside heading restores the hidden rows/diagram. Source hashes and an init-script writable
  observer prove this display/copy/caret-only flow never changes any vault byte or starts a write.
- Valid top-level backtick3/4/5, longer-close and Mermaid controls must have byte-identical DPR1 PNG
  screenshots versus the unfixed build. The crop includes the block/container gutter, not the
  asynchronously debounced footer. JS keyword paint, fonts and CM's SVG measure/settle are allowed
  their actual paint turns before capture; no fixed completion sleep is used.
- Malformed/container notes are semantic expectations, not pixel-identity controls: the parser fix
  intentionally corrects existing backtick behaviour too. The candidate report's `changes` lists
  every changed row, exact changed fields and before/after screenshot paths for c-lead's review.
- Setup/identity problems exit2 (INVALID). User-visible assertion failures exit1 with named
  render/fence/copy/reveal/away/pixels/bytes reasons; a clean primary run exits0.

## Initially-partial parse companion (benchmark only)

c-lead approved this separately; run **after C-15c reaches impl/core**, never by adding probes to a
production build. The primary production run remains required. The companion seeds a large run of
paragraphs before a final short tilde fence, reads C9 `__perf.editor.parse`, records it again on the
first **trusted wheel event**, then jumps the real viewport and requires full/idle coverage plus
correct final rendering/copy/caret behaviour. If the tree is already complete at the jump, that is
an INVALID unmet fixture precondition, never a pass. Weight2 conservatively covers this large note.

```sh
$L run -w 2 -- node verify/core/C-13/fences.mjs --companion=true --url=http://localhost:6342/ --identity=<benchmark-outDir>.identity.json --out=$W/scratch/c-d/C-13/partial-companion
```

It observes coverage, not performance budgets or timing sign-off. No private app/CodeMirror state
entry point is used; the declared C9 getter is the only internal read-out.

## Mutants

Apply each committed patch to its own scratch source copy of the candidate commit, using
`git apply --check` then `git apply`. Each copy owns its own install and private cache/config.
Build in production mode, writing an identity with `--patch=<patch> --commit=<base-commit>`.
Run **the same production primary invocation**, changing only URL/identity/output/patch arguments,
against each preview. A stale patch or missing identity is invalid, not a kill.

- `old-closed.patch` restores the old three-backtick guess. Tilde/malformed rows must fail with
  fence/copy/render reasons; otherwise the gate never proved closure came from parsed markers.
- `copy-closing-row.patch` captures through the closing row's line end. Copy body-byte assertions
  must fail; otherwise the gate can silently copy a delimiter.

No new renderer or HTML sink is introduced; Mermaid's existing strict renderer/lifecycle is untouched.
No timing-budget, reload/session-persistence or extra Markdown-normalization claim is made here.
