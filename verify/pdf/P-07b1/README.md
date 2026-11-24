# Original PDF find — P-07b1

`find.mjs` drives the real app in pinned Chrome for Testing through its OPFS picker stub. It opens
GEN-18-876 by tree click, checks that p450 has no text-layer spans, presses real Meta+F, types the
four authored remote sentinels, and checks the app input's focus, final key cancellation, `1 of 1`,
the physical page box, and one visible current-hit range with the expected text on p3/450/700/876.
It checks unchanged PDF bytes and zero uncaught page errors, and captures the visible find UI.

## Run

Install the pinned browser once (`node verify/install-browser.mjs`). Generate the fixtures into the
scratch folder, prepare the build (P-07a's preparation, shared), then run each theme. Defaults:
`BME_SCRATCH` = the scratch folder's `P-07a/<mode>`, `BME_FIXTURES` = `P-07b1/book`,
`BME_ROLE_FIXTURES` (portfolio arm) = `P-07b1/roles`, `BME_OUT` = `P-07b1/result`; set them to move
any of these. `BME_SCRATCH`/`BME_OUT` below are examples.

```sh
node verify/fixtures/pdf/generators/unique-textbook.mjs --out "$S/book" --seed 1346651697 --pages 876
BME_SCRATCH="$S/app" BME_MODE=production node verify/pdf/P-07a/prepare.mjs
for theme in dark light; do
  BME_SCRATCH="$S/app" BME_FIXTURES="$S/book" BME_OUT="$S/$theme" BME_THEME=$theme BME_DPR=1 \
    node verify/pdf/P-07b1/find.mjs
done
```

`BME_PORT` is any free port you choose (default 6404); theme is dark/light and DPR is 1/2. The
script owns server startup and cleanup in `finally`. Generated fixture bytes stay in scratch; PDF and
oracle hashes/lengths must match their admitted manifest records. Results include raw served-body
identity, the actual browser/driver pin, fixture records, live range observations and worker requests.

The pre-change baseline failed the named Original Meta+F witness: no app input and an uncancelled
trusted key. During development, an observer using `queueMicrotask` sampled cancellation *before*
React's capture listener: native dispatch can checkpoint microtasks between listeners. The observer
now retains the actual KeyboardEvent and reads `defaultPrevented` after the trusted press finishes.
The corrected baseline still fails, while the app-owned input and interception pass in the candidate.

## Scope and deferred review

This package's merge sanity check is clean typecheck/lint plus the real-app run,
with light/dark screenshots inspected. No more mutant, harness-fault or identity-proof reruns are
being built for review. Existing baseline/candidate evidence is retained.

The larger D7 R2–R8 matrix, copy-compatibility drags, StrictMode/hide lifecycle matrix, the three
P-07b1 mutants, and qualified R7/R8 timing remain owed to the post-K7 review phase. This script
claims reach on its four generated sentinels, not independent totals on real books, native-disk
behaviour, every keyboard/IME path, or qualified performance. Header/tab-focus Meta+F needs the
DocumentPane seam. Eager-layer removal and whole-document copy are P-07b2, not this package.
