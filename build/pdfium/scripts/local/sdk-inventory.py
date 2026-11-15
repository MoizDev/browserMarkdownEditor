import hashlib
import json
import pathlib
import os
import urllib.request

root = pathlib.Path('/work')
sdk = pathlib.Path(os.environ['SDK_ROOT'])
plan = json.loads((root / 'sdk-download-plan.json').read_text())
files = []
for archive in plan['archives']:
    path = sdk / 'downloads' / archive['file']
    if not path.is_file() or path.stat().st_size != archive['bytes']:
        raise SystemExit(f'SDK cached archive length mismatch: {path}')
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for part in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(part)
    files.append({**archive, 'sha256': digest.hexdigest()})
source_pin = 'afa15e0c56d1292e073c2c91bafc1d5e0cdf0dd3'
source_files = []
for name in ['src/lib/libcore.js', 'src/settings.js', 'system/lib/libc/sbrk.c']:
    url = f'https://raw.githubusercontent.com/emscripten-core/emscripten/{source_pin}/{name}'
    with urllib.request.urlopen(url, timeout=60) as response:
        upstream = response.read()
    installed = (sdk / 'upstream/emscripten' / name).read_bytes()
    if upstream != installed:
        raise SystemExit(f'SDK runtime differs from the pinned Emscripten source: {name}')
    path = root / 'source/emscripten-pinned' / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(upstream)
    source_files.append({'path': name, 'sourceUrl': url, 'sha256': hashlib.sha256(upstream).hexdigest(), 'bytes': len(upstream)})
inventory = []
for path in sorted(sdk.rglob('*')):
    relative = path.relative_to(sdk)
    if '.git' in relative.parts:
        continue
    if path.is_symlink():
        inventory.append({'path': str(relative), 'symlink': os.readlink(path)})
    elif path.is_file():
        digest = hashlib.sha256()
        with path.open('rb') as stream:
            for part in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(part)
        inventory.append({'path': str(relative), 'bytes': path.stat().st_size, 'mode': oct(path.stat().st_mode & 0o777), 'sha256': digest.hexdigest()})
serialized = json.dumps(inventory, separators=(',', ':')).encode() + b'\n'
(root / 'sdk-file-inventory.json').write_bytes(serialized)
lock = {'emsdkCommit': 'd223ae73c6998296e3ab27cf81dc2c2c9fd383de', 'version': '6.0.0',
        'toolchainId': '772bb4648be4a897ca062d6adc65bc70223d2703', 'architecture': 'arm64',
        'nativeVolume': 'bme-p-d-b0-toolchain', 'sdkRoot': str(sdk), 'fileInventorySha256': hashlib.sha256(serialized).hexdigest(),
        'fileInventoryEntries': len(inventory),
        'emscriptenSourcePin': source_pin, 'archives': files, 'criticalSourceFiles': source_files,
        'emccVersion': (root / 'emcc-version.txt').read_text(), 'nodeVersion': (root / 'node-version.txt').read_text(),
        'clangVersion': (root / 'clang-version.txt').read_text(), 'binaryenVersion': (root / 'binaryen-version.txt').read_text()}
(root / 'sdk-lock.json').write_text(json.dumps(lock, indent=2) + '\n')
print(json.dumps({'archives': len(files), 'compressedBytes': sum(item['bytes'] for item in files), 'criticalSourceFilesMatched': len(source_files)}))
