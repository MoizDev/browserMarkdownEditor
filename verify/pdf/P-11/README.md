# PDF selection gates (P-11)

These are headless-browser runs against the real production app, not code-based tests. They enter a
named OPFS vault through **Open Vault**, click the file tree, and use real mouse/keyboard input. No
app modules, product hooks or synthetic input events are used. All external requests are blocked.

## Run

Read the run's scratch `HOWTO.md`; every install/build/browser/static command uses `bme-lock` and
long commands run in an `hc` terminal. Use this worktree's pinned Playwright 1.63.0 and Chrome for
Testing 157.0.8103.39, never the installed Chrome or bundled Chromium.

```sh
node verify/fixtures/pdf/generators/selection-page.mjs --out <fresh-scratch-fixtures> --seed 1346651697
# Build with the production scratch Vite config, then serve that output on your seat's port.
BUILD_WORKTREE='<built source worktree>' BUILD_DIST='<its production outDir>' \
CHROME='<pinned Chrome executable>' \
  <bme-lock> run -- node verify/pdf/P-11/selection.mjs \
  http://localhost:6480 <scratch-fixtures> <scratch-results> verify all
```

`record` instead of `verify` records the unfixed DPR-2 dark baseline without treating the expected
three failures as a script failure. Each run writes `result.json`, full build/source identity, bound
served-body identities and selection captures. `verify` checks dark/light at DPR 1/2 and exits nonzero
for any failed assertion. The final argument can instead be `R3a`, `R3b` or `R3c` to run that gate.
Unknown modes/gates are refused before browser launch; every requested named gate must execute
exactly once in every required case. A setup error is **not** a killed mutant.

The shared `buildIdentity` helper derives the source commit, clean-tree state, named patch hash and
emitted-file hashes from `BUILD_WORKTREE` and `BUILD_DIST`; there is no caller-supplied commit label.
`bindServedBodies` uses its functional `raw-route` mode: hash `route.fetch()`'s raw response bytes,
then fulfill unchanged. Every same-origin JS/**MJS**/CSS/wasm body must match an emitted file. Pending
body work is drained/fail-closed through `check()` before assertions and before context cleanup.
The main app, PDF viewer, PDF worker client and actual PDF worker module are all required witnesses,
not an optional response list. A normal build must have clean product sources. A mutant build sets
`BUILD_MUTANT=R3a` (or R3b/R3c), must have modified product sources and records that committed patch's
hash. Do not use this intercepting arm as a timing measurement.

## Gate contracts

| Gate | Assertion and witness | Identity | False pass prevented | Stated loss |
|---|---|---|---|---|
| R3a | A left-margin drag copies the oracle's exact title prefix; a drag beginning on text copies the step-zero native string and its pointerdown is not prevented. Selection is empty before each drag and noncollapsed with nonempty text and both endpoints in the visible viewer's text layers afterwards. | Fixture SHA/length, recorded point geometry, browser version and emitted/served raw-body identity. | A distinct clipboard sentinel is seeded and confirmed before each gesture; live selection and copied output must both equal the independent oracle, and Copy must replace the sentinel. | One margin geometry to the left of a title; other gutters/RTL/rotation inferred, not claimed verified. GEN-23 is a follow-up once its generator merges. |
| R3b | Native ⌘A then ⌘C on eager-40 yields exactly the independently authored whitespace-normalized forty-page string (20,919 characters), not the vault name or any tree row. Live selection is noncollapsed and its endpoints are in the visible PDF text layers. The page-number input and its nonempty value are mandatory; it retains its own select-all. | Visible named vault switcher, 40 built text layers, fixture SHA/length and browser/emitted/served identities. | A fresh sentinel is confirmed before Select All; live selection and clipboard must both equal the independent string/length and Copy must replace the sentinel. | Eager pages only; whole-document canonical copy above 300 pages belongs to D7, not P-11. |
| R3c | While a real multiline selection is active, the 14-CSS-pixel left-edge strip has **zero** tinted pixels. Live selection is witnessed before copying and again after the pixel capture, including endpoints in the visible PDF layers. | Page-box aspect/viewport rectangle asserted before deriving strip; DPR, theme, fixture SHA and bound build/served identities. | A distinct pre-drag clipboard sentinel must be replaced. Both live multiline selection and copied text must equal the independent authored two-line slice; an unselected white page cannot pass merely by having zero tinted pixels. | One page and strip; no exhaustive layout/font coverage. |

Classic Original's documented native right-click menu is unchanged: a real right-click still has
`defaultPrevented === false` (p-lead's correction to the initial brief; D-PDF-contextmenu is P5).

## Mutants — real source builds, never a response-time logic patch

Create **one** detached scratch worktree at the fix commit and run its own `npm ci` once through the
build semaphore. For each gate, restore **only this disposable worktree**, then:

```sh
git -C <scratch-mutant-tree> checkout -- .
git -C <scratch-mutant-tree> apply --check <absolute-path>/mutants/R3a.patch
git -C <scratch-mutant-tree> apply <absolute-path>/mutants/R3a.patch
# build from that tree with the production config, using a private outDir/cacheDir
# serve it; run with BUILD_WORKTREE=<scratch-mutant-tree>, BUILD_DIST=<its output>,
# BUILD_MUTANT=R3a; require R3a to execute once and fail in ALL four theme/DPR cases
```

Repeat for R3b and R3c. Require `requestedCasesComplete: true`, `mutantRejected: true`, the named
failure in every required case, and no `executionError` in each report; a nonzero setup exit is not
accepted as rejection. Patch-time refusal is a failed/unproven mutant, never a pass. R3a removes
only the blank-margin pointerdown listener; R3b removes only the capture select-all listener; R3c
removes only `br::selection` transparency. Each must fail its named observable assertion while the
fixed build passes. Remove the disposable worktree and stop its servers after collecting results.

Generated outputs have `NOASSERTION`, proposed `CC0-1.0`, pending the owner's licence act. They are
local run inputs, not approved for redistribution; no generated bytes are committed.
