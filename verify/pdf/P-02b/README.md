# Classic PDF failure containment (P-02b)

All behavioural checks drive the real built app via the named OPFS picker/tree. No app module is
imported by a run. Builds, static checks, preview servers and browser runs use bme-lock. Preview is
started only within the granted run and stopped immediately afterwards. P-02a is signed at f73e1e6;
P-02b is a separate package and does not claim complete D2 acceptance until its fault gates pass.

## First witness, before the fix

```
node verify/pdf/P-02b/reproduce.mjs <production-url/> <f73-artifact-identity.json> <fresh-results>
```

Observed on production f73e1e6, CfT 157.0.8103.39, real Open Vault/tree gesture:
- exact SHA-checked bug_jpx.pdf (rights-unverified local witness, never admitted or committed);
- successful OpenJPEG fetch and all raw served bodies matched the f73 inventory;
- worker null-image message for page 0, decoder `memory access out of bounds` warning;
- completed 780×1009 blit carrying the sentinel set before the tree click; zero ink;
- no accessible failure notice at all. Screenshot inspected: working page/navigation chrome over
  a completely white page. This is a failed renderer, not a valid blank-page fixture.

Evidence: `/Users/adham/Developer/bme-impl/scratch/p-e/P-02b-baseline/report.json` and
`silent-decode-failure.png`. The baseline script requires all those witnesses, not a setup exit.

## Agreed product behaviour / scope

- App-owned native module worker, explicit ready/test transferable handshake and 5-second startup
  bound, no fake-worker parsing on the main thread. One shared worker, no automatic restart loop.
- Observe-only fetch/XHR and WebAssembly compile/instantiate failures. Forward the original
  response/result/throw unchanged; report codes only, never PDF text/URLs. Dependency failures taint
  the shared worker. A complete JS fallback is still complete and shows no incomplete-page notice;
  its dependency code stays on the document's diagnostic channel. The gate must cover that arm.
- Null images and failed renders have sticky page/document notices and invalidate clean captures.
  Unknown pinned image-message shape fails closed. Common images lack page provenance, so their
  verdict is conservatively document-wide. No guessing from page whiteness or console text.
- A dead shared worker fails every document on it visibly. Explicit Retry creates one fresh worker;
  healthy-worker Retry reopens only the document. New demanded opens retire a tainted worker before
  creating its replacement. Existing documents then retry against that one replacement themselves.
- Loading tasks/proxies stay real pdf.js objects, with no replaced methods. Adapter-owned operation
  and close helpers race document/port failure; native-owner lifetime detaches every handler when
  the port dies, so an impossible Terminate reply cannot hold application teardown forever.
- Annotation shows its notice and rejects an incomplete backdrop/capture without losing/remounting
  pending ink. In-place annotation Retry is a seam to w-a; until it lands the notice says to retry
  from View. Read-mode Retry belongs locally to PdfPane. No source file is repaired or written.

## Pending acceptance (not yet signed)

Final corrupt-resource / null-common-image / worker-startup/crash / version-message faults, Retry,
eval/Function rejection, non-root base and no-write/lazy runs and their named source mutants.
P-02a's reference ink/corpus limitations still apply (CJK outline and exact JPX/JBIG2 generator gaps).
