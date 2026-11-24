import hashlib
import json
import pathlib
import subprocess

root = pathlib.Path('/work')
files = []
for path in sorted((root / 'apt-cache').glob('*.deb')):
    identity = subprocess.check_output(['dpkg-deb', '--field', str(path), 'Package', 'Version', 'Architecture'], text=True)
    fields = dict(line.split(': ', 1) for line in identity.strip().splitlines())
    hash = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            hash.update(chunk)
    files.append({'file': path.name, 'bytes': path.stat().st_size, 'sha256': hash.hexdigest(), **fields})
installed = subprocess.check_output(['dpkg-query', '-W', '-f=${binary:Package}\t${Version}\t${Architecture}\n'], text=True)
(root / 'os-installed.tsv').write_text(installed)
metadata = []
for path in sorted((root / 'apt-metadata').glob('*')):
    metadata.append({'file': path.name, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'bytes': path.stat().st_size})
lock = {'snapshot': '20261101T000000Z', 'repositories': ['debian/bookworm/main', 'debian-security/bookworm-security/main'],
        'bootstrapCaSha256': hashlib.sha256((root / 'bootstrap-ca.pem').read_bytes()).hexdigest(),
        'requested': (root / 'os-package-requests.txt').read_text().splitlines(), 'metadata': metadata,
        'packages': files, 'downloadedDebBytes': sum(file['bytes'] for file in files)}
(root / 'os-lock.json').write_text(json.dumps(lock, indent=2) + '\n')
print(json.dumps({'packages': len(files), 'downloadedDebBytes': lock['downloadedDebBytes']}))
