#!/usr/bin/env bash
# Rebuild the app's PDFium engine from source, locally, in a native arm64 Linux container.
#
#   build/pdfium/rebuild.sh /absolute/new/stage-dir
#
# Needs docker (or CONTAINER=podman) running natively on arm64, about 40 GB free and several hours.
# Network is on only for the two fetch steps; SDK install, configure, compile and link run offline.
# The new engine lands in <stage>/engine-output/<buildId>/ with its manifest; see README.md to swap it in.
set -euo pipefail
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo=$(CDPATH= cd -- "$here/../.." && pwd)
stage=${1:?usage: rebuild.sh /absolute/new/stage-dir}
run=${CONTAINER:-docker}
image=bme-pdfium-build:local

BME_STAGE_ROOT="$stage" sh "$here/scripts/stage-local.sh"
M=$stage/material B=$stage/engine-build O=$stage/engine-output
"$run" volume create bme-pdfium-toolchain >/dev/null

# 1. The pinned build image (Debian snapshot; every installed package checked against locks/os-installed.tsv).
"$run" build --platform linux/arm64 -t "$image" -f "$here/Containerfile" "$here"
config=$("$run" image inspect --format '{{.Id}}' "$image")
c() { "$run" run --rm --platform linux/arm64 -v bme-pdfium-toolchain:/toolchain "$@" "$image" bash -lc "${cmd}"; }

# 2. Exact source, recipe and emsdk commits, then the SDK archives by size and SHA-256 (network on).
cmd='BME_MATERIAL_ROOT=/work sh /work/fetch-sources.sh && BME_SDK_LOCK=/work/sdk-lock.json BME_SDK_ARCHIVE_DIR=/toolchain/emsdk/downloads python3 /work/fetch-sdk.py' c -v "$M:/work"
# 3. Install the SDK offline; an unpinned download fails the step.
cmd='bash /work/sdk.sh' c --network none -v "$M:/work"
# 4. PDFium DEPS at the locked revisions (network on), then the locked GN/build patches offline.
cmd='bash /work/deps.sh' c -v "$M:/work"
cmd='bash /work/configure.sh' c --network none -v "$M:/work"
# 5. Compile and link offline against the app's own export allow-list, then package glue, WASM, ABI and notices.
cmd='bash /work/compile.sh && bash /work/prepare-link.sh && bash /work/collect-runtime-notices.sh && source /toolchain/emsdk/emsdk_env.sh &&
  BME_MATERIAL_ROOT=/materials BME_BUILD_DIR=/work BME_EXPORT_MAP=/repo/src/pdf/engine/pdfium/exports.json BME_CONTAINER_CONFIG_DIGEST='"$config"' node /work/generate-inputs.mjs &&
  bash /work/link.sh &&
  BME_MATERIAL_ROOT=/materials BME_BUILD_DIR=/work BME_EXPORT_MAP=/repo/src/pdf/engine/pdfium/exports.json BME_ENGINE_DIR=/output BME_MANIFEST_PATH=/output/manifest.json node /work/package.mjs' \
  c --network none -v "$B:/work" -v "$M:/materials:ro" -v "$repo:/repo:ro" -v "$O:/output"

# 6. Check the output offline: lengths, hashes, baked identity, exports/imports, ABI and notices.
built=$(ls -d "$O"/*/ | head -1)
node "$here/scripts/verify-artifact.mjs" --development "$built" "$O/manifest.json"
echo "New engine: $built  (manifest: $O/manifest.json). See build/pdfium/README.md to swap it in."
