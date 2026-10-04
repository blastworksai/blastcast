#!/usr/bin/env bash
# ClaudeBWAI — writes SHA256SUMS and a detached armored SHA256SUMS.asc for the release assets in <dir>.
# Usage: sign-sums.sh <dir> [gnupghome]   (default GNUPGHOME /opt/glitch/_local/blastcast-gpg). gpg prompts for the passphrase itself.
set -euo pipefail
DIR="${1:?usage: sign-sums.sh <dir> [gnupghome]}"
export GNUPGHOME="${2:-${GNUPGHOME:-/opt/glitch/_local/blastcast-gpg}}"
[[ -d "$DIR" ]] || { echo "No such directory: $DIR"; exit 1; }
cd "$DIR"
shopt -s nullglob
files=()
for f in *; do [[ -f "$f" && "$f" != SHA256SUMS && "$f" != SHA256SUMS.asc ]] && files+=("$f"); done
(( ${#files[@]} )) || { echo "No release assets in $DIR"; exit 1; }
sha256sum -- "${files[@]}" > SHA256SUMS
rm -f SHA256SUMS.asc
gpg --pinentry-mode loopback --armor --detach-sign --output SHA256SUMS.asc SHA256SUMS
gpg --verify SHA256SUMS.asc SHA256SUMS
echo "Wrote $DIR/SHA256SUMS and $DIR/SHA256SUMS.asc"
