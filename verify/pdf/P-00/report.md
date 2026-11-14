# P-00a functional baseline report

## Scope and result

**Functional capture complete:** GEN-23, GEN-18-876, GEN-18-1000 and GEN-21, each at DPR 1 and 2
(8 fresh-context cases). The two completed full-string captures have **byte-identical functional
records, screenshot-hash manifests and emitted-build manifests**. Nothing under `src/` was changed.

This records the classic viewer's old behavior; it does **not** declare D1–D7 fixed or passed.
GEN-08/11 are the following P-00b package. Timing, scroll-hole sign-off and save timing remain **NOT
RUN**, pending V-04/reference-machine coordination. No external/private-document sign-off is claimed.

## Identity

- Served production app: `d53ae0a5c6a4b000c01ec83d487d608bc3f11895`.
- Planning base: `b10d0d3b24943b9f834a5b4c6169270f06312aa7`.
- The entire `src/` tree at those commits is identical: `adb19b09faa1253f87a61bb639091e71dffc77ae`.
- The production build was made before I-0 was merged into the lane, using a private Vite cache and
  output directory. The capture driver subsequently uses the lane's pinned Playwright **1.63.0**.
- Chrome for Testing **157.0.8103.39**, pinned executable, headless; 1440×900 CSS viewport; actual
  DPR 1/2 and dark theme asserted. No npx driver, installed Chrome channel or IDB shim.
- Identity is **interim: commit + emitted-file hashes** (`.js`, `.mjs`, `.css`, `.wasm`), as p-lead
  permitted. V-01a's raw-route served-body binding is a named follow-up, not claimed here.

`../baselines/P-00a-functional.json` carries fixture SHA/pages, browser/config, gesture witnesses,
full copied strings, expected correct outputs, every query's counts/pages, actual schema-1 Text
records and source-byte equality. The landmark manifest joins those profiles by `(fixture, DPR)`;
PNG bytes remain outside the repository. Emitted chunk identities are in `P-00a-build-identity.json`.

## Corpus freeze and determinism

Generators/independent oracles are frozen through `77b908f`; seed **1346651697** (`0x50444631`),
Node **v26.0.0**, zlib **1.2.12**. Two fresh invocations in `W/scratch/p-a/corpus-7` and `corpus-8`
produced byte-identical PDF **and oracle JSON** outputs (8 emitted files, no differences).

Manifest: `verify/fixtures/pdf/manifest.json`, SHA-256
`31931a68be031e3bc645a3805ec16e977674d30d7448599bf0a9e13f1b9e637e`.

| Fixture | Pages | PDF bytes | PDF SHA-256 |
|---|---:|---:|---|
| GEN-23 | 15 | 19,849 | `5fc279b7b414caacd45acf2c480cf161d53ff86008517037a198315d88eabadd` |
| GEN-18-876 | 876 | 886,701 | `a636924dd8010fd8b3271e42f0212baac915eb6976c547948add6fae9755dc86` |
| GEN-18-1000 | 1000 | 1,012,126 | `ecd7e551b19b22c19427c8930b8e50103e91af75031e9ab73484db4179093a18` |
| GEN-21 | 2 | 2,389 | `f96b1895a0d89b35de8f81d140c19c27042dbd156c8f1d58e45972185923b381` |

Content/artwork/glyph references are authored. No external document or font program is embedded.
Licence is **NOASSERTION**, proposed **CC0-1.0**, awaiting the owner's decision. The raw serializer
pins PDF dates and derives document IDs from fixture ID/version/seed. Caller-selected outputs are
no-clobber; no generated PDF or large input oracle is committed.

## What the old viewer actually did

Both DPRs agreed unless stated otherwise.

- **Paper:** title copies exactly 29 characters; abstract 93; cross-page boundary 51. Original DOM
  find counts for first marker / final marker / repeated quote / joined hyphen / split-font word are
  **1 / 1 / 15 / 0 / 0**. Real Text-view find counts are **1 / 1 / 15 / 0 / 15**.
- **Books:** Original initially finds the p3 sentinel but **not p450, p700 or the final page**. Their
  target-layer witnesses show those distant pages were unbuilt. After actual page-box visits,
  Original finds all four sentinels and all four repeated quotes. Text's real find form searches all
  876/1000 physical pages and finds all four sentinels plus four quotes. Joined `interoperability`
  is absent in both surfaces. The additional 1000-page arm is not mislabelled as the 876-page role.
