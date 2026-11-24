#!/bin/bash
# Build the unsigned VaultAgent.pkg from two compiled helpers.
#
#   helper/packaging/macos/build-pkg.sh <darwin-arm64 binary> <darwin-x64 binary> <version> <out.pkg>
#
# lipo → one universal binary, ad-hoc signed (Apple silicon refuses to run
# unsigned code); pkgbuild stages it in /Library/Application Support/VaultAgent/stage,
# and scripts/postinstall installs it per user. Needs Xcode command-line tools.

set -euo pipefail

if [ $# -ne 4 ]; then
    echo "usage: $0 <arm64-binary> <x64-binary> <version> <out.pkg>" >&2
    exit 2
fi
ARM64="$1"
X64="$2"
VERSION="${3#vaultagent-v}"
OUT="$4"
HERE="$(cd "$(dirname "$0")" && pwd)"
IDENTIFIER="dev.bme.vaultagent"

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]]; then
    echo "bad version: $VERSION" >&2
    exit 2
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/vaultagent-pkg.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

PAYLOAD="$WORK/payload"
STAGE="$PAYLOAD/Library/Application Support/VaultAgent/stage"
mkdir -p "$STAGE"
lipo -create -output "$STAGE/vaultagent" "$ARM64" "$X64"
chmod 755 "$STAGE/vaultagent"
# lipo keeps each slice's signature, but re-sign the fat file as one: cheap and certain.
codesign --force --sign - "$STAGE/vaultagent"
lipo "$STAGE/vaultagent" -verify_arch arm64 x86_64

SCRIPTS="$WORK/scripts"
mkdir -p "$SCRIPTS"
cp "$HERE/scripts/postinstall" "$SCRIPTS/postinstall"
chmod 755 "$SCRIPTS/postinstall"

pkgbuild \
    --root "$PAYLOAD" \
    --install-location / \
    --scripts "$SCRIPTS" \
    --identifier "$IDENTIFIER" \
    --version "$VERSION" \
    --ownership recommended \
    "$WORK/vaultagent-component.pkg"

sed "s/__VERSION__/$VERSION/g" "$HERE/distribution.xml" > "$WORK/distribution.xml"

mkdir -p "$(dirname "$OUT")"
productbuild \
    --distribution "$WORK/distribution.xml" \
    --resources "$HERE/resources" \
    --package-path "$WORK" \
    "$OUT"

echo "built $OUT ($VERSION)"
