#!/bin/sh
set -eu
if [ "$(dpkg --print-architecture)" != arm64 ]; then echo 'Native arm64 base required' >&2; exit 1; fi
mkdir -p /work/apt-cache/partial /work/apt-metadata
# This changes only the local container, never the host. The immutable snapshot
# keeps dependency resolution fixed; GPG signature and package hash checks stay on.
rm -f /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources
printf '%s\n' \
  'deb [check-valid-until=no signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] https://snapshot.debian.org/archive/debian/20261101T000000Z/ bookworm main' \
  'deb [check-valid-until=no signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] https://snapshot.debian.org/archive/debian-security/20261101T000000Z/ bookworm-security main' \
  > /etc/apt/sources.list.d/locked-snapshot.list
printf '%s\n' \
  'Acquire::https::CaInfo "/work/bootstrap-ca.pem";' \
  'Acquire::Retries "1";' \
  'Dir::Cache::archives "/work/apt-cache";' \
  'APT::Keep-Downloaded-Packages "true";' \
  > /etc/apt/apt.conf.d/99-locked-bootstrap
export DEBIAN_FRONTEND=noninteractive
# Provisioning restarts killed the earlier container during dpkg unpack. Finish
# pending configuration from the already hash-checked snapshot cache first.
if ! dpkg --configure --pending; then
  apt-get --yes --no-install-recommends --no-download --fix-broken install
fi
apt-get update
for source in /var/lib/apt/lists/*InRelease; do cp "$source" /work/apt-metadata/; done
packages='ca-certificates curl git python3 xz-utils time make patch unzip file'
: > /work/os-package-requests.txt
for package in $packages; do
  version=$(apt-cache policy "$package" | awk '$1 == "Candidate:" {print $2}')
  if [ -z "$version" ] || [ "$version" = '(none)' ]; then echo "Missing pinned package: $package" >&2; exit 1; fi
  printf '%s=%s\n' "$package" "$version" >> /work/os-package-requests.txt
done
set -- $(tr '\n' ' ' < /work/os-package-requests.txt)
apt-get --yes --no-install-recommends --print-uris --download-only install "$@" > /work/os-package-uris.txt
apt-get --yes --no-install-recommends --download-only install "$@"
# Installation cannot silently fetch a changed package after the locked download.
apt-get --yes --no-install-recommends --no-download install "$@"
python3 /work/os-inventory.py
cp /etc/os-release /work/os-release
