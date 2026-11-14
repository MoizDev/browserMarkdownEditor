# Whiteboard reference harness (W-B2 / B-39)

This is an outside-the-app recorder for **`impl/reference` only**. It drives the real production app
with ordinary UI/input and OPFS fixtures. It is not an engine page, diagnostics route or test suite.
No function in it is shipped by the app. No probe calls an editor setter.

**Current implementation scope (charter §0):** pinned runtime, plain package-marker/object-shape
assertions before private reads, and the reference-only import split. Field-control tables, source/
served mutants and artifact-identity diagnostics already written below are retained for the deferred
review phase; none is a prerequisite for using or merging this reader.

```js
import {launch} from './index.mjs'
const h = await launch({baseURL:'http://localhost:6520/'}) // serve impl/reference's build
try {
  await h.vault.seed({'Seed.md':'# Reference'})
  await h.vault.open()
  await h.ui.createDrawing('Example.tldraw')
  console.log(await h.probe.session('Example.tldraw')) // checked tool/selection and other reads
} finally { await h.close() }
```

The implementation sanity command is `L run -w 2 -- node verify/whiteboard/w-b/b39-sanity.mjs`.
It reads tool/selection through actual input on all three hosts and saves light/dark captures.
The stricter recipes below are deferred proof tooling, not the implementation merge bar.

## Import boundary

`index.mjs` imports `today/probe.mjs`, its network-version guard and its field controls: it is a
**reference entry point**. No run that drives the new engine may import it or any `today/` module,
even transitively. `saved.mjs` is the legacy-file reference adapter (uses the installed public legacy
point decoder), not a native-format reader.

Outside-app primitives (`runtime`, `input`, `vault`, `transfer`, `pixels`, `pdf`, `agent`, `lifecycle`,
`control`, `mutant-build`) are separately importable without the probe. The `path` branch of
`input.settleModifiers` and the reference-canvas branch of `vault.waitForSave` require a reference
handle; new-engine runs must use public output/checkpoint predicates instead of inventing a getter.

