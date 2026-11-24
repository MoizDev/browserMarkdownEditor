#!/bin/sh
set -eu
# Only immutable public source commits. No credentials, global Git rewrites,
# self-updaters, dependency hooks, branch/tag resolution or full engine build.
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_NOSYSTEM=1
export GIT_TERMINAL_PROMPT=0
# Explicit staging root keeps checkout material outside the repository itself.
ROOT=${BME_MATERIAL_ROOT:?Set BME_MATERIAL_ROOT to a dedicated writable staging directory}
mkdir -p "$ROOT/source"
fetch_source() {
  name=$1
  url=$2
  pin=$3
  directory=$ROOT/source/$name
  mkdir -p "$directory"
  if [ ! -d "$directory/.git" ]; then git init --quiet "$directory"; fi
  if ! git -C "$directory" cat-file -e "$pin^{commit}" 2>/dev/null; then
    git -c credential.helper= -C "$directory" fetch --depth=1 --no-tags "$url" "$pin"
  fi
  git -C "$directory" checkout --quiet --detach "$pin"
  actual=$(git -C "$directory" rev-parse HEAD)
  if [ "$actual" != "$pin" ]; then printf 'Source pin mismatch: %s\n' "$name" >&2; exit 1; fi
  printf '%s | %s | %s\n' "$name" "$actual" "$url"
  du -sk "$directory"
}
fetch_source emsdk https://github.com/emscripten-core/emsdk.git d223ae73c6998296e3ab27cf81dc2c2c9fd383de
fetch_source recipe https://github.com/bblanchon/pdfium-binaries.git 0dc8e9598ab4496f8620043ec2c3f2eabf4eea33
fetch_source pdfium https://pdfium.googlesource.com/pdfium.git 6688c576fd851f4159c6fae39396da50939de110
