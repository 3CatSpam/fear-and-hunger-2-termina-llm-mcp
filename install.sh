#!/bin/zsh
# Installs / uninstalls the ClaudeBridge plugin into Fear & Hunger 2: Termina.
# Usage: ./install.sh [install|uninstall]
set -e

APP="${GAME_APP:-/Applications/Fear and Hunger 2 Termina.app}"
WWW="$APP/Contents/Resources/app.nw"
PLUGINS_JS="$WWW/js/plugins.js"
BACKUP="$PLUGINS_JS.pre-claudebridge"
SRC="$(cd "$(dirname "$0")" && pwd)/game-plugin/ClaudeBridge.js"

[[ -f "$PLUGINS_JS" ]] || { echo "plugins.js not found at $PLUGINS_JS"; exit 1; }

case "${1:-install}" in
install)
    [[ -f "$BACKUP" ]] || cp "$PLUGINS_JS" "$BACKUP"
    cp "$SRC" "$WWW/js/plugins/ClaudeBridge.js"
    if grep -q '"name":"ClaudeBridge"' "$PLUGINS_JS"; then
        echo "already registered in plugins.js"
    else
        # append as the last entry of the $plugins array
        python3 - "$PLUGINS_JS" <<'PY'
import sys, re
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
i = s.rstrip().rfind(']')
head = s[:i].rstrip()
entry = '{"name":"ClaudeBridge","status":true,"description":"MCP bridge","parameters":{}}'
if not head.endswith(','):
    head += ','
open(p, 'w', encoding='utf-8').write(head + '\n' + entry + '\n' + s[i:])
PY
    fi
    echo "installed. backup: $BACKUP. Restart the game."
    ;;
uninstall)
    [[ -f "$BACKUP" ]] && cp "$BACKUP" "$PLUGINS_JS"
    rm -f "$WWW/js/plugins/ClaudeBridge.js"
    echo "uninstalled (plugins.js restored from backup)."
    ;;
*) echo "usage: $0 [install|uninstall]"; exit 1 ;;
esac
