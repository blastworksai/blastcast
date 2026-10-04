#!/usr/bin/env bash
# ClaudeBWAI: sign, package, notarize and staple BlastCast.app on the Mac (run in Thor's own Terminal, never over SSH).
# Usage: sign-notarize.sh <path/to/BlastCast.app> <out-dir>
set -euo pipefail

TEAM="RN28A922NH"
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENTITLEMENTS="$KIT/entitlements.plist"

die() { echo "ERROR: $*" >&2; exit 1; }
step() { echo; echo "== $*"; }

[ "$#" -eq 2 ] || die "usage: $0 <path/to/BlastCast.app> <out-dir>"
INPUT_APP="$1"
OUT_DIR="$2"

step "Preflight"
[ "$(uname -s)" = "Darwin" ] || die "this script only runs on macOS"
[ -f "$ENTITLEMENTS" ] || die "missing $ENTITLEMENTS"
[ -d "$INPUT_APP/Contents" ] || die "not an app bundle: $INPUT_APP"
for tool in codesign pkgbuild productbuild spctl; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool not found (install the Command Line Tools)"
done
xcrun --find notarytool >/dev/null 2>&1 || die "xcrun notarytool not found"
xcrun --find stapler >/dev/null 2>&1 || die "xcrun stapler not found"
if [ -n "${SSH_CONNECTION:-}" ]; then
  echo "WARNING: this looks like an SSH session. Signing fails over SSH (errSecInternalComponent)." >&2
  echo "WARNING: run this script in Thor's own Terminal instead." >&2
fi
if [ -e "$OUT_DIR" ] && [ -n "$(ls -A "$OUT_DIR" 2>/dev/null)" ]; then
  die "out-dir exists and is not empty: $OUT_DIR"
fi

APP_IDENTITY="$(security find-identity -v -p codesigning | grep "Developer ID Application:.*($TEAM)" | head -n 1 | awk '{print $2}' || true)"
INSTALLER_IDENTITY="$(security find-identity -v | grep "Developer ID Installer:.*($TEAM)" | head -n 1 | awk '{print $2}' || true)"
[ -n "$APP_IDENTITY" ] || die "no 'Developer ID Application' certificate for team $TEAM in the keychain"
[ -n "$INSTALLER_IDENTITY" ] || die "no 'Developer ID Installer' certificate for team $TEAM in the keychain"
echo "Application identity: $APP_IDENTITY"
echo "Installer identity:   $INSTALLER_IDENTITY"

mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
APP="$OUT_DIR/BlastCast.app"

step "Copying the app (the input is never signed in place)"
ditto "$INPUT_APP" "$APP"

sign() {
  codesign --force --timestamp --options runtime --entitlements "$ENTITLEMENTS" --sign "$APP_IDENTITY" "$1"
}

step "Signing Mach-O leaves"
while IFS= read -r -d '' f; do
  if file -b "$f" | grep -q "Mach-O"; then
    echo "leaf: ${f#"$APP"/}"
    sign "$f"
  fi
done < <(find "$APP/Contents/Frameworks" -type f -print0)

step "Signing framework bundles"
while IFS= read -r -d '' f; do
  echo "framework: ${f#"$APP"/}"
  sign "$f"
done < <(find "$APP/Contents/Frameworks" -depth -type d -name '*.framework' -print0)

step "Signing helper apps"
while IFS= read -r -d '' f; do
  echo "helper: ${f#"$APP"/}"
  sign "$f"
done < <(find "$APP/Contents/Frameworks" -depth -type d -name '*.app' -print0)

step "Signing the main app"
sign "$APP"

step "Verifying the signature and entitlements"
codesign --verify --deep --strict --verbose=2 "$APP"
ENT_XML="$(codesign -d --entitlements - --xml "$APP" 2>/dev/null || true)"
for key in com.apple.security.device.camera com.apple.security.device.audio-input; do
  printf '%s' "$ENT_XML" | grep -q "$key" || die "signed app is missing entitlement $key"
done
echo "entitlements present: camera, audio-input"

