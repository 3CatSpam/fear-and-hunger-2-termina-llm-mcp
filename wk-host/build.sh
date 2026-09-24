#!/bin/zsh
# Builds a native arm64 WebKit build of the game as a separate .app (the original is untouched).
# The game data is cloned with APFS copy-on-write, so it costs almost no extra disk.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
SRC_APP="${GAME_APP:-/Applications/Fear and Hunger 2 Termina.app}"
OUT="${OUT:-$ROOT/build/Fear and Hunger 2 Termina (WebKit).app}"

mkdir -p "$OUT/Contents/MacOS" "$OUT/Contents/Resources"

swiftc -O -swift-version 5 -o "$OUT/Contents/MacOS/FungerWK" "$HERE/Sources/main.swift" \
    -framework Cocoa -framework WebKit -framework Network

cat > "$OUT/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>FungerWK</string>
  <key>CFBundleIdentifier</key><string>com.laggyo.fungerwk</string>
  <key>CFBundleName</key><string>Fear and Hunger 2 Termina (WebKit)</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleSupportedPlatforms</key><array><string>MacOSX</string></array>
  <key>LSApplicationCategoryType</key><string>public.app-category.games</string>
  <key>CFBundleIconFile</key><string>app</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLIST

[[ -f "$SRC_APP/Contents/Resources/app.icns" ]] && cp "$SRC_APP/Contents/Resources/app.icns" "$OUT/Contents/Resources/app.icns"
[[ -d "$OUT/Contents/Resources/app.nw" ]] || cp -cR "$SRC_APP/Contents/Resources/app.nw" "$OUT/Contents/Resources/app.nw"

# put the bridge plugin into the copy (registers it in the copy's plugins.js)
GAME_APP="$OUT" "$ROOT/install.sh" install

# testing only: DEBUG_EVAL=1 turns on the plugin's eval hatch in this copy (must happen before signing)
if [[ "${DEBUG_EVAL:-0}" == "1" ]]; then
    sed -i '' 's/var ALLOW_EVAL = false;/var ALLOW_EVAL = true;/' "$OUT/Contents/Resources/app.nw/js/plugins/ClaudeBridge.js"
fi

codesign --force --deep -s - "$OUT"
echo "built: $OUT"
