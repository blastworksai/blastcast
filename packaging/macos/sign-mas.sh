#!/usr/bin/env bash
# ClaudeBWAI: sign and package the assembled BlastCast.app for the Mac App Store, in Thor's own Terminal (never over SSH).
# The input is copied, never signed in place. No notarization: the store does its own checks.
# Usage: sign-mas.sh <path/to/BlastCast.app> <out-dir> [path/to/BlastCast_MAS.provisionprofile]
# Env overrides: MAS_APP_IDENTITY, MAS_INSTALLER_IDENTITY (certificate names), MAS_PROFILE.
# Flags follow the CP2 spike (sign-spike.sh) exactly: codesign --force --sign <id> --entitlements <plist>,
# with no --options runtime and no --timestamp (the spike proved that set on Thor).
set -euo pipefail

TEAM="RN28A922NH"
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PARENT_ENT="$KIT/entitlements-mas.plist"
CHILD_ENT="$KIT/entitlements-mas-child.plist"
LOGIN_ENT="$KIT/entitlements-mas-loginhelper.plist"
APP_NAME="${MAS_APP_IDENTITY:-Apple Distribution: Kristof Kennes ($TEAM)}"
INSTALLER_NAME="${MAS_INSTALLER_IDENTITY:-3rd Party Mac Developer Installer: Kristof Kennes ($TEAM)}"

die() { echo "ERROR: $*" >&2; exit 1; }
step() { echo; echo "== $*"; }

[ "$#" -ge 2 ] && [ "$#" -le 3 ] || die "usage: $0 <path/to/BlastCast.app> <out-dir> [path/to/profile.provisionprofile]"
INPUT_APP="$1"
OUT_DIR="$2"
PROFILE="${3:-${MAS_PROFILE:-$HOME/BlastCastBuilds/mas/BlastCast_MAS.provisionprofile}}"

step "Preflight"
[ "$(uname -s)" = "Darwin" ] || die "this script only runs on macOS"
for f in "$PARENT_ENT" "$CHILD_ENT" "$LOGIN_ENT" "$PROFILE"; do [ -f "$f" ] || die "missing $f"; done
[ -d "$INPUT_APP/Contents" ] || die "not an app bundle: $INPUT_APP"
for tool in codesign security ditto file productbuild pkgutil xattr; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool not found (install the Command Line Tools)"
done
if [ -n "${SSH_CONNECTION:-}" ]; then
  echo "WARNING: this looks like an SSH session. Signing fails over SSH (errSecInternalComponent)." >&2
  echo "WARNING: run this script in Thor's own Terminal instead." >&2
fi
if [ -e "$OUT_DIR" ] && [ -n "$(ls -A "$OUT_DIR" 2>/dev/null)" ]; then
  die "out-dir exists and is not empty: $OUT_DIR"
fi

APP_ID="$(security find-identity -v | grep -F "\"$APP_NAME\"" | head -n 1 | awk '{print $2}' || true)"
INSTALLER_ID="$(security find-identity -v | grep -F "\"$INSTALLER_NAME\"" | head -n 1 | awk '{print $2}' || true)"
[ -n "$APP_ID" ] || die "no '$APP_NAME' identity in the keychain (security find-identity -v)"
[ -n "$INSTALLER_ID" ] || die "no '$INSTALLER_NAME' identity in the keychain (security find-identity -v)"
echo "Application identity: $APP_ID ($APP_NAME)"
echo "Installer identity:   $INSTALLER_ID ($INSTALLER_NAME)"

mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
APP="$OUT_DIR/BlastCast.app"
PKG="$OUT_DIR/BlastCast-mas.pkg"

step "Copying the app (the input is never signed in place)"
ditto "$INPUT_APP" "$APP"
cp "$PROFILE" "$APP/Contents/embedded.provisionprofile"
# ClaudeBWAI — 7 Oct, App Store Connect error 91109: a browser-downloaded profile carries com.apple.quarantine,
# and cp keeps it. Strip every extended attribute from the copy before signing (signing never relies on them).
xattr -cr "$APP"

sign() { # sign <path> <entitlements>
  codesign --force --sign "$APP_ID" --entitlements "$2" "$1"
}

