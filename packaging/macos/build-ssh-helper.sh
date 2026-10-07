#!/usr/bin/env bash
# ClaudeBWAI — einh 5 Oct: bundled ssh helper for the Mac App Store build (GOV-352).
# Builds a self-contained arm64 OpenSSH client (static OpenSSL 3.5.9, no zlib) on Thor.
# Runs over SSH on purpose: nothing here is signed.
# Usage: build-ssh-helper.sh <min-macos-version>
#   <min-macos-version> is LSMinimumSystemVersion from the MAS Electron zip's Info.plist (N or N.N, today 13.0).
# Layout, rooted at this script's own directory (~/BlastCastBuilds/mas/):
#   src/    inputs: openssl-3.5.9.tar.gz, openssh-10.5p1.tar.gz
#   build/  extracted sources (script-owned scratch, wiped every run)
#   stage/  OpenSSL install prefix (script-owned scratch, wiped every run)
#   out/    ssh and BUILDINFO.txt
set -euo pipefail

OPENSSH_SHA256="d44d28a839ea9daf969cc69150fde59910b2b39361dad81a3bd6cbd19218db11"
OPENSSL_SHA256="603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a"
OPENSSH_TAR="openssh-10.5p1.tar.gz"
OPENSSL_TAR="openssl-3.5.9.tar.gz"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$ROOT/src"
BUILD="$ROOT/build"
STAGE="$ROOT/stage"
OUT="$ROOT/out"

die() { echo "ERROR: $*" >&2; exit 1; }
step() { echo; echo "== $*"; }

[ "$#" -eq 1 ] || die "usage: $0 <min-macos-version>   (for example 13.0)"
MIN_VERSION="$1"

step "Preflight"
[ "$(uname -s)" = "Darwin" ] || die "this script only runs on macOS"
[ -n "$MIN_VERSION" ] || die "the minimum macOS version is empty; pass LSMinimumSystemVersion from the MAS app's Info.plist"
case "$MIN_VERSION" in
  *[!0-9.]*|.*|*.|*..*|*.*.*) die "minimum macOS version '$MIN_VERSION' must look like N or N.N (for example 13.0)" ;;
esac
for tool in shasum make clang tar lipo otool strip sysctl sw_vers perl; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool not found (install the Command Line Tools)"
done
[ -f "$SRC/$OPENSSL_TAR" ] || die "missing $SRC/$OPENSSL_TAR"
[ -f "$SRC/$OPENSSH_TAR" ] || die "missing $SRC/$OPENSSH_TAR"
if [ -e "$OUT/ssh" ]; then
  die "$OUT/ssh already exists; move it aside (or move out/ aside) and run again. This script never overwrites it."
fi

step "Verifying the source tarballs (before anything is extracted)"
sha_of() { shasum -a 256 "$1" | awk '{print $1}'; }
GOT_OPENSSL="$(sha_of "$SRC/$OPENSSL_TAR")"
GOT_OPENSSH="$(sha_of "$SRC/$OPENSSH_TAR")"
[ "$GOT_OPENSSL" = "$OPENSSL_SHA256" ] || die "SHA-256 of $OPENSSL_TAR does not match. Expected $OPENSSL_SHA256, got $GOT_OPENSSL. Refusing to build."
[ "$GOT_OPENSSH" = "$OPENSSH_SHA256" ] || die "SHA-256 of $OPENSSH_TAR does not match. Expected $OPENSSH_SHA256, got $GOT_OPENSSH. Refusing to build."
echo "openssl: $GOT_OPENSSL"
echo "openssh: $GOT_OPENSSH"

export MACOSX_DEPLOYMENT_TARGET="$MIN_VERSION"
JOBS="$(sysctl -n hw.ncpu)"

step "Fresh scratch (build/ and stage/ are script-owned)"
rm -rf "$BUILD" "$STAGE"
mkdir -p "$BUILD" "$STAGE" "$OUT"
tar -xzf "$SRC/$OPENSSL_TAR" -C "$BUILD"
tar -xzf "$SRC/$OPENSSH_TAR" -C "$BUILD"
OPENSSL_DIR="$BUILD/openssl-3.5.9"
OPENSSH_DIR="$BUILD/openssh-10.5p1"
[ -d "$OPENSSL_DIR" ] || die "extracting $OPENSSL_TAR did not produce $OPENSSL_DIR"
[ -d "$OPENSSH_DIR" ] || die "extracting $OPENSSH_TAR did not produce $OPENSSH_DIR"

