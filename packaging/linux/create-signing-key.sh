#!/usr/bin/env bash
# ClaudeBWAI — one-time wizard: creates the BlastCast archive signing key. Run by einh, as claudebwai, in his own ssh terminal.
# The passphrase is asked for by gpg itself (pinentry). This script never reads, echoes or stores it, and never exports the private key.
set -euo pipefail
GNUPGHOME_DIR=/opt/glitch/_local/blastcast-gpg
UID_STR="Blastworks.ai <blastworksai@gmail.com>"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
confirm() { read -r -p "$1 [y/N] " a; [[ "$a" == y || "$a" == Y ]] || { echo "Stopped by you before: $1"; exit 1; }; }
command -v gpg >/dev/null || { echo "gpg is not installed."; exit 1; }
[[ "$(id -un)" == claudebwai ]] || { echo "Run this as claudebwai (you are $(id -un))."; exit 1; }
if [[ -e "$GNUPGHOME_DIR" ]]; then
  [[ -d "$GNUPGHOME_DIR" && ! -L "$GNUPGHOME_DIR" ]] || { echo "$GNUPGHOME_DIR exists and is not a plain directory. Refusing."; exit 1; }
  [[ "$(stat -c %u "$GNUPGHOME_DIR")" == "$(id -u)" ]] || { echo "$GNUPGHOME_DIR is not owned by you. Refusing."; exit 1; }
  [[ -z "$(ls -A "$GNUPGHOME_DIR")" ]] || { echo "$GNUPGHOME_DIR is not empty: a key may already exist. Refusing."; exit 1; }
fi
echo "Step 1 of 3: create $GNUPGHOME_DIR (mode 0700)."
confirm "Create it?"
mkdir -p -m 0700 "$GNUPGHOME_DIR"; chmod 0700 "$GNUPGHOME_DIR"
export GNUPGHOME="$GNUPGHOME_DIR"
echo "Step 2 of 3: generate an ed25519 sign-only key for \"$UID_STR\", valid 3 years."
echo "gpg will ask you for a passphrase in its own prompt. Type it there; nothing here sees it."
confirm "Generate the key?"
gpg --pinentry-mode loopback --quick-generate-key "$UID_STR" ed25519 sign 3y
FPR="$(gpg --list-keys --with-colons "$UID_STR" | awk -F: '/^fpr:/{print $10; exit}')"
[[ -n "$FPR" ]] || { echo "Key not found after generation."; exit 1; }
echo "Step 3 of 3: export the PUBLIC key beside this script."
confirm "Write blastcast-archive-keyring.asc and .gpg into $HERE?"
gpg --armor --export "$FPR" > "$HERE/blastcast-archive-keyring.asc"
gpg --export "$FPR" > "$HERE/blastcast-archive-keyring.gpg"
echo
echo "Done. Fingerprint: $FPR"
echo "Public key files written (commit them): $HERE/blastcast-archive-keyring.{asc,gpg}"
echo "The private key stays in $GNUPGHOME_DIR. Do not copy it anywhere."