step "Signing loose Mach-O files under Contents (child)"
# Skipped here: anything inside a nested *.app (signed with its bundle below), a framework's own main binary
# (signed with the framework), Contents/MacOS (signed with the main app) and Helpers/ssh (signed on its own).
# The nested-app test runs on the path RELATIVE to the outer app: the absolute path always contains BlastCast.app/.
while IFS= read -r -d '' f; do
  rel="${f#"$APP"/}"
  case "$rel" in *.app/*) continue ;; esac
  case "$rel" in Contents/MacOS/*|Contents/Helpers/ssh) continue ;; esac
  if file -b "$f" | grep -q "Mach-O"; then
    fwdir="${f%%.framework/*}.framework"
    if [ "$f" = "$fwdir/Versions/A/$(basename "$fwdir" .framework)" ]; then continue; fi
    echo "leaf: $rel"
    sign "$f" "$CHILD_ENT"
  fi
done < <(find "$APP/Contents" -type f -print0)

step "Signing framework bundles (child)"
while IFS= read -r -d '' f; do
  echo "framework: ${f#"$APP"/}"
  sign "$f" "$CHILD_ENT"
done < <(find "$APP/Contents" -depth -type d -name '*.framework' -print0)

step "Signing helper apps (child)"
while IFS= read -r -d '' f; do
  case "${f#"$APP"/}" in Contents/Library/LoginItems/*) continue ;; esac
  echo "helper: ${f#"$APP"/}"
  sign "$f" "$CHILD_ENT"
done < <(find "$APP/Contents" -depth -type d -name '*.app' -print0)

step "Signing login helper apps under Contents/Library/LoginItems (login helper)"
if [ -d "$APP/Contents/Library/LoginItems" ]; then
  while IFS= read -r -d '' f; do
    echo "login helper: ${f#"$APP"/}"
    sign "$f" "$LOGIN_ENT"
  done < <(find "$APP/Contents/Library/LoginItems" -depth -type d -name '*.app' -print0)
fi

step "Signing the bundled ssh helper (child)"
[ -f "$APP/Contents/Helpers/ssh" ] || die "missing Contents/Helpers/ssh"
sign "$APP/Contents/Helpers/ssh" "$CHILD_ENT"

step "Signing the main app (parent)"
sign "$APP" "$PARENT_ENT"

step "Verifying the signature and entitlements"
codesign --verify --deep --strict --verbose=2 "$APP"
echo "--- entitlements: app"
codesign -d --entitlements :- "$APP" 2>/dev/null || true
echo "--- entitlements: Helpers/ssh"
codesign -d --entitlements :- "$APP/Contents/Helpers/ssh" 2>/dev/null || true
echo "--- signer of every Mach-O"
while IFS= read -r -d '' f; do
  if file -b "$f" | grep -q "Mach-O"; then
    auth="$(codesign -dv --verbose=2 "$f" 2>&1 | grep -m1 '^Authority=' || true)"
    echo "${f#"$APP"/}: ${auth:-UNSIGNED}"
  fi
done < <(find "$APP/Contents" -type f -print0)

step "Checking that no file carries the quarantine attribute (App Store Connect 91109)"
# Captured, not `grep -q`: under pipefail an early grep exit can SIGPIPE xattr and turn a match into a false (agy review, 7 Oct).
quarantined="$(xattr -lr "$APP" 2>/dev/null | grep 'com.apple.quarantine' || true)"
if [ -n "$quarantined" ]; then
  echo "$quarantined" >&2
  die "files above still carry com.apple.quarantine; App Store Connect rejects them"
fi
echo "no quarantine attributes"

step "Checking that every file is readable by non-root users (App Store Connect 90255)"
# ClaudeBWAI — 7 Oct: owner-only files become root-only once installed, and the signature can't then be verified.
unreadable="$(find "$APP" ! -type l \( ! -perm -o+r -o \( -type d ! -perm -o+x \) \) -print)"
if [ -n "$unreadable" ]; then
  echo "$unreadable" >&2
  die "files above are not readable by everyone; App Store Connect rejects them (re-assemble with the current package.mjs)"
fi
echo "all files readable"

step "Building the installer package"
productbuild --component "$APP" /Applications --sign "$INSTALLER_ID" "$PKG"
pkgutil --check-signature "$PKG"

step "Done"
echo "pkg: $PKG"
echo "Next step: Transporter, Verify then Deliver (runbook section 3)."
