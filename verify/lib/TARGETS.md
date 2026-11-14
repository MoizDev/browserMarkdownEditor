# Functional worker counters (V-01b part 1)

Use only in a **functional** real-app run. `instrumentTargets` refuses a bench grant: pausing
workers changes timings. Every debug port comes from the caller's assigned range, is pre-probed,
bound to `127.0.0.1`, and closes with the fresh pinned browser. Never use a remote-origin wildcard.

```js
const session = await openBrowser({ debuggingPort: MY_DEBUG_PORT });
await installCounters(session.context, { vaultName, postMessages: true, blobReads: true });
await installVault(session.context, { name: vaultName });
const page = await session.context.newPage();
const counters = await instrumentTargets(page, { debuggingPort: MY_DEBUG_PORT, vaultName, report });
// Install the normal served-build binding too, before goto. Seed after goto.
await counters.check(); // after an app action, and before reporting an assertion
const { window, records, targets, deferredFrames } = await counters.read();
// finally: check, stop the observer, close the browser, stop the server
```

`check()` independently compares announced workers with pre-start installation receipts. Missing
instrumentation fails as `HarnessFault: uncounted worker: …`, even if the worker has already ended.
`read()` merges the window snapshot and streamed worker records, carrying target id/type/URL and
creator. It never evaluates a busy worker just to collect its records. Shared/service workers are
unsupported and fail if unexpectedly started. Frames are recorded and resumed, explicitly
**deferred to part 2, not counted**. Nested/opaque-frame controls remain part 2.

The shared runtime wraps FSA reads/writes/closes/removals/iteration, worker starts/termination,
canvas contexts, and optional postMessage/Blob.arrayBuffer activity. It grants no permissions.
Native handle prototypes are also hooked when returned or received: worker globals need not
expose the FSA constructors during the prelude. Acquisition hooks run before the app receives the
handle; an early message listener covers cloned handles without starting transferred ports.
Capability-transition records distinguish pre-start API availability from later native handles.

The actual PDF builder gets bytes, the archive worker gets a Blob: their FSA counts should be
**zero**. Replies and Blob reads witness real work. `worker-targets-smoke.mjs` additionally plants
one clearly labelled **instrument control, not an app gate**, reading one OPFS file. Its first
instruction checks that the prelude already exists, rather than accepting eventual attachment.

Logical termination is observed at a terminate call or target detach/destruction. It does **not**
mean the busy thread has stopped using CPU yet: allow up to **terminate()+2 seconds** (Chromium's
forcible termination delay, measured by c-c), and state this loss whenever CPU cessation matters.

## Measured Chrome for Testing 157.0.8103.39 trap

In a dedicated **module** worker (the real app's pdf.js worker), this legitimate CDP sequence
crashes its renderer before instrumentation is installed:

1. Page session: `Target.setAutoAttach({autoAttach:true, waitForDebuggerOnStart:true, flatten:true})`.
2. Attached worker session: recursively apply auto-attach, then `Runtime.enable`.
3. Receive `Runtime.executionContextCreated`, id 1.
4. **Before resume**, `Runtime.evaluate({expression:'location.href', contextId:1, returnByValue:true})`.

The renderer died about 250ms after attach (unqualified observation), not at the later command
timeout. `1+1` returned 2; `globalThis.name` returned its string; auto-attach-off and resume-without-
evaluate controls completed the same annotated save without crashing. Explicit contextId did
not cure WorkerLocation. Evidence: scratch/v-a-targets/reports/2026-11-14T00-16-*.

**Never touch WorkerLocation before resume; take the URL from TargetInfo.** The runtime receives
that URL from the observer, including for its receipt and relative child-worker URLs. Any other
new pre-resume native getter must first get the same isolated control; do not assume it is safe.
Existing crash diagnostics and mutants are retained for the deferred review phase, not rerun as
implementation merge conditions (charter §0).
