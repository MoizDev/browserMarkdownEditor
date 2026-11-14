# P-00 — classic-viewer step zero

These scripts drive the **real production app** through the file tree, pointer, keyboard,
clipboard, Original/explicit Text controls and OPFS. They import no app code. This is a record of
old behavior, **not a claim that the old defects pass their acceptance gates**.

## Frozen inputs and provenance

- App production build: `d53ae0a5c6a4b000c01ec83d487d608bc3f11895`; its entire `src/` tree is identical
  to planning base `b10d0d3`. Built before any Part A changes and before I-0 was merged into this lane.
- Fixtures: `verify/fixtures/pdf/manifest.json`. GEN-23; GEN-18's **876**-page role and additional
  1000-page variant; GEN-21. Authored content only. `NOASSERTION`, proposed `CC0-1.0`, pending the
  owner's licence decision. No fonts, documents or artwork were copied from external sources.
- Generators use Node `v26.0.0`, zlib `1.2.12`, seed `1346651697` (`0x50444631`), fixed 2000-01-01 UTC
  PDF dates and document IDs derived from `[fixture-id, generator-version, seed]`. They refuse existing
  output files. Both PDF and independent input-oracle JSON are in the hash/byte output protocol.
- Browser: Chrome for Testing **157.0.8103.39**, launched by the executable in `verify/browser-pin.json`;
  **Playwright 1.63.0 from this worktree's pinned dependency**, not the npx cache or installed Chrome.
  Named OPFS picker and granted-permission stubs. **No IDB shim**; real handle storage is exercised.
- 1440×900 CSS viewport; dark app theme; separate fresh contexts at DPR 1 and 2. Off-origin requests
  are aborted. The deliberate blocked optional font stylesheet is not a page error.

The PDF bytes and large authored input oracles stay in scratch. Only the small observation records
and screenshot hashes are committed. No fixture bytes or screenshots belong in this directory.

## Generate, twice in fresh directories

Run from the lane worktree; choose empty, external directories for `A` and `B`:

```sh
for out in "$A" "$B"; do
  node verify/fixtures/pdf/generators/authored-paper-15.mjs --out "$out" --seed 1346651697
  node verify/fixtures/pdf/generators/repeated-quotes-anchors.mjs --out "$out" --seed 1346651697
  node verify/fixtures/pdf/generators/unique-textbook.mjs --out "$out" --seed 1346651697 --pages 876
  node verify/fixtures/pdf/generators/unique-textbook.mjs --out "$out" --seed 1346651697 --pages 1000
done
diff -rq "$A" "$B"
```

The generators are data tools, not a test runner. Their generic CLI/hash/random stand-in is temporarily
centralized in `authored-paper-15.mjs`; it will be replaced by v-b's shared helpers when those land.
The independent raw PDF serializer stays in the PDF fixture domain.

## Capture, twice

Read the run's shared scratch `HOWTO.md`. Every install/build/static/browser command needs its
published semaphore. `L` below is its `bin/bme-lock`. `CHROME` is the **pinned executable path**, not a
channel. `DIST` is the production output of the baseline commit, never a Part A/candidate build.
The script owns and closes its static server; do not start a second server on that port.

```sh
L run -- node verify/pdf/P-00/capture.mjs \
  --dist "$DIST" --corpus "$A" --out "$CAPTURE_A" --chrome "$CHROME" \
  --app-commit d53ae0a5c6a4b000c01ec83d487d608bc3f11895 --port 6380
L run -- node verify/pdf/P-00/capture.mjs \
  --dist "$DIST" --corpus "$B" --out "$CAPTURE_B" --chrome "$CHROME" \
  --app-commit d53ae0a5c6a4b000c01ec83d487d608bc3f11895 --port 6380
diff -u "$CAPTURE_A/functional.json" "$CAPTURE_B/functional.json"
```

`--only <comma-separated manifest fixture names without .pdf>` and `--dpr 1|2|1,2` permit an explicit
subset for diagnosis. Default is all four fixtures × both DPRs; typos, duplicates and empty arms fail.
The script's output includes actual fixture hashes/pages, browser/driver/DPR/viewport, source-tree
identity, emitted-file hashes (`.js`, `.mjs`, `.css`, `.wasm`), queried hit/page sequences, copied strings,
source-byte equality and schema-1 Text records. The only record canonicalization is the random vault ID
in map keys. All anchors, digests, revision counts, fingerprints and camera values remain untouched.

**Identity limitation for this package:** identity is the recorded build commit plus emitted-file
hashes; v-a's V-01a served-artifact toolbox will supply the stronger awaited, fail-closed response
attestation in a follow-up. Do not mistake the command's commit label alone for artifact attestation.

## Witnesses and intended losses

- Each Copy/drag/Select All starts with a different clipboard sentinel. A real noncollapsed selection
  with text must exist; ordinary drag endpoints must belong to PDF text layers; Copy must replace the
  sentinel. Cross-page copy must intersect both page bodies. Pointer endpoints and the hit element's
  text are recorded. Select All capturing chrome is deliberately labelled **known-bad**, never the
  desired new golden. Independently authored correct strings/counts remain beside these witnesses.
- The first page canvas has nonzero size and dark ink. Its page boxes and source-point geometry are
  recorded, with screenshot landmarks kept outside git. The PDF source hash must remain unchanged.
- Original receives a **trusted Meta+F with defaultPrevented=false**. Native Chrome's toolbar is not
  automatable headlessly: the subsequent `window.find` calls are explicitly labelled **browser DOM
  find-engine diagnostics**, not toolbar automation. Each hit records its page, offset, actual selected
  text and nonzero rectangle; counts terminate on a witnessed wrap or no match. Never-built target
  layers are recorded before explicitly visiting them. The Text arm uses the **real app find form**,
  waits for all physical pages to be searched and activates a real result button where one exists.
- Text records are captured **before search changes their navigation revisions**. They must be manual
  schema-1 Text records with an actual quote anchor, not a seeded/invented record or an app-internal call.
- Negative control: `--mutant pdf-pane-boot-throw` substitutes the **whole served PdfPane chunk** with a
  named boot fault. The capture must fail its page-paint prerequisite and `failure.json` must record
  `mutantFired:true` plus the named page error. A random setup error does not establish this control.
  This is a capture-prerequisite control, **not** the later D1/D3/D7 logic-mutant coverage.

No timing claim, scroll-hole sign-off, save-latency result, external/private document measurement,
hardware-GPU assertion, light-theme product review or second-machine determinism claim is made here.
The timing half waits for v-c's V-04 method, `impl/reference` and the shared bench window. GEN-08/11
and their captures are the following P-00b package, not silently covered by these four fixtures.
