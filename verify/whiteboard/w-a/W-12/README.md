# W-12: pen priority on legacy canvases

These are plain Playwright runs of the real production app, not isolated event-handler tests.
The product module imports nothing, exposes only `installPenPriority()`, and installs the permanent
pointer gate before React renders. Non-passive window touch listeners exist only from an in-legacy
pen-down until both pens and rejected Touch identifiers are gone; an idle Markdown session does not
pay their main-thread scroll-blocking cost. Only today's three roots have `data-legacy-board`;
the new engine must not have it.

## Source and startup seam

Initial source commit: `9024192` (module, three root markers, initial exact startup patch). Lead
review added the dynamic touch-listener lifetime described above. The patch is now
formatted with empty context lines instead of whitespace-only lines; its installed main source is
unchanged. `src/main.tsx` is **not edited in this worktree**. The owner applies `install-main.patch`:
import `installPenPriority` from `./utils/penPriority`, then call it before `installTooltips()` and
before `ReactDOM.createRoot(...).render(...)`.

`build.mjs` copies committed source to a fresh owned scratch directory, overlays the four owned
source files, applies the startup patch with `git apply --check`, installs that copy's own dependencies,
and builds with the normal production Vite configuration. A logic mutant is a checked source patch
on that scratch copy, never a production-minified logic substitution or product flag. The recorded
metadata contains the source commit, overlay hashes, exact install/mutant patches and served index hash.
It refuses to overwrite earlier build evidence. All heavy commands use bme-lock in an hc terminal.

```sh
L=/Users/adham/Developer/bme-impl/scratch/bin/bme-lock
S=/Users/adham/Developer/bme-impl/scratch/w-a/w12
# From this worktree. Give every build an unused W12_BUILD_NAME; variants are candidate /
# no-filter / forget-touches / up-only / eager-canvas / always-touch.
W12_BUILD_NAME=candidate-dynamic "$L" build -- node verify/whiteboard/w-a/W-12/build.mjs candidate
# Serve only while about to run or actually running; stop between runs.
# From $S/candidate-dynamic/source, on an owned port:
"$L" serve -- ./node_modules/.bin/vite preview --config "$S/candidate-dynamic/vite.config.mjs" --port 6500 --strictPort
# From this worktree:
WA_SCRATCH="$S/evidence/candidate-dynamic-r2" BUILD_META="$S/candidate-dynamic/build.json" PHASE=gate \
  "$L" run -w 2 -- node verify/whiteboard/w-a/W-12/pen-priority.mjs
```

Use `BASE_URL` for another port, `DPR`, `HOSTS`, `ORDERS`, `REPEAT` as needed. All runs use pinned
Playwright 1.63.0 and Chrome for Testing 157.0.8103.39, `hasTouch: true`, and reject off-origin requests.
The original reference is W-00's `WB-D8.mjs` on impl/reference ff3d755. Its touch-capable context was
material: merely delivering trusted CDP touches from a desktop context did not reproduce the join.

## Checks, witnesses, mutants and limits

| Check | Witness / identity | Mutant and named guard | False pass prevented | Loss |
| --- | --- | --- | --- | --- |
| Pen + pinch, each host, lift and move-after-pinch orders | Real reference stroke on disk and in DOM; trusted pen/two-touch receipts; actual UI zoom; unchanged fixed-ROI reference PNG; second stroke complete on disk; separate next contact has a separate id | `no-filter`, rejected by `pen-stroke-complete` | A delivered input, clean tab or later save is not saved complete ink: read actual post-action JSON/PDF attachment and require counts + complete flags + a new live id | CDP is not a physical pen display, palm or latency proof (R-18) |
| Rejected contacts moved after pen-up | Same reference pixels and zoom, plus no leaked events to a window-capture listener registered after mount | `forget-touches`, rejected by `held-touch-after-pen-up` | Today's library can ignore a leaked move even though the filter let it through: the later listener detects that leak independently; fresh no-pen input must reach it | A mixed TouchEvent cannot be partially delivered; touches that began before pen-down are outside this guard's stated scope |
| Fresh pinch still zooms | New 60→120px contacts with no pen double actual zoom (1.7–2.3 ratio), and reach the later listener | Both gesture mutants still run this same positive control | Dropping every touch cannot masquerade as pen priority | Browser logical gesture, not hardware calibration |
| Markdown-only / pen outside a legacy pane | Real Markdown DOM, no legacy root, trusted touch events pass after an outside pen-down, unchanged note / zero app writes; actual network contains no canvas chunks or library version markers | `eager-canvas`, rejected by `canvas-loaded` | The module in the entry chunk must not silently pull in the canvas library; the eager-import mutant is an actual production build | This is lazy-loading and outside-pane behaviour, not a constant-time microbenchmark |
| No pen ever down: no blocking app touch listener | Injected native add/remove ledger shows zero non-passive app window touch listeners before any pen; each real canvas arm controls attribution with 0→4→0 app registrations, and records same-window capture order | `always-touch`, rejected by `touch-listeners-when-idle` | An immediate return still leaves Chrome's blocking region. Dropping all registration records would fail the four-listener arming control and this mutant | Playwright adds anonymous non-passive hit-target interceptors of its own; raw records remain, but app attribution requires a served-origin caller stack. This is not an uninjected touch-scroll latency measurement |
| Pen cancel releases the filter | Search actual native text-selection drags at three positions per host with `Input.setInterceptDrags`, and real vertical pen-pan attempts on unchanged host DOM; require `isTrusted && pointerType==='pen' && type==='pointercancel'`, no intervening pen-up, then a fresh pinch | `up-only` counts ONLY if a qualifying route exists | No synthetic PointerEvent is ever called trusted. A later pen-up would hide the missing cancel release | **NOT COVERED** on the pinned headless browser: 9 text-drag + 3 pan routes emitted no qualifying pen cancel. No up-only mutant proof is claimed; w-lead/r-gates/vr-lead must rule on this loss |