step "Building OpenSSL (static)"
OPENSSL_CONFIGURE="./Configure darwin64-arm64-cc no-shared no-tests no-apps --prefix=$STAGE/openssl --openssldir=$STAGE/openssl/ssl"
(
  cd "$OPENSSL_DIR"
  ./Configure darwin64-arm64-cc no-shared no-tests no-apps --prefix="$STAGE/openssl" --openssldir="$STAGE/openssl/ssl"
  make -j"$JOBS"
  make install_sw
)
if [ -f "$STAGE/openssl/lib/libcrypto.a" ]; then
  SSL_LIBDIR="$STAGE/openssl/lib"
elif [ -f "$STAGE/openssl/lib64/libcrypto.a" ]; then
  SSL_LIBDIR="$STAGE/openssl/lib64"
else
  die "OpenSSL installed no libcrypto.a under $STAGE/openssl/lib or lib64"
fi
echo "OpenSSL libraries: $SSL_LIBDIR"

step "Building OpenSSH ssh"
SSH_CONFIGURE="./configure --with-ssl-dir=$STAGE/openssl --with-zlib=no --without-pam --without-libedit --without-kerberos5 --disable-strip LDFLAGS=-L$SSL_LIBDIR"
(
  cd "$OPENSSH_DIR"
  ./configure --with-ssl-dir="$STAGE/openssl" --with-zlib=no --without-pam --without-libedit --without-kerberos5 --disable-strip LDFLAGS="-L$SSL_LIBDIR"
  make -j"$JOBS" ssh
)
cp "$OPENSSH_DIR/ssh" "$OUT/ssh"
strip "$OUT/ssh"

step "Checking the result"
ARCHS="$(lipo -archs "$OUT/ssh")"
[ "$ARCHS" = "arm64" ] || die "ssh architectures are '$ARCHS', expected exactly 'arm64'"

OTOOL_OUT="$(otool -L "$OUT/ssh")"
BAD_LINES="$(printf '%s\n' "$OTOOL_OUT" | tail -n +2 | awk '{print $1}' | grep -v -e '^/usr/lib/' -e '^/System/Library/' || true)"
[ -z "$BAD_LINES" ] || die "ssh links against libraries outside /usr/lib and /System/Library: $BAD_LINES"
if printf '%s\n' "$OTOOL_OUT" | tail -n +2 | grep -E 'libcrypto|libssl|libz' >/dev/null; then
  die "ssh links dynamically against libcrypto, libssl or libz; it must be self-contained"
fi

VERSION_OUT="$("$OUT/ssh" -V 2>&1 || true)"
case "$VERSION_OUT" in *OpenSSH_10.5p1*) ;; *) die "ssh -V does not report OpenSSH_10.5p1: $VERSION_OUT" ;; esac
case "$VERSION_OUT" in *"OpenSSL 3.5.9"*) ;; *) die "ssh -V does not report OpenSSL 3.5.9: $VERSION_OUT" ;; esac
echo "arch: $ARCHS"
echo "version: $VERSION_OUT"

step "Writing BUILDINFO.txt"
OUT_SHA="$(sha_of "$OUT/ssh")"
{
  echo "date (UTC): $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "host macOS: $(sw_vers -productVersion)"
  echo "compiler: $(clang --version | head -1)"
  echo "MACOSX_DEPLOYMENT_TARGET: $MACOSX_DEPLOYMENT_TARGET"
  echo "$OPENSSL_TAR sha256: $GOT_OPENSSL"
  echo "$OPENSSH_TAR sha256: $GOT_OPENSSH"
  echo "out/ssh sha256: $OUT_SHA"
  echo "lipo -archs: $ARCHS"
  echo "ssh -V: $VERSION_OUT"
  echo "openssl configure (in openssl-3.5.9): $OPENSSL_CONFIGURE"
  echo "openssh configure (in openssh-10.5p1): $SSH_CONFIGURE"
  echo "otool -L out/ssh:"
  printf '%s\n' "$OTOOL_OUT"
} > "$OUT/BUILDINFO.txt"

echo
echo "OK: $OUT/ssh arm64, min macOS $MACOSX_DEPLOYMENT_TARGET, $VERSION_OUT, sha256 $OUT_SHA"
