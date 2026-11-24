#!/usr/bin/env python3
"""Refuse a build image whose installed OS inventory differs from its lock."""
import os
import pathlib
import subprocess

lock = pathlib.Path(os.environ['BME_OS_INSTALLED_LOCK'])
expected = sorted(lock.read_text().splitlines())
actual = sorted(subprocess.check_output(
    ['dpkg-query', '-W', '-f=${binary:Package}\t${Version}\t${Architecture}\n'], text=True
).splitlines())
if not expected or any(len(row.split('\t')) != 3 for row in expected) or actual != expected:
    raise SystemExit('Installed OS packages differ from the reviewed inventory')
print('Installed OS packages match the reviewed inventory')