Every passing canvas arm asserts a live legacy root and the library's own fetched `@tldraw/*, 5.2.4`
registration markers; served chunk/index hashes identify the actual candidate or mutant build.
The late listener is injected driver instrumentation, not a product hook. The permanent pointer gate
is installed before lazy loading. Same-window capture callbacks run registration order, so the passive
touch observer is added after pen-down arms the dynamic filter. All six arms record **no app/library
window-capture touch listener before the pen**, then four filter registrations, then zero after the
contacts end. If a future library adds earlier window-capture touch handlers this guard must be
re-reviewed; the run fails that condition rather than claiming that capture magically wins.

The no-filter and forget-touches mutant commands use the same script and their own BUILD_META/port:
`EXPECT_FAILURE=pen-stroke-complete` or `EXPECT_FAILURE=held-touch-after-pen-up`. Each arm must actually
report that named failure; identity/harness faults do not qualify. Run without EXPECT_FAILURE to get
the normal nonzero gate exit on either mutant. All six host/order arms were rejected as required.

`markdown-only.mjs` accepts `EXPECT_FAILURE=canvas-loaded` only for the named no-canvas-load assertion,
or `EXPECT_FAILURE=touch-listeners-when-idle` only for the named idle-listener assertion. Wrong
build/browser/version, permission or UI faults cannot be counted. `cancel-route.mjs` and
`cancel-pan.mjs` explicitly print NOT COVERED when no trusted route is found. With an actual trusted
route, `EXPECT_FAILURE=cancel-release` must reject `up-only`; without one it throws NO MUTANT PROOF.

## Results and integration obligations

Artifacts live under `$S/evidence/<variant>/reference/<row>/gate/<arm>-<repeat>/`. Only scripts and
`gate-manifest.json` are committed. Run `node verify/whiteboard/w-a/W-12/manifest.mjs` after capture
for hashes and the honest coverage summary; it is artifact bookkeeping, not an isolated product test.

Dynamic production candidate: six stroke/lifetime arms pass; Markdown-only and no-idle-blocking app
listener checks pass. No-filter and forgotten-touch mutants reject all six arms by their named guards;
eager import rejects `canvas-loaded`, and always-installed touch listeners reject
`touch-listeners-when-idle`. Final build names are `*-dynamic`; final candidate evidence is
`candidate-dynamic-r2` and `candidate-dynamic-lazy-r2`. Native cancel remains NOT COVERED as above.
Earlier static-listener and exploratory results remain in scratch, but are not the revised module's
proof. An initial raw listener-count check found three anonymous Playwright hit-target interceptors;
the corrected ledger retains them and controls app-stack attribution instead of pretending they are
product listeners. The first eager-import build failed at patch-check time and is not counted.

The real main.tsx seam must still be replayed (same six arms + Markdown-only) after its owner wires
it. Build it with `W12_SEAM_REF=<actual-seam-ref> W12_BUILD_NAME=seam-v1` and `build.mjs candidate`:
this archives the resolved commit without owned overlays or applying the startup patch, requires the
real startup call, and records `sourceMode: unmodified-seam-ref` and the filter source hash. Use
`$S/evidence/seam` and `$S/evidence/seam-lazy` for the replay, with its actual metadata; the manifest
requires this source mode/hash. Never call the scratch-patched candidate the integrated seam.

M7 removes this module, its startup import/call and all three `data-legacy-board` attributes with the
old engine. Suggested user-doc sentence for the integrator: “Touches that begin on a canvas while
the pen is down stay ignored until those contacts lift, even if the pen lifts first.”
