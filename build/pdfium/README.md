# The PDFium engine: how it is built

The app ships one PDF engine, committed in `src/pdf/vendor/pdfium/`: Google's unmodified PDFium
(commit `6688c576fd851f4159c6fae39396da50939de110`, `chromium/8152`) built to WebAssembly with the
`bblanchon/pdfium-binaries` recipe (commit `0dc8e9598ab4496f8620043ec2c3f2eabf4eea33`, MIT, see
`RECIPE-LICENSE-MIT.txt`) and emsdk 6.0.0, with the changes in `patches/`. It exports exactly the
functions the app calls, listed in `src/pdf/engine/pdfium/exports.json` (139 PDFium functions plus
`malloc`/`free`). The same files load in `npm run dev` and in a production build;
`build/pdfiumAssets.ts` checks every byte against `manifest.json` and fails the dev server or
`npm run build` on any mismatch or missing file.

## Rebuild it

```sh
build/pdfium/rebuild.sh /absolute/path/to/a/new/stage-dir
```

Needs docker (or `CONTAINER=podman`) on an arm64 machine, about 40 GB of disk and several hours. It
builds the pinned image (`Containerfile`, packages checked against `locks/`), fetches the exact
sources and SDK by hash (the only two steps with network), installs, configures, compiles and links
offline, and verifies the result. Everything it needs is pinned in `locks/` and `patches/`;
`scripts/` holds each step. The committed engine was built this way; this script has not been run
since it was gathered into this folder.

## Swap in a new engine

1. Copy the new engine directory's files (`pdfium.wasm`, `pdfium.mjs`, `abi.json`, `NOTICE.txt`,
   `licenses/`) and its `manifest.json` into `src/pdf/vendor/pdfium/`, replacing the old ones. Keep
   `canonical-inputs.json` and `abi-layout.txt` from the same build as a record.
2. If the export list changed, the new build must have been made from the updated
   `src/pdf/engine/pdfium/exports.json`; the manifest's `canonicalExportMapSha256` must equal that
   file's SHA-256.
3. `npm run build`, then open, annotate, save and reopen a PDF in `npm run preview`.
