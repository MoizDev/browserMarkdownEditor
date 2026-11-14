# P-07a — canonical PDF find through the real Text view

Plain Node + Playwright driving the running app. No app-module imports, direct matcher calls,
unit tests or product diagnostics. Read the repository's `verify-in-browser` skill and scratch
HOWTO first. Every slow command belongs in an `hc run --bg` terminal; use `hc wait`, not polling.
Classic pdf.js runs weigh **1** (p-lead ruling); the new PDFium pool's weight 2 starts at P3.

## Preparation and runs

`L=/Users/adham/Developer/bme-impl/scratch/bin/bme-lock`. Choose a fresh scratch directory `S`;
never put output in the repository. After the shared toolbox/fixture helpers and GEN-18 merge:

```sh
node verify/fixtures/pdf/generators/find-corpus.mjs --out "$S/corpus" --seed 1346651697
node verify/fixtures/pdf/generators/find-corpus.mjs --out "$S/corrupt" --seed 1346651697 --fault content-xref
node verify/fixtures/pdf/generators/find-corpus.mjs --out "$S/cap" --seed 1346651697 --variant cap
node verify/fixtures/pdf/generators/unique-textbook.mjs --out "$S/book" --seed 1346651697 --pages 876

# Separate build preparation from run; never nest build under run/bench.
BME_MODE=production BME_SCRATCH="$S/app-production" "$L" build -- node verify/pdf/P-07a/prepare.mjs
BME_MODE=dev BME_SCRATCH="$S/app-dev" "$L" build -- node verify/pdf/P-07a/prepare.mjs

# Execute every required visible case, not just one matrix cell.
for theme in dark light; do for dpr in 1 2; do
  BME_THEME=$theme BME_DPR=$dpr BME_FIXTURES="$S/corpus" BME_SCRATCH="$S/app-production" \
    BME_OUT="$S/corpus-$theme-$dpr" "$L" run -- node verify/pdf/P-07a/run.mjs
done; done
BME_CORRUPT=1 BME_FIXTURES="$S/corrupt" BME_SCRATCH="$S/app-production" \
  BME_OUT="$S/corrupt-result" "$L" run -- node verify/pdf/P-07a/run.mjs
BME_CAP=1 BME_FIXTURES="$S/cap" BME_SCRATCH="$S/app-production" \
  BME_OUT="$S/cap-result" "$L" run -- node verify/pdf/P-07a/run.mjs

# StrictMode/all-page reuse, then independent cold refine and hide sessions.
for arm in ordinary refine hide; do
  BME_MODE=dev BME_PORT=6400 BME_TEXTBOOK=1 BME_FIXTURES="$S/book" BME_SCRATCH="$S/app-dev" \
    BME_LIFECYCLE=$([ "$arm" = refine ] && echo 1 || echo 0) \
    BME_HIDE=$([ "$arm" = hide ] && echo 1 || echo 0) BME_OUT="$S/book-$arm" \
    "$L" run -- node verify/pdf/P-07a/run.mjs
done
BME_MODE=dev BME_PORT=6400 BME_FIXTURES="$S/corpus" BME_SCRATCH="$S/app-dev" \
  BME_OUT="$S/corpus-strict" "$L" run -- node verify/pdf/P-07a/run.mjs
```

The browser arm uses `serveApp({build:false})` and stops it in `finally` after **each** run. It
never leaves a preview parked while waiting for a grant. Production defaults to port 6401; every
port must be 6400–6419. All booleans/modes/theme/DPR/roles are validated; no positional run args.
Refine and hide require separate fresh textbook sessions. A historical baseline is not an
acceptance bypass. Each requested query/lifecycle arm must execute; setup failures never pass.

Temporary pre-merge runs used an explicitly recorded scratch-only Node resolver pointing the
canonical `verify/lib/*` and fixture-helper imports at their owners' worktrees. No copied helper
or private identity implementation is committed here. Remove that resolver after those merges.
Until GEN-18's records merge, the textbook run explicitly supplies `BME_FIXTURE_MANIFEST` pointing
to p-a's manifest; its PDF **and oracle** must match the declared hashes/lengths. No silent fallback.

## Witness, identity and the two mutants

- **Witness:** named OPFS vault → Open Vault → actual tree click → own More options menu → Read
  extracted text. Every counted submit first completes an independently absent query and witnesses
  zero hits; stale results cannot stand in for a new action. Check exact generator-recorded hit
  counts/pages, live input, physical-page result click and unchanged PDF bytes. Textbook page 450
  must initially have no Original text-layer spans. A Worker-message wrapper counts canonical
  `GetTextContent` requests separately from the Original's independent normalized text layers.
- **Refine:** a live unfinished p3 query is replaced with the p700 query. A DOM MutationObserver,
  enabled by the real submit, rejects every old-query result after refine; completed canonical
  extraction requests remain exactly one per page, including StrictMode. No app API is called.
