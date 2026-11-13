# Classic PDF runtime assets (P-02a) and the following diagnostics package (P-02b)

Every behavioural run enters the real production app through Open Vault and its file tree. No
app module is imported by a run. Build/serve/static/browser commands take the run's corresponding
`bme-lock` grant. Only Playwright 1.63.0 and the pinned Chrome for Testing are accepted.

## Reproduce P-02a

1. Build this source with the seat's scratch Vite recipe, adding `pdfClassicAssets()` from
   `build/pdfClassicAssets.ts` to its plugin list until I-3 wires the production config. Serve on a
   seat-owned port with `vite preview --strictPort` through the serve lock.
2. Generate the corpus twice in fresh directories and compare bytes:

   ```sh
   node verify/fixtures/pdf/generators/codecs-minimal.mjs --out <fresh-fixtures> --seed 1346651697
   ```

3. Bind the served artifact to its exact product-source tree and emitted bytes (after the build):

   ```sh
   node verify/pdf/P-02/artifact-identity.mjs <dist> <source-root> <source-commit> <fresh-identity.json>
   ```

   The recorder checks every tracked product-source blob against the commit, then hashes every
   emitted file. It does not accept a build-commit label as proof. For the one supported mutant,
   add `missing-wasm`; it checks the exact single source patch instead of trusting that label.
4. Run, under one browser slot, the four theme × DPR cases:

   ```sh
   node verify/pdf/P-02/run-matrix.mjs http://localhost:<port>/ <fixtures> <fresh-results> <identity.json> generated
   ```

   Each case edits/searches a Markdown-only vault and waits 5 seconds (the 4-second prefetch
   deadline plus margin); it then opens every required PDF in a fresh browser context. A blit
   sentinel is set **before** the tree gesture, and the canvas must carry that action's marker.
   A genuinely blank page still requires that live completed-paint witness. Authored CCITT and
   local JPX masks have independent black/white landmarks, not just an ink count. Every served
   body is awaited and checked against the expected artifact, including `.mjs` workers and
   `.wasm`; a missing/mismatched body fails closed. The run requires the app entry and native
   worker bodies, fixture/oracle hashes, all named arms, and a positive PDF-asset fetch control.

`local` is a separate, explicitly named arm: it additionally requires the three SHA-checked
rights-unverified JBIG2/CCITT witnesses at the absolute planning evidence path and
`LOCAL_JPX_WITNESS=<scratch-positive-jpx-metadata.json>`. No witness is silently skipped. The
positive JPX is an authored 4×4 checker made locally with existing OpenJPEG 2.5.4; its PDF SHA and
encoder binary SHA are recorded, but it is **a local positive witness, encoder not pinned**. It is
not committed or admitted as a reproducible GEN-09 replacement. Generated records remain licence
`NOASSERTION`, proposed `CC0-1.0`, pending the owner's choice.

X-ORIGIN means zero **additional** off-origin attempts beyond the independently recorded
Markdown baseline, as verification.md defines it. The baseline is itself constrained to the
existing optional Google Fonts hosts; all off-origin requests are aborted. A new PDF CDN request
cannot join that allow-list. A Markdown-only vault must fetch zero PDF chunks/assets.

## The mutant must actually lose

```sh
node verify/pdf/P-02/make-mutant.mjs <fresh-mutant-root> <source-commit>
# Under build lock, in that root:
npm ci --no-audit --no-fund
./node_modules/.bin/vite build --config <mutant-root>/mutant.vite.config.mjs
node verify/pdf/P-02/artifact-identity.mjs <mutant-root>/dist <mutant-root> <source-commit> <mutant-identity.json> missing-wasm
# Serve that output on a second owned port; run the same matrix against it.
```

Patch refusal fails, never counts as a kill. `view-codecs.mjs` must fail specifically on completed
white blits with a missing-wasm warning after every required fixture arm executes. The matrix
accepts the negative control only when that named observable failure exists in all four cases;
a setup timeout, missing body or arbitrary nonzero exit is not a kill.

## Static lint-ban witness (I-3 seam)

```sh
node verify/pdf/P-02/lint-witness.mjs <exact-rule-module> <results>
```

The proposed production rule is in `planning/60-implementation/seams/p-e-P-02-eslint-rule.mjs`
(main checkout, absolute path in the handoff). The real ESLint engine runs it on the five old
calls and on a sixth caller plus alias/escape controls; all five must fail, while type-only and
the sole-adapter controls stay allowed. Until I-3 applies it, `npm run lint` has no classic-open
ban: the scratch witness is proof of the proposed rule, not a claim that integration is done.
The final production rule must be re-run at integration.

## Evidence already observed

- Unfixed production build d53ae0a: authored CCITT/CJK and local JPX/JBIG2 were blank, decoder
  warnings/null-image messages appeared, and no notice was shown. The genuine blank control was
  clean. Original reports/screenshots: `W/scratch/p-e/baseline/` (pre-I-0 npx driver, pinned CfT).
- Asset build 6a407c1: authored CCITT, CJK and JBIG2 content returned. `bug_jpx.pdf` still emitted
  an out-of-bounds decoder error despite a successful OpenJPEG fetch; it is now explicitly the
  P-02b decode-failure/notice arm, not a positive-ink fixture (p-lead ruling).
- Generator v2 corrects the independently specified CCITT black/white polarity with explicit
  `/Decode [1 0]`; its two fresh outputs match. This is an authored-input correction before
  fixture adoption, not a change to accept the broken app's pixels.
- First identity-bound P-02a local run (dark, DPR 1): `W/scratch/p-e/gate-view-a2/report.json`.
  All eight cases passed, all 8/16 CCITT/JPX landmarks matched, no decoder warning, no additional
  off-origin request, zero Markdown PDF requests, positive PDF-assets control. Screenshots of the
  CCITT right-half ink and JPX checker were inspected. The matrix results are recorded in the
  package handoff after all four cases and the mutant have run.
- Proposed lint policy: `W/scratch/p-e/lint-policy/lint-witness.json` — five old sites and sixth
  caller/namespace/dynamic escapes fail; type-only/sole-adapter controls pass.

## Stated false passes and losses

The gate prevents a stale or untouched white canvas, OCR text mistaken for scan ink, an unelapsed
prefetch window, a supplied build label without served bytes, and a setup failure mistaken for a
mutant kill. A positive resource fetch alone is not a positive scan witness.

P-02a's committed browser path currently checks View. The fifth caller (annotation text) and real
Vite/lint/package/notices wiring are owner seams; annotation/thumbnail/closed-agent raster need
integration follow-up. Independent local JBIG2 crops and CJK glyph outlines are not established;
nonzero ink is not full fidelity. JPX/JBIG2 negative-construction generators remain a corpus gap.
P-02b owns strict native workers, typed asset/null-image diagnostics, visible notice/Retry, killed
port cleanup, eval/Function failures and corrupt resources. ICC/standard-font/large-image memory,
non-root base, warm-vault switch/no-write and engine comparison are not signed off by this slice.
No full D2 milestone is claimed by P-02a.
