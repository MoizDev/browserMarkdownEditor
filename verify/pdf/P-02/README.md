# Classic PDF runtime assets (P-02)

These are headless-browser runs of the real production app, not module tests. Build and serve with
this seat's scratch Vite config under the run's build/serve locks. Every browser uses the pinned
Chrome for Testing path; until I-0 merges, set PLAYWRIGHT_MODULE to a Playwright 1.63.0 npx-cache
`index.mjs`. Every command that starts a browser holds `bme-lock run`.

```
node verify/fixtures/pdf/generators/codecs-minimal.mjs --out <fresh-fixtures> --seed 1346651697
node verify/pdf/P-02/view-codecs.mjs http://localhost:<port>/<base>/ <fresh-fixtures> <results>
```

`LOCAL_CODEC_WITNESSES=1` additionally reads four rights-unverified local witnesses at the absolute
planning evidence path, verifies their approved hashes, and labels each result accordingly. It
never copies or admits those bytes. No external request or download is needed. `DPR=2` covers the
second device ratio. `EXPECT_BROKEN=1` records the unfixed witness and requires at least one real
completed white blit with a decoder warning. Off-origin requests are aborted, but the request log
still records attempts (including the existing optional Google stylesheet).

## First unfixed witness

- Build: d53ae0a5c6a4b000c01ec83d487d608bc3f11895, production, Vite 7.3.1.
- Browser: Chrome for Testing 157.0.8103.39; driver Playwright 1.63.0 from npx cache (pre-I-0).
- Real gestures: named OPFS picker, Open Vault, each PDF's tree row, completed page blit.
- The generated CCITT G4 true/false variants both painted 0 dark pixels (780×780 canvas), and the
  worker sent null-image `obj` messages. Both logged missing `wasmUrl` / JBig2 initialization errors.
- Local JPX, JBIG2 symbol-offset and JBIG2 file-header witnesses also painted 0 dark pixels with
  decoder warnings. The old CCITT witness painted content but still logged decoder warnings.
- The authored CJK page was blank with CMap warnings. The genuine blank page remained blank with
  no decode warning. No visible page error was shown for the failures.
- Raw evidence and screenshots: `/Users/adham/Developer/bme-impl/scratch/p-e/baseline/`.
  The JPX screenshot was inspected: entirely white inside working page/navigation chrome.
- Generator outputs matched byte-for-byte across two independent output directories.

## Gate limits (not a full D2 sign-off)

This first slice observes View only. It does not yet establish independent reference crops for
JPX/JBIG2 or a CJK glyph-outline oracle; merely nonzero ink is not full fidelity. Annotate,
thumbnail and closed-agent raster, fault/retry, lazy network/no-write, large-image memory,
non-root/offline and mutants remain unproven until their runs are added. A gate without its working
mutant is unproven. The original build is the current white-page negative control, not a licence to
skip the later adapter-without-wasm and dropped-diagnostic mutant builds.
