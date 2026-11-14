# P-00b — Unicode and tagged/Type3 baseline

## Result and provenance

Captured GEN-08 and GEN-11 through the **unchanged P-00 capture script**, each at DPR 1 and 2,
from the same pre-Part-A production app as P-00a. Both complete runs exited 0 (hc t2jj); their
4-case `functional.json` files are **byte-identical**, SHA-256
`365fc90b097376e170be0ad669debe8eeb81cd28b858b63b4988851f52e401c9`.

- App: `d53ae0a5c6a4b000c01ec83d487d608bc3f11895`; source equals planning base `b10d0d3`.
- Chrome for Testing **157.0.8103.39**, pinned worktree Playwright **1.63.0**, headless; 1440×900,
  dark theme, DPR 1 and 2. No installed Chrome, npx driver or IDB shim.
- Same source-bound interim identity as P-00a: commit + emitted-file hashes. Both emitted manifests
  exactly equal `../baselines/P-00a-build-identity.json` (SHA-256
  `f890bcc3edcccb7d3c589b0b065b694143987f02ca606d7a600bb646ed3201a5`). V-01a adoption remains pending.
- No product edit, capture-script change or fixture adaptation. The parent directed this capture.
  GEN-08 source is p-f's **95e85dc**; GEN-11 source **d48358d**. Both imported unchanged from that lane.
  The parent's `9c19a5a6…` identity is GEN-11's **PDF SHA**, not a Git commit.

The generator inputs are frozen locally at `9672efc`. With Node26.0.0/zlib1.2.12 and seed1346651697,
two fresh generations (`W/scratch/p-a/p00b-corpus-a`, `p00b-corpus-b`) produced identical PDF and
oracle JSON bytes. Their four manifest entries were imported from p-f's manifest; no unrelated P-11
fixture entries were imported.

| Fixture | Pages | PDF bytes | SHA-256 |
|---|---:|---:|---|
| GEN-08 | 12 | 13,547 | `74c7441a53b5dd0fb552f692a9188a021dbbd34bc00e902325167ec2c47fb652` |
| GEN-11 | 6 | 6,973 | `9c19a5a6d0bc698762e554d332974d3ed8f713ec528d5955ac07e0ae510362d6` |

These are entirely authored diagnostic TrueType outlines/Type3 CharProcs and authored text,
not copied fonts/documents. Licence remains **NOASSERTION**, proposed **CC0-1.0**, awaiting the owner.
GEN-11 is marked repairable because its final two pages deliberately contain malformed/cyclic
structure metadata; they are not a successful accessibility oracle.

## Old behavior recorded

Both DPRs produced the same strings/counts and no page errors. Every PDF source hash stayed unchanged.
All copy gestures have the same live-selection/sentinel witnesses as P-00a.

| Observation | GEN-08 | GEN-11 |
|---|---|---|
| Title clipboard length | 31 | 30 |
| Two-line clipboard length | 88 | 88 |
| Cross-page clipboard length | 69 | 65 |
| Native Select All clipboard length | 582 | 716 |
| Select All classification | Known-bad: app chrome included | Known-bad: app chrome included |
| Real stored Text record | Manual schema1, page0/offset0, revision1 | Manual schema1, page0/offset0, revision1 |

- GEN-08's full native Select All preserves the logical Arabic `سبب`, Hebrew `אבג` beside the
  authored LTR/digit run, CJK `日本三月`, combining `e\u0301`, `🙂` and `👩‍💻`. The full strings and code
  points remain in the JSON; no normalization of the captured string was added by the harness.
- Both original `office` probes are found by the **browser DOM find engine** (pages7/8). The actual
  Text find form reports **one** match (page7) after searching all12 physical pages; the presentation
  ligature is not folded there. Five pages are reported partial/unavailable. Expected correct count2
  remains beside this old witness, rather than turning the old miss into the desired golden.
- GEN-11's unmapped Type3 selection produces **U+0081/U+0082/U+0083**, not the desired U+FFFD/partial
  representation; its independently mapped control produces `ABC`. Both draw the same authored
  CharProcs in the inspected first-page screenshot. This is old behavior, not a corrected encoding.
- Original DOM find and Text's real form both report **1 / 1 / 0** for `NESTED-FORM-TEXT`,
  `DRAWN-TOKEN`, `REPLACEMENT-TOKEN`. Text finishes all6 pages, with one partial/unavailable page.
  ActualText is not silently substituted; no complete tagged-PDF accessibility claim is made.
- First-page fitted boxes are1120×1449.40625 CSSpx, from612×792-point source boxes. Dark-pixel counts
  are9782/37943 (GEN08 DPR1/2) and20206/78647 (GEN11 DPR1/2); actual glyph ink is visible in the
  inspected first-page captures. This does not assert every nonembedded CID fallback glyph painted.

Primary records: `../baselines/P-00b-functional.json`. Independent per-page source/logical strings,
glyph mapping/geometry, caret intervals and structure controls remain in the frozen generator oracle,
not inferred from these old outputs. This package uses the requested common capture; it does not
claim the later per-page emphasis, fallback-font, caret or accessibility gates.

## Screenshot provenance and a bounded difference

All functional records and7 of8 PNGs are identical across the two runs. The GEN-08 DPR2 Original
PNG differs at **5 device pixels**, within CSS bounds `[517,508]–[619,535]` inside the Arabic ink.
This was checked by decoding the two PNG scanlines with the standard-library zlib path; the whole
canvas dark-pixel count stayed37943 and every functional field was identical. No product diagnosis
is inferred from a screenshot/compositor difference.

Both image-hash manifests are retained, not retried until a chosen image happened to match:

- `../baselines/P-00b-landmarks-a.json`:
  `6d7378ea1bc50c498f219758ff8893b729142367773575d493526f2a52cebaac`.
- `../baselines/P-00b-landmarks-b.json`:
  `3ae57148f82fd16a0dfae0f4a80b593b23d9fc6808b75c2f0f9bba18775e258b`.

PNG bytes stay in `W/scratch/p-a/p00b-capture-{1,2}`. This is **not** a pixel-exact screenshot or
hardware-GPU acceptance claim; the difference is explicitly handed to p-lead with this report.

## Replay and checks

Use the P-00 README's locked generator/capture recipe, adding:

```sh
node verify/fixtures/pdf/generators/rtl-cjk-unicode.mjs --out "$CORPUS" --seed 1346651697
node verify/fixtures/pdf/generators/type3-tagged-text.mjs --out "$CORPUS" --seed 1346651697
# Run the unchanged capture against the frozen baseline DIST with:
# --only rtl-cjk-unicode,type3-tagged-text
```

Completed local pair: `sh W/scratch/p-a/capture-b.sh a 1` and `... b 2`, each under `bme-lock run`
(weight1), with the static server owned/closed by that run. `typecheck` and `lint` both passed after
the fixture import and domain merge (hc t2jk). No p-a listener remained on6380–6399. The runner's
unchanged whole-PdfPane-boot-fault prerequisite control is documented by P-00a; no new product
logic mutant or semantic acceptance gate is claimed by this data-only capture.

Native Meta+F still has the P-00a loss: trusted/defaultPrevented=false plus labelled `window.find`
diagnostics, **not native-toolbar automation**. No timing, scroll-hole, save-latency, real-device,
authorized-original, second-host or complete accessibility sign-off is claimed. Shared identity/helper
adoption is still pending; next assigned package is P-01 (D1).
