#!/bin/bash
set -euo pipefail
python3 - <<'PY'
from pathlib import Path
import shutil
sdk=Path('/toolchain/emsdk/upstream/emscripten')
pdf=Path('/toolchain/work/pdfium')
work=Path('/work')
paths=[sdk/'system/lib/dlmalloc.c', pdf/'third_party/freetype/src/include/freetype/freetype.h', pdf/'third_party/freetype/src/src/bdf/README', pdf/'third_party/freetype/src/src/pcf/README', pdf/'third_party/freetype/src/src/base/fthash.c', pdf/'third_party/freetype/src/src/gzip/zlib.h']
for p in paths:
    if not p.is_file(): raise SystemExit(f'Missing runtime notice input: {p}')
    if p.is_relative_to(sdk): out=work/'inputs/licenses/emscripten'/p.relative_to(sdk)
    else: out=work/'inputs/licenses/pdfium'/p.relative_to(pdf)
    out.parent.mkdir(parents=True,exist_ok=True)
    shutil.copyfile(p,out)
PY
