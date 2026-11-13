# P-01a — first pre-fix witness (not package acceptance)

No lane `src/` file has been changed. This is the first D1-G2 equivalent-request witness;
G2's transition matrix, G3, the logic mutants and the product fix are still pending.

## Real-app failure

A production hold build of **d53ae0a5c6a4b000c01ec83d487d608bc3f11895** (the unchanged planning-base
viewer) is opened through Open Vault → `fixture.pdf` in a named OPFS vault. After an initial ink-bearing
page paints, the user zooms in. One of four named phases is held: page fetch, emphasis bind, actual
RenderTask continuation, or verification RenderTask continuation. The driver makes **60 actual wheel
scrolls**, alternating ±1 CSSpx inside that same whole-page target, then releases the promise.

Each of the four phases fails only the named assertion:

```text
<phase>/equivalent requests keep one render work canvas: expected 1, got 2
```

For every phase: the hold fired once; all60 scrolls really moved; one final display blit occurred;
final current-density glyph ink exists; native text DOM identity survived; maximum managed canvas
drawing-state roots was1. The old completed target was discarded and a second work canvas allocated.
This is not a lucky scroll-speed failure, setup failure or a timing/scroll-hole result.

Full report (hc t2wr, exit1):
`W/scratch/p-a/P-01/witness-all/reports/2026-11-13T23-26-34.085Z-D1-G2-equivalent-342e0118-400e-4dff-bb78-e754b8c5f1f1.json`.
The initial render-only run (t2vx, exit1) observed the same named failure. Lint subsequently passed
(t2ws); the original no-ex-assign lint finding was corrected, not relaxed.

## Identity and observation

- CfT157.0.8103.39, worktree Playwright1.63.0, fresh contexts, 1440×900, DPR2, dark.
- Unmodified V-01a toolbox **527faea**, exported to `W/scratch/p-a/toolbox-527faea/verify/lib`
  under p-lead's explicit permission; imported file bytes are checked against that commit and their
  SHA256 is recorded. No private attestation implementation or changed helper.
- Strict **raw-route** served-body binding, awaited before assertions. Each case recorded12 bound
  code bodies and zero binding faults, including the actual worker `.mjs`:
  `assets/pdf.worker.min-DEtVeC4l.mjs`, SHA256
  `2ab9e09667296dab1a618868b3ce6e6c23d5b8f48120ae7c5b34e7e335ed01fa`.
- Prepared build manifest SHA256:
  `daef332b4fc7dd96e874ec39e47617ce517929b08fba3e3ea94d6d096c43ec5d`.
- Exact scratch-source hold patch SHA256:
  `d48193fa8a9419e3ef49cf9381988216b0797f6941bc6380f4df9480fc462b2d`.
- Context/bitmap/blit/save/restore/Worker-message observations are injected **outside** the app.
  Hidden source maps attribute the existing getContext callsite to distinguish work and verification
  canvases from font/layout canvases. The closest mapped frame owns a context; the classifier must
  positively see a real work context and worker operator request, never match nothing and pass.
- The hold is a **scratch source patch**, never a product toggle or served logic substitution.
  page/bind await a run-owned promise; render/verify pause the existing public RenderTask.onContinue
  callback. Every phase is witnessed. Unarmed calls resolve immediately. The driver never imports
  or calls an application module, hook, session, target predicate or render function.

## Inputs and replay

`dense-viewer.mjs` authors the new40-page role and a one-page control. The latter makes outside
per-page concurrency/work counts unambiguous, instead of attributing another page's prefetch to the
held page. It also covers D1's one-page edge, not a substitute for the40-page scroll role.

Seed1346651697, Node26.0.0/zlib1.2.12; two clean generation invocations produced identical PDF/oracle
bytes. Frozen identities are in the PDF manifest. No external text/font program; NOASSERTION with
proposed CC0-1.0 pending owner approval.

Preparation and execution are **separate grants**, avoiding a nested build under a run slot:

```sh
L build -- node verify/pdf/P-01/prepare.mjs --base d53ae0a \
  --source "$SCRATCH/source-old-holds" --scratch "$SCRATCH/old-holds" \
  --variant holds --toolbox "$TOOLBOX/verify/lib"
L run -- node verify/pdf/P-01/G2.mjs --prepared "$SCRATCH/old-holds/prepared.json" \
  --fixture "$SCRATCH/fixtures-a/dense-one-page.pdf" --scratch "$SCRATCH/witness-all" \
  --toolbox "$TOOLBOX/verify/lib" --phase all --port 6384
```

The source and output must be separate external scratch paths. Preparation refuses a dirty scratch
source, validates every patch anchor and performs an owned npm ci (no dependency symlink). Vite uses
private cache/output and hidden maps; those maps are attribution data, not application instrumentation.
`serveApp({build:false})` owns/stops the private preview in finally; no preview remains between runs.

## Open obligations

Before P-01a is offered: complete the pre-fix G2 transition/G3 compatibility witnesses and gate
rules, then implement the product fix and demonstrate the applicable logic-mutant rejections. P-01b is density G4 plus G1's functional coverage;
its timed form follows v-c's calibration/window method. A managed drawing-root count is a Canvas API
state observation, not private RenderTask/worker-heap introspection; no timing or physical GPU-memory
claim is made. D2 supplies the visible error UI; P-01 only supplies bounded stopping and one named
reporting callsite until `recordClassicRenderFailure(session.health, error, i)` can be wired.
