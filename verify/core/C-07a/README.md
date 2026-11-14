# Agent regex isolation (D09 / C-07a)

`regex-responsive.mjs` is a headless-browser run against the **real app**. Its one local
`helperStandIn` answers helper discovery and the actual agent WebSocket, starts a run only after a
user sends a message, and sends recorded `vault_search` calls. It never imports an app module into
the page or calls an executor directly. It makes no outside requests. Fixtures are fresh named
OPFS files; no user's vault is opened.

Use Playwright 1.63.0 and Chrome for Testing 157.0.8103.39 from the integrator's HOWTO. Every browser,
server, build and install goes through `bme-lock`; start the server immediately before the run and
stop it even if the run fails. `BME_ORIGIN` defaults to `http://localhost:6320`; `BME_OUTPUT` controls
its JSON/screenshots. `BME_CASE` is `all` (default), `responsive`, `deadline`, `stop`, `controls`,
`output-cap` or `long-query`. Run the last two separately: their large fixture/header would obscure
which hostile line the normal responsiveness fixture reaches.
The lane's scratch wrapper acquires the browser grant before starting its separate serve grant,
then stops that server in an EXIT trap; it is not an app dependency.

## The five parts

- **Witness:** warm the real text cache with `neverthere`; a near-miss `(a+)+$` matches an early file
  before a hostile line of 26 a's and `!`. A pre-existing RAF heartbeat records the actual gap while
  typing lands in the other visible note. The deadline arm writes 34 a's and `!` through independent
  native OPFS handles, preserving the early acknowledged match. The Stop arm confirms that hostile
  file was posted before pressing the actual Stop button. The helper deliberately waits for the
  cancelled tool's answer before sending `run.done`, so silent reply suppression cannot pass.
- **Identity:** assert the browser version against `verify/browser-pin.json`, observe the genuine
  matcher worker's CDP attach/detach, record its URL, and audit the main realm's query `RegExp.exec`
  count. A fake timeout on the same synchronous main-thread code fails both typing/RAF and that
  audit. Worker `postMessage`/`terminate` observations are script-side only. The deadline's Chrome
  trace maps the CDP worker id to its real worker thread and requires that thread's long task to
  end within the bounded shutdown grace; actual CDP detachment is a separate leak check.
- **Mutants:** patches under `mutants/` apply to a scratch copy and build with the production Vite
  configuration: restore the original main-thread search; omit matcher retirement; drop acknowledged
  output. The first must fail responsiveness/typing, the second actual CDP detach, the third retained
  early output. The missing-termination mutant must fail the trace's completed-worker-task bound,
  not merely the terminate counter. A patch that no longer applies is a patch failure, never a
  skipped arm. No mutant
  source enters `src/` in the lane. The original-search mutant also supplies the controls' original
  answers (backreference/lookaround, empty/filename matches, Unicode/CRLF, huge line, caps and syntax).
  `original-controls.json` is the raw result of that real-browser original-search run, not hand-written
  expectations; the candidate compares every result byte. A fourth `clip-incomplete` mutant moves
  timeout status behind the rows: the separately seeded >60k-output gate must reject it.
- **Output status:** 295 acknowledged matches reproduce clipping a trailing timeout status at the
  normal 60k output cap. Incomplete status must lead both rows **and the unbounded query summary**;
  a separate valid 68,006-character pattern checks the latter. Its short retry identity is computed
  once in the worker, never by serialising or hashing that pattern per file on the UI thread.
- **False passes excluded:** heartbeat begins before the call; its pre-query gaps are recorded
  separately. Fixtures are near misses, not empty/matching hostile lines. Partial output is asserted
  by exact path/line/text; an empty timeout is not accepted as No matches. A following literal query
  proves the cache remains usable. Stop is issued with the malicious file genuinely in flight.
- **Loss:** this is an observed browser interleaving, not a proof over every reply/cancel/crash order.
  RAF gaps include browser/OS scheduling noise; the raw pre-query distribution makes it visible.
  The 34-a exponential tail is killed, not allowed to run indefinitely; the missing-termination
  mutant observes its real target for three budgets before rejection. **Measured browser loss:**
  Chromium can spend about two additional seconds of CPU on another core after a hostile query's
  five-second deadline and native `terminate()` call. The main thread remains responsive. Native filesystem observers,
  real helper CLIs and real-machine sleep are not covered by this OPFS/stand-in gate. Full library
  faults, failure-window/poison handling and lifecycle are C-07b's separate PL0-G1/G2 package.

## Chromium termination ruling

The first strict detach-by-6.5 s arm correctly failed. Its trace showed a **7,006.2 ms wall /
7,003.8 ms CPU** worker task, with the main-thread native terminate mark about **5,005 ms** into it.
This is real background CPU, not just delayed CDP teardown. Chromium's public
[`worker_thread.cc` at 0aee4434a4db, line 71](https://chromium.googlesource.com/chromium/src/+/0aee4434a4db/third_party/blink/renderer/core/workers/worker_thread.cc#71)
defines `kForcibleTerminationDelay` as two seconds; `Terminate` schedules that fallback at line 167,
and lines 332 onward implement the delayed forcible termination. No Chromium code is copied here.

c-lead ruled to keep the full five-second query budget and explicitly carry that engine loss, rather
than kill legitimate work two seconds early. The deadline arm therefore requires all of:

1. The partial, explicitly incomplete answer at 5 s ± 1.5 s.
2. Exactly one native terminate call, on that worker, at 5 s ± 1.5 s.
3. The trace-identified worker's actual long task completes by 5 s + 2 s engine grace + 1.5 s.
4. The actual target detaches within that bound and the next query still returns the right answer.

A completed short setup task cannot stand in for the hostile task: the trace must contain the
completed long worker task. Stop's **answer latency** is measured separately from its bounded
engine cleanup tail. Gate changes here are based on that reviewed browser fact; the failing strict
runs and their raw traces remain in scratch and the lane hand-off notes name them.

## Durable baseline

Before the consumer was changed (`d32de0e`), this real-bridge run failed the 100 ms responsiveness
assertion: **616.7 ms** maximum RAF gap, roughly **649 ms** for the tool, zero page errors, Chrome for
Testing **157.0.8103.39**. Raw output and fixture screenshot are in the lane scratch directory; the
lane hand-off note gives absolute paths. No candidate or mutant result is implied by this baseline.
