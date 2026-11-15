#!/usr/bin/env python3
"""Fetch locked SDK archives; publish only size- and hash-validated bytes.

Run in the target-architecture container before the offline installation phase.
A candidate x86-64 archive list alone is not a complete ship toolchain lock.
"""
import hashlib
import json
import os
import pathlib
import platform
import tempfile
import urllib.parse
import urllib.request

lock_path = pathlib.Path(os.environ['BME_SDK_LOCK'])
destination = pathlib.Path(os.environ['BME_SDK_ARCHIVE_DIR'])
lock = json.loads(lock_path.read_text())
architecture = {'aarch64': 'arm64', 'arm64': 'arm64', 'x86_64': 'x86_64'}.get(platform.machine())
if architecture not in ('arm64', 'x86_64') or lock['architecture'] != architecture or lock['version'] != '6.0.0':
    raise SystemExit('host architecture and locked SDK must match')
destination.mkdir(parents=True, exist_ok=True)

class LockedRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, url):
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme != 'https' or parsed.hostname != 'storage.googleapis.com':
            raise ValueError('refusing cross-origin archive redirect')
        return super().redirect_request(request, fp, code, message, headers, url)

opener = urllib.request.build_opener(LockedRedirects())

def digest_file(path):
    digest = hashlib.sha256()
    count = 0
    with path.open('rb') as stream:
        while chunk := stream.read(1024 * 1024):
            count += len(chunk)
            digest.update(chunk)
    return count, digest.hexdigest()

for item in lock['archives']:
    name = item['file']
    parsed = urllib.parse.urlparse(item['url'])
    if pathlib.PurePath(name).name != name or parsed.scheme != 'https' or parsed.hostname != 'storage.googleapis.com':
        raise SystemExit('refusing SDK URL or filename outside locked origin')
    expected = (item['bytes'], item['sha256'])
    output = destination / name
    if output.exists():
        if digest_file(output) != expected:
            raise SystemExit(f'existing archive does not match lock, refusing overwrite: {output}')
        continue
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(prefix='.sdk-', dir=destination, delete=False) as temp:
            temporary = pathlib.Path(temp.name)
            digest = hashlib.sha256()
            count = 0
            with opener.open(item['url'], timeout=60) as response:
                if urllib.parse.urlparse(response.geturl()).hostname != 'storage.googleapis.com':
                    raise SystemExit('refusing cross-origin archive redirect')
                while chunk := response.read(1024 * 1024):
                    count += len(chunk)
                    if count > item['bytes']:
                        raise SystemExit(f'archive exceeds locked size: {name}')
                    digest.update(chunk)
                    temp.write(chunk)
            temp.flush()
            os.fsync(temp.fileno())
        if (count, digest.hexdigest()) != expected:
            raise SystemExit(f'archive hash/size mismatch: {name}')
        # A racing writer must not be overwritten, even with a verified archive.
        os.link(temporary, output)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
print('Locked SDK archives available for offline installation')
