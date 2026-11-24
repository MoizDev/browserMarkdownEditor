#!/bin/bash
set -euo pipefail
export HOME=/toolchain/home EMSDK_QUIET=1
source /toolchain/emsdk/emsdk_env.sh
export EM_CACHE=/toolchain/emscripten-cache
export PATH=/toolchain/work/pdfium/third_party/ninja:$PATH
cd /toolchain/work/pdfium
mode=${BME_BUILD_MODE:-development}
case "$mode" in
  development) unset SOURCE_DATE_EPOCH; epoch=unset ;;
  ship-candidate)
    epoch=$(git show -s --format=%ct HEAD)
    if [ "${SOURCE_DATE_EPOCH:-}" != "$epoch" ]; then echo 'SOURCE_DATE_EPOCH must equal the pinned source commit time' >&2; exit 1; fi ;;
  *) echo 'Unknown build mode' >&2; exit 1 ;;
esac
# The caller must use a clean output directory for an independent ship build.
# Ninja may resume the same interrupted compile; it must not import a shared cache.
ninja -C out/b0 -j4 pdfium
ninja -C out/b0 -t inputs obj/libpdfium.a > /work/archive-inputs.txt
ninja -C out/b0 -t commands obj/libpdfium.a > /work/archive-commands.txt
printf '%s %s\n' "$mode" "$epoch" > /work/compile.complete
