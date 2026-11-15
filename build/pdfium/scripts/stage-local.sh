#!/bin/sh
# Prepare a NEW local arm64 staging directory for build/pdfium/rebuild.sh. No build, network,
# container, registry, repository or publication action happens here.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
stage=${BME_STAGE_ROOT:?Set BME_STAGE_ROOT to a new absolute directory outside the repository}
case "$stage" in /*) ;; *) echo 'BME_STAGE_ROOT must be absolute' >&2; exit 1 ;; esac
name=$(basename -- "$stage")
case "$name" in .|..|/|'') echo 'Invalid staging directory name' >&2; exit 1 ;; esac
parent=$(CDPATH= cd -P -- "$(dirname -- "$stage")" && pwd)
stage=$parent/$name
case "$stage/" in "$root/"*) echo 'Stage outside this repository' >&2; exit 1 ;; esac
if [ -e "$stage" ] || [ -L "$stage" ]; then echo 'Refusing to overwrite existing stage' >&2; exit 1; fi
mkdir "$stage"
mkdir "$stage/material" "$stage/engine-build" "$stage/engine-output" "$stage/material/patches"
cp "$root"/locks/* "$stage/material/"
cp "$root"/scripts/local/* "$stage/material/"
cp "$root"/patches/gn/* "$stage/material/patches/"
for name in abi.c compile.sh prepare-link.sh collect-runtime-notices.sh generate-inputs.mjs link.sh package.mjs role-pre.template.js; do
  cp "$root/scripts/$name" "$stage/engine-build/$name"
done
printf '%s\n' 'Stage created.'