step "Building the installer package"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"
MIN_OS="$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' "$APP/Contents/Info.plist")"
[ -n "$VERSION" ] || die "could not read CFBundleShortVersionString"
[ -n "$MIN_OS" ] || die "could not read LSMinimumSystemVersion"
STAGE="$OUT_DIR/.pkg-stage"
mkdir -p "$STAGE/installer-root"
ditto "$APP" "$STAGE/installer-root/BlastCast.app"
cat > "$STAGE/requirements.plist" <<REQ
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>arch</key><array><string>arm64</string></array>
<key>os</key><array><string>$MIN_OS</string></array>
</dict></plist>
REQ
# COMPONENT-PLIST-BEGIN (must match componentPlist in package.mjs)
cat > "$STAGE/components.plist" <<'COMP'
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><array><dict>
<key>RootRelativeBundlePath</key><string>BlastCast.app</string>
<key>BundleIsRelocatable</key><false/>
<key>BundleIsVersionChecked</key><true/>
<key>BundleHasStrictIdentifier</key><true/>
<key>BundleOverwriteAction</key><string>upgrade</string>
</dict></array></plist>
COMP
# COMPONENT-PLIST-END
PKG="$OUT_DIR/BlastCast-$VERSION-macos-arm64.pkg"
pkgbuild --root "$STAGE/installer-root" --component-plist "$STAGE/components.plist" \
  --identifier com.blastworks.blastcast.pkg --version "$VERSION" \
  --install-location /Applications --ownership recommended "$STAGE/BlastCast-component.pkg"
productbuild --package "$STAGE/BlastCast-component.pkg" --product "$STAGE/requirements.plist" --sign "$INSTALLER_IDENTITY" "$PKG"
rm -rf "$STAGE"

step "Notarizing (this waits for Apple)"
NOTARY_OUT="$OUT_DIR/.notary-result.json"
notary_submit() {
  xcrun notarytool submit "$PKG" --keychain-profile blastcast-notary --wait --output-format json >"$NOTARY_OUT" 2>"$NOTARY_OUT.err"
}
transient() {
  grep -Eqi 'HTTP[^0-9]*5[0-9][0-9]|status code:? *5[0-9][0-9]|network|timed out|NSURLErrorDomain|could not connect|connection (was )?(lost|reset)' "$NOTARY_OUT" "$NOTARY_OUT.err" 2>/dev/null
}
status_of() { plutil -extract status raw -o - "$NOTARY_OUT" 2>/dev/null || true; }
id_of() { plutil -extract id raw -o - "$NOTARY_OUT" 2>/dev/null || true; }

NOTARY_STATUS=""
if notary_submit; then
  NOTARY_STATUS="$(status_of)"
elif transient; then
  echo "Apple-side or network error; retrying once." >&2
  sleep 15
  if notary_submit; then NOTARY_STATUS="$(status_of)"; fi
fi
if [ "$NOTARY_STATUS" != "Accepted" ]; then
  echo "Notarization did not succeed (status: ${NOTARY_STATUS:-none})." >&2
  cat "$NOTARY_OUT" "$NOTARY_OUT.err" >&2 2>/dev/null || true
  SUB_ID="$(id_of)"
  if [ -n "$SUB_ID" ]; then
    xcrun notarytool log "$SUB_ID" --keychain-profile blastcast-notary >&2 || true
  fi
  exit 1
fi
echo "Notarization: Accepted"

step "Stapling and checking Gatekeeper"
xcrun stapler staple "$PKG"
xcrun stapler validate "$PKG"
SPCTL_OUT="$(spctl -a -vvv -t install "$PKG" 2>&1 || true)"
echo "$SPCTL_OUT"
printf '%s' "$SPCTL_OUT" | grep -q "accepted" || die "spctl did not accept the package"
printf '%s' "$SPCTL_OUT" | grep -q "source=Notarized Developer ID" || die "spctl source is not Notarized Developer ID"

step "Done"
SIZE="$(stat -f %z "$PKG")"
SHA="$(shasum -a 256 "$PKG" | awk '{print $1}')"
echo "pkg:    $PKG"
echo "bytes:  $SIZE"
echo "sha256: $SHA"
echo "Next step: send these three lines (pkg path, bytes, sha256) to Glitch."