- **Book copy:** two lines copy exactly 113 characters; cross-page copy 51. At DPR 1 the title copies
  all 29 characters. At DPR 2 it copies only **`Chapter ` (8 characters)** despite both pointer
  endpoints hitting the live title span. This is preserved as an old witness, not diagnosed or fixed
  here; p-lead assigned p-f a separate P-11b investigation.
- **Repeated quotes:** both surfaces find two identical quotes on p1 and one revised-quote query on
  p2; `English-to` across the drawn line end is absent. Title/two-line/cross-page copies are 22/79/58
  characters respectively.
- **Select All is known-bad on every case:** it includes the vault name/app controls. Paper clipboard
  length is 32,119; either book 7,121 (only built text, pages 1–4); repeated quotes 535. Full strings,
  selected-page witnesses and independent PDF-only desired output references are retained. This is
  not promoted to a desired golden.
- Every file has the authored 612×792-point source box and 1120×1449.40625-CSS-pixel fitted DOM box;
  first/last boxes agree. First canvases contain nonzero dark ink at both DPRs. Source PDF hashes
  remain unchanged after all gestures. There are **zero page errors** in all 8 healthy cases.
- Actual manual schema-1 Text records were written through the header action and physical-page form:
  page 0 for paper/quotes, page 449 for books, offset 0. Fingerprints, page digests, full anchors,
  camera checkpoints and navigation revisions are retained. Only random vault IDs in map keys are
  canonicalized. Native PageDown was deliberately not used for this checkpoint: its animated scroll
  generated 9 versus 10 real revision callbacks on otherwise identical runs; no counter was erased.

Original's Meta+F is trusted and `defaultPrevented:false`. The native toolbar is unavailable in
headless Chrome; subsequent `window.find` is explicitly a **browser DOM find-engine diagnostic**,
with actual selected range/page/offset/rectangle and wrap witnesses. It is not claimed as native
browser-toolbar automation. Text find uses the app's actual form and result buttons.

## Repeat evidence and negative control

Completed captures: `W/scratch/p-a/baselines-7` and `baselines-11`. The latter exited 0 as hc t2f7.
The first capture had completed every case and emitted its completion manifest before its surrounding
paired job was stopped for a timing window; the incomplete queued second arm was never credited.
Earlier failed/paused diagnostic attempts are not the offered goldens.

`diff -u` returned no differences for each pair:

| Record | SHA-256 of either completed copy |
|---|---|
| `functional.json` | `d8c74769e86a5bfc953ece2d777da688cf0237d2e4f58f3f4073cef910bf5ba7` |
| `landmarks.json` | `7a57f45ba556531cede5b73dd093c17f10a3b93708a8dd548eec8d55e7a59f56` |
| `build-identity.json` | `f890bcc3edcccb7d3c589b0b065b694143987f02ca606d7a600bb646ed3201a5` |

The named whole-chunk `pdf-pane-boot-throw` control ran as hc t2f8 and exited **1**. Its recorded
`mutantFired:true` and actual page error **`P00 MUTANT: PDF pane chunk did not boot`** accompany the
failed page-paint prerequisite; see `P-00a-mutant.json`. This is not credited merely because a command
failed, and is **not** a substitute for later defects' specific logic mutants.

False passes prevented: stale clipboard (a different sentinel before every observed gesture/Copy),
collapsed or unrelated selections (live endpoints in PDF layers), a single-page cross-page drag
(two selected page bodies required), blank white success (dark ink required), unrun case subsets
(argument/required-arm validation), stale find status (real form plus completed physical-page scan),
and a fake seeded Text record (the real manual Text action and actual persisted quote are required).

## Commands, static checks and next work

Exact portable commands are in [README.md](README.md). Local completed replay:

```sh
hc run --bg --name p-a-final-replay --cwd W/wt/p-a \
  sh W/scratch/p-a/capture-all.sh 8 11
# capture-all.sh wraps the real capture in bme-lock run (weight 1).
```

`npm run typecheck` and `npm run lint` passed through `bme-lock static`; production build passed
through `bme-lock build`. Both completed browser jobs closed their servers; no p-a listener remained
on ports 6380–6399. No tests, runner, production diagnostics, source hooks or product edits were added.

Next: adopt V-01a identity and v-b's generic fixture helpers when merged, then P-00b captures on the
frozen GEN-08/11. Timing half remains separate (impl/reference, V-04 method, bench window). No claim
of hardware GPU, light-theme product review, second-host determinism, scroll-hole acceptance,
save latency or authorized-original sign-off is made by this report.
