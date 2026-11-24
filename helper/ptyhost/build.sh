#!/bin/bash
# Builds the FROZEN PTY host. Read the header of ptyhost.c before running this:
# a different binary is a different cdhash, and every macOS user then gets the
# privacy prompts (Documents, Desktop, Downloads, iCloud Drive) or Full Disk Access
# grant for `vaultagent-pty` once more. Run it only on purpose; commit
# vaultagent-pty and PINNED.json together. CI never runs it (it checks the pin).
#
# No signing certificate: ad-hoc only (`--sign -`), which is all the user will ever have.
set -euo pipefail
cd "$(dirname "$0")"

OUT=vaultagent-pty
IDENTIFIER=dev.bme.vaultagent.pty

# Reproducibility: nothing here embeds a timestamp or the checkout path (no -g, so
# no DWARF paths; -ffile-prefix-map is insurance if a flag is ever added), and
# ld's LC_UUID is a hash of the output, hence deterministic. Verified by building
# twice into different directories: identical sha256.
clang -O2 -Wall -Wextra -Werror \
    -arch arm64 -arch x86_64 -mmacosx-version-min=11.0 \
    -ffile-prefix-map="$PWD"=. \
    -o "$OUT" ptyhost.c
strip -x "$OUT" 2>/dev/null || true

codesign --force --sign - --identifier "$IDENTIFIER" "$OUT"
codesign --verify --strict "$OUT"

sha256=$(shasum -a 256 "$OUT" | awk '{print $1}')
# The cdhash is what TCC matches a grant against (the designated requirement of an
# ad-hoc binary). `codesign -dv` prints one CDHash line per architecture slice for
# a universal file; the hash of the whole thing is pinned as the sha256 above, and
# the arm64 slice's cdhash (the one Apple silicon Macs run) is recorded here.
cdhash=$(codesign -dvvv --arch arm64 "$OUT" 2>&1 | sed -n 's/^CDHash=//p' | head -1)
cdhash_x86=$(codesign -dvvv --arch x86_64 "$OUT" 2>&1 | sed -n 's/^CDHash=//p' | head -1)
[ -n "$cdhash" ] || { echo "could not read the cdhash" >&2; exit 1; }

cat > PINNED.json <<JSON
{
  "sha256": "$sha256",
  "cdhash": "$cdhash",
  "cdhashX86_64": "$cdhash_x86"
}
JSON
echo "built $OUT  sha256=$sha256  cdhash(arm64)=$cdhash  cdhash(x86_64)=$cdhash_x86"
