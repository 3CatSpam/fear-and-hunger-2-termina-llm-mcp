#!/bin/zsh
# Builds a DMG containing ONLY the launcher (no game files), for sharing.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
"$HERE/build.sh"
APP="$ROOT/build/Termina WebKit Launcher.app"
STAGE="$ROOT/build/dmg-stage"
DMG="$ROOT/build/Termina-WebKit-Launcher.dmg"

# safety: the launcher must never carry game data
if find "$APP" -name "app.nw" -o -name "rpg_core.js" -o -name "*.rpgmvo" | grep -q .; then
    echo "REFUSING: game files found inside the app bundle" >&2; exit 1
fi
SIZE=$(du -sm "$APP" | cut -f1)
[[ $SIZE -lt 50 ]] || { echo "REFUSING: app is ${SIZE}MB, too big for a launcher-only build" >&2; exit 1; }

rm -rf "$STAGE" "$DMG"; mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
cp "$HERE/dmg/README.txt" "$STAGE/READ ME FIRST.txt"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "Termina WebKit Launcher" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$STAGE"
echo "built: $DMG ($(du -h "$DMG" | cut -f1))"
