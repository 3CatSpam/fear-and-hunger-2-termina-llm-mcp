#!/bin/zsh
# Builds the native WebKit launcher (universal arm64 + x86_64). It contains NO game data:
# on first run it asks for / finds the player's own copy of the game and serves it in place, unmodified.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
NAME="Termina WebKit Launcher"
OUT="${OUT:-$ROOT/build/$NAME.app}"
MIN=13.3

rm -rf "$OUT"
mkdir -p "$OUT/Contents/MacOS" "$OUT/Contents/Resources" "$ROOT/build/obj"

for arch in arm64 x86_64; do
    swiftc -O -swift-version 5 -target "$arch-apple-macos$MIN" -o "$ROOT/build/obj/FungerWK-$arch" "$HERE/Sources/main.swift" \
        -framework Cocoa -framework WebKit -framework Network
done
lipo -create "$ROOT/build/obj/FungerWK-arm64" "$ROOT/build/obj/FungerWK-x86_64" -output "$OUT/Contents/MacOS/FungerWK"

cat > "$OUT/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>FungerWK</string>
  <key>CFBundleIdentifier</key><string>com.laggyo.fungerwk</string>
  <key>CFBundleName</key><string>$NAME</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.2</string>
  <key>CFBundleVersion</key><string>2</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleSupportedPlatforms</key><array><string>MacOSX</string></array>
  <key>LSApplicationCategoryType</key><string>public.app-category.games</string>
  <key>LSMinimumSystemVersion</key><string>$MIN</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLIST

# WebKit-mode shims (file-backed saves, Continue fix) + the optional MCP bridge, injected at runtime
cp "$ROOT/game-plugin/ClaudeBridge.js" "$OUT/Contents/Resources/ClaudeBridge.js"
# testing only: DEBUG_EVAL=1 turns on the plugin's eval hatch (must happen before signing)
if [[ "${DEBUG_EVAL:-0}" == "1" ]]; then
    sed -i '' 's/var ALLOW_EVAL = false;/var ALLOW_EVAL = true;/' "$OUT/Contents/Resources/ClaudeBridge.js"
fi

codesign --force --deep -s - "$OUT"
lipo -archs "$OUT/Contents/MacOS/FungerWK"
echo "built: $OUT"
