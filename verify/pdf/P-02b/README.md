# Classic PDF failure containment (P-02b)

## Implementation acceptance — charter §0

The current bar is typecheck + lint and one real-app headless sanity run, with light/dark
screenshots inspected. No review signature, mutant, identity rerun or fault matrix is a merge
condition. The existing proof code/evidence below is preserved for the separate post-K7 review.

```
node verify/pdf/P-02b/sanity.mjs <production-preview-url/> <fresh-results>
```

Run under bme-lock run, using pinned Playwright 1.63.0 and Chrome for Testing. The preview is
started within the granted run and stopped at its end. The sanity opens an authored JPX scan,
shows the corrupt-image notice and thumbnail placeholder, exercises a document-only Retry,
closes the worker through CDP and demands another document to show the no-progress notice, then
explicitly retries onto a fresh renderer. Both themes are checked; source bytes/write counts
stay unchanged. No app module or app-internal method is called by the run.

## Reproduction before the fix

`reproduce.mjs <preview-url/> <f73-artifact-identity.json> <fresh-results>` recorded production
f73e1e6, CfT 157.0.8103.39, actual Open Vault/tree gesture:
- exact SHA-checked bug_jpx.pdf (**rights-unverified local witness**, never admitted/committed);
- successful OpenJPEG fetch and matched raw served bytes;
- null-image reply for page 0 and a decoder memory-access warning;
- completed 780×1009 white blit carrying the marker set before the tree click, zero ink;
- no accessible failure notice. The screenshot was inspected: white paper and working chrome.

Evidence: `W/scratch/p-e/P-02b-baseline/`. This is a failed image, not the genuine blank control.

## Product behaviour

- One app-owned native module worker; ready/test transferable handshake and 5-second startup
  bound. No fake-worker parsing on the main thread and no automatic restart loop.
- Fetch/XHR and WebAssembly compile/instantiate observers preserve exact responses/results/
  throws. Codes contain no PDF text/URLs. Failed dependencies taint the worker, but a fully
  painted JS fallback is complete and has no false warning.
- Null images/failed renders give persistent page/document notices and invalidate clean raster
  captures. Unknown pinned image-message shapes fail closed. Unattributed common images are
  conservatively document-wide. Whiteness and console text are not failure heuristics.
- Native errors fail the documents sharing that port visibly. A silent closure instead yields
  a **soft** no-progress notice after about 10 seconds of demanded work: work stays alive and
  the notice clears on progress/completion. Only explicit Retry restarts it. There is no decode
  deadline, no automatic timeout kill and no new large-scan refusal.
- Healthy-worker Retry reopens just the document; unresponsive/tainted/failed Retry creates one
  fresh worker. Other affected documents can retry against that replacement separately.
- Real pdf.js task/proxy methods stay untouched. Operation/close helpers guard failure; the
  native owner's lifetime detaches all port listeners on retirement. An explicitly closed,
  abandoned port cannot hold teardown behind an impossible Terminate reply.
- Annotation preserves the canvas/ink and tells the user to retry from View. In-place annotation
  Retry is a coordinated w-a seam. Failed backdrops/captures must not masquerade as clean PNGs.

## Existing observations (unqualified, not review sign-off)

The pre-§0 pilot at 783b324 passed corrupt-image/Retry, startup CSP/throw/stall/version, message
shape, codec recovery, complete JS fallback, soft slow-render, A3 source-image boundary and
silent-closure recovery observations. Its eval guard failed in the **harness**: disabling main
global eval also disables Playwright UtilityScript's subsequent page.evaluate. That method/proof
is owed to the review phase, not counted as a product pass or re-run for this merge.

An authored local A3@600 dpi DCT image (69,612,752 source pixels, existing cjpeg, encoder not
pinned) painted its 25 independent checker landmarks in a roughly 1.0 s shared-load functional
sample. This is NOT a benchmark or decode SLA. The soft 10 s threshold leaves generous slack;
a deliberately slow successful renderer ran ~12.7 s, showed the notice and finished without a
restart. Actual worker crashes often take Chrome's renderer down; CDP self.close() is the
reachable silent-closure observation. The original file is never repaired or changed by Retry.

## Interfaces and seams

`recordClassicRenderFailure(health, error, zeroBasedPage?)` publishes the existing UI; cancellation
is ignored. `session.health.guard(...)` keeps stream/render waits connected to lifecycle and soft
progress. Async consumers returning a raster call assertComplete(pageIndex) before returning it.

Exact owner changes are in `P/60-implementation/seams/p-e-P-02b.md`: core prefetch, p-b Text stream
guards, w-a fifth caller/capture/thumbnail wiring, help text and PDF skill. None is edited across
ownership boundaries here. In-place annotation Retry remains explicitly deferred until its host
and parent-health wiring land together; the current notice points to View.

Remaining review obligations: the existing fault scripts and complete mutant/realm/memory/base-
path/agent runs, CJK outline and exact JPX/JBIG2 generator gaps. They are not a condition of
implementation merge under §0 and are not silently reported passing.