- **Hide:** the real note-row pointerdown records unfinished progress **and nonempty live hits**.
  Wait for the pause note and computed hidden PDF pane, then require zero new extraction requests
  for 250 ms. Reopening retains the query and every earlier hit throughout resume, not just at the
  final state. One cancelled in-flight extraction may be retried after show; this arm does not
  falsely equate an aborted request with a completed-page extraction.
- **Identity:** V-01a `prepareApp` freezes source commit/clean state, config, emitted inventory and
  mutant patch SHA. `bindServedBodies` uses **raw-route**, unchanged fulfilment; its awaited check
  precedes assertions and finishing. Required PDF lazy chunk, `.mjs` worker and CSS must be seen;
  every same-origin JS/mjs/CSS/WASM body is bound, not merely a claimed build label. This disables
  the HTTP cache and is **not timing evidence**. Both browser/driver pins are checked. Fixture and
  independent oracle bytes must match the stream manifest; OPFS readback uses `readWitness`.

Prepare both scratch mutants under build, then use the same real-app gate in all four cases:

```sh
"$L" build -- node verify/pdf/P-07a/mutant.mjs hyphen "$S/mutant-hyphen"
"$L" build -- node verify/pdf/P-07a/mutant.mjs abort "$S/mutant-abort"
"$L" run -- node verify/pdf/P-07a/mutant-proof.mjs hyphen "$S/mutant-hyphen" "$S/corpus" "$S/hyphen-proof"
"$L" run -- node verify/pdf/P-07a/mutant-proof.mjs abort "$S/mutant-abort" "$S/book" "$S/abort-proof"
```

`mutant.mjs` refuses nonunique patch anchors and existing output, clones this worktree's own install
with APFS, and builds with the production config. The hyphen mutant removes only line-end H joins;
the named count failures must be **exactly** `transformation` and `state-of-the-art`, with the other
11 controls passing. The abort mutant removes both old-scan aborts; the named stale-result observer
must fail. `mutant-proof.mjs` requires all four theme/DPR cases, correct mutant identity, zero page
errors and no HarnessFault. A build refusal, wrong browser, missing fixture, timeout or generic
nonzero status **does not kill a mutant**. Proof JSON links every raw browser result.

## Corpus, decisions and losses

`GEN-P07a-find-corpus`, `GEN-P07a-find-corrupt`, `GEN-P07a-find-cap` and their `-oracle` records use
seed `0x50444631`, fixed PDF dates, IDs derived from the exact role/version/seed, and no external
assets. Licences remain NOASSERTION with CC0-1.0 proposed; private verification is not redistribution.
Unicode ToUnicode text is an extraction oracle, not a glyph-fidelity golden. No external font file
is embedded. GEN-08's full script/glyph corpus remains a separate fixture lane obligation.

- Page 5's invalid Flate is recovered as **textless**, never credited as a failed-page witness.
- Page 14 in the separate corrupt variant has an incorrect content-object header number: real
  extraction rejects, while later pages are still found. All arms now require **zero pageerrors**.
  An earlier provisional one-error allowance was removed after controls localized the observed
  CLOSE error to the reader's cancellation misuse, not a demonstrated corrupt-page vendor defect.
- Page 15 plants a searchable prefix before a >1 MiB item. It remains **partial**, and later pages
  still match. pdf.js cancel requires an Error reason; missing it left its controller incorrectly
  open. Waiting for cancellation acknowledgement can also strand an already-closed sink. The
  reader now supplies an Error and fire-and-forgets with `.catch`, preserving the partial prefix.
- The initial cap construction used spaced words and hit the existing 4 MiB text/map safety limit
  at 5,017 hits. The final construction authors 10,005 contiguous `a` glyphs, still independently
  expects 10,005 source/10,000 reported hits; neither the cap nor expected count was weakened.
- pdf.js drops the page-12 soft hyphen **before** schema-1 canonical text. That absent marker cannot
  safely be inferred. The loss is explicit; U+2010/U+2011/hard-hyphen joins are covered. P5/schema 2
  may retain it. RTL glyphs are authored in visual order; the oracle is logical order.
- The lead approved canonical UTF-8 **plus** keys and compact offset runs in the same 32 MiB/document,
  64 MiB app-wide budget so snippets/refinements do not churn the 12-page geometry cache. Full maps
  are not retained. A dev-only injected standard-API allocation observer measures that budget; it
  is not a product hook or JS-heap measurement. One decoded page serves a snippet group.
- No authorised originals, native filesystem/FSEvents, Original find routing/highlights, exact
  on-glyph UTF-16 ranges, R3/R4/R5 or reference-machine R7/R8 timing is claimed here. Those await
  P-07b/F5/P5 or their named owners. Fixed generator shapes are not random-input coverage. The
  legacy Text status combines partial/failed/textless counts, so separate severity UI awaits F2.

The static no-regex seam and deliberately violating source are documented in
`P/60-implementation/seams/p-b-P-07a.md`. Run `lint-witness.mjs` under static **after** that seam;
before it, exit 1 with no restrictions is the truthful missing-guard witness, not a passed gate.
