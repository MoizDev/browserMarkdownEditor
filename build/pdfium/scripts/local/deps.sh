#!/bin/bash
set -euo pipefail
export HOME=/toolchain/home
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0
export DEPOT_TOOLS_UPDATE=0 DEPOT_TOOLS_METRICS=0
export CIPD_CACHE_DIR=/toolchain/cipd-cache
export VPYTHON_VIRTUALENV_ROOT=/toolchain/vpython-root
mkdir -p "$HOME" /toolchain/work
if [ ! -d /toolchain/depot_tools/.git ]; then
  git init --quiet /toolchain/depot_tools
  git -c credential.helper= -C /toolchain/depot_tools fetch --depth=1 --no-tags https://chromium.googlesource.com/chromium/tools/depot_tools.git a03dfbf7f2d1cefa2795d81d59ca4f16c8616a8f
  git -C /toolchain/depot_tools checkout --quiet --detach a03dfbf7f2d1cefa2795d81d59ca4f16c8616a8f
fi
if [ "$(git -C /toolchain/depot_tools rev-parse HEAD)" != a03dfbf7f2d1cefa2795d81d59ca4f16c8616a8f ]; then echo 'depot_tools pin drift' >&2; exit 1; fi
if [ ! -d /toolchain/work/pdfium/.git ]; then
  mkdir -p /toolchain/work/pdfium
  tar -C /work/source/pdfium -cf - . | tar -C /toolchain/work/pdfium -xf -
fi
if [ "$(git -C /toolchain/work/pdfium rev-parse HEAD)" != 6688c576fd851f4159c6fae39396da50939de110 ]; then echo 'PDFium pin drift' >&2; exit 1; fi
if ! git -C /toolchain/work/pdfium remote get-url origin >/dev/null 2>&1; then
  git -C /toolchain/work/pdfium remote add origin https://pdfium.googlesource.com/pdfium.git
fi
if [ "$(git -C /toolchain/work/pdfium remote get-url origin)" != https://pdfium.googlesource.com/pdfium.git ]; then echo 'Unexpected PDFium source remote' >&2; exit 1; fi
export PATH=/toolchain/depot_tools:$PATH
cd /toolchain/work
printf '%s\n' \
  'solutions = [{"name": "pdfium", "url": "https://pdfium.googlesource.com/pdfium.git", "managed": False, "custom_deps": {"third_party/llvm-build/Release+Asserts": None, "third_party/rust-toolchain": None, "build/linux/debian_bullseye_arm64-sysroot": None, "buildtools/linux64-format": None, "third_party/cpython3/linux-amd64": None, "third_party/siso/cipd": None, "tools/skia_goldctl/linux": None, "tools/resultdb": None, "third_party/instrumented_libs": None, "third_party/test_fonts": None}, "custom_vars": {"checkout_configuration": "minimal", "checkout_rust": False, "checkout_clang_coverage_tools": False, "checkout_clang_tidy": False, "checkout_clangd": False, "download_remoteexec_cfg": False}}]' \
  'target_os = ["emscripten"]' > .gclient
# No hooks: no floating LLVM/sysroot, corpus, browser, or native test execution.
gclient sync --nohooks --no-history --shallow --jobs 4 --revision pdfium@6688c576fd851f4159c6fae39396da50939de110
gclient revinfo --actual --output-json /work/deps-revinfo.actual.json
python3 - <<'PY'
import json
from pathlib import Path
expected = json.loads(Path('/work/deps-revinfo.json').read_text())
actual = json.loads(Path('/work/deps-revinfo.actual.json').read_text())
if expected != actual:
    raise SystemExit('Resolved Git/CIPD materials differ from the locked development inputs')
PY
cp .gclient /work/gclient-input.txt
du -sk /toolchain/work /toolchain/depot_tools /toolchain/cipd-cache /toolchain/vpython-root > /work/deps-disk-kib.txt
