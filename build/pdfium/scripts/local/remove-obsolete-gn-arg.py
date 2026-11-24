# Controlled recipe adaptation for standalone PDFium's pinned build tree.
# Keep --fail-on-unused-args: remove the Chromium-only setting it rejected,
# rather than making GN ignore unused settings globally.
import difflib
import hashlib
import json
from pathlib import Path

path = Path('/toolchain/work/pdfium/build/toolchain/wasm/BUILD.gn')
marker = Path('/toolchain/work/pdfium/.b0-standalone-arg')
text = path.read_text()
sha = lambda data: hashlib.sha256(data.encode()).hexdigest()
if marker.exists():
    record = json.loads(marker.read_text())
    if sha(text) != record['afterSha256']:
        raise SystemExit('Controlled WASM toolchain GN patch drift')
else:
    old = '    use_allocator_shim = false\n'
    if text.count(old) != 1:
        raise SystemExit('Obsolete allocator-shim setting no longer matches exactly')
    changed = text.replace(old, '')
    record = {'path': 'build/toolchain/wasm/BUILD.gn', 'beforeSha256': sha(text), 'afterSha256': sha(changed),
              'reason': 'use_allocator_shim is not declared in standalone PDFium; GN --fail-on-unused-args refused it'}
    patch = ''.join(difflib.unified_diff(text.splitlines(keepends=True), changed.splitlines(keepends=True),
                                       fromfile='a/toolchain/wasm/BUILD.gn', tofile='b/toolchain/wasm/BUILD.gn'))
    Path('/work/patches/standalone-wasm-allocator.patch').write_text(patch)
    path.write_text(changed)
    marker.write_text(json.dumps(record, indent=2) + '\n')
Path('/work/b0-standalone-arg.json').write_text(json.dumps(record, indent=2) + '\n')