One-line import-edge check (then inspect each importing module's entire transitive closure):

```sh
rg -n 'today/|harness/index\.mjs|from ["\x27].*/index\.mjs|harness/saved\.mjs' verify --glob '*.mjs'
```

Every hit must belong to a declared reference run or the harness itself. **This grep alone is not
closure proof**: r-gates follows each import in a proposed new-engine entry point recursively,
including re-exports, to ensure no reference module/legacy decoder is reached. A violation blocks it.

## Pins, storage and resource rules

- Installed Playwright **1.63.0** is asserted from this worktree's package, never npx.
- Browser: exact CfT **157.0.8103.39**, launched by the physical path under
  `/Users/adham/Developer/bme-impl/scratch/browsers/`. No `channel` fallback. Actual path/version enter
  identity; post-launch failures close the owned context/browser. The planning CDP/installed-browser
  transport is explicitly NOT RUN here: matching a remote version cannot prove its executable path.
  Physical-device and pinned-picture-image transport need their separately verified harness.
- Named OPFS vault, permissions granted on every descendant; seed only after navigation. The pinned
  browser survives native handle restore. Native IDB is default; the old dev shim is opt-in and its
  loss is explicit. `theme:null` avoids setup reseeding when observing storage destruction.
- All installs/builds/static checks/servers/browsers use `bme-lock`. **Never nest memory grants**:
  build first, then run against that artifact. Stop preview between runs and for every timing window.
  w-b ports are 6520–6539; other seats use their own charter ranges. Scratch is outside the repo.

## Prepare, serve, run (no server is silently started by a helper)

From a clean, committed harness checkout with its own `npm ci`:

```sh
W=/Users/adham/Developer/bme-impl; L=$W/scratch/bin/bme-lock
H=$(git rev-parse HEAD); R=$(git rev-parse impl/reference)
node verify/whiteboard/w-b/b39-build.mjs --reference-commit "$R" --scratch "$W/scratch/w-b/b39/reference"
# Read reference/latest.json: CONFIG and RECEIPT are its config and receipt paths.
# Start via hc run --bg in a separate terminal:
$L serve -- ./node_modules/.bin/vite preview --config "$CONFIG" --port 6520 --strictPort
$L run -w 2 -- node verify/whiteboard/w-b/b39-run.mjs --url http://localhost:6520/ \
  --receipt "$RECEIPT" --reference-commit "$R" --harness-commit "$H" \
  --mode clean --out "$W/scratch/w-b/b39/clean"
# Stop preview immediately after the run.
```

The builder archives the exact reference git object into a fresh scratch source tree; it copies
independent dependency files (preserving relative symlinks), never shares node_modules or copies
.git. Archive/copy/patch/build all hold one build grant. It emits the hashes of **all emitted JS,
including worker assets**, source/harness commits and exact source-patch hash. The run independently
requires the expected commits, a clean reviewed harness, expected variant and the committed patch.
It compares the server receipt to the local artifact and hashes actual script response bodies.
A stale matching server does not stand in for the independently expected build.

## Guard (c): every private read

Before every atomic projection, `today/version.mjs` validates the library's own registration tuples
in the **text of chunks fetched by the browser**: `@tldraw/utils`, `state`, `state-react`, `store`,
`validate`, `tlschema`, `editor`, all **5.2.4**. Package markers are not filenames, hashes, globals or
operator declarations. Immutable response parsing is cached; the assertion still runs every read.

The page-side reader accepts that network evidence before traversing the mounted provider. It
requires an exact vault-relative path, matches the nearest owning file prop, verifies the provider's
container is that same DOM root and checks the required Editor/Store methods. Each record, nested
props/meta, camera/box/matrix, instance/input/user object, selection and page list is shape-checked
before projection. A loading container or an absent path is `PROBE_NOT_MOUNTED` (bounded wait).
A mounted canvas with a missing/wrong member is **`PROBE_OBJECT_ASSERT <member>`**, immediately fatal.
An assertion is never caught as an empty selection, empty document or null editor.

Known schema-optional data (e.g. absent text on a stroke) can be null/absent; that is not an API miss.
Unmapped/unsupported fields are explicit in `FIELD_MAP.md`. In particular the old planning adapter's
`inputs.isHovering` and invented edge-scroll/paste defaults are not returned as fake false/1 values.
`pending()` and private `export()` are explicitly unavailable: use actual writes/UI downloads.

## Deferred guard (d): per-field, same-run controls

`h.referenceControls.runUI(path)` uses actual toolbar clicks, ink, selection/Escape, public Undo/Redo,
zoom/pan, viewport resize and the legacy Edit → Toggle locked action on a locked page. Each qualifying field records before/
after plus its independent public witness. Undo is a bounded public sequence: selection itself can
occupy a history entry. The token confirms the same exact editor object answered throughout.

`persistedPair({first,second})` opens two app-written corpus fixtures **A, B, A in one run**, comparing
known persisted scalar projections with independent file bytes. A change in count/id cannot qualify
a constant leaf: the set of actual values must differ. Noncontrasting leaves stay **UNCONTROLLED**.

Before counting a row, call:

```js
h.referenceControls.require(['session.selection'], {kind:'notebook', phase:'after-action'})
// A persisted-only field can use phase:'persisted-only'; never substitute it after an edit.
```

No token is inherited across runs or host kinds. A field with no qualifying control throws
`PROBE_CONTROL_ASSERT <field>: UNCONTROLLED`; its row must not count. The token is **only control
coverage**, not permission to compare a raw unmapped quantity. r-gates reads `FIELD_MAP.md` row by
row and the actual journal, including the mapping precision/aliasing limits.

## Deferred proof tooling: three named-guard mutants

- **(c), `--mode object`:** marker-kind substitution renames `getCurrentPageShapes` consistently in
  **every** script containing it. Expected per-file counts come from the local compiled artifact;
  the served bodies are independently hash/count-checked before installing routes. Every target's
  before/after hash, exact count and actual serve count is retained. Only
  **`PROBE_OBJECT_ASSERT editor.getCurrentPageShapes: expected a function`** counts as rejection.
- **Version, `--mode version`:** replace only the library registration version constants, consistently
  including the root package. Only a **`PROBE_VERSION_ASSERT` observing 0.0.0 instead of 5.2.4** counts.
- **(d), `--mode tool`:** build with `--tool-mutant` into separate scratch. The committed app-source
  patch adds a Toolbar override beside today's style-panel override, with Select always selected and
  Draw never selected. The actual tool still changes by real input. Only the **draw toolbar-state
  mismatch of `PROBE_CONTROL_ASSERT session.currentTool`** counts, not a missing control or loader
  error. Its partial before/after model/pressed-state observations survive the failure.

Object/version use the clean build and same command with the appropriate `--mode`. Tool uses the
separately built receipt/config and `--mode tool`. **A mutant rejected by build identity, another
assertion, a timeout or an app error is unproven**, never reported as a successful guard self-check.
Missing/stale patches and count mismatches stop at preparation. The public prefetch/renderer is
still the app's; the harness never mounts an editor itself.

## Witness, false pass and loss

The clean run must mount all three real canvas hosts, pass each claimed field control and return
matching path/object/version/build identities. Both A/B order reversals must pass. Mutants need the
named guard **and** proof changed chunks/patches reached the app. A pinned read cannot be credited
because an input receipt exists; value change and its public consequence are both required.

**Loss:** these are selected fixtures/actions, not exhaustive state interleavings or a physical pen.
OPFS is not native-disk FSEvents/permissions. Browser receipts do not prove internal input admission.
Pixels need the pinned picture image for goldens; these functional captures are not image-parity
sign-off. Saved/live normalization shares legacy format helpers, so it does not independently prove
the ink codec/outline. A controlled-but-unmapped field remains **not compared**. For every probe-only
row: **the two arms compare different observation surfaces; a wrong mapping could pass while behaviour
differs. Unmapped fields are not compared.**

Historical planning smoke/growth/collection campaigns and their old npx/chunk-hash assumptions are
not copied as runnable acceptance scripts. Their reusable primitives are here; this package's runs
are in `verify/whiteboard/w-b/`. Corpus fixture origin/hashes are in `fixtures/ORIGIN.md`.
