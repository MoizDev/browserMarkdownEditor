import json
import pathlib
import urllib.request

root = pathlib.Path('/work')
release = '772bb4648be4a897ca062d6adc65bc70223d2703'
archives = [
    {'file': f'{release}-wasm-binaries-arm64.tar.xz', 'url': f'https://storage.googleapis.com/webassembly/emscripten-releases-builds/linux/{release}/wasm-binaries-arm64.tar.xz'},
    {'file': 'node-v22.16.0-linux-arm64.tar.xz', 'url': 'https://storage.googleapis.com/webassembly/emscripten-releases-builds/deps/node-v22.16.0-linux-arm64.tar.xz'},
]
for archive in archives:
    with urllib.request.urlopen(urllib.request.Request(archive['url'], method='HEAD'), timeout=60) as response:
        size = response.headers.get('Content-Length')
        if not size or not size.isdecimal():
            raise SystemExit('SDK archive length unavailable; ask lead before fetching')
        archive['bytes'] = int(size)
os_lock = json.loads((root / 'os-lock.json').read_text())
base = json.loads((root / 'base-pin.json').read_text())
# Count the entire fetched source disk size as a conservative transfer estimate.
source_upper_bound = (1344 + 768 + 63716) * 1024
expected = os_lock['downloadedDebBytes'] + base['compressedLayerBytes'] + source_upper_bound + sum(item['bytes'] for item in archives)
if expected > 5 * 1024**3:
    raise SystemExit(f'Expected material fetch {expected} exceeds the approved5GiB budget')
(root / 'sdk-download-plan.json').write_text(json.dumps({'archives': archives, 'conservativeTotalFetchBytes': expected}, indent=2) + '\n')
print(json.dumps({'sdkArchiveBytes': sum(item['bytes'] for item in archives), 'conservativeTotalFetchBytes': expected}))
