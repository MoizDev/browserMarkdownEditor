#!/usr/bin/env python3
"""Refuse an SDK archive or installed critical file differing from the lock."""
import hashlib
import json
import os
import platform
from pathlib import Path

lock = json.loads(Path(os.environ['BME_SDK_LOCK']).read_text())
sdk = Path(os.environ['SDK_ROOT'])
architecture = {'aarch64': 'arm64', 'arm64': 'arm64', 'x86_64': 'x86_64'}.get(platform.machine())
if lock['version'] != '6.0.0' or architecture not in ('arm64', 'x86_64') or lock['architecture'] != architecture:
    raise SystemExit('Host architecture and locked SDK must match')

def check(path, item):
    h = hashlib.sha256()
    count = 0
    with path.open('rb') as stream:
        while chunk := stream.read(1024 * 1024):
            count += len(chunk)
            h.update(chunk)
    if count != item['bytes'] or h.hexdigest() != item['sha256']:
        raise SystemExit(f'Locked SDK input mismatch: {path}')

for item in lock['archives']:
    check(sdk / 'downloads' / item['file'], item)
if os.environ.get('BME_SDK_INSTALLED') == '1':
    if len(lock.get('criticalSourceFiles', [])) < 3:
        raise SystemExit('Incomplete critical SDK file lock')
    for item in lock['criticalSourceFiles']:
        check(sdk / 'upstream' / 'emscripten' / item['path'], item)
print('SDK inputs match locked lengths and SHA-256')
