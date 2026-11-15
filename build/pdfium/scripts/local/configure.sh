#!/bin/bash
set -euo pipefail
export HOME=/toolchain/home
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0
export EMSDK_QUIET=1
source /toolchain/emsdk/emsdk_env.sh
export EM_CACHE=/toolchain/emscripten-cache
export PATH=/toolchain/work/pdfium/buildtools/linux64:/toolchain/work/pdfium/third_party/ninja:/toolchain/depot_tools:$PATH
export DEPOT_TOOLS_UPDATE=0 DEPOT_TOOLS_METRICS=0
cd /toolchain/work/pdfium
if [ ! -L third_party/emsdk ]; then
  if [ -e third_party/emsdk ]; then echo 'Unexpected SDK entry in source tree' >&2; exit 1; fi
  ln -s /toolchain/emsdk third_party/emsdk
fi
if [ "$(readlink third_party/emsdk)" != /toolchain/emsdk ]; then echo 'SDK source link drift' >&2; exit 1; fi
if [ ! -f .b0-gn-patches ]; then
  git apply --check /work/patches/pdfium-wasm.patch
  git -C build apply --check /work/source/recipe/patches/wasm/build.patch
  git -C build apply --check /work/source/recipe/patches/clang_rt.patch
  git apply /work/patches/pdfium-wasm.patch
  git -C build apply /work/source/recipe/patches/wasm/build.patch
  git -C build apply /work/source/recipe/patches/clang_rt.patch
  mkdir -p build/config/wasm
  cp /work/source/recipe/patches/wasm/config.gn build/config/wasm/BUILD.gn
  # Header staging patches are intentionally absent: zero PDFium C++ edits.
  sha256sum /work/source/recipe/patches/wasm/pdfium.patch /work/patches/pdfium-wasm.patch /work/source/recipe/patches/wasm/build.patch /work/source/recipe/patches/clang_rt.patch /work/source/recipe/patches/wasm/config.gn > .b0-gn-patches
fi
python3 /work/remove-obsolete-gn-arg.py
cp .b0-gn-patches /work/b0-patch-hashes.txt
sha256sum /work/patches/standalone-wasm-allocator.patch >> /work/b0-patch-hashes.txt
git diff --name-only > /work/b0-pdfium-changed-paths.txt
git diff > /work/b0-pdfium-build-files.patch
git -C build diff > /work/b0-chromium-build-files.patch
if git diff --name-only | grep -E '\.(cc|cpp|c|h)$'; then echo 'Renderer source modification refused' >&2; exit 1; fi
if git -C build diff --name-only | grep -E '\.(cc|cpp|c|h)$'; then echo 'Compiler-support source modification refused' >&2; exit 1; fi
mkdir -p out/b0
printf '%s\n' \
  'is_debug = false' \
  'is_component_build = false' \
  'is_clang = false' \
  'use_custom_libcxx = false' \
  'treat_warnings_as_errors = false' \
  'pdf_is_standalone = true' \
  'pdf_is_complete_lib = true' \
  'pdf_enable_v8 = false' \
  'pdf_enable_xfa = false' \
  'pdf_use_skia = false' \
  'pdf_use_agg = true' \
  'pdf_use_partition_alloc = false' \
  'pdf_use_libyuv = false' \
  'target_cpu = "wasm"' \
  'target_os = "emscripten"' \
  'use_siso = false' \
  > out/b0/args.gn
gn --version > /work/gn-version.txt
ninja --version > /work/ninja-version.txt
gn gen out/b0 --fail-on-unused-args
cp out/b0/args.gn /work/b0-args.gn
gn desc out/b0 //core/fxcrt:fxcrt > /work/b0-gn-target.txt
ninja -C out/b0 -t targets all > /work/b0-ninja-targets.txt
if ! grep -Fxq 'core/fxcrt:fxcrt: phony' /work/b0-ninja-targets.txt; then echo 'Exact fxcrt Ninja target missing' >&2; exit 1; fi
ninja -C out/b0 -t commands 'core/fxcrt:fxcrt' > /work/b0-compile-commands.txt
if grep -E '(^| )-O3( |$)' /work/b0-compile-commands.txt; then echo 'Unplanned O3 compilation refused' >&2; exit 1; fi
printf '%s\n' 'core/fxcrt:fxcrt' > /work/b0-target.txt
