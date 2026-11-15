#!/bin/bash
set -euo pipefail
export HOME=/toolchain/home EMSDK_QUIET=1
source /toolchain/emsdk/emsdk_env.sh
export EM_CACHE=/toolchain/emscripten-cache
source=/toolchain/work/pdfium
sdk=/toolchain/emsdk/upstream/emscripten
mkdir -p /work/inputs/headers /work/inputs/sdk /work/inputs/licenses
cp "$source"/public/*.h /work/inputs/headers/
cp "$sdk"/src/settings_internal.js "$sdk"/tools/link.py "$sdk"/emcc.py /work/inputs/sdk/
cp "$sdk"/src/lib/libcore.js /work/inputs/sdk/libcore.js.original
emcc -I "$source/public" -Xclang -fdump-record-layouts-complete -fsyntax-only /work/abi.c > /work/abi-layout.txt
# Preserve complete upstream texts/source-credit headers. The dependency
# reconciliation and final NOTICE generation run after this material stage.
python3 - <<'PY'
from pathlib import Path
import shutil
src=Path('/toolchain/work/pdfium')
sdk=Path('/toolchain/emsdk/upstream/emscripten')
dst=Path('/work/inputs/licenses')
paths=[src/'LICENSE']
for root in [src/'third_party', sdk/'system/lib', sdk]:
    if root == sdk:
        paths += [root/'LICENSE']
        continue
    paths += [p for p in root.rglob('*') if p.is_file() and (p.name.upper().startswith(('LICENSE', 'COPYING', 'COPYRIGHT', 'FTL.')) or p.name in ('README.ijg', 'NOTICE', 'NOTICE.txt')) and '.git' not in p.parts]
# Header-only notices and embedded font-data credits are distribution inputs too.
paths += [src/'third_party/agg23/agg_array.h', src/'third_party/lcms/src/include/lcms2.h', src/'third_party/libopenjpeg/src/openjpeg.c', src/'third_party/zlib/zlib.h']
paths += list((src/'core/fxge/fontdata').rglob('*.cpp'))
paths += list((src/'core/fxge/fontdata').rglob('*.h'))
for p in sorted(set(paths)):
    if not p.is_file():
        raise SystemExit(f'Missing notice input: {p}')
    if p.is_relative_to(src): rel=Path('pdfium')/p.relative_to(src)
    else: rel=Path('emscripten')/p.relative_to(sdk)
    target=dst/rel
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(p,target)
PY
printf 'metadata ready\n' > /work/prepare-link.complete
