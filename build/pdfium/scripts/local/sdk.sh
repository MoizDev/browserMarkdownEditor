#!/bin/sh
set -eu
export HOME=/toolchain/home
export SDK_ROOT=/toolchain/emsdk
mkdir -p "$HOME" /toolchain/emscripten-cache
if [ ! -d "$SDK_ROOT/.git" ]; then
  mkdir -p "$SDK_ROOT"
  tar -C /work/source/emsdk --exclude='./node' --exclude='./upstream' --exclude='./downloads' --exclude='./.emscripten' -cf - . | tar -C "$SDK_ROOT" -xf -
fi
if [ "$(git -C "$SDK_ROOT" rev-parse HEAD)" != d223ae73c6998296e3ab27cf81dc2c2c9fd383de ]; then echo 'emsdk source pin mismatch' >&2; exit 1; fi
mkdir -p "$SDK_ROOT/downloads"
# Reuse the one complete pinned archive fetched before the VirtioFS failure.
if [ -f /work/source/emsdk/downloads/node-v22.16.0-linux-arm64.tar.xz ] && [ ! -f "$SDK_ROOT/downloads/node-v22.16.0-linux-arm64.tar.xz" ]; then
  cp /work/source/emsdk/downloads/node-v22.16.0-linux-arm64.tar.xz "$SDK_ROOT/downloads/"
fi
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0
export EMSDK_KEEP_DOWNLOADS=1 EMSDK_NUM_CORES=4 EMSDK_NOTTY=1
export EM_CACHE=/toolchain/emscripten-cache
cd "$SDK_ROOT"
python3 - <<'PY'
import json
from pathlib import Path
pin = json.loads(Path('emscripten-releases-tags.json').read_text())['releases']['6.0.0']
if pin != '772bb4648be4a897ca062d6adc65bc70223d2703':
    raise SystemExit('SDK release-toolchain pin drift')
PY
# Fetch/verify the two locked downloads separately before this offline phase.
# Run this container without networking so the installer cannot substitute them.
export BME_SDK_LOCK=/work/sdk-lock.json
python3 /work/verify-sdk.py
python3 emsdk.py install 6.0.0
python3 emsdk.py activate 6.0.0
# Installed tool versions are input identity, not an engine/API check.
. ./emsdk_env.sh
export EM_CACHE=/toolchain/emscripten-cache
emcc --version > /work/emcc-version.txt
"$SDK_ROOT/upstream/bin/clang" --version > /work/clang-version.txt
"$SDK_ROOT/upstream/bin/wasm-opt" --version > /work/binaryen-version.txt
node --version > /work/node-version.txt
BME_SDK_INSTALLED=1 python3 /work/verify-sdk.py
