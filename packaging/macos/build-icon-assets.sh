#!/usr/bin/env bash
# ClaudeBWAI — BlastCast Task 5.1: compile the app icon into an asset catalog (Assets.car) with Xcode's actool.
#
# Run on Thor (macOS, Xcode installed and opened once). No signing, no network.
#
# Usage:  build-icon-assets.sh <icons-dir> <out-dir>
#   <icons-dir>  folder holding blastcast-{16,32,64,128,256,512,1024}.png (the same files package.mjs turns into
#                BlastCast.icns: assets/brand/icons/ in the repo, copy that folder to Thor first)
#   <out-dir>    must not exist or must be empty; receives Assets.car and partial.plist
#
# Afterwards: copy <out-dir>/Assets.car to packaging/macos/Assets.car, and put the printed SHA-256
# into ASSETS_CAR_SHA256 in package.mjs.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <icons-dir> <out-dir>" >&2
  exit 2
fi
icons=$1
out=$2

if ! xcrun --find actool >/dev/null 2>&1; then
  echo "actool not found. Install Xcode from the App Store and open it once so it finishes setup, then run this again." >&2
  exit 1
fi

if [ -e "$out" ] && { [ ! -d "$out" ] || [ -n "$(ls -A "$out")" ]; }; then
  echo "Refusing: output folder $out exists and is not empty." >&2
  exit 1
fi

# pixel size -> catalog entries (size@scale), per Apple's macOS app icon set
declare -a SIZES=(16 32 128 256 512)
for px in 16 32 64 128 256 512 1024; do
  if [ ! -f "$icons/blastcast-$px.png" ]; then
    echo "Missing icon: $icons/blastcast-$px.png" >&2
    exit 1
  fi
done

work=$(mktemp -d "${TMPDIR:-/tmp}/blastcast-icons.XXXXXX")
trap 'rm -rf "$work"' EXIT
set_dir="$work/Icons.xcassets/AppIcon.appiconset"
mkdir -p "$set_dir" "$out"

printf '{\n  "images" : [\n' > "$set_dir/Contents.json"
first=1
for size in "${SIZES[@]}"; do
  for scale in 1 2; do
    px=$((size * scale))
    name="icon_${size}x${size}@${scale}x.png"
    cp "$icons/blastcast-$px.png" "$set_dir/$name"
    [ "$first" -eq 1 ] || printf ',\n' >> "$set_dir/Contents.json"
    first=0
    printf '    { "idiom" : "mac", "size" : "%sx%s", "scale" : "%sx", "filename" : "%s" }' \
      "$size" "$size" "$scale" "$name" >> "$set_dir/Contents.json"
  done
done
printf '\n  ],\n  "info" : { "version" : 1, "author" : "xcode" }\n}\n' >> "$set_dir/Contents.json"

xcrun actool --compile "$out" \
  --platform macosx --minimum-deployment-target 13.0 \
  --app-icon AppIcon \
  --output-partial-info-plist "$out/partial.plist" \
  --output-format human-readable-text \
  "$work/Icons.xcassets"

if [ ! -f "$out/Assets.car" ]; then
  echo "actool finished but produced no Assets.car in $out" >&2
  exit 1
fi

echo "Assets.car SHA-256:"
shasum -a 256 "$out/Assets.car"
echo "--- assetutil --info ---"
xcrun assetutil --info "$out/Assets.car"
