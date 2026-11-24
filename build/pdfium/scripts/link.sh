#!/bin/bash
set -euo pipefail
export HOME=/toolchain/home EMSDK_QUIET=1
source /toolchain/emsdk/emsdk_env.sh
export EM_CACHE=/toolchain/emscripten-cache EMCC_CORES=4 BINARYEN_CORES=4
export LC_ALL=C.UTF-8 TZ=UTC
python3 - <<'PY'
import hashlib,json,os,subprocess
from pathlib import Path
work=Path('/work')
settings=json.loads((work/'build-settings.json').read_text())
sdk=Path('/toolchain/emsdk/upstream/emscripten')
core=sdk/'src/lib/libcore.js'
hash=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
current=hash(core)
if current==settings['originalLibcoreSha256']:
    core.write_bytes((work/'patches/libcore.js.patched').read_bytes())
elif current!=settings['patchedLibcoreSha256']:
    raise SystemExit('Refusing drifted Emscripten role-patch input')
if hash(core)!=settings['patchedLibcoreSha256']:
    raise SystemExit('Role patch output mismatch')
(work/'link').mkdir(exist_ok=True)
if (work/'link.complete').exists():
    raise SystemExit('Link already complete; keep this single build, do not re-run it')
args=['em++','-O2','--no-entry','-lexports.js','--pre-js','/work/role-pre.js','-Wl,--Map=/work/link/pdfium.map']
for key,value in settings['settings'].items():
    args.append(f'-s{key}={json.dumps(value,separators=(",",":"))}')
args += ['/toolchain/work/pdfium/out/b0/obj/libpdfium.a','-o','/work/link/pdfium.mjs']
(work/'link-command.json').write_text(json.dumps(args,indent=2)+'\n')
env=dict(os.environ,SOURCE_DATE_EPOCH=settings['sourceDateEpoch'])
subprocess.run(args,env=env,check=True)
subprocess.run(['/toolchain/emsdk/upstream/bin/wasm-dis','/work/link/pdfium.wasm','-o','/work/link/pdfium.wat'],check=True)
# Source files are runtime notice inputs, not evidence of executed callbacks.
for source in ['src/lib/libexports.js','LICENSE']:
    p=sdk/source
    out=work/'inputs/sdk'/p.name
    out.write_bytes(p.read_bytes())
(work/'link.complete').write_text(settings['buildId']+'\n')
PY
