# Guard-release reference captures (W-00)

Plain Node/Playwright scripts driving the real app. They import no app modules, use no private
React/editor probe, and add no product code. They are **reference recorders, not M0 acceptance**:
`reproduced: true` means the old defect was observed, not that the app passed. A reference result
with a missing witness is not a passing gate. Per-fix semantic mutant builds belong to the later
fix packages; none is claimed proved by this package.

## Run

Read the run's `scratch/HOWTO.md` first. All installs, builds, servers, browsers and static checks
use `scratch/bin/bme-lock`. Use the pinned Playwright dependency and Chrome from
`verify/browser-pin.json`; never the npx cache, bundled Chromium or auto-updating installed Chrome.

1. Export `impl/reference` to an owned scratch source directory (`git archive`), install that
   source's dependencies through the build lock, and build with an owned scratch Vite config.
   It imports that export's Vite config, uses that export as `root`, and puts `cacheDir`/`outDir`
   under scratch. Never mutate `src/`, shared config or the reference branch.
2. Write `$WA_SCRATCH/build.json` containing `commit`, `ref`, `mode` and `indexSha256` (the actual
   built index's SHA-256), then serve that build at an owned loopback port through the serve lock.
3. From this worktree, e.g.:

   ```sh
   L=/Users/adham/Developer/bme-impl/scratch/bin/bme-lock
   REPEAT=1 BASE_URL=http://localhost:6500/ "$L" run -w 2 -- node verify/whiteboard/w-a/WB-D21.mjs
   REPEAT=2 BASE_URL=http://localhost:6500/ "$L" run -w 2 -- node verify/whiteboard/w-a/WB-D21.mjs
   node verify/whiteboard/w-a/manifest.mjs
   ```

Every script accepts `REPEAT` (default `1`), `PHASE` (`before` by default), `BASE_URL`, `WA_SCRATCH`,
`BUILD_META`, `CHROME` and `DPR`. `CORPUS` overrides the retained planning corpus location. Selected
scripts also accept `HOSTS`, `KINDS` or `CONTINUATIONS`. The same scripts run unchanged against the
M0 build with its own `BUILD_META` and `PHASE=after`. Do not relabel an old build as M0.

Results live under `$WA_SCRATCH/reference/<row>/<phase>/<arm>-<repeat>/`. Only the scripts and
`reference-manifest.json` are committed. The manifest hashes every retained artifact, fixture and
script, reports repeat comparison, and records pending arms without turning them into passes.
Failed exploratory attempts are retained separately under `scratch/w-a/debug/first-captures/`.
Stop the server when not about to run; stop all activity in an announced timing window.

## Identity and observations

The driver asserts the served index hash against the declared build and the exact browser version.
It records actual fetched canvas chunks and their SHA-256, **only as build identity**. The separate
library-version assertion reads the library's own `@tldraw/<package>, 5.2.4` registration markers
from actual response text. No object is obtained from those chunks. Backend reporting says exactly
what was observed: legacy DOM/SVG board plus the injected main-window HTML canvas context receipts,
not a guessed GPU/worker identity.

The named OPFS vault is fresh per arm. Fixture writes bypass the app-write counter through a retained
native `createWritable`; app writes go through injected wrappers. Enumeration, picker descendants
and normal file-handle acquisition all preserve paths for those wrappers. Reload uses real Chrome
navigation and native stored handles; a window marker proves that it was not a hash-only navigation.
Before-unload prompts, if a later build raises one, are accepted as the user's Leave action.

| Row | User action and primary witness | False pass excluded / stated boundary |
| --- | --- | --- |
| WB-D1 | Replace A/Same.pdf, then export B/Same.notebook; dialogs, read-back hashes and `.Garbage` bytes | First replacement must ask; a mere completed write cannot stand for replacement. Cross-folder, not cross-vault or injected mid-write failure. |
| WB-D2 | Two strokes on physical page 2 → delete last page → one Undo; painted nodes and actual saved JSON | Dialog must name 2 strokes; both start on page 2. Not exhaustive history interleavings. |
| WB-D3 | Native, truncated and non-JSON input in all three hosts; 20 real pen attempts, unchanged/changed bytes and write receipts | A real canvas or visible refusal surface must exist. Native WB/NB already refuse via the compatibility fence; those are controls. PDF `board.json` is a separate observed unsafe case. |
| WB-D5 | Open app-written 10k fixture, switch to Markdown; hidden/mounted DOM, scheduling stacks and heap samples | Must actually hide a mounted board and start with 10k saved strokes. App/library share chunks: counts are canvas-attributed, not reliable individual app/library attribution. |
| WB-D6 | Unlock all → drag backdrop → Backspace → Undo; saved backdrop/ink positions and actual writes | Initial backdrop must be locked; ink must remain still while paper moves. Keyboard and eraser-specific paths are separate. |
| WB-D8 | Trusted CDP pen + two touches 60→120px, pen up, held touch move, next contact; UI zoom, DOM ids and disk bytes | Fresh no-pen pinch must still zoom; trusted receipts alone do not prove admitted ink. The archived lift→touch-end order, held-touch movement after lift, and move-after-pinch orders are recorded; the next pen contact sends no tool key. No physical palm or trusted pen-cancel claim. |
| WB-D19 | Two painted strokes → immediate close/reload, with and without CmdS; bytes after teardown | One stroke must already be durable and the second actually painted. A synthetic pagehide is never used. Window/pane close, vault switch and folder trash are not claimed. |
| WB-D21 | First-sheet ink → new sheet → second ink → both PDF outputs; genuine reader captures of disjoint ink ROIs | Both nodes and sheets must remain in saved board bytes. The first PDF must visibly contain first ink and second output contain second ink. Other physical-page combinations are not exhaustive. |
| WB-D22 | CmdS at requested 0/4/16ms; capture first completed write's bytes, then later autosave | The actual elapsed time is recorded; no claim of exact hardware sub-frame timing. A clean tab or later autosave cannot stand for the first forced write. |
| WB-D28 | Store nondefault Dark preference before mount; draw semantic black; screen, actual PNG/SVG downloads, both PDF outputs and Theme menu | Black must really be saved as the semantic swatch; printed PDF is a positive dark-ink control. Generic PNG ROI can differ with export padding, so original bytes are retained. |
| WB-D33 | Tab navigation, public status and destructive/nudge keys when the selected backdrop is publicly identified | **Pending B-39** when public status only says Select. No private state, no fabricated selection, no zero-write pass without selection witness. |
| WB-D39 | Create a second sheet on each paper host, in both app themes; before/after backdrop DOM and captures | First sheet must actually show paper; second sheet and ink must be persisted. Newly found during W-00, registered by w-lead for W-13. |

## Fixtures and repeat tolerance

Seed PDFs are original local fixtures made with the installed MIT `pdf-lib`, with fixed metadata dates.
Native envelopes are original constructions from `formats/native-format.md` §3.1. Truncated inputs
and 10k documents are retained, app-written planning corpus files; their source and SHA-256 are in
the results. No owner vault or third-party asset is used or transmitted.

Repeated logical counts and flags compare exactly. Paint counts compare within 5% plus 3 pixels;
zoom percentages allow 10% for the animated in-flight sample and 1% for the settled pinch ratio.
D5 rAF counts allow 30%, timer counts 2 callbacks; heap is reported, not compared as an identical
allocation count. Full screenshots include transient Saved chrome and are **archival captures, not
pixel-exact goldens**; D21/D28 compare their declared content ROIs. The machine is shared, so these
are functional callback observations, never performance sign-off.
