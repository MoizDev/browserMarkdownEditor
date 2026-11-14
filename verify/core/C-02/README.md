# C-02 / D01: a walk permit is local I/O, not a subtree

Only real-app headless-browser gates: native OPFS files, the rendered explorer, actual picker
buttons and observer records. No app-module imports, extracted walker, test runner or in-file tests.
Chrome for Testing 157.0.8103.39 and Playwright 1.63.0 are asserted; no IndexedDB shim. Every fixture
uses a fresh browser context, named picker root and en-US locale.

## Outside witnesses and loss

`browser.mjs` wraps native directory iteration before navigation. A completed walk needs its named
vault switcher, no welcome screen, every expected expanded DOM path (including the final row), peak
concurrent enumerations <=12 and zero outstanding enumerators. An empty tree uses the switcher and
absent welcome as its completion signal. A quiet counter alone is NOT completion: the broken walk
has zero native work in flight while all permits are held by parents awaiting children.

- `repro.mjs`: 11 parents with Sub, 12 parents with Sub, chain13, binary depth4, 64 leaf folders.
  `--all` additionally opens 0, 1 and 10,000 leaf folders (the last has 20,000 DOM paths). Every open
  fixture must match its FULL manifest. `--peak 1` strengthens the one-slot proof.
- `watcher.mjs`: actually observes a successful native subscription before external writes, adds
  twelve nested folders, then a separate `after.md`. Both publication and the later batch must arrive.
- `adversarial.mjs`: iterator rejects after one yielded entry; old root/tree remain coherent; a
  second vault opens in the SAME app. Hidden .Assets/.Garbage/.git are never enumerated, a local
  .appearance.json colours the file icon, and a kept row has the same DOM object and zero observed
  mutations across an external change elsewhere. This observes DOM preservation, not React's
  internal scheduler/render count.
- `order.mjs`: capture ordered DOM paths on the UNFIXED production build for hostile case/accent/
  digit/CJK/emoji/dot names and 10,000 sibling files. `--reference` asserts byte-for-byte path-order
  equality on the cached-collator build. The hostile fixture also makes changed sensitivity visible.

Loss: OPFS is not native disk/FSEvents. This gate does not prove all possible switch/rescan races,
all Unicode/locales, OS permission modes, or every input interleaving. It does not measure elapsed
performance; 5 seconds is the known-small-fixture stall observation window, not a speed target.
The 10,000-entry fixture gets a 60-second functional deadline but the same exact-manifest assertion.

## Commands

Use the integrator's HOWTO. Every install/build/static/server/browser command needs bme-lock, and
slow commands run in an hc background terminal. Previews run ONLY around their browser invocation.
Ports6301 here belong to c-b. The scratch config imports this lane's normal Vite config, sets this
worktree as root and private cacheDir/outDir; never npm run build or a shared node_modules.

```sh
L=/Users/adham/Developer/bme-impl/scratch/bin/bme-lock
S=/Users/adham/Developer/bme-impl/scratch/c-b/C-02
# Run builds from the lane checkout; --outDir selects the artifact to preserve.
"$L" build -- ./node_modules/.bin/vite build --config "$S/vite.config.mjs" --outDir "$S/candidate-dist"
# Start matching preview separately, with --strictPort:
"$L" serve -- ./node_modules/.bin/vite preview --config "$S/vite.config.mjs" --outDir "$S/candidate-dist" --host 127.0.0.1 --port 6301 --strictPort
# Then, from the installed lane checkout:
"$L" run -w 2 -- node verify/core/C-02/repro.mjs --all --url http://localhost:6301/ --result "$S/candidate-repro.json"
"$L" run -- node verify/core/C-02/watcher.mjs --url http://localhost:6301/ --result "$S/candidate-watcher.json"
"$L" run -- node verify/core/C-02/adversarial.mjs --url http://localhost:6301/ --result "$S/candidate-adversarial.json"
"$L" run -w 2 -- node verify/core/C-02/order.mjs --url http://localhost:6301/ --result "$S/candidate-order.json" --reference "$S/baseline-order.json"
```

The scratch scoped controllers start an hc serve child AFTER the run grant, wait for Vite readiness,
run these unchanged invocations, then stop/remove that server in finally. They never occupy a serve
slot while waiting for the run grant. The 10,000-node flows use weight2 conservatively.

## Unfixed witness and mutants

Before modifying listDir, the production baseline reproduced: 12-nested, chain13, binary4 each
stalled after 13 completed native enumerations with active0. 11-nested completed23; 64-wide completed65.
The watcher also stalled after13, old ready.md retained. Both scripts exit1 with `FAIL hand-count`;
these are genuine expected product failures, not a generic nonzero setup result.

`one-slot.patch` changes capacity to1 in a SCRATCH SOURCE COPY only; it does not change the shipped
constant. The fixed one-slot build must pass all eight manifests plus watcher and adversarial cases,
with peak<=1 on the manifest run. The same patch combined with `hold-through-recursion.patch` must
still deadlock the unfixed nested fixtures (11-nested too), while its wide control succeeds. That
contrast proves the fix does not depend on any spare permits.

`hold-through-recursion.patch` restores the old boundary. Its production build must fail the same
three nested fixtures while both controls still succeed, with the named `FAIL hand-count` reason.
All patches require git apply --check then apply; any setup/patch failure is invalid, not a kill.
Each scratch source has its own npm ci, production configuration and cache/output directories.

The cached-collator change is a SEPARATE commit. Its sensitivity mutant must fail `FAIL sort-order`
against the captured original DOM order; merely recording a nonzero exit is not evidence.
Static gates remain npm run typecheck and npm run lint, both through L static.
