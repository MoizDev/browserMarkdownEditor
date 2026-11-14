# P1-dev step a: development engine supply

No engine bytes belong in the checkout or a production build. The manifest is
`src/pdf/engine/dev/manifest.json`; `fetch-dev-artefact.mjs` downloads only its
pinned public archive, verifies its exact length and SHA-256 before atomic
publication, and verifies the cache and the extracted glue/WASM on every reuse.
A corrupt cache refuses rather than silently replacing bytes used by another
lane. Every engine tool/output path below is outside the repository.

## Fetch

```sh
node verify/pdf/engine/fetch-dev-artefact.mjs --out-dir /absolute/scratch/engine
```

Repeat the command: `cached: true`, no network download. `--archive /local.tgz`
uses a local candidate instead of downloading, useful for the build-refusal
witness: change one byte of a copy and use a **fresh** scratch output directory.
It must exit nonzero and publish no archive/assets. Neither a length mismatch
nor a hash mismatch is a recoverable cache hit. Extracted files live at
`<out-dir>/<archive-sha>/lib/pdfium.{js,wasm}`.

## Loader interface (worker-private)

`devPdfiumAssets()` returns the committed identity/hashes and same-origin URLs
under `<BASE_URL>__bme_pdfium_dev/<archive-sha>/`. The privileged pool fetches and
verifies bytes; **only its opaque frame compiles the WASM**.
`createDevPdfiumRuntimeSource()` supplies a self-contained classic-worker prefix,
which installs `globalThis.instantiateDevPdfium`. That function accepts:

```ts
{ compiledModule: WebAssembly.Module, glueSource: string,
  role: 'render' | 'writer', onAbort?: (reason: string) => void }
```

It resolves to `{ module, instance, buildId, HEAPU8, HEAPU32, HEAP32, HEAPF32,
HEAPF64 }`. Every heap property is a fresh-view getter; reread after native calls
that can allocate. Raw native exports/instance never leave the worker. The typed
adapter must call only the plan's export allowlist. `instantiateDevPdfium` is also
exported for a caller that already executes inside a classic worker.

Both glue and WASM identity are checked by the trusted pool before transfer;
the opaque worker has no `crypto.subtle` and checks glue length, not its hash.
Instantiation intercepts the resize import **before** the instance captures it. Both stock geometric growth's
maximum and the actual JS grow helper are clamped. The immutable render policy is
1 GiB; writer policy is 3.5 GiB, but this prebuilt's 2 GiB binary maximum is the
actual effective writer ceiling. Failed initialization poisons the worker: the
host must terminate it. No product startup PDF/API self-check is added.

The Node-only Vite plugin is `build/pdfiumDevAssets.ts`; I-3 wires it into the
shared config and includes `build` in TypeScript. Set
`BME_DEV_ENGINE_DIR=/absolute/scratch/engine` only when supplying the local engine.
The plugin does not read this variable/manifest/assets in production build mode.

## What this package proves

Supply evidence is the fetched archive's exact hash/length manifest and the
production-byte gate below. **Rendering and initialization evidence starts at
P3 through the real document pane.** No in-page module bootstrap, direct native
API check, hidden diagnostic route, or isolated engine script is a permitted
substitute, whether placed in the repository or in scratch. This package makes
no rendering, callback ABI, memory-capacity or containment-security claim.

## BLD-DEV-G1: production network scan and forced-on mutant

These commands must take the machine's build/run/serve grants. Run from a clean,
committed lane; choose fresh scratch directories. `build-scan-app.mjs` archives
that exact commit into scratch, gives it its **own** `npm ci`, adds only a served
Rollup output inventory to the scratch config, and builds with production mode.
Its final output graph (including HTML) and copied public source assets also
produce `served-identity.json` outside the app: exact SHA/length per file, source
commit, and mutant identity. This expectation is not read back from `dist`.

```sh
BME_DEV_ENGINE_DIR=/absolute/scratch/engine bme-lock build -- node \
  verify/pdf/P1-dev-a/build-scan-app.mjs /absolute/scratch/p1-clean
BME_DEV_ENGINE_DIR=/absolute/scratch/engine bme-lock build -- node \
  verify/pdf/P1-dev-a/build-scan-app.mjs /absolute/scratch/p1-mutant --mutant
```

For each arm, use that scratch app's `vite preview --config <printed-config>
--port <seat-port> --strictPort` under `bme-lock serve`, then:

```sh
bme-lock run -- node verify/pdf/P1-dev-a/scan-production.mjs \
  http://localhost:<seat-port>/ /absolute/scratch/scan \
  /absolute/scratch/p1-clean/served-identity.json
```

Clean must exit 0. Mutant must exit 1 **with a recorded contamination violation**,
not from a browser crash/identity/setup error. Stop preview after each arm.

- **Witness:** the real app welcome screen paints; the browser fetches every
  output-graph file, including unvisited lazy chunks and unreferenced emitted
  assets. The scan reads response bodies from its network log, never `dist`.
- **Identity:** independently recorded build-output expectations, served inventory's
  commit, pinned Chrome/Playwright, every fetched file's SHA/length/URL (including
  `.mjs`/`.wasm`), and source-mutation SHA. Every required response is awaited and
  compared with its expected bytes; a missing/wrong body fails closed. Use the
  mutant's own `served-identity.json` for the mutant arm.
- **Mutant:** in the scratch source only, force on all three loader dev guards and
  the asset plugin's production guard. Since the engine zone is still dark before
  P3, a scratch-only importer makes the forced loader reachable. Every source
  match is asserted before patch/build. The scan must detect the real glue/WASM
  hashes and/or the dev build ID/development marker.
- **False pass:** inspecting only the welcome screen's eagerly loaded chunks can
  miss leaked assets. An intentionally unreachable mutant proves nothing; its
  importer and the received contaminated bytes are required.
- **Loss:** the scratch importer proves the supply-stage scanner, not DCE through
  P3's future importer. Repeat with that real importer when wired. The inventory
  covers this build graph, not arbitrary server filesystem contents. Interim
  `route.fetch` interception captures raw APIResponse bytes (CDP text-body reads
  re-encoded CSS on the pinned Chrome); decoded bodies are fulfilled unchanged,
  but interception changes HTTP caching. Replace with the shared identity toolbox
  when its raw-body handling is ready. No init-refusal/provenance claim is made.

## BLD-DEV-G2: not yet runnable

The full production init-refusal gate requires P3's engine host and its real
`engine.init`/`doc.open` traffic. This package adds no hidden diagnostic API or
fake host to manufacture that witness. When P3 exists, serve its production app,
substitute this dev artifact at the engine URL with `page.route`, and require
`EngineBroken`, no accepted `doc.open`, plus a healthy positive control and a
scratch-source accepted-ID mutant that reaches document acceptance. Until then
G2 is **NOT YET RUNNABLE**, not passed. Production's absent assets/compiled-out
loader guards are only the supply-side part, not an initialization proof.
